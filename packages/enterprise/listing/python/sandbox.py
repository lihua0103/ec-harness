"""Sandbox 层：safe_builtins 白名单 + AST 禁用表 + 程序函数围栏 + stdout 捕获。

阻断的是**程序执行安全**，独立于数据拦截开关（ADR-0007 口径）——开关
关闭（零拦截）不解除这些阻断：

1. builtins 白名单：无 ``open``/``eval``/``exec``/``getattr`` 等（文件读写
   与动态取属性直接 NameError）；``__import__`` 是**白名单安全导入器**
   （FP-3）：numpy/pandas 家族（护栏包装）+ 纯计算标准库放行，其余拒绝。
   刻意不提供 getattr/setattr/vars/globals/locals——getattr 与 ``pd.__dict__``
   一样能按字符串取到 ``read_csv``，绕过 AST 属性禁用。
   常用异常类（Exception/ValueError/...）与 dir/repr/map/filter 已补齐——
   2026-08-28 实战反馈：过瘦的白名单把 AI 逼成"裸 except + 六连败试错"。
2. AST 禁用表（执行安全）：
   - 读取器按 ``read_`` 前缀阻断；写出器按枚举名单阻断（to_csv/to_excel/
     to_pickle 等，FP-1：to_datetime/to_list 等纯转换函数放行）；
   - 双下划线属性（``__dict__``/``__class__`` 等）整体阻断——防
     ``pd.__dict__['read_sas']`` 形态绕过前缀禁用；
   - 文件 IO 构造器按名阻断（ExcelFile/HDFStore/SAS7BDAT/loadtxt/
     genfromtxt/fromfile/load/save*/savetxt/memmap）——numpy 侧不吃
     read_ 前缀的补充封堵；
   - ``eval``/``query``/``exec``/``compile``/``breakpoint``/``__import__``
     名字阻断（比 NameError 给模型更明确的报错）。
3. 程序函数围栏：``list_files`` / ``scan_excel_structures`` 的路径一律
   限制在项目根内，``../`` 越界即抛错。

stdout/stderr **原样捕获回执**：sandbox 内 AI 操作不构成数据出域
（2026-08-27/28 裁决，显式接受的已知边界，见 ADR-0007 §残留风险）。
"""
import ast
import math
import types
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from discovery import list_files, scan_excel_structures

#: builtins 白名单：纯计算、内省（dir/repr）与异常类。
SANDBOX_BUILTINS: dict[str, Any] = {
    "len": len, "range": range, "enumerate": enumerate, "zip": zip,
    "list": list, "dict": dict, "set": set, "tuple": tuple, "frozenset": frozenset,
    "str": str, "bytes": bytes, "int": int, "float": float, "bool": bool,
    "min": min, "max": max, "sum": sum, "abs": abs, "round": round,
    "sorted": sorted, "any": any, "all": all,
    "isinstance": isinstance, "issubclass": issubclass, "hasattr": hasattr,
    "callable": callable, "type": type, "print": print,
    "dir": dir, "repr": repr, "hash": hash, "id": id,
    "iter": iter, "next": next, "map": map, "filter": filter, "reversed": reversed,
    "divmod": divmod, "pow": pow, "format": format, "chr": chr, "ord": ord,
    # 异常类：让模型写标准的 except ValueError，而不是被迫裸 except。
    "Exception": Exception, "BaseException": BaseException,
    "ValueError": ValueError, "TypeError": TypeError, "KeyError": KeyError,
    "IndexError": IndexError, "RuntimeError": RuntimeError,
    "StopIteration": StopIteration, "ZeroDivisionError": ZeroDivisionError,
    "ArithmeticError": ArithmeticError, "AttributeError": AttributeError,
    "AssertionError": AssertionError, "NotImplementedError": NotImplementedError,
    "OSError": OSError, "FileNotFoundError": FileNotFoundError, "Warning": Warning,
}
# 刻意不在白名单（并给出明确报错/NameError）：open eval exec compile
# getattr setattr delattr vars globals locals input breakpoint；
# __import__ 以 safe_import 形式在场（见下）。

#: AST 禁用表（执行安全,FP-1 修订）：读取器按 **read_ 前缀**阻断（read_*
#: 全部是真实文件/网络读取器,数据已注入沙箱,无合法需求,零误伤）；写出器
#: 改为**枚举**——一刀切 to_* 会误杀 to_datetime/to_numeric/to_list/
#: to_numpy/to_dict 等纯转换函数（2026-08-28 FP 复盘：pd.to_datetime 被
#: 拦会让正常清洗工作流直接断路）。升级 pandas 时核对新 to_ 写出器。
BLOCKED_ATTR_PREFIXES = ("read_",)
#: DataFrame/Series 的全部文件/IO 写出器（写出绕过 publish 唯一交付通道）。
IO_WRITER_METHODS = {
    "to_csv", "to_excel", "to_pickle", "to_sql", "to_hdf", "to_parquet",
    "to_feather", "to_stata", "to_msgpack", "to_gbq", "to_orc", "to_clipboard",
    "to_json", "to_xml", "to_latex", "to_html", "to_markdown", "to_spss",
}
BLOCKED_ATTR_NAMES = IO_WRITER_METHODS | {
    # 文件 IO 构造器（numpy/pandas 不吃 read_ 前缀的那批）
    "ExcelFile", "ExcelWriter", "HDFStore", "SAS7BDAT", "DataSource",
    "loadtxt", "genfromtxt", "fromfile", "fromregex",
    "load", "save", "savez", "savez_compressed", "savetxt", "memmap",
}
BLOCKED_NAMES = {"eval", "query", "exec", "compile", "breakpoint", "__import__"}

#: 运行时属性护栏（2026-08-28 漏洞扫描 V-2/V-3/V-4：AST 黑名单挡不住
#: "逐个属性都合法"的下钻链，实战已复现 pd.io.common.os.system RCE 与
#: np.lib.npyio.DataSource 任意读）。规则：
#: 1. 双下划线属性 → 拒绝；2. read_ 前缀与下列名字（含写出器）→ 拒绝；
#: 3. **一切 module 类型的属性 → 拒绝**（pd.io/np.lib/pd.compat 等内部
#:    子模块树是全部已知逃逸路径的公共入口）。采样经注入的 ``rng`` 走，
#:    不需要 np.random 模块本体。
RUNTIME_BLOCKED_ATTRS = BLOCKED_ATTR_NAMES | {
    "get_handle", "urlopen", "urlopener", "urlretrieve", "request",
    "system", "popen", "spawn", "spawnl", "spawnv", "startfile",
    "NamedTemporaryFile", "TemporaryFile", "mkdtemp", "mkstemp",
    "os", "sys", "subprocess", "builtins", "io",
}


class GuardedModule:
    """pd/np 的运行时护栏包装：AST 编译期检查之外的动态下钻防线。

    __slots__ + object.__setattr__ 防模型改写包装器本身；模块类型属性
    一律拒绝（子模块树即逃逸入口）。合法顶层 API（DataFrame/merge/
    array/...）原样透传，能力无损。
    """

    __slots__ = ("_module", "_label")

    def __init__(self, module: types.ModuleType, label: str) -> None:
        object.__setattr__(self, "_module", module)
        object.__setattr__(self, "_label", label)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise ValueError(f"沙箱运行时禁用双下划线属性: {self._label}.{name}")
        if name.startswith(BLOCKED_ATTR_PREFIXES) or name in RUNTIME_BLOCKED_ATTRS:
            raise ValueError(f"沙箱运行时禁用属性: {self._label}.{name}")
        value = getattr(object.__getattribute__(self, "_module"), name)
        if isinstance(value, types.ModuleType):
            raise ValueError(f"沙箱禁用子模块访问: {self._label}.{name}")
        return value


#: import 白名单（FP-3，2026-08-28 深夜）：纯计算标准库（无文件/网络面）。
#: numpy/pandas 家族按根前缀放行——numpy/pandas **自身的内部惰性导入**必须
#: 能过（实战复现：ndarray.sum() 经 C 层 PyImport_Import 取当前帧 builtins
#: 的 __import__ 导入 numpy._core._methods，缺失即 KeyError 让合法 API 断路）；
#: 返回值一律经 GuardedModule 把守（import pandas.io.common 照样进不了 os）。
IMPORTABLE_MODULES = {
    "json", "datetime", "math", "statistics", "re", "collections",
    "itertools", "functools", "decimal", "fractions", "random",
    "operator", "string", "textwrap", "numbers", "bisect", "heapq",
}
_GUARDED_IMPORT_ROOTS = {"numpy", "pandas"}
_REAL_IMPORT = __import__


def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    """沙箱 __import__：白名单放行 + numpy/pandas 家族护栏包装。"""
    if level:
        raise ImportError("沙箱不支持相对导入")
    root = name.split(".", 1)[0]
    if root in _GUARDED_IMPORT_ROOTS:
        module = _REAL_IMPORT(name, globals, locals, fromlist, level)
        return GuardedModule(module, name) if isinstance(module, types.ModuleType) else module
    if name in IMPORTABLE_MODULES or root in IMPORTABLE_MODULES:
        return _REAL_IMPORT(name, globals, locals, fromlist, level)
    raise ImportError(
        f"沙箱 import 白名单之外: {name!r}"
        f"（可用: numpy/pandas(护栏内) 与纯计算标准库 {sorted(IMPORTABLE_MODULES)}；"
        f"os/sys/subprocess/shutil/pathlib/socket 等不在内）")


#: 白名单导入器进 builtins：模型 import 语句与 C 层惰性导入共用此入口。
SANDBOX_BUILTINS["__import__"] = safe_import

def _confined(project: Path, relpath: str) -> Path:
    """把相对路径限制在项目根内；越界（../ 穿越 / 绝对路径逃逸）即抛错。"""
    root = Path(project).resolve()
    target = (root / relpath).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"ESCAPE_PROJECT_ROOT: {relpath!r}")
    return target


def assert_code_allowed(code: str) -> None:
    """AST 禁用表检查：read_* 前缀、写出器名单、双下划线属性、IO 构造器、
    禁用名字在编译期即拒绝（不给运行机会；纯转换函数不误伤，FP-1）。"""
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("__"):
                raise ValueError(f"沙箱禁用双下划线属性: .{node.attr}")
            if any(node.attr.startswith(prefix) for prefix in BLOCKED_ATTR_PREFIXES):
                raise ValueError(f"沙箱禁用属性访问: .{node.attr}()")
            if node.attr in BLOCKED_ATTR_NAMES:
                raise ValueError(f"沙箱禁用文件IO接口: .{node.attr}()")
        elif isinstance(node, ast.Name) and node.id in BLOCKED_NAMES:
            raise ValueError(f"沙箱禁用名字: {node.id}")


def build_environment(project: Path, datasets: dict[str, pd.DataFrame]) -> dict[str, Any]:
    """构建 sandbox 命名空间：受限 builtins + 会话数据集 + 围栏内程序函数。

    pd/np 经 GuardedModule 包装（运行时子模块/IO 面护栏）；``rng`` 是
    numpy Generator 实例（采样/种子能力恢复，模块本体不暴露——FP-2）；
    ``datetime``/``json`` 为纯计算标准库（无文件面）。``tag_dataframe``
    不在此暴露（审计 P1-1）。
    """
    import datetime as datetime_module
    import json as json_module
    return {
        "__builtins__": SANDBOX_BUILTINS,
        "datasets": datasets,
        "pd": GuardedModule(pd, "pd"), "np": GuardedModule(np, "np"), "math": math,
        "rng": np.random.default_rng(),
        "datetime": datetime_module, "json": json_module,
        "list_files": lambda subdir="": list_files(_confined(project, subdir), ""),
        "scan_excel_structures": lambda relpath="": scan_excel_structures(_confined(project, relpath)),
    }


#: 环境自描述（信息供给：失败回执附带，模型一次读明，不再试错探环境）。
ENVIRONMENT_HINT = (
    "命名空间: datasets(会话数据集 dict), pd, np, math, rng(采样 Generator), "
    "datetime, json, list_files(subdir), scan_excel_structures(relpath), outputs(须自行定义)。"
    "builtins 白名单含 dir/repr/map/filter 与 Exception/ValueError 等异常类；"
    "import 白名单: numpy/pandas(护栏内)+re/json/datetime/statistics/collections 等纯计算库;无 open/getattr/eval/exec。读取器(read_*)、写出器(to_csv/to_excel/"
    "to_pickle 等)、双下划线属性、文件 IO 构造器与子模块(pd.io/np.lib)被阻断——"
    "pd.to_datetime/to_numeric/to_list/to_numpy 等纯转换函数照常可用。"
    "stdout 原样回显;doc/ 全量可读;数据集行值不进回执。"
)


#: 捕获流上限（V-7a，健壮性）：执行继续不停，只是不再累积——防 print
#: 海量输出把 worker 内存打爆；触限在回执标记 truncated。
MAX_CAPTURE_STREAM_CHARS = 1_000_000


class _CappedCapture(StringIO):
    """带容量上限的捕获流：超限丢弃后续写入但返回正常长度（print 兼容）。"""

    def __init__(self) -> None:
        super().__init__()
        self._written = 0
        self.truncated = False

    def write(self, text: str) -> int:  # type: ignore[override]
        if self._written >= MAX_CAPTURE_STREAM_CHARS:
            self.truncated = True
            return len(text)
        self._written += len(text)
        return super().write(text)


def run_sandbox_code(
    code: str, project: Path, datasets: dict[str, pd.DataFrame],
) -> dict[str, Any]:
    """在受限命名空间 exec 代码；返回执行结果与原样 stdout/stderr。

    AST 禁用表在 exec 前检查（编译期拒绝，不给运行机会）。不吞异常：
    ok=False 时 error 带异常摘要，stdout/stderr 仍然原样带回。
    """
    capture_out, capture_err = _CappedCapture(), _CappedCapture()
    environment = build_environment(project, datasets)
    try:
        assert_code_allowed(code)
        with redirect_stdout(capture_out), redirect_stderr(capture_err):
            exec(compile(code, "<listing-code>", "exec"), environment)  # noqa: S102 - 沙箱白名单执行
    except Exception as exc:
        return {
            "ok": False, "environment": environment, "error": f"代码执行失败: {exc}",
            "stdout": capture_out.getvalue(), "stderr": capture_err.getvalue(),
            "stdoutTruncated": capture_out.truncated, "stderrTruncated": capture_err.truncated,
        }
    return {
        "ok": True, "environment": environment, "error": None,
        "stdout": capture_out.getvalue(), "stderr": capture_err.getvalue(),
        "stdoutTruncated": capture_out.truncated, "stderrTruncated": capture_err.truncated,
    }
