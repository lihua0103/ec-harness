"""DSH 临床数据守卫的常驻安全检查进程。

协议：每行一个 JSON 请求，每行一个 JSON 响应。进程只输出脱敏摘要，
任何导入或检查异常都转换为 fail-closed 响应，绝不放行未知故障。

FIX-3 (R-6 / AR-2.9): 所有异常回执经 sanitize_error 统一脱敏（路径→[PATH]、
受试者/日期→占位），绝不外泄 str(exc) 原文与本地路径。
FIX-6 (AR-2.6): 单行解析失败返回 SECURITY_UNAVAILABLE 并继续服务后续请求。
FIX-9 (BR-06.5): 上下文键名统一（camelCase/snake_case 均可消费）。
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

from security.egress_checkpoint import EgressViolation, check_egress_v2
from security.local_data_inspector import LocalDataInspectionError, inspect_local_data
from security.patterns import clean_surrogates, sanitize_error


def _result(ok: bool, **fields: Any) -> dict[str, Any]:
    return {"ok": ok, **fields}


# E-2（2026-08-22 e2e 审计）：worker 启动依赖预检清单，与 requirements.txt 对齐。
# 此前落在缺依赖解释器上的 worker 会在首个重操作时崩溃，traceback 写入已失效
# stderr 句柄产生 EBADF，以无语义方式杀掉整轮运行。启动即 fail-fast：
# stdout 输出一条结构化横幅并退出，Node 侧捕获后给出可行动诊断。
WORKER_REQUIRED_MODULES = ("pandas", "pyreadstat", "openpyxl", "xlrd", "pyzipper")


def missing_worker_dependencies(importer=None, stop_on_first: bool = False):
    """返回缺失的必需依赖名列表；全部齐备时为空列表。importer 可注入测试。

    stop_on_first=True 时命中首个缺失立即返回——预检线程据此第一时间发
    横幅退出，不等其余重依赖（pandas 等导入需秒级）完成。
    """
    import importlib

    import_module = importer or importlib.import_module
    missing: list[str] = []
    for name in WORKER_REQUIRED_MODULES:
        try:
            import_module(name)
        except ImportError as exc:
            missing.append(str(getattr(exc, "name", None) or name))
            if stop_on_first:
                break
    return missing


def _emit(response: dict[str, Any]) -> None:
    """安全写出响应行（真实故障修复：孤立代理字符）。

    DSH harness 的 JSON 可携带 \\udXXX 孤立代理（读 GBK 文件名等场景），
    直接 ensure_ascii=False 写 stdout 会抛 UnicodeEncodeError 杀死 worker，
    导致后续全部请求挂起。任何失败都不允许中断服务循环。
    """
    try:
        line = clean_surrogates(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
        sys.stdout.write(line + "\n")
    except UnicodeEncodeError:
        sys.stdout.write(json.dumps(
            {"ok": False, "code": "SECURITY_UNAVAILABLE",
             "reason": "response encoding failure", "requestId": response.get("requestId")},
            ensure_ascii=True,
        ) + "\n")
    sys.stdout.flush()


def _normalize_context(context: Any) -> dict[str, Any]:
    """FIX-9: Node 侧 camelCase 上下文键名统一为 Python 消费侧 snake_case。"""
    if not isinstance(context, dict):
        return {}
    normalized = dict(context)
    for camel, snake in (("sessionId", "session_id"), ("userId", "user_id")):
        if snake not in normalized or normalized.get(snake) in (None, ""):
            normalized[snake] = normalized.get(camel)
    return normalized


def _handle(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("operation")
    context = _normalize_context(request.get("context"))

    # 测试数据环境关闭时完全旁路；开启时只允许或阻断，不改写载荷。
    data_interception_enabled = context.get("dataInterceptionEnabled", True)

    if operation == "check_llm":
        # 数据拦截关闭时原样放行；开启时只允许或阻断，永不改写载荷。
        if not data_interception_enabled:
            payload = request.get("payload", {})
            return _result(True, action="allow", payload=payload)
        payload = request.get("payload", {})
        try:
            evidence = check_egress_v2(payload, context)
            return _result(True, action="allow", **evidence)
        except EgressViolation as exc:
            return _result(False, code="EGRESS_VIOLATION", audit_id=exc.audit_id,
                           threats=len(exc.threats))

    if operation == "inspect_local_data":
        # 2026-08-25: 开关关闭时本地元数据检查无条件可用（零限制）。
        if data_interception_enabled and context.get("localDataAccess") != "uat-local":
            return _result(
                False,
                code="LOCAL_DATA_ACCESS_REQUIRED",
                reason="this UAT task requires the explicit local metadata inspection lane",
            )
        try:
            metadata = inspect_local_data(
                str(context.get("localDataRoot") or ""),
                str(request.get("path") or ""),
            )
        except LocalDataInspectionError as exc:
            return _result(False, code="LOCAL_DATA_INSPECTION_DENIED", reason=str(exc))
        except Exception as exc:
            return _result(False, code="SECURITY_UNAVAILABLE", reason=sanitize_error(exc))
        return _result(True, action="local-metadata", metadata=metadata)

    # 2026-08-24 架构重设计（用户裁决）：IR 车道（listing_validate_plan /
    # listing_execute）退役，由代码车道（listing_run_code / listing_publish）替代。
    # 模型全权编写 pandas 代码；沙箱保证 SAS 行级数据与 doc/ 外数据零出域。
    if operation in {"listing_inspect", "listing_run_code", "listing_publish"}:
        # 2026-08-25: 流程引导（listing 家族）不受出域开关控制——inspect 读
        # spec/ALS/schema、run_code 迭代、publish 出 Excel 都是本地计算，是
        # 引导 AI 的主流程，开关只管"数据是否出域"。localDataAccess 门禁在
        # 开关关闭时不再适用：关闭即零限制，本地车道无条件可用。
        if not data_interception_enabled:
            pass
        elif context.get("localDataAccess") != "uat-local":
            return _result(False, code="LOCAL_DATA_ACCESS_REQUIRED",
                           reason="clinical listing requires uat-local mode")
        # E-1（2026-08-22 e2e 审计）：导入必须先于主 try 完成。此前 import 放在
        # try 内而 `except ListingWorkflowError:` 引用导入名——任何导入失败
        # （缺依赖/代码漂移）都会让 except 子句抛 UnboundLocalError，把真实的
        # ImportError 永久掩盖。导入失败单独回结构化收据，保留脱敏后的真因。
        try:
            from security.listing_code_lane import (
                publish_listing_code,
                run_listing_code,
            )
            from security.listing_workflow import ListingWorkflowError, inspect_listing
        except Exception as exc:
            return _result(False, code="LISTING_STACK_UNAVAILABLE",
                           reason=sanitize_error(exc))
        try:
            project = str(request.get("project") or "")
            raw_scenario = request.get("scenario")
            scenario = str(raw_scenario) if raw_scenario else None
            if operation == "listing_inspect":
                credential_ref = str(request.get("credentialRef") or "") or None
                credentials_dir = str(context.get("credentialsDir") or "") or None
                return _result(True, action="listing-inspect", inspection=inspect_listing(
                    local_data_root=str(context.get("localDataRoot") or ""),
                    project=project, scenario=scenario,
                    credential_ref=credential_ref, credentials_dir=credentials_dir,
                ))
            if operation == "listing_run_code":
                return _result(True, action="listing-run-code", receipt=run_listing_code(
                    local_data_root=str(context.get("localDataRoot") or ""),
                    project=project, scenario=scenario,
                    code=request.get("code"),
                    credential_ref=str(request.get("credentialRef") or "") or None,
                    credentials_dir=str(context.get("credentialsDir") or "") or None,
                    session_id=str(context.get("sessionId") or "unknown-session"),
                ))
            return _result(True, action="listing-publish", receipt=publish_listing_code(
                local_data_root=str(context.get("localDataRoot") or ""),
                project=project, scenario=scenario,
                credential_ref=str(request.get("credentialRef") or "") or None,
                credentials_dir=str(context.get("credentialsDir") or "") or None,
                session_id=str(context.get("sessionId") or "unknown-session"),
                output_plane_root=str(context.get("outputPlaneRoot") or "") or None,
            ))
        except ListingWorkflowError as exc:
            # E-3: ListingWorkflowError 的文案本身即模型安全（不含路径/记录），
            # 保留原文与结构化 code，让 AI 能据此采取动作（如补凭据），
            # 而不是收到一句无法行动的 "operation failed"。
            return _result(False, code=getattr(exc, "code", "LISTING_WORKFLOW_ERROR"),
                           reason=str(exc))
        except Exception as exc:
            return _result(False, code="WORKFLOW_UNAVAILABLE", reason=sanitize_error(exc))

    # 2026-08-25 P0 修复（真实故障：关闭开关后 Listing 仍反复报
    # "Listing 结果安全检查失败"）。tool-result-guard.js 的
    # scrubUntrustedListingContent 会对未被信任的 Listing 文本块发起
    # operation="scrub_text" 请求，但 worker 从未注册该 operation——请求落到
    # 函数末尾的 UNKNOWN_OPERATION 分支，ok=False，Node 侧据此把每个文本块
    # 替换成 {clinicalGuard:"CHECK_FAILED"}。这条路径与开关状态无关，因此
    # 关闭拦截也照样触发，且每个内容块各报一次，表现为"反复拦截"。
    #
    # 修法：注册 scrub_text，并让它首先遵从开关——关闭时原样返回文本，
    # 不做任何扫描或改写（关闭 = 零限制，Harness 完全接手）。
    if operation == "scrub_text":
        text = request.get("text")
        if not isinstance(text, str):
            return _result(False, code="SCRUB_TEXT_INVALID_INPUT",
                           reason="text must be a string")
        # 开关关闭：不扫描、不改写，原样放行。
        if not data_interception_enabled:
            return _result(True, action="allow", text=text)
        try:
            from security.patterns import scan_text_context_aware
            verdict = scan_text_context_aware(text, scan_if_metadata=True)
        except Exception as exc:
            return _result(False, code="SECURITY_UNAVAILABLE",
                           reason=sanitize_error(exc))
        if verdict.get("should_block"):
            return _result(True, action="scrubbed", text=json.dumps({
                "clinicalGuard": "SCRUBBED",
                "reason": "内容命中临床数据模式，已替换为占位",
                "context": verdict.get("context"),
            }, ensure_ascii=False))
        return _result(True, action="allow", text=text)

    if operation == "ping":
        # FIX-11: 心跳探活——只需返回响应即证明 worker 存活。
        return _result(True, action="pong")

    return _result(False, code="UNKNOWN_OPERATION")


def main() -> int:
    # 真实故障修复（P0）：zh-CN Windows 下 sys.stdin/stdout 默认 cp936，
    # Node 侧按 UTF-8 写入的中文请求会被解码为乱码并产生孤立代理字符，
    # 既使出域指纹 .encode('utf-8') 崩溃（全线 fail-closed 停摆），
    # 也会让中文检测在乱码上运行而静默失效。协议层强制 UTF-8，
    # 不依赖 PYTHONIOENCODING/PYTHONUTF8 外部环境变量。
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    # E-2: 依赖预检 fail-fast。预检在后台线程执行（完整 import pandas 等
    # 需数秒，不能挡在协议路径上——ping/check_llm 必须立即可答）；缺依赖
    # 时输出不带 requestId 的结构化横幅并立即退出，Node 侧记录为启动诊断，
    # 触发 fail-closed。完整 import（而非 find_spec）同时能暴露包损坏
    # （如 pyreadstat DLL 加载失败），这类故障 find_spec 探不出来。
    import threading

    def _preflight() -> None:
        missing = missing_worker_dependencies(stop_on_first=True)
        if missing:
            _emit({
                "ok": False,
                "code": "WORKER_DEPENDENCY_MISSING",
                "reason": "worker python is missing required packages: "
                          + ", ".join(sorted(set(missing))),
            })
            # 横幅已 flush；直接终止，避免与主线程的输出交错撕裂响应行。
            os._exit(3)

    threading.Thread(target=_preflight, daemon=True).start()
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            request_id = request.get("requestId")
            response = _handle(request)
        except Exception as exc:
            # FIX-3 / FIX-6 (AR-2.6): 畸形行不再让进程崩溃（UnboundLocalError 已修），
            # 返回 SECURITY_UNAVAILABLE 并继续服务后续请求。
            response = _result(False, code="SECURITY_UNAVAILABLE",
                               reason=sanitize_error(exc))
        response["requestId"] = request_id
        _emit(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
