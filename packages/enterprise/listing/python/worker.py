"""Listing 持久 Worker：全量读取、sandbox 计算、数据拦截出口、唯一 Excel 发布。

数据流（2026-08-28 第三版口径，ADR-0007）：

    discovery（全量读 + 源头标注；doc/ 零拦截、恒全量）
      ↓
    sandbox(标准 Python 执行环境,ADR-0009 执行面全开;stdout 原样)
      ↓
    三操作各自产回执
      ↓
    data_guard.sanitize_receipt（唯一拦截出口：只投影 dataset 载荷；
    宿主开关 dataInterception=false 时零处理）
      ↓
    审计 JSONL（无数据值：时间/操作/开关态/被投影载荷的 source+path）
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
from source_registry import SOURCE_ATTR, DataSource

#: stdout/stderr 回执截断（防协议超限，不是数据红线）。
MAX_CAPTURE_CHARS = 16_384
#: 回执内名称显示上限（V-4,机械上限非内容判定:压缩"列名走私行值"隐蔽
#: 信道带宽;真实变量名远短于此,零误伤）。真实名称保留在会话/发布产物里。
MAX_RECEIPT_NAME_CHARS = 120


def _display_name(value: Any) -> str:
    text = str(value)
    if len(text) <= MAX_RECEIPT_NAME_CHARS:
        return text
    return text[:MAX_RECEIPT_NAME_CHARS - 1] + "…"

_session_project: Optional[Path] = None
_session_datasets: dict[str, pd.DataFrame] = {}
_last_outputs: Optional[dict[str, pd.DataFrame]] = None


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
        return {"ok": False, "code": "PROJECT_NOT_FOUND", "reason": f"项目目录不存在: {project}"}
    interception = _interception_flag(request)
    extensions = _request_extensions(request)
    try:
        # doc/ 零拦截（ADR-0007）：恒全量读，与开关无关
        documents, spec_failures = read_spec_files(project / "doc")
        datasets, failures, sources = load_datasets(project, request.get("credentialRef"), extensions)
    except ValueError as exc:
        return {"ok": False, "code": "DATASET_NAME_CONFLICT", "reason": str(exc)}

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
        return {"ok": False, "code": "DATASET_NAME_CONFLICT", "reason": str(exc)}
    if failures:
        return {"ok": False, "code": "DATASET_LOAD_FAILED",
                "reason": "一个或多个数据源加载失败", "failures": failures}
    _session_project, _session_datasets, _last_outputs = project, datasets, None
    return None


def operation_run_code(request: dict) -> dict:
    project = Path(request["project"]).resolve()
    error = _ensure_session(project, request.get("credentialRef"), _request_extensions(request))
    if error is not None:
        return error

    result = run_sandbox_code(request["code"], project, _session_datasets)
    stdout, stderr = result["stdout"][:MAX_CAPTURE_CHARS], result["stderr"][:MAX_CAPTURE_CHARS]
    truncated_flags = {
        "stdoutTruncated": bool(result.get("stdoutTruncated")),
        "stderrTruncated": bool(result.get("stderrTruncated")),
    }
    if not result["ok"]:
        return {"ok": False, "code": "CODE_EXECUTION_ERROR", "reason": result["error"],
                "retryable": True, "stdout": stdout, "stderr": stderr,
                "environmentHint": ENVIRONMENT_HINT, **truncated_flags}

    environment = result["environment"]
    if "outputs" not in environment:
        return {"ok": False, "code": "OUTPUTS_REQUIRED",
                "reason": "代码必须定义 outputs: dict[str, pandas.DataFrame]",
                "stdout": stdout, "stderr": stderr,
                "environmentHint": ENVIRONMENT_HINT, **truncated_flags}
    try:
        outputs = normalize_outputs(environment["outputs"])
    except ValueError as exc:
        return {"ok": False, "code": "INVALID_OUTPUTS", "reason": str(exc),
                "retryable": True, "stdout": stdout, "stderr": stderr,
                "environmentHint": ENVIRONMENT_HINT, **truncated_flags}

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
        return {"ok": False, "code": "NO_SUCCESSFUL_RUN", "reason": "publish 前必须成功执行 run_code"}
    project = Path(request["project"]).resolve()
    if _session_project != project:
        return {"ok": False, "code": "PROJECT_SESSION_MISMATCH", "reason": "项目与当前会话不一致"}
    scenario = request.get("scenario", "manual")
    output = project / ".clinical-listing" / "output" / scenario / f"{scenario.upper()}_LISTINGS.xlsx"
    try:
        statistics = create_multi_sheet_excel(
            _last_outputs, output, scenario,
            track_changes=request.get("trackChanges", True),
            cover_labels=request.get("coverLabels"))
        return {"ok": True, "action": "listing-publish", "receipt": {
            "outputFile": str(output.relative_to(project)),
            "scenario": scenario, "dataClass": "REAL",
            "format": "single-workbook-multi-sheet-xlsx", "statistics": statistics}}
    except Exception as exc:
        return {"ok": False, "code": "PUBLISH_ERROR", "reason": f"发布失败: {exc}",
                "traceback": traceback.format_exc()}


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
        response = {"ok": False, "code": "UNKNOWN_OPERATION", "reason": f"未知操作: {operation}"}

    interception = _interception_flag(request)
    projections: list = []
    response = sanitize_receipt(response, interception, audit=projections)
    record = audit_record(operation, interception, projections)
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
        try:
            response = dispatch(json.loads(line))
        except Exception as exc:
            response = {"ok": False, "code": "WORKER_ERROR", "reason": str(exc),
                        "traceback": traceback.format_exc()}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
