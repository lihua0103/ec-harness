"""Listing 持久 Worker：全量读取、sandbox 计算、数据拦截出口、唯一 Excel 发布。

数据流：

discovery（doc/ 需求全量分片；doc 外辅助 Excel 结构化；数据集全量入会话）
      ↓
    sandbox(标准 Python 执行环境,ADR-0009 执行面全开)
      ↓
    三操作各自产回执
      ↓
    data_guard.sanitize_receipt（唯一拦截出口：宿主开关开启时投影
    dataset / aux-excel；关闭时原样返回）
      ↓
    审计 JSONL（无数据值：时间/操作/被投影载荷的 source+path）
      ↓
    excel（固定模板 + layout 自定义排版）

数据集扩展名固定在 discovery.DATA_EXTENSIONS；模型请求不能伪造开关。
宿主通过内部 hostDataInterception 字段下发 ui-settings 的开关状态。
会话状态在进程内：inspect 全量加载后留在会话
（run_code 免二次读取）。
"""
import json
import math
import re
import sys
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from data_guard import audit_record, sanitize_receipt
from discovery import DatasetSourceConflict, load_datasets, dataset_payloads, read_aux_excel_files, read_spec_files
from excel import ListingPublishError, SUPPORTED_SCENARIOS, create_multi_sheet_excel
from sandbox import ENVIRONMENT_HINT, run_sandbox_code
from source_registry import SOURCE_ATTR, DataSource

DOCUMENT_CHUNK_CHARS = 256 * 1024

_GENERIC_ERROR_REASONS = {
    "CODE_EXECUTION_ERROR": "代码执行失败；详细诊断保留在 Worker 进程内",
    "DATASET_NAME_CONFLICT": "数据集名称冲突",
    "DATASET_LOAD_FAILED": "一个或多个临床数据源加载失败",
    "AUXILIARY_LOAD_FAILED": "一个或多个需求辅助文件加载失败",
    "INVALID_OUTPUTS": "outputs 必须是非空 dict[str, pandas.DataFrame]",
    "PUBLISH_ERROR": "发布失败",
    "SCENARIO_REQUIRED": "必须根据完整需求明确选择 Listing 场景",
    "WORKER_ERROR": "Worker 内部错误",
}


def _error(code: str, retryable: bool = False) -> dict:
    return {"ok": False, "code": code, "reason": _GENERIC_ERROR_REASONS[code], "retryable": retryable}


def _host_data_interception(request: dict) -> bool:
    """只信任 TS 宿主注入的布尔值；模型侧 dataInterception 无效。"""
    return request.get("hostDataInterception", True) is True


def _stream_payload(result: dict) -> dict:
    return {
        "stdout": result.get("stdout", ""),
        "stderr": result.get("stderr", ""),
        "stdoutTruncated": bool(result.get("stdoutTruncated")),
        "stderrTruncated": bool(result.get("stderrTruncated")),
    }


def _omitted_stream_payload() -> dict:
    return {"stdoutOmitted": True, "stderrOmitted": True}
_session_project: Optional[Path] = None
_session_datasets: dict[str, pd.DataFrame] = {}
_session_sources: dict[str, str] = {}
_session_documents: list[dict[str, Any]] = []
_session_auxiliary_documents: list[dict[str, Any]] = []
_session_document_chunks_read: set[tuple[str, int]] = set()
_last_outputs: Optional[dict[str, pd.DataFrame]] = None
_session_failures: list[dict[str, Any]] = []
_session_protected_hashes: Optional[set[int]] = None
# doc/ 防洗白基线（审计修复 2026-09-03）：记录会话建立时的文件指纹。
# 基线内未变化的文件是项目原始输入（信任）；之后新增/被改写的 doc 文件
# 一旦内容命中保护值索引即拒绝出域，封堵 run_code 写 doc/ 再 read_document
# 的行值洗白通道。
_session_doc_baseline: Optional[dict[str, tuple[int, int]]] = None
_session_doc_baseline_project: Optional[Path] = None


def _reset_session() -> None:
    global _session_project, _session_datasets, _session_sources, _session_documents, _session_auxiliary_documents
    global _session_document_chunks_read, _last_outputs, _session_failures, _session_protected_hashes
    global _session_doc_baseline, _session_doc_baseline_project
    _session_project, _session_datasets, _session_sources, _session_documents, _session_auxiliary_documents = None, {}, {}, [], []
    _session_failures = []
    _session_document_chunks_read, _last_outputs = set(), None
    _session_protected_hashes = None
    _session_doc_baseline, _session_doc_baseline_project = None, None


def _write_audit(project: Path, record: dict) -> None:
    """审计落盘失败不阻断（投影才是防线），但记 stderr。"""
    try:
        audit_dir = project / ".clinical-listing"
        audit_dir.mkdir(parents=True, exist_ok=True)
        with (audit_dir / "audit.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except (OSError, PermissionError) as exc:
        # 审计是旁路诊断能力，不能把只读项目扫描变成失败或污染执行流。
        sys.stderr.write(f"[enterprise-listing] audit write failed: {exc}\n")


# ---------------------------------------------------------------------------
# listing_inspect：全量读 + 回执（出域由 sanitize_receipt 投影）
# ---------------------------------------------------------------------------

def _scalar_is_missing(value: Any) -> bool:
    if value is None or value is pd.NA or value is pd.NaT:
        return True
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def _protected_representations(value: Any) -> set[str]:
    """临床标量的本地可扫描表示；不同 JSON 数字格式保持等价匹配。"""
    scalar = value.item() if hasattr(value, "item") else value
    if _scalar_is_missing(scalar):
        return set()
    if isinstance(scalar, (str, bool, int)):
        text = str(scalar)
    elif isinstance(scalar, float):
        if not math.isfinite(scalar):
            return set()
        text = str(scalar)
    else:
        text = str(scalar)
    representations = {text}
    if isinstance(scalar, float) and scalar.is_integer():
        representations.add(str(int(scalar)))
    return representations


def protected_value_hashes(
    datasets: dict[str, pd.DataFrame], auxiliary: list[dict[str, Any]],
) -> set[int]:
    """只保留进程内 64 位哈希；碰撞最多误拦，不会导致漏放。

    字符串值额外哈希相邻 token bigram（\\x00 连接，防止跨词误拼）：实测
    "New York" 类多词值按单 token 匹配必然漏报。
    """
    hashes: set[int] = set()
    for frame in datasets.values():
        for row in frame.itertuples(index=False, name=None):
            for value in row:
                hashes.update(_scalar_hashes(value))

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "rows":
                    collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif value is not None:
            hashes.update(_scalar_hashes(value))

    for document in auxiliary:
        collect(document.get("rows"))
    return hashes


_NGRAM_MAX_TOKENS = 12


def _scalar_hashes(value: Any) -> set[int]:
    hashes: set[int] = set()
    for text in _protected_representations(value):
        hashes.add(hash(text))
        tokens = _SCAN_TOKEN_PATTERN.findall(text)
        if 2 <= len(tokens) <= _NGRAM_MAX_TOKENS:
            hashes.update(
                hash(a + "\x00" + b) for a, b in zip(tokens, tokens[1:]))
    return hashes


_SCAN_TOKEN_PATTERN = re.compile(r"[^\s\[\]{}()<>\"'`~,;:!?/\\|=_*#]+")

def _json_scalar_texts(value: Any, output: list[str]) -> None:
    if isinstance(value, dict):
        for item in value.values():
            _json_scalar_texts(item, output)
    elif isinstance(value, list):
        for item in value:
            _json_scalar_texts(item, output)
    elif value is not None:
        output.extend(_protected_representations(value))


def text_contains_protected_value(text: str, protected_hashes: set[int]) -> bool:
    """JSON 精确匹配 + 普通文本 token/bigram 匹配，避免把哈希索引回传宿主。"""
    candidates: list[str] = []
    try:
        _json_scalar_texts(json.loads(text), candidates)
    except (json.JSONDecodeError, TypeError):
        pass
    candidates.append(text)
    for candidate in candidates:
        tokens = _SCAN_TOKEN_PATTERN.findall(candidate)
        for token in tokens:
            if hash(token) in protected_hashes:
                return True
        if len(tokens) <= _NGRAM_MAX_TOKENS * 4:
            for a, b in zip(tokens, tokens[1:]):
                if hash(a + "\x00" + b) in protected_hashes:
                    return True
    return False


def operation_scan_init(request: dict) -> dict:
    """专用扫描 Worker 的预热：装载项目 → 建保护值哈希 → 释放数据。

    与主车道 worker 分进程运行（根治扫描请求被长 run_code 阻塞导致的
    批量误拦）；本进程只保留哈希集合，不持有任何数据值（实测 RBQM
    71 数据集项目，DataFrame 释放后常驻内存仅哈希级）。
    """
    project = Path(request["project"]).resolve()
    data_interception = _host_data_interception(request)
    global _session_datasets, _session_documents, _session_auxiliary_documents
    if _session_project == project and _session_protected_hashes is not None:
        return {"ok": True, "action": "listing-scan-init", "ready": True}
    error = _ensure_session(
        project, request.get("credential"), include_errors=not data_interception)
    if error is not None:
        return {**error, "retryable": True}
    _session_protected_hashes = protected_value_hashes(
        _session_datasets, _session_auxiliary_documents)
    _session_datasets = {}
    _session_documents = []
    _session_auxiliary_documents = []
    return {"ok": True, "action": "listing-scan-init", "ready": True}

def _document_fingerprint(document: dict[str, Any], project: Path) -> Optional[tuple[int, int]]:
    """doc 文件的 (size, mtime_ns) 指纹；文件不可达返回 None（视为已变化）。"""
    try:
        stat = (project / "doc" / document["path"]).stat()
        return (stat.st_size, stat.st_mtime_ns)
    except OSError:
        return None


def _apply_doc_content_guard() -> list[dict[str, Any]]:
    """doc/ 防洗白（须在 _session_protected_hashes 建立后调用）。

    项目原始输入以会话首次建立时的指纹为基线，直接信任（ADR-0010：doc/
    是需求域，不做内容扫描）。基线建立后新增或被改写的 doc 文件，先做
    保护值精确匹配：命中即剔除并返回失败记录（fail-closed，不进入上下文），
    未命中则接受并刷新基线。项目切换时基线随新项目重建。
    """
    global _session_doc_baseline, _session_doc_baseline_project
    if _session_project is None or _session_protected_hashes is None:
        return []
    if _session_doc_baseline_project != _session_project:
        _session_doc_baseline = {
            document["path"]: _document_fingerprint(document, _session_project)
            for document in _session_documents
        }
        _session_doc_baseline_project = _session_project
        return []
    failures: list[dict[str, Any]] = []
    kept: list[dict[str, Any]] = []
    refreshed: dict[str, tuple[int, int]] = {}
    for document in _session_documents:
        fingerprint = _document_fingerprint(document, _session_project)
        if _session_doc_baseline is not None and _session_doc_baseline.get(document["path"]) == fingerprint:
            refreshed[document["path"]] = fingerprint
            kept.append(document)
            continue
        if text_contains_protected_value(_canonical_document(document), _session_protected_hashes):
            failures.append({
                "path": document["path"], "stage": "doc-guard",
                "code": "PROTECTED_DOCUMENT_CONTENT"})
            continue
        if fingerprint is not None:
            refreshed[document["path"]] = fingerprint
        kept.append(document)
    _session_documents[:] = kept
    _session_doc_baseline = refreshed
    return failures


def operation_inspect(request: dict) -> dict:
    project = Path(request["project"]).resolve()
    data_interception = _host_data_interception(request)
    if not project.is_dir():
        return {"ok": False, "code": "PROJECT_NOT_FOUND", "reason": f"项目目录不存在: {project}"}
    try:
        # 第三方 OLE2/Excel 解析器可能直接向 stdout 写 warning；协议 stdout
        # 只能输出一行 JSON，否则父进程会把告警误当成 Worker 回执。
        with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            # doc/ 完整解析并留在会话；AI 必须按 manifest 读完所有分片。
            documents, spec_failures = read_spec_files(
                project / "doc", include_errors=not data_interception)
            aux_documents, aux_failures = read_aux_excel_files(
                project, include_rows=True,
                include_errors=not data_interception)
            datasets, failures, sources = load_datasets(
                project, request.get("credential"),
                include_errors=not data_interception)
    except DatasetSourceConflict:
        return _error("DATASET_NAME_CONFLICT")

    # 全量数据集留在会话，run_code 免二次读取（读失败已在回执披露）
    global _session_project, _session_datasets, _session_sources, _session_documents, _session_auxiliary_documents
    global _session_document_chunks_read, _last_outputs, _session_failures, _session_protected_hashes
    global _session_doc_baseline, _session_doc_baseline_project
    _session_project, _session_datasets, _session_sources, _session_documents, _session_auxiliary_documents = project, datasets, sources, documents, aux_documents
    _session_document_chunks_read, _last_outputs = set(), None
    _session_protected_hashes = protected_value_hashes(datasets, aux_documents)
    if _session_project != _session_doc_baseline_project:
        _session_doc_baseline, _session_doc_baseline_project = None, None
    doc_guard_failures = _apply_doc_content_guard()
    _session_failures = [*spec_failures, *aux_failures, *failures, *doc_guard_failures]

    scenario = request.get("scenario")
    return {"ok": True, "action": "listing-inspect",
            "inspection": {
        "requirementDocuments": [_document_manifest(document) for document in _session_documents],
        "documentReadProtocol": {
            "encoding": "json-utf8",
            "chunkSize": DOCUMENT_CHUNK_CHARS,
            "completeOnlyWhenAllChunksRead": True,
        },
        "auxiliaryDocuments": aux_documents,
        "datasets": dataset_payloads(
            datasets, sources, include_values=not data_interception),
        "failures": _session_failures,
        "scenario": scenario,
        "supportedScenarios": sorted(SUPPORTED_SCENARIOS),
    }}


def _canonical_document(document: dict[str, Any]) -> str:
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _document_manifest(document: dict[str, Any]) -> dict[str, Any]:
    encoded = _canonical_document(document)
    return {
        "documentId": document["documentId"],
        "path": document["path"],
        "type": document["type"],
        "size": document["size"],
        "chunkSize": DOCUMENT_CHUNK_CHARS,
        "totalChunks": (len(encoded) + DOCUMENT_CHUNK_CHARS - 1) // DOCUMENT_CHUNK_CHARS,
        "encoding": "json-utf8",
        "complete": False,
    }


def operation_read_document(request: dict) -> dict:
    project = Path(request["project"]).resolve()
    if _session_project != project:
        return {"ok": False, "code": "PROJECT_SESSION_NOT_INITIALIZED",
                "reason": "必须先调用 enterprise_listing_inspect 初始化项目会话"}
    document_id = request.get("documentId")
    chunk_index = request.get("chunkIndex")
    document = next((item for item in _session_documents if item.get("documentId") == document_id), None)
    if document is None:
        return {"ok": False, "code": "DOCUMENT_NOT_FOUND", "reason": "需求文件不存在"}
    if isinstance(chunk_index, bool) or not isinstance(chunk_index, int) or chunk_index < 0:
        return {"ok": False, "code": "INVALID_CHUNK_INDEX", "reason": "chunkIndex 必须是非负整数"}
    encoded = _canonical_document(document)
    total_chunks = (len(encoded) + DOCUMENT_CHUNK_CHARS - 1) // DOCUMENT_CHUNK_CHARS
    if chunk_index >= total_chunks:
        return {"ok": False, "code": "INVALID_CHUNK_INDEX",
                "reason": f"chunkIndex 必须小于 {total_chunks}"}
    _session_document_chunks_read.add((str(document_id), chunk_index))
    # 注：分片内容来自 inspect 装载的会话内存快照，磁盘换文件不重装载不会
    # 出域；洗白路径（重装载带值文件）由 _apply_doc_content_guard 剔除。
    return {"ok": True, "action": "listing-read-document", "document": {
        "documentId": document["documentId"],
        "path": document["path"],
        "type": document["type"],
        "encoding": "json-utf8",
        "chunkIndex": chunk_index,
        "totalChunks": total_chunks,
        "chunkSize": DOCUMENT_CHUNK_CHARS,
        "content": encoded[chunk_index * DOCUMENT_CHUNK_CHARS:(chunk_index + 1) * DOCUMENT_CHUNK_CHARS],
        "isFinal": chunk_index == total_chunks - 1,
    }}


# ---------------------------------------------------------------------------
# listing_run_code：sandbox 内 AI 操作（开关开启时流输出不回流）
# ---------------------------------------------------------------------------

def normalize_outputs(value: Any) -> dict[str, pd.DataFrame]:
    if not isinstance(value, dict) or not value:
        raise ValueError("outputs 必须是非空字典")
    result: dict[str, pd.DataFrame] = {}
    for name, frame in value.items():
        if not isinstance(name, str) or not name.strip():
            raise ValueError("outputs 键必须是非空字符串")
        if not isinstance(frame, pd.DataFrame):
            raise ValueError(f"outputs[{name!r}] 不是 DataFrame")
        result[name] = frame.copy()
        result[name].attrs = dict(frame.attrs)
        # AI 自己的产物：无继承源头时标记 model-output（passthrough）
        result[name].attrs.setdefault(SOURCE_ATTR, DataSource.MODEL_OUTPUT.value)
    return result


def _decode_runner_value(value: Any) -> Any:
    if isinstance(value, list):
        return [_decode_runner_value(item) for item in value]
    if isinstance(value, dict):
        if value.get("$type") == "datetime" and isinstance(value.get("value"), str):
            return pd.Timestamp(value["value"])
        if value.get("$type") == "date" and isinstance(value.get("value"), str):
            return pd.Timestamp(value["value"]).date()
        if value.get("$type") == "timedelta" and isinstance(value.get("value"), (int, float)):
            return pd.Timedelta(seconds=value["value"])
        return {str(key): _decode_runner_value(item) for key, item in value.items()}
    return value


def decode_runner_outputs(value: Any) -> dict[str, pd.DataFrame]:
    if not isinstance(value, list) or not value:
        raise ValueError("outputs must be a non-empty list")
    decoded: dict[str, pd.DataFrame] = {}
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("invalid output structure")
        name = item.get("name")
        columns = item.get("columns")
        records = item.get("records")
        attrs = item.get("attrs", {})
        if not isinstance(name, str) or not name.strip() or name in decoded:
            raise ValueError("invalid output name")
        if not isinstance(columns, list) or not all(isinstance(column, str) for column in columns):
            raise ValueError("invalid output columns")
        if not isinstance(records, list) or any(not isinstance(row, list) or len(row) != len(columns) for row in records):
            raise ValueError("invalid output records")
        if not isinstance(attrs, dict):
            raise ValueError("invalid output attributes")
        frame = pd.DataFrame([[_decode_runner_value(cell) for cell in row] for row in records], columns=columns)
        frame.attrs = _decode_runner_value(attrs)
        decoded[name] = frame
    return normalize_outputs(decoded)


def _all_document_chunks_read() -> bool:
    expected = {(str(document["documentId"]), index)
                for document in _session_documents
                for index in range(_document_manifest(document)["totalChunks"])}
    return expected.issubset(_session_document_chunks_read)

def _ensure_session(
    project: Path, credential: Optional[str], include_errors: bool = False,
) -> Optional[dict]:
    """会话未命中当前项目时全量收集；读失败 fail-closed（返回错误回执）。"""
    global _session_project, _session_datasets, _session_sources, _session_documents, _session_auxiliary_documents
    global _session_document_chunks_read, _last_outputs, _session_failures, _session_protected_hashes
    global _session_doc_baseline, _session_doc_baseline_project
    if _session_project == project:
        return None
    try:
        with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            documents, spec_failures = read_spec_files(
                project / "doc", include_errors=include_errors)
            auxiliary_documents, auxiliary_failures = read_aux_excel_files(
                project, include_rows=True, include_errors=include_errors)
            datasets, failures, sources = load_datasets(
                project, credential, include_errors=include_errors)
    except DatasetSourceConflict:
        return _error("DATASET_NAME_CONFLICT")
    if auxiliary_failures:
        return {**_error("AUXILIARY_LOAD_FAILED", retryable=True),
                "failures": [*auxiliary_failures]}
    if failures and not datasets:
        return {**_error("DATASET_LOAD_FAILED", retryable=True),
                "failures": failures}
    _session_project, _session_datasets, _session_sources, _session_documents = project, datasets, sources, documents
    _session_auxiliary_documents = auxiliary_documents
    _session_document_chunks_read, _last_outputs = set(), None
    _session_protected_hashes = protected_value_hashes(datasets, auxiliary_documents)
    if _session_project != _session_doc_baseline_project:
        _session_doc_baseline, _session_doc_baseline_project = None, None
    doc_guard_failures = _apply_doc_content_guard()
    # 失败清单必须与 inspect 口径一致：部分数据集失败不能静默清零，
    # 否则 datasetFailureCount 谎报、listing 从不完整数据发布。
    _session_failures = [*spec_failures, *failures, *doc_guard_failures]
    return None


def operation_scan_text(request: dict) -> dict:
    """供宿主检查通用工具结果；受保护值集合留在本 Agent Worker 进程内。"""
    project = Path(request["project"]).resolve()
    if _session_project != project:
        return {"ok": False, "code": "SCAN_SESSION_NOT_INITIALIZED",
                "reason": "通用工具结果扫描前必须先完成 enterprise_listing_inspect"}
    text = request.get("text")
    if not isinstance(text, str):
        return {"ok": False, "code": "INVALID_SCAN_TEXT", "reason": "scan text 必须是字符串"}
    if _session_protected_hashes is None:
        return {"ok": False, "code": "PROTECTED_VALUES_UNAVAILABLE", "retryable": True}
    return {"ok": True, "containsProtectedValue":
            text_contains_protected_value(text, _session_protected_hashes)}


def _snapshot_failure(failures: list[dict[str, Any]]) -> dict[str, Any] | None:
    """需求/辅助失败 fail-closed；数据源部分失败不拖垮可用数据集。"""
    if not failures:
        return None
    stages = {failure.get("stage") for failure in failures}
    if "read-spec" in stages:
        code = "REQUIREMENTS_LOAD_FAILED"
        reason = "一个或多个需求文件读取失败"
    elif "read-aux-excel" in stages:
        code = "AUXILIARY_LOAD_FAILED"
        reason = "一个或多个需求辅助文件读取失败"
    else:
        # 企业项目常携带冗余/历史数据源。只要仍有可用数据集，失败清单
        # 保留在 inspect 回执中，由 spec 驱动选择；不能诱导模型修改输入。
        if _session_datasets:
            return None
        code = "DATASET_LOAD_FAILED"
        reason = "临床数据源全部加载失败"
    return {"ok": False, "code": code, "reason": reason,
            "retryable": True, "failures": failures}


def operation_run_code(request: dict) -> dict:
    project = Path(request["project"]).resolve()
    data_interception = _host_data_interception(request)
    error = _ensure_session(
        project, request.get("credential"),
        include_errors=not data_interception)
    if error is not None:
        return error
    snapshot_error = _snapshot_failure(_session_failures)
    if snapshot_error is not None:
        return snapshot_error
    if not _all_document_chunks_read():
        return {"ok": False, "code": "REQUIREMENTS_NOT_FULLY_READ",
                "reason": "必须先读取 doc/ 中每个需求文件的全部分片"}

    result = run_sandbox_code(
        request["code"], project, _session_datasets,
        [*_session_documents, *_session_auxiliary_documents])
    # 开启时 stdout/stderr 可能由一行 print 直接携带受保护值；一律不回流。
    stream_payload = _omitted_stream_payload() if data_interception else _stream_payload(result)
    if not result["ok"]:
        diagnostics = {
            "errorType": str(result.get("errorType", "ExecutionError")),
            "outputsDefined": bool(result.get("outputsDefined", False)),
        }
        # SyntaxError 的消息由 code_runner 白名单生成（编译期、只含模型
        # 自己的源码行），可安全进入诊断；其余 error 文本保持进程内。
        if diagnostics["errorType"] == "SyntaxError" and result.get("error"):
            diagnostics["syntax"] = str(result["error"])[:2000]
        if data_interception:
            return {**_error("CODE_EXECUTION_ERROR", retryable=True),
                    "diagnostics": diagnostics,
                    "environmentHint": ENVIRONMENT_HINT, **stream_payload}
        return {"ok": False, "code": "CODE_EXECUTION_ERROR",
                "reason": "代码执行失败",
                "retryable": True, "diagnostics": diagnostics,
                "environmentHint": ENVIRONMENT_HINT, **stream_payload}
    if not result.get("outputsDefined"):
        return {"ok": False, "code": "OUTPUTS_REQUIRED", "reason": "代码必须定义 outputs: dict[str, pandas.DataFrame]",
                "environmentHint": ENVIRONMENT_HINT, **stream_payload}
    try:
        if isinstance(result.get("outputsInvalid"), str):
            raise ValueError(result["outputsInvalid"])
        outputs = decode_runner_outputs(result.get("outputs"))
    except ValueError as exc:
        if data_interception:
            return {**_error("INVALID_OUTPUTS", retryable=True),
                    "environmentHint": ENVIRONMENT_HINT, **stream_payload}
        return {"ok": False, "code": "INVALID_OUTPUTS", "reason": str(exc),
                "retryable": True, "environmentHint": ENVIRONMENT_HINT, **stream_payload}

    global _last_outputs
    _last_outputs = outputs
    if data_interception:
        metadata = [{
            "rowCount": len(frame), "columnCount": int(frame.shape[1]),
            "columns": [{"dtype": str(frame[column].dtype), "nullCount": int(frame[column].isna().sum())}
                        for column in frame.columns],
        } for frame in outputs.values()]
    else:
        metadata = [{
            "name": name, "rowCount": len(frame), "columnCount": int(frame.shape[1]),
            "columns": [{"name": str(column), "dtype": str(frame[column].dtype),
                         "nullCount": int(frame[column].isna().sum())}
                        for column in frame.columns],
        } for name, frame in outputs.items()]
    return {"ok": True, "action": "listing-run-code", "receipt": {
        "outputCount": len(outputs),
        "outputs": metadata,
        "publishReady": True,
        "datasetFailureCount": sum(
            1 for failure in _session_failures
            if failure.get("stage") in {"extract-archive", "read-dataset"}),
        **stream_payload,
    }}


def _metadata_auxiliary_documents(include_rows: bool) -> list[dict[str, Any]]:
    """Return full auxiliary metadata only when interception is disabled."""
    if include_rows:
        return [dict(document) for document in _session_auxiliary_documents]
    return [{key: value for key, value in document.items() if key != "rows"}
            for document in _session_auxiliary_documents]


def operation_read_metadata(request: dict) -> dict:
    """Read inspect metadata in pages without exposing dataset or Excel values."""
    project = Path(request["project"]).resolve()
    if _session_project != project:
        return {"ok": False, "code": "PROJECT_SESSION_NOT_INITIALIZED",
                "reason": "必须先调用 enterprise_listing_inspect 初始化项目会话"}
    data_interception = _host_data_interception(request)
    page_index = request.get("pageIndex", 0)
    page_size = request.get("pageSize", 20)
    compact = request.get("compact") is True
    if (isinstance(page_index, bool) or not isinstance(page_index, int) or page_index < 0
            or isinstance(page_size, bool) or not isinstance(page_size, int)
            or page_size < 1 or page_size > 100):
        return {"ok": False, "code": "INVALID_METADATA_PAGE",
                "reason": "pageIndex 必须是非负整数，pageSize 必须在 1 到 100 之间"}
    datasets = dataset_payloads(_session_datasets, _session_sources,
                                include_values=not data_interception)
    if compact:
        # 目录概览模式（2026-09-03 实测补充）：大项目元数据页会被宿主截断，
        # 模型被迫多轮补读。compact 只保留 name/path/columns/rowCount，
        # 全目录可一页返回；详细统计（dtypes/null/unique）按需走普通分页。
        datasets = [{key: payload[key] for key in ("name", "path", "columns", "rowCount") if key in payload}
                    for payload in datasets]
    total = len(datasets)
    start = page_index * page_size
    failures = [{key: failure[key] for key in ("path", "stage", "code") if key in failure}
                for failure in _session_failures]
    return {"ok": True, "action": "listing-read-metadata", "metadata": {
        "pageIndex": page_index,
        "pageSize": page_size,
        "totalDatasets": total,
        "totalPages": (total + page_size - 1) // page_size,
        "datasets": datasets[start:start + page_size],
        "auxiliaryDocuments": _metadata_auxiliary_documents(not data_interception),
        "failureCount": len(failures),
        "failures": failures,
    }}


# ---------------------------------------------------------------------------
# listing_publish：输出结构指纹（产物是 Excel，不回流 AI）
# ---------------------------------------------------------------------------

def operation_publish(request: dict) -> dict:
    if _last_outputs is None:
        return {"ok": False, "code": "NO_SUCCESSFUL_RUN", "reason": "publish 前必须成功执行 run_code"}
    project = Path(request["project"]).resolve()
    if _session_project != project:
        return {"ok": False, "code": "PROJECT_SESSION_MISMATCH", "reason": "项目与当前会话不一致"}
    scenario = request.get("scenario")
    if scenario is None:
        return _error("SCENARIO_REQUIRED")
    if not isinstance(scenario, str) or scenario not in SUPPORTED_SCENARIOS:
        return {"ok": False, "code": "INVALID_SCENARIO",
                "reason": "不支持的 scenario"}
    output = project / ".clinical-listing" / "output" / scenario / f"{scenario.upper()}_LISTINGS.xlsx"
    data_interception = _host_data_interception(request)
    try:
        create_multi_sheet_excel(
            _last_outputs, output, scenario,
            track_changes=request.get("trackChanges", True),
            cover_labels=request.get("coverLabels"))
        receipt = {
            "outputFile": output.relative_to(project).as_posix(),
            "scenario": scenario, "dataClass": "REAL",
            "format": "single-workbook-multi-sheet-xlsx", "outputCount": len(_last_outputs)}
        if not data_interception:
            receipt["sheetNames"] = list(_last_outputs.keys())
        return {"ok": True, "action": "listing-publish", "receipt": receipt}
    except ListingPublishError as exc:
        return {"ok": False, "code": "PUBLISH_ERROR",
                "reason": "发布失败", "stage": exc.code, "retryable": True}
    except Exception as exc:
        if data_interception:
            return _error("PUBLISH_ERROR", retryable=True)
        return {"ok": False, "code": "PUBLISH_ERROR",
                "reason": f"发布失败: {exc}", "retryable": True}


# ---------------------------------------------------------------------------
# 调度：三操作 → 统一拦截出口 → 审计
# ---------------------------------------------------------------------------

def dispatch(request: dict) -> dict:
    data_interception = _host_data_interception(request)
    operation = request.get("operation")
    if operation == "listing_inspect":
        response = operation_inspect(request)
    elif operation == "listing_read_document":
        response = operation_read_document(request)
    elif operation == "listing_read_metadata":
        response = operation_read_metadata(request)
    elif operation == "listing_run_code":
        response = operation_run_code(request)
    elif operation == "listing_publish":
        response = operation_publish(request)
    elif operation == "listing_scan_text":
        response = operation_scan_text(request)
    elif operation == "listing_scan_init":
        response = operation_scan_init(request)
    else:
        response = {"ok": False, "code": "UNKNOWN_OPERATION", "reason": f"未知操作: {operation}"}

    projections: list = []
    response = sanitize_receipt(response, data_interception, audit=projections)
    record = audit_record(operation, projections, data_interception)
    if record is not None and isinstance(request.get("project"), str):
        _write_audit(Path(request["project"]).resolve(), record)
    return response


def main() -> None:
    # NDJSON 协议行恒 UTF-8：Windows 下 Python 默认用 ANSI 代码页写 stdout，
    # 中文 reason 会变 GBK 乱码（实战已见）。spawn 侧已设 PYTHONUTF8=1，
    # 此处 reconfigure 作双保险（老版本 Python 无该方法则跳过）。
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except Exception:
                pass
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            response = dispatch(json.loads(line))
        except Exception as exc:
            # 协议层异常不能吞掉：stderr 末 16KB 由宿主在 Worker 退出时留存诊断。
            sys.stderr.write(f"[enterprise-listing] worker dispatch error: {exc!r}\n")
            response = _error("WORKER_ERROR")
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
