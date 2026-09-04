"""Sandbox 层:标准 Python 执行环境 + stdout 捕获上限(ADR-0009 出域单点)。

2026-08-28 用户终裁(ADR-0009):**任何一层都不限制 harness AI 的代码执行面**。
数据安全开关开启时,红线 = 数据集行值与 doc 外辅助 Excel 单元格值不出域
——那由 data_guard.sanitize_receipt 与 worker 回执策略在出口处理,不在执行层设卡。
因此本模块不再维护 builtins 白名单、AST 禁用表、
GuardedModule 运行时护栏与 import 白名单(ADR-0008 形态随本决策退役,历史
与风险登记见 SECURITY_SCAN_20260828.md §六):

- 代码以**标准 Python** 执行:open/eval/exec/getattr 与 import os/sys 等
  全部可用,pd/np 以裸模块进入命名空间(datasets 已注入,read_*/to_*
  各取所需);
- ``list_files``/``scan_excel_structures`` 仍是限项目根的便利助手
  (../ 越界即错)——这是助手的自带围栏而非执行限制,模型可用 open/os
  自行处理任意路径;
- 残余边界按非对抗威胁模型显式接受(ADR-0009 §风险登记):R-1 无限制
执行的宿主破坏面、R-3 网络出域。数据安全开关开启时,stdout/stderr 由
worker 统一省略;关闭时由 worker 原样回执。

保留的机械护栏均与执行面无关(回执/健壮性域):stdout/stderr 捕获 1MB
上限(V-7a,触限不停执行,只标记 truncated);失败回执附
ENVIRONMENT_HINT(信息供给,免试错探环境)。
"""
import json
import math
import pickle
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

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


def build_environment(
    project: Path, datasets: dict[str, pd.DataFrame],
    documents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """构建 sandbox 命名空间:**标准 builtins**(exec 对不含 ``__builtins__``
    的 globals 自动注入真 builtins 与真 ``__import__``)+ 会话数据集 +
    便利助手。``rng``/``datetime``/``json`` 为预置便利(不依赖白名单,
    import 亦可自取)。``tag_dataframe`` 不在此暴露(源头标记不可由模型
    重贴,审计 P1-1)。"""
    import datetime as datetime_module
    import json as json_module
    documents = documents or []
    return {
        "datasets": datasets,
        "requirements": documents,
        "spec_documents": documents,
        "auxiliary_documents": [d for d in documents if d.get("_source") == "aux-excel"],
        "pd": pd, "np": np, "math": math,
        "rng": np.random.default_rng(),
        "datetime": datetime_module, "json": json_module,
        "list_files": lambda subdir="": list_files(_confined(project, subdir), ""),
        "scan_excel_structures": lambda relpath="": scan_excel_structures(_confined(project, relpath)),
    }


#: 环境自描述(信息供给:失败回执附带,模型一次读明,不再试错探环境)。
ENVIRONMENT_HINT = (
    "命名空间: datasets(会话数据集 dict), pd, np, math, rng(采样 Generator), "
    "datetime, json, requirements/spec_documents( inspect 的需求快照), auxiliary_documents(辅助表快照), "
    "list_files(subdir), scan_excel_structures(relpath), outputs(须自行定义)。"
    "标准 Python 全量可用(import os/sys、open、eval 等不受限,ADR-0009 执行面放开;"
    "文件路径建议限项目根内)。"
    "数据安全开关开启时:数据集行值与 doc 外辅助 Excel 单元格值不出域——run_code 回执只含"
    "输出数量/行数/列数/dtype/空值统计;行值只存在于本会话进程内,交付一律"
    "走 publish(自动格式化);数据安全开关开启时 stdout/stderr 不回流;doc/ 全目录由 inspect/read_document 全量读取。"
)


#: 捕获流上限(V-7a,健壮性):执行继续不停,只是不再累积——防 print
#: 海量输出把 worker 内存打爆;触限在回执标记 truncated。
MAX_CAPTURE_STREAM_CHARS = 1_000_000

#: runner 自杀上限:略小于宿主 listing 车道 900s 超时,让挂死的 runner
#: 先自终结并清掉临时目录,而不是等宿主 kill 后变孤儿(残留 PHI pickle)。
RUNNER_TIMEOUT_SECONDS = 840


def run_sandbox_code(
    code: str, project: Path, datasets: dict[str, pd.DataFrame],
    documents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """执行模型代码;捕获 stdout/stderr 供 Worker 判定状态。

    不做任何执行面检查(ADR-0009/0010):行值出域的控制点在回执出口
    (worker/data_guard.sanitize_receipt 投影),不在本层。不吞异常;worker
    在开关开启时把动态异常文本与流内容留在进程内,关闭时原样回执。
    """
    runner = Path(__file__).with_name("code_runner.py")
    with tempfile.TemporaryDirectory(prefix="dsh-listing-") as temp_dir:
        request_path = Path(temp_dir) / "request.pkl"
        result_path = Path(temp_dir) / "result.json"
        with request_path.open("wb") as handle:
            pickle.dump({"code": code, "project": str(project), "datasets": datasets, "documents": documents or []}, handle)
        # stdin=DEVNULL:runner 若继承 worker stdin,模型代码里一句 input()
        # 会吃掉 NDJSON 协议行,宿主请求就此悬死直到超时并被整会话处决。
        try:
            completed = subprocess.run(
                [sys.executable, str(runner), str(request_path), str(result_path)],
                cwd=str(project), capture_output=True, stdin=subprocess.DEVNULL,
                text=True, encoding="utf-8", errors="replace", check=False,
                timeout=RUNNER_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "isolated runner timed out", "stdout": "", "stderr": "",
                    "stdoutTruncated": False, "stderrTruncated": False}
        if completed.returncode != 0 or not result_path.is_file():
            return {"ok": False, "error": "isolated runner exited unexpectedly", "stdout": "",
                    "stderr": completed.stderr[-16_384:], "stdoutTruncated": False, "stderrTruncated": False}
        try:
            return json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"ok": False, "error": "invalid isolated runner result", "stdout": "", "stderr": "",
                    "stdoutTruncated": False, "stderrTruncated": False}
