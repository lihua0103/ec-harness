"""Listing 持久 Worker：全量读取、sandbox 计算、数据拦截出口、唯一 Excel 发布。

数据流（2026-08-28 第三版口径，ADR-0007）：

    discovery（全量读 + 源头标注；doc/ 零拦截、恒全量）
      ↓
    sandbox(标准 Python 执行环境,ADR-0009 执行面全开;stdout 捕获)
      ↓
    三操作各自产回执
      ↓
    data_guard.sanitize_receipt（投影 dataset 载荷）
      ↓
    value_mask.mask_receipt_strings（FR-8 值遮蔽：回执字符串命中会话
    数据集单元格值替换 [DATA]；doc/ 载荷子树豁免；开关关闭时跳过）
      ↓
    审计 JSONL（无数据值：时间/操作/开关态/被投影载荷的 source+path
    /maskedCount 纯计数）
      ↓
    excel（固定模板 + layout 自定义排版）

开关是**宿主侧**的（ui-settings DataSecurityService 设置页 + tool-audit
通用车道护栏），由 TS 入口逐请求下发 ``dataInterception`` 旗标与
``datasetExtensions`` 扩展名表；请求缺省按 True / 内置默认扩展名处理
（fail-closed）。会话状态在进程内：inspect 全量加载后留在会话
（run_code 免二次读取）。
"""
import json
import sys
import traceback
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from data_guard import audit_record, sanitize_receipt
from discovery import load_datasets, dataset_payloads, normalize_extensions, read_spec_files
from excel import create_multi_sheet_excel
from sandbox import ENVIRONMENT_HINT, run_sandbox_code
from source_registry import SOURCE_ATTR, DataStr, DataSource
from value_mask import ValueMatcher, build_value_set, compile_matcher, mask_receipt_strings

#: stdout/stderr 回执截断（防协议超限，不是数据红线）。
MAX_CAPTURE_CHARS = 16_384
#: 回执内名称显示上限（V-4,机械上限非内容判定:压缩"列名走私行值"隐蔽
#: 信道带宽;真实变量名远短于此,零误伤）。真实名称保留在会话/发布产物里。
MAX_RECEIPT_NAME_CHARS = 120


def _display_name(value: Any) -> DataStr:
    """回执内名称显示（构造点车道标记：outputs 表名/列名是 AI 可控的
    数据派生字符串——可走私单元格值，一律包 DataStr 进遮蔽通道）。"""
    text = str(value)
    if len(text) <= MAX_RECEIPT_NAME_CHARS:
        return DataStr(text)
    return DataStr(text[:MAX_RECEIPT_NAME_CHARS - 1] + "…")

_session_project: Optional[Path] = None
_session_datasets: dict[str, pd.DataFrame] = {}
_last_outputs: Optional[dict[str, pd.DataFrame]] = None
#: 值遮蔽缓存：(构建时的数据集字典对象, matcher)。按对象身份失效——
#: inspect/_ensure_session 重载会话后新字典自动触发重建，无需手动清。
#: matcher（值集 + 前缀桶索引）与值集同槽：同一数据集身份只编译一次
#: （100 万级值集编译秒级，每请求重编会把 run_code 拖回秒级——性能
#: 修复 2026-08-30）。
_value_mask_cache: Optional[tuple[dict, ValueMatcher]] = None


def _value_mask_matcher() -> ValueMatcher:
    """从会话数据集构建（并缓存）值遮蔽预编译匹配器。"""
    global _value_mask_cache
    cached = _value_mask_cache
    if cached is not None and cached[0] is _session_datasets:
        return cached[1]
    values, _stats = build_value_set(_session_datasets)
    matcher = compile_matcher(values)
    _value_mask_cache = (_session_datasets, matcher)
    return matcher


def _reset_session() -> None:
    global _session_project, _session_datasets, _last_outputs
    _session_project, _session_datasets, _last_outputs = None, {}, None


def _interception_flag(request: dict) -> bool:
    """宿主下发的拦截旗标；缺省 True（fail-closed：读不到 = 拦着）。"""
    return bool(request.get("dataInterception", True))


def _request_extensions(request: dict) -> Optional[set[str]]:
    """宿主下发的数据集扩展名表（DataSecurityService 单源）；缺省回落内置。"""
    return normalize_extensions(request.get("datasetExtensions"))


def _write_audit(project: Path, record: dict) -> None:
    """审计落盘失败不阻断（投影才是防线），但记 stderr。"""
    try:
        audit_dir = project / ".clinical-listing"
        audit_dir.mkdir(parents=True, exist_ok=True)
        with (audit_dir / "audit.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as exc:
        print(f"[audit] 写入失败: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# listing_inspect：全量读 + 回执（出域由 sanitize_receipt 投影）
# ---------------------------------------------------------------------------

def operation_inspect(request: dict) -> dict:
    project = Path(request["project"]).resolve()
    if not project.is_dir():
        return {"ok": False, "code": "PROJECT_NOT_FOUND",
                "reason": DataStr(f"项目目录不存在: {project}")}   # content 类：恒 DataStr
    interception = _interception_flag(request)
    extensions = _request_extensions(request)
    try:
        # doc/ 零拦截（ADR-0007）：恒全量读，与开关无关
        documents, spec_failures = read_spec_files(project / "doc")
        datasets, failures, sources = load_datasets(project, request.get("credentialRef"), extensions)
    except ValueError as exc:
        return {"ok": False, "code": "DATASET_NAME_CONFLICT", "reason": DataStr(str(exc))}

    # 全量数据集留在会话，run_code 免二次读取（读失败已在回执披露）
    global _session_project, _session_datasets, _last_outputs
    _session_project, _session_datasets, _last_outputs = project, datasets, None

    scenario = request.get("scenario")
    inferred = None if scenario else (
        "medical" if "medical" in project.name.lower()
        else "rbqm" if "rbqm" in project.name.lower()
        else "manual"
    )
    return {"ok": True, "action": "listing-inspect", "inspection": {
        "documents": documents,
        "datasets": dataset_payloads(datasets, sources, with_sample=not interception),
        "failures": [*spec_failures, *failures],
        "scenario": scenario,
        "inferredScenario": inferred,
        "dataInterception": interception,
    }}


# ---------------------------------------------------------------------------
# listing_run_code：sandbox 内 AI 操作（不出域，stdout 原样）
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


def _ensure_session(project: Path, credential: Optional[str], extensions: Optional[set[str]] = None) -> Optional[dict]:
    """会话未命中当前项目时全量收集；读失败 fail-closed（返回错误回执）。"""
    global _session_project, _session_datasets, _last_outputs
    if _session_project == project:
        return None
    try:
        datasets, failures, _ = load_datasets(project, credential, extensions)
    except ValueError as exc:
        return {"ok": False, "code": "DATASET_NAME_CONFLICT", "reason": DataStr(str(exc))}
    if failures:
        return {"ok": False, "code": "DATASET_LOAD_FAILED",
                "reason": DataStr("一个或多个数据源加载失败"), "failures": failures}
    _session_project, _session_datasets, _last_outputs = project, datasets, None
    return None


def operation_run_code(request: dict) -> dict:
    project = Path(request["project"]).resolve()
    error = _ensure_session(project, request.get("credentialRef"), _request_extensions(request))
    if error is not None:
        return error

    result = run_sandbox_code(request["code"], project, _session_datasets)
    # content 类构造点（车道规则）：stdout/stderr/reason/traceback/
    # environmentHint 是 AI 可控回显面，恒包 DataStr 进遮蔽通道。
    stdout = DataStr(result["stdout"][:MAX_CAPTURE_CHARS])
    stderr = DataStr(result["stderr"][:MAX_CAPTURE_CHARS])
    truncated_flags = {
        "stdoutTruncated": bool(result.get("stdoutTruncated")),
        "stderrTruncated": bool(result.get("stderrTruncated")),
    }
    if not result["ok"]:
        return {"ok": False, "code": "CODE_EXECUTION_ERROR", "reason": DataStr(result["error"]),
                "retryable": True, "stdout": stdout, "stderr": stderr,
                "environmentHint": DataStr(ENVIRONMENT_HINT), **truncated_flags}

    environment = result["environment"]
    if "outputs" not in environment:
        return {"ok": False, "code": "OUTPUTS_REQUIRED",
                "reason": DataStr("代码必须定义 outputs: dict[str, pandas.DataFrame]"),
                "stdout": stdout, "stderr": stderr,
                "environmentHint": DataStr(ENVIRONMENT_HINT), **truncated_flags}
    try:
        outputs = normalize_outputs(environment["outputs"])
    except ValueError as exc:
        return {"ok": False, "code": "INVALID_OUTPUTS", "reason": DataStr(str(exc)),
                "retryable": True, "stdout": stdout, "stderr": stderr,
                "environmentHint": DataStr(ENVIRONMENT_HINT), **truncated_flags}

    global _last_outputs
    _last_outputs = outputs
    metadata = {
        _display_name(name): {"rowCount": len(frame), "columns": [
            {"name": _display_name(column), "dtype": str(frame[column].dtype),
             "nullCount": int(frame[column].isna().sum())}
            for column in frame.columns
        ]}
        for name, frame in outputs.items()
    }
    return {"ok": True, "action": "listing-run-code", "receipt": {
        "outputCount": len(outputs),
        "outputs": metadata,
        "publishReady": True,
        "stdout": stdout,
        "stderr": stderr,
        **truncated_flags,
    }}


# ---------------------------------------------------------------------------
# listing_publish：输出结构指纹（产物是 Excel，不回流 AI）
# ---------------------------------------------------------------------------

def operation_publish(request: dict) -> dict:
    if _last_outputs is None:
        return {"ok": False, "code": "NO_SUCCESSFUL_RUN",
                "reason": DataStr("publish 前必须成功执行 run_code")}
    project = Path(request["project"]).resolve()
    if _session_project != project:
        return {"ok": False, "code": "PROJECT_SESSION_MISMATCH",
                "reason": DataStr("项目与当前会话不一致")}
    scenario = request.get("scenario", "manual")
    output = project / ".clinical-listing" / "output" / scenario / f"{scenario.upper()}_LISTINGS.xlsx"
    try:
        statistics = create_multi_sheet_excel(
            _last_outputs, output, scenario,
            track_changes=request.get("trackChanges", True),
            cover_labels=request.get("coverLabels"))
        return {"ok": True, "action": "listing-publish", "receipt": {
            "outputFile": output.relative_to(project).as_posix(),
            "scenario": scenario, "dataClass": "REAL",
            "format": "single-workbook-multi-sheet-xlsx", "statistics": statistics}}
    except Exception as exc:
        return {"ok": False, "code": "PUBLISH_ERROR", "reason": DataStr(f"发布失败: {exc}"),
                "traceback": DataStr(traceback.format_exc())}


# ---------------------------------------------------------------------------
# 调度：三操作 → 统一拦截出口 → 审计
# ---------------------------------------------------------------------------

def dispatch(request: dict) -> dict:
    operation = request.get("operation")
    if operation == "listing_inspect":
        response = operation_inspect(request)
    elif operation == "listing_run_code":
        response = operation_run_code(request)
    elif operation == "listing_publish":
        response = operation_publish(request)
    else:
        response = {"ok": False, "code": "UNKNOWN_OPERATION",
                    "reason": DataStr(f"未知操作: {operation}")}

    interception = _interception_flag(request)
    projections: list = []
    response = sanitize_receipt(response, interception, audit=projections)
    mask_audit: dict = {}
    if interception:
        response = mask_receipt_strings(response, _value_mask_matcher(), audit=mask_audit)
    record = audit_record(operation, interception, projections,
                          masked_count=mask_audit.get("maskedCount", 0))
    if record is not None and isinstance(request.get("project"), str):
        try:
            _write_audit(Path(request["project"]).resolve(), record)
        except Exception:
            pass
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
        request: Optional[dict] = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError(f"请求必须是 JSON 对象: {type(request).__name__}")
            response = dispatch(request)
        except Exception as exc:
            response = {"ok": False, "code": "WORKER_ERROR", "reason": DataStr(str(exc)),
                        "traceback": DataStr(traceback.format_exc())}
            # FR-8 关键旁路：兜底回执（reason/traceback 可能带数据集值，
            # 如 dataset_payloads 抛错的 traceback）同样必须遮蔽后才能出域。
            # 请求不可解析或非对象（无旗标可读）→ fail-closed 按开处理。
            if not isinstance(request, dict) or _interception_flag(request):
                response = mask_receipt_strings(response, _value_mask_matcher())
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
