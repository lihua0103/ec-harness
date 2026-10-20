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

# 运行期异常类名白名单（方案 §7.2）：类名进入回执 errorType 前必须可信。
# 不用 __module__ 判定——exec 的 globals 无 __name__ 时自定义类 __module__
# 会落到 'builtins'（实测），模块名判断不可靠。显式内置名单：解释器固定
# 词表不含数据，可保留；其余（模型自定义类、三方库类）归并 ExecutionError。
_TRUSTED_ERROR_NAMES = frozenset({
    "ZeroDivisionError", "NameError", "UnboundLocalError", "ValueError",
    "TypeError", "KeyError", "IndexError", "LookupError", "AttributeError",
    "ImportError", "ModuleNotFoundError", "OSError", "FileNotFoundError",
    "PermissionError", "IsADirectoryError", "FileExistsError", "RuntimeError",
    "NotImplementedError", "MemoryError", "RecursionError", "TimeoutError",
    "StopIteration", "StopAsyncIteration", "GeneratorExit", "ArithmeticError",
    "OverflowError", "FloatingPointError", "UnicodeError", "UnicodeDecodeError",
    "UnicodeEncodeError", "SyntaxError", "IndentationError", "TabError",
    "EOFError", "AssertionError", "ReferenceError", "BufferError",
    "ConnectionError", "BrokenPipeError", "KeyboardInterrupt", "SystemExit",
})


def _trusted_error_type(exc: BaseException) -> str:
    name = type(exc).__name__
    if name == "JSONDecodeError":  # 常用库异常，类名稳定且不含数据
        return name
    return name if name in _TRUSTED_ERROR_NAMES else "ExecutionError"


def _safe_runtime_error(exc: BaseException) -> str | None:
    """运行期异常的**定点白名单**消息（方案 §7.2）：运行期异常文本可能
    嵌入数据值（eval 数据串的 NameError、按值取列的 KeyError 等），
    只放行可证明不含数据的固定消息。NameError 文本是模型自己代码里的
    符号名（修错最高频信号）；运行期 raise 的 SyntaxError 不再借"编译期
    安全"口径回流文本（编译/执行分离前的实洞）。"""
    if isinstance(exc, ZeroDivisionError):
        return "division by zero"
    if isinstance(exc, NameError):
        return str(exc)
    if isinstance(exc, ValueError) and str(exc).startswith("ESCAPE_PROJECT_ROOT:"):
        return str(exc)
    return None


def main() -> None:
    request_path, result_path = Path(sys.argv[1]), Path(sys.argv[2])
    with request_path.open("rb") as handle:
        request = pickle.load(handle)
    environment = build_environment(Path(request["project"]), request["datasets"], request.get("documents", []))
    stdout, stderr = _CappedCapture(), _CappedCapture()
    result: dict[str, Any] = {"ok": True, "error": None}
    # 编译/执行分离（方案 §7.2，2026-10-20 P0）：编译发生在未执行任何模型
    # 代码的可信阶段，SyntaxError 文本只含模型自己提交的源码行与行号——
    # 数据尚未进入执行，不可能携带数据集/辅助 Excel 值（实测暴露：大代码
    # 块无行号盲修不可行）。运行期错误走 _safe_runtime_error 白名单。
    code_object = None
    try:
        code_object = compile(request["code"], "<listing-code>", "exec")
    except SyntaxError as exc:
        text = (exc.text or "").strip()
        result.update(ok=False, stage="compile", errorType="SyntaxError",
                      error=f"line {exc.lineno}: {exc.msg}" + (f": {text[:200]}" if text else ""))
    except (ValueError, MemoryError, RecursionError) as exc:
        result.update(ok=False, stage="compile", errorType=_trusted_error_type(exc), error=None)
    if result["ok"] and code_object is not None:
        try:
            with redirect_stdout(stdout), redirect_stderr(stderr):
                exec(code_object, environment)  # noqa: S102
        except BaseException as exc:  # noqa: BLE001
            result.update(ok=False, stage="execute",
                          errorType=_trusted_error_type(exc), error=_safe_runtime_error(exc))
    # outputsDefined 是进程内可确认观察（environment 是否出现 outputs 键），
    # 成功与异常路径都如实上报；此前异常路径缺省被父端当 False，谎报诊断
    # 事实（方案 P0"修正 outputsDefined 等错误诊断事实"）。
    result["outputsDefined"] = "outputs" in environment
    if result["ok"] and result["outputsDefined"]:
        outputs, error = _encode_outputs(environment["outputs"])
        if error is not None:
            result["outputsInvalid"] = error
        else:
            result["outputs"] = outputs
    result.update(stdout=stdout.getvalue(), stderr=stderr.getvalue(), stdoutTruncated=stdout.truncated, stderrTruncated=stderr.truncated)
    result_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

if __name__ == "__main__":
    main()