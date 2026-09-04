"""在独立进程中执行不可信 Listing 代码，并只通过 JSON 返回结果。"""
import datetime as datetime_module
import json
import pickle
import sys
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from sandbox import MAX_CAPTURE_STREAM_CHARS, build_environment

class _CappedCapture(StringIO):
    def __init__(self) -> None:
        super().__init__()
        self._written = 0
        self.truncated = False

    def write(self, text: str) -> int:  # type: ignore[override]
        if self._written >= MAX_CAPTURE_STREAM_CHARS:
            self.truncated = True
            return len(text)
        remaining = MAX_CAPTURE_STREAM_CHARS - self._written
        super().write(text[:remaining])
        self._written += min(len(text), remaining)
        if len(text) > remaining:
            self.truncated = True
        return len(text)

def _json_value(value: Any) -> Any:
    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, np.generic):
        return _json_value(value.item())
    if isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if np.isfinite(value) else None
    if isinstance(value, (pd.Timestamp, datetime_module.datetime)):
        return {"$type": "datetime", "value": value.isoformat()}
    if isinstance(value, datetime_module.date):
        return {"$type": "date", "value": value.isoformat()}
    if isinstance(value, (pd.Timedelta, datetime_module.timedelta)):
        return {"$type": "timedelta", "value": value.total_seconds()}
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return str(value)

# ``_source`` 源头标记只能由 worker 侧 setdefault 供给（model-output），
# 不接受模型代码重贴——否则未来任何按 _source 分支的出口都会被伪造
# （审计"源头标记不可由模型重贴"不变量）。
_ALLOWED_ATTR_KEYS = ("labels", "report_metadata", "_layout", "_skip_default_template")

def _encode_outputs(value: Any) -> tuple[list[dict[str, Any]] | None, str | None]:
    if not isinstance(value, dict) or not value:
        return None, "outputs 必须是非空字典"
    encoded: list[dict[str, Any]] = []
    for name, frame in value.items():
        if not isinstance(name, str) or not name.strip():
            return None, "outputs 键必须是非空字符串"
        if not isinstance(frame, pd.DataFrame):
            return None, f"outputs[{name!r}] 不是 DataFrame"
        encoded.append({
            "name": name,
            "columns": [str(column) for column in frame.columns],
            "records": [[_json_value(cell) for cell in row] for row in frame.itertuples(index=False, name=None)],
            "attrs": {key: _json_value(frame.attrs[key]) for key in _ALLOWED_ATTR_KEYS if key in frame.attrs},
        })
    return encoded, None

def main() -> None:
    request_path, result_path = Path(sys.argv[1]), Path(sys.argv[2])
    with request_path.open("rb") as handle:
        request = pickle.load(handle)
    environment = build_environment(Path(request["project"]), request["datasets"], request.get("documents", []))
    stdout, stderr = _CappedCapture(), _CappedCapture()
    result: dict[str, Any] = {"ok": True, "error": None}
    try:
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exec(compile(request["code"], "<listing-code>", "exec"), environment)  # noqa: S102
    except BaseException as exc:  # noqa: BLE001
        # 异常文本可能包含临床值；仅保留可证明为静态执行错误的消息。
        safe_error = None
        if isinstance(exc, ZeroDivisionError):
            safe_error = "division by zero"
        elif isinstance(exc, NameError):
            safe_error = str(exc)
        elif isinstance(exc, ValueError) and str(exc).startswith("ESCAPE_PROJECT_ROOT:"):
            safe_error = str(exc)
        elif isinstance(exc, SyntaxError):
            # 编译期错误：消息只含模型自己提交的源码行与行号——数据尚未
            # 进入执行，不可能携带任何数据集/辅助 Excel 值（实测暴露：
            # 大代码块无行号盲修不可行）。
            text = (exc.text or "").strip()
            safe_error = f"line {exc.lineno}: {exc.msg}" + (f": {text[:200]}" if text else "")
        result.update(ok=False, errorType=type(exc).__name__, error=safe_error)
    if result["ok"]:
        result["outputsDefined"] = "outputs" in environment
        if result["outputsDefined"]:
            outputs, error = _encode_outputs(environment["outputs"])
            if error is not None:
                result["outputsInvalid"] = error
            else:
                result["outputs"] = outputs
    result.update(stdout=stdout.getvalue(), stderr=stderr.getvalue(), stdoutTruncated=stdout.truncated, stderrTruncated=stderr.truncated)
    result_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

if __name__ == "__main__":
    main()