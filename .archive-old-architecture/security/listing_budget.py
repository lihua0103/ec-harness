"""Listing execute 的存在性预言机预算（审计发现 F-4）。

## 威胁模型

execute 收据回传过滤后的 rowCount。真实数据值本身永不出域（validator 只放行
结构化关系运算，executor 只回传计数），但模型可以提交
`filter: COLUMN eq literal("张三")` 并从 rowCount 是否为 0 读出 1 bit：
"该值是否存在于该列"。反复提交不同 literal 即可把患者级成员关系逐位问出来，
且此前次数无上限、无任何记录。

## 处置决策（2026-08-22，用户裁决）

接受该通道并配限频 + 审计计数，不对 rowCount 分桶——临床交付物需要真实行数，
分桶会破坏收据可读性和产物核对。因此：

- 每会话每项目的 execute 次数设上限；超限 fail-closed 拒绝并给出结构化原因。
- 每次 execute 都写审计记录（会话、项目、场景、计划指纹、本次序号）。
  审计只记录结构性元数据，不记录 literal 值本身——记录 literal 等于把
  推断出的数据值抄进审计文件，反而扩大出域面。

预算是进程内状态：worker 是长驻单进程，会话级计数在其生命周期内有效。
worker 重启会重置计数，但审计记录持久化，异常频次在事后可查。
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Any

from security.audit_log import write_audit_record

# 历史默认值只保留为审计基线，不再作为硬拒阈值。存在性预言机风险由持续
# 记账提供可观测性，不能以耗尽预算永久锁死 AI 的本地迭代。
DEFAULT_MAX_EXECUTIONS = 50

_counters: dict[tuple[str, str], int] = {}


def _audit_dir() -> str:
    package_root = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
    return os.environ.get("EMERALD_AUDIT_ROOT") or os.path.join(
        package_root, "var", "ai_ops_audit"
    )


def _max_executions() -> int:
    raw = os.environ.get("EMERALD_LISTING_MAX_EXECUTIONS")
    if not raw:
        return DEFAULT_MAX_EXECUTIONS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_EXECUTIONS
    return value if value > 0 else DEFAULT_MAX_EXECUTIONS


def plan_fingerprint(plan: dict[str, Any]) -> str:
    """计划的结构指纹。

    只对规范化后的计划结构取摘要。指纹不可逆，因此即使计划里含模型提交的
    literal 阈值，审计记录也不会泄露其原文；同时反复提交同一计划可被识别。
    """
    material = json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def reset_budget(session_id: str | None = None, project: str | None = None) -> None:
    """清空计数。仅供测试与 worker 重启使用。"""
    if session_id is None or project is None:
        _counters.clear()
        return
    _counters.pop((session_id, project), None)


# 单会话单项目的代码车道 run 次数上限。run 只回聚合元数据信封，迭代需要
# 比 execute 更多的次数；仍远低于逐位穷举存在性预言机所需量级。
DEFAULT_MAX_CODE_RUNS = 200

_run_counters: dict[tuple[str, str], int] = {}


def code_fingerprint(code: str) -> str:
    """代码的结构指纹：不可逆摘要，审计不落代码原文与 literal。"""
    return hashlib.sha256(str(code).encode("utf-8")).hexdigest()[:16]


def charge_code_run(*, session_id: str, project: str, scenario: str, code: str) -> int:
    """记账一次代码车道 run，超过阈值时记录告警但继续执行。"""
    key = (session_id or "unknown-session", project or "")
    raw = os.environ.get("EMERALD_LISTING_MAX_CODE_RUNS")
    limit = DEFAULT_MAX_CODE_RUNS
    if raw:
        try:
            parsed = int(raw)
        except ValueError:
            parsed = 0
        limit = parsed if parsed > 0 else DEFAULT_MAX_CODE_RUNS
    used = _run_counters.get(key, 0) + 1
    record = {
        "event": "listing_run_code",
        "sessionId": key[0],
        "project": key[1],
        "scenario": scenario,
        "codeFingerprint": code_fingerprint(code),
        "sequence": used,
        "limit": limit,
        "thresholdExceeded": used > limit,
        "allowed": True,
    }
    try:
        write_audit_record(_audit_dir(), "listing_ops", record)
    except OSError:
        pass
    _run_counters[key] = used
    return used


def reset_run_budget(session_id: str | None = None, project: str | None = None) -> None:
    """清空 run 计数。仅供测试与 worker 重启使用。"""
    if session_id is None or project is None:
        _run_counters.clear()
        return
    _run_counters.pop((session_id, project), None)


def charge_execution(
    *, session_id: str, project: str, scenario: str, plan: dict[str, Any],
) -> int:
    """记账一次 execute；超过阈值时记录告警但继续执行。"""
    key = (session_id or "unknown-session", project or "")
    limit = _max_executions()
    used = _counters.get(key, 0) + 1
    fingerprint = plan_fingerprint(plan)
    record = {
        "event": "listing_execute",
        "sessionId": key[0],
        "project": key[1],
        "scenario": scenario,
        "planFingerprint": fingerprint,
        "sequence": used,
        "limit": limit,
        "outputCount": len(plan.get("outputs", [])),
        "filterCount": sum(len(item.get("filters", [])) for item in plan.get("outputs", [])),
        "thresholdExceeded": used > limit,
        "allowed": True,
    }
    try:
        write_audit_record(_audit_dir(), "listing_ops", record)
    except OSError:
        # 审计不可写不能让已授权的临床交付静默失败；计数仍然生效。
        pass
    _counters[key] = used
    return used
