"""AI 代码车道的静态能力沙箱（2026-08-24 架构重设计）。

安全模型（用户裁决的红线口径）：
- doc/ 内规格文本允许进模型；SAS 行级数据与 doc/ 外真实数据文件绝不进模型。
- 模型全权编写 pandas 变换代码；本地以**白名单 AST + 受限运行时 + 子进程隔离**
  执行，显式出域通道（网络 / 文件读写 / 进程 / 回程值）构造性归零：
  - 无 import 能力（模块只经注入提供：pd / np / math / datasets）
  - 无 ``open`` / ``__import__`` / ``eval`` / ``exec``（受限 builtins 根本不含）
  - 私有与双下划线属性/名称全部禁用（杀 ``__globals__`` / ``__class__`` 反射链）
  - pandas/numpy 的文件与序列化 IO 方法按名禁用（read_* / to_* / load / save）
  - 子进程超时可杀，崩溃不伤 worker
- 回程只允许聚合元数据信封（行数 / 列名 / dtype / 空值计数）；列名与错误文本
  是仅有的字符串通道，出信封前必须 scrub（见 listing_code_lane）。
- 聚合统计侧信道（存在性预言机）沿用 IR 车道 F-4 处置：限频 + 审计。

本模块只在受信父进程内使用；子进程入口见 sandbox_runner。
"""
from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

# 子进程以包根为 cwd（`-m security.sandbox_runner` 的导入根），不依赖父进程 cwd。
_PACKAGE_ROOT = str(Path(__file__).resolve().parents[1])

class SandboxViolation(ValueError):
    """模型安全的沙箱拒绝原因（不含任何本地路径或数据值）。"""

    def __init__(self, message: str, code: str = "SANDBOX_CODE_REJECTED") -> None:
        super().__init__(message)
        self.code = code


# 语法层整体禁用的节点：导入、作用域逃逸、异步（沙箱内无事件循环）。
_BLOCKED_NODES = (
    ast.Import,
    ast.ImportFrom,
    ast.Global,
    ast.Nonlocal,
    ast.AsyncFunctionDef,
    ast.AsyncFor,
    ast.AsyncWith,
    ast.Await,
)

# 按调用名禁用：文件 / 序列化 IO、动态执行、系统调用。按属性名匹配同时覆盖
# pd.read_csv、df.to_pickle、np.load、series.to_csv 等任意接收者形态。
#
# 原则：只拦截跨进程边界或破坏沙箱完整性的调用。子进程内存内的数据转换
#（to_dict / to_numpy / tolist 等）结果留在子进程内存，出域由信封收口，
# 不在此层拦截。该集合保护本地执行隔离，不受模型出域开关影响。
_BLOCKED_CALLS = frozenset({
    # pandas / numpy 文件与库 IO（读取）
    "read_csv", "read_excel", "read_sas", "read_sql", "read_sql_query", "read_sql_table",
    "read_table", "read_parquet", "read_feather", "read_orc", "read_pickle", "read_html",
    "read_json", "read_spss", "read_stata", "read_hdf", "read_clipboard", "read_gbq",
    # pandas / numpy 文件与库 IO（写入）
    "to_csv", "to_excel", "to_sql", "to_parquet", "to_pickle", "to_hdf", "to_feather",
    "to_orc", "to_gbq", "ExcelWriter", "ExcelFile", "HDFStore",
    "load", "save", "savez", "savez_compressed", "savefile",
    "fromfile", "fromregex", "loadtxt", "genfromtxt",
    # 动态执行（pd.eval / df.eval / df.query 走表达式引擎）
    "eval", "exec", "compile", "query",
    # 系统
    "system", "popen", "spawn", "spawnl", "spawnv", "startfile", "open",
    # 序列化到文件
    "dump",
})


def check_code(source: Any) -> ast.Module:
    """白名单 AST 校验；违规抛 SandboxViolation（fail closed）。

    本地执行隔离始终生效，与模型出域拦截开关相互独立。
    """
    if not isinstance(source, str) or not source.strip():
        raise SandboxViolation("code is empty")
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        location = f"line {exc.lineno or 0}, column {exc.offset or 0}"
        raise SandboxViolation(
            f"SyntaxError at {location}: {exc.msg}", code="SANDBOX_SYNTAX_ERROR") from exc
    except ValueError as exc:
        raise SandboxViolation(f"code could not be parsed: {exc}") from exc
    for node in ast.walk(tree):
        if isinstance(node, _BLOCKED_NODES):
            raise SandboxViolation(
                f"{type(node).__name__} is not allowed inside the sandbox")
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_"):
                raise SandboxViolation(
                    f"attribute '{node.attr}' is not allowed inside the sandbox")
        elif isinstance(node, ast.Name):
            # `_` 是惯例占位名，放行；其余下划线开头一律拒绝（含 __builtins__）。
            if node.id.startswith("_") and node.id != "_":
                raise SandboxViolation(
                    f"name '{node.id}' is not allowed inside the sandbox")
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr in _BLOCKED_CALLS:
                raise SandboxViolation(
                    f"'{func.attr}' is not allowed inside the sandbox")
            if isinstance(func, ast.Name) and func.id in _BLOCKED_CALLS:
                raise SandboxViolation(
                    f"'{func.id}' is not allowed inside the sandbox")
    return tree


def safe_builtins() -> dict[str, Any]:
    """受限 builtins：纯计算与容器构造，无 IO / 反射 / 动态执行。"""
    import builtins as _builtins

    allowed = (
        "abs", "all", "any", "bool", "bytes", "callable", "chr", "dict", "divmod",
        "enumerate", "filter", "float", "format", "frozenset", "hash", "int",
        "isinstance", "iter", "len", "list", "map", "max", "min", "next", "ord",
        "pow", "range", "repr", "reversed", "round", "set", "sorted", "str", "sum",
        "tuple", "zip",
    )
    return {name: getattr(_builtins, name) for name in allowed}


def build_namespace(datasets: Any) -> dict[str, Any]:
    """构造受限执行命名空间；只暴露注入能力，不给 import 通道。"""
    import math

    import numpy as np
    import pandas as pd

    return {
        "__builtins__": safe_builtins(),
        "pd": pd,
        "np": np,
        "math": math,
        "datasets": datasets,
    }


def run_sandbox(
    *,
    code: str,
    files: dict[str, str],
    mode: str = "run",
    timeout_seconds: float = 300.0,
    staging: str | None = None,
    review_columns: list[str] | None = None,
    contents_sheet_name: str = "Contents",
    scenario: str = "listing",
    allowed_data_dirs: list[str] | None = None,
) -> dict[str, Any]:
    """在隔离子进程中执行模型代码并取回结构化结果。

    P0-2 Fix: 添加 allowed_data_dirs 参数，限制沙盒只能读取指定目录下的数据文件。

    结果只可能是：
    - run 模式：聚合元数据信封（无任何单元格值）
    - publish 模式：固定 Writer 落盘后的 artifact 元数据
    - error：类型名 + 截断脱敏消息（父层还会再 scrub 一道）
    子进程崩溃 / 超时一律收敛为结构化 error，绝不让原始 traceback 出域。
    """
    check_code(code)
    job = {
        "mode": mode,
        "code": code,
        "datasets": files,
        "staging": staging,
        "reviewColumns": list(review_columns or []),
        "contentsSheetName": contents_sheet_name,
        "scenario": scenario,
    }
    # P0-FIX (RBQM run_code): 始终传递 allowedDataDirs，即使为 None。
    # 过去 `if allowed_data_dirs:` 会跳过空列表，导致 sandbox_runner 无法区分
    # "未配置"（安全拒绝）与"显式空列表"（调用方错误）。现在交由 sandbox_runner
    # 做最终防御性校验，拒绝空目录或空字符串。
    if allowed_data_dirs is not None:
        job["allowedDataDirs"] = allowed_data_dirs
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "security.sandbox_runner"],
            input=json.dumps(job, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            cwd=_PACKAGE_ROOT,
        )
    except subprocess.TimeoutExpired:
        return {
            "status": "error",
            "error": {
                "type": "SandboxTimeout",
                "message": f"sandbox execution exceeded {int(timeout_seconds)}s and was terminated",
            },
        }
    except OSError:
        return {
            "status": "error",
            "error": {
                "type": "SandboxUnavailable",
                "message": "the sandbox runner could not be started",
            },
        }
    result = _parse_runner_output(completed.stdout)
    if result is None:
        # stderr 可能携带列名级信息，绝不回传；只给结构化原因。
        return {
            "status": "error",
            "error": {
                "type": "SandboxCrashed",
                "message": "the sandbox runner did not return a structured result",
            },
        }
    return result


def _parse_runner_output(stdout: str) -> dict[str, Any] | None:
    for line in reversed(str(stdout or "").splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None
