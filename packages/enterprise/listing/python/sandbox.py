"""Sandbox 层:标准 Python 执行环境 + stdout 捕获上限(ADR-0009 出域单点)。

2026-08-28 用户终裁(ADR-0009):**任何一层都不限制 harness AI 的代码执行面**。
唯一恒定红线 = 数据集行值不出域——那由 data_guard.sanitize_receipt 在回执
出口投影,不在执行层设卡。因此本模块不再维护 builtins 白名单、AST 禁用表、
GuardedModule 运行时护栏与 import 白名单(ADR-0008 形态随本决策退役,历史
与风险登记见 SECURITY_SCAN_20260828.md §六):

- 代码以**标准 Python** 执行:open/eval/exec/getattr 与 import os/sys 等
  全部可用,pd/np 以裸模块进入命名空间(datasets 已注入,read_*/to_*
  各取所需);
- ``list_files``/``scan_excel_structures`` 仍是限项目根的便利助手
  (../ 越界即错)——这是助手的自带围栏而非执行限制,模型可用 open/os
  自行处理任意路径;
- 残余边界按非对抗威胁模型显式接受(ADR-0009 §风险登记):R-1 无限制
  执行的宿主破坏面、R-2 stdout 打印行值、R-3 网络出域。

保留的机械护栏均与执行面无关(回执/健壮性域):stdout/stderr 捕获 1MB
上限(V-7a,触限不停执行,只标记 truncated);失败回执附
ENVIRONMENT_HINT(信息供给,免试错探环境)。
"""
import math
import os
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

from discovery import list_files, scan_excel_structures


def _confined(project: Path, relpath: str) -> Path:
    """把相对路径限制在项目根内;越界(../ 穿越 / 绝对路径逃逸)即抛错。"""
    root = Path(project).resolve()
    target = (root / relpath).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"ESCAPE_PROJECT_ROOT: {relpath!r}")
    return target


def build_environment(project: Path, datasets: dict[str, pd.DataFrame]) -> dict[str, Any]:
    """构建 sandbox 命名空间:**标准 builtins**(exec 对不含 ``__builtins__``
    的 globals 自动注入真 builtins 与真 ``__import__``)+ 会话数据集 +
    便利助手。``rng``/``datetime``/``json`` 为预置便利(不依赖白名单,
    import 亦可自取)。``tag_dataframe`` 不在此暴露(源头标记不可由模型
    重贴,审计 P1-1)。"""
    import datetime as datetime_module
    import json as json_module
    return {
        "datasets": datasets,
        "pd": pd, "np": np, "math": math,
        "rng": np.random.default_rng(),
        "datetime": datetime_module, "json": json_module,
        "list_files": lambda subdir="": list_files(_confined(project, subdir), ""),
        "scan_excel_structures": lambda relpath="": scan_excel_structures(_confined(project, relpath)),
    }


#: 环境自描述(信息供给:失败回执附带,模型一次读明,不再试错探环境)。
ENVIRONMENT_HINT = (
    "命名空间: datasets(会话数据集 dict), pd, np, math, rng(采样 Generator), "
    "datetime, json, list_files(subdir), scan_excel_structures(relpath), outputs(须自行定义)。"
    "标准 Python 全量可用(import os/sys、open、eval 等不受限,ADR-0009 执行面放开;"
    "文件路径建议限项目根内)。"
    "唯一红线:数据集行值不出域——run_code 回执只含 outputs 元数据"
    "(表名/列名/dtype/行数),行值只存在于本会话进程内,交付一律走 publish"
    "(自动格式化);stdout 原样回显,请勿 print 行值(纪律);doc/ 全量可读。"
)


#: 捕获流上限(V-7a,健壮性):执行继续不停,只是不再累积——防 print
#: 海量输出把 worker 内存打爆;触限在回执标记 truncated。
MAX_CAPTURE_STREAM_CHARS = 1_000_000


class _CappedCapture(StringIO):
    """带容量上限的捕获流:超限丢弃后续写入但返回正常长度(print 兼容)。"""

    def __init__(self) -> None:
        super().__init__()
        self._written = 0
        self.truncated = False

    def write(self, text: str) -> int:  # type: ignore[override]
        if self._written >= MAX_CAPTURE_STREAM_CHARS:
            self.truncated = True
            return len(text)
        self._written += len(text)
        if self._written > MAX_CAPTURE_STREAM_CHARS:
            self.truncated = True   # 单次写入越限(fd 合并通道整块并入):首越限内容保留,标记 truncated
        return super().write(text)


def _merge_fd_capture(capture: _CappedCapture, stream) -> None:
    """fd 通道捕获并入捕获流(A-15b:子进程/直写 fd1、fd2 的输出)。

    读出量按上限的 4 倍字节预留(utf-8 单字符至多 4 字节,越限必被捕获流
    上限接管并标记 truncated);子进程输出编码不受控,utf-8 解码失败的
    尾部字节以替换符呈现,不让解码错误炸掉回执。
    """
    stream.seek(0)
    raw = stream.read(MAX_CAPTURE_STREAM_CHARS * 4 + 1)
    if raw:
        capture.write(raw.decode("utf-8", errors="replace"))


def run_sandbox_code(
    code: str, project: Path, datasets: dict[str, pd.DataFrame],
) -> dict[str, Any]:
    """执行模型代码;返回执行结果与原样 stdout/stderr。

    不做任何执行面检查(ADR-0009 出域单点):行值出域的控制点在回执出口
    (worker/data_guard.sanitize_receipt 投影),不在本层。不吞异常:
    ok=False 时 error 带异常摘要,stdout/stderr 仍然原样带回。

    fd 级捕获(A-15b,2026-08-29):redirect_stdout 只替换 sys.stdout 对象,
    不动文件描述符——子进程(继承 fd1/fd2)与直写 fd 的输出会原样进入
    worker 的 NDJSON 协议管道,零遮蔽且破坏单行协议。因此执行期间把
    fd1/fd2 dup2 到临时文件(Windows 下 dup2/TemporaryFile 均可用),
    Python print(StringIO)与子进程输出全部落入捕获流,统一经回执出口
    遮蔽;fd 恢复在 finally 无条件先于读捕获与任何协议响应写出完成。
    """
    capture_out, capture_err = _CappedCapture(), _CappedCapture()
    environment = build_environment(project, datasets)
    exec_error: Optional[str] = None
    with tempfile.TemporaryFile() as fd_out, tempfile.TemporaryFile() as fd_err:
        saved_out, saved_err = os.dup(1), os.dup(2)
        try:
            os.dup2(fd_out.fileno(), 1)
            os.dup2(fd_err.fileno(), 2)
            try:
                with redirect_stdout(capture_out), redirect_stderr(capture_err):
                    exec(compile(code, "<listing-code>", "exec"), environment)  # noqa: S102 - 出域单点:执行面不设卡,红线在回执出口
            except Exception as exc:
                exec_error = f"代码执行失败: {exc}"
            finally:
                os.dup2(saved_out, 1)   # 恢复必须先于任何协议响应写出(A-15b 注记①)
                os.dup2(saved_err, 2)
        finally:
            os.close(saved_out)
            os.close(saved_err)
        _merge_fd_capture(capture_out, fd_out)
        _merge_fd_capture(capture_err, fd_err)
    if exec_error is not None:
        return {
            "ok": False, "environment": environment, "error": exec_error,
            "stdout": capture_out.getvalue(), "stderr": capture_err.getvalue(),
            "stdoutTruncated": capture_out.truncated, "stderrTruncated": capture_err.truncated,
        }
    return {
        "ok": True, "environment": environment, "error": None,
        "stdout": capture_out.getvalue(), "stderr": capture_err.getvalue(),
        "stdoutTruncated": capture_out.truncated, "stderrTruncated": capture_err.truncated,
    }
