"""出境检查点 (Egress Checkpoint)

红线1最后一道防线：所有发送给LLM的数据必须经过此检查点。
这是硬拦截，不是soft check - 检测到临床数据立即抛异常，中断请求。

设计原则：
1. 单一出境点：所有LLM请求必经此门（架构约束）
2. 专用识别：针对临床试验数据的特征，不是通用脱敏
3. 零容忍：检测到数据=中断请求，不是warning
4. 完整留痕：每次拦截记录到独立审计文件
5. 性能优先：正常请求快速通过（<5ms），只对疑似内容深度扫描
6. 全局开关：DATA_PROTECTION_ENABLED=0 关闭所有拦截（用于测试/非敏感环境）
"""

import base64
import hashlib
import hmac
import json
import os
import re
import unicodedata
import uuid
from typing import Any, Dict, List, Tuple, Optional
from datetime import datetime
from dataclasses import dataclass

from security.audit_log import harden_permissions, write_audit_record
from security.patterns import strip_uuids
from security.patterns import (
    CDISC_CORE_FIELDS,
    CLINICAL_TERMS,
    CLINICAL_TERMS_LOWER,
    DATE_PATTERNS,
    MEDICAL_CODE_PATTERNS,
    SAFE_FILENAME_CONTEXT_RE,
    SAS_CLINICAL_DOMAINS,
    SUBJECT_ID_PATTERNS,
    is_document_version_number,
    ends_with_alpha_segment,
    in_operational_span,
    operational_spans,
    is_safe_filename_date,
    stable_hash,
)

# ============================================================================
# P0-1 Fix: clinicalGuard HMAC 签名验证
# ============================================================================
_EMERALD_SIGNING_SALT = os.environ.get("EMERALD_SIGNING_SALT", "").encode("utf-8")


def _sign_clinical_guard(marker: str, critical_fields: dict) -> str:
    """为 clinicalGuard 收据生成 HMAC 签名。

    签名内容 = marker + 按字母序序列化的关键字段 JSON
    防伪造：攻击者无法在不掌握 EMERALD_SIGNING_SALT 的情况下伪造有效签名。
    """
    if not _EMERALD_SIGNING_SALT:
        return ""
    canonical = json.dumps(critical_fields, sort_keys=True, ensure_ascii=False)
    raw = f"{marker}:{canonical}".encode("utf-8")
    return hmac.new(_EMERALD_SIGNING_SALT, raw, hashlib.sha256).hexdigest()[:16]


def _verify_clinical_guard_signature(value: dict) -> bool:
    """递归验证 clinicalGuard 字段的 HMAC 签名。

    防止伪造攻击：攻击者可能在 payload 中注入伪造的 clinicalGuard 结构。
    验证策略：
    1. clinicalGuard 字段本身必须是字符串标记（不能是嵌套 dict/list）
    2. 必须存在有效的 signature 字段
    3. signature 必须是 marker + critical_fields 的 HMAC
    4. 不允许在 clinicalGuard 结构中混入未知字段
    """
    marker = value.get("clinicalGuard") or value.get("clinical_guard")
    if not isinstance(marker, str) or not marker:
        return False

    sig = value.get("signature") or value.get("sig")
    if not isinstance(sig, str) or len(sig) != 16:
        return False

    critical_fields = {
        "listingId": value.get("listingId") or value.get("listing_id"),
        "schemaFingerprint": value.get("schemaFingerprint") or value.get("schema_fingerprint"),
        "stage": value.get("stage"),
        "status": value.get("status"),
        "dataClass": value.get("dataClass") or value.get("data_class"),
    }
    expected_sig = _sign_clinical_guard(marker, {k: v for k, v in critical_fields.items() if v is not None})
    if not hmac.compare_digest(sig, expected_sig):
        return False

    forbidden_nested = {"data", "records", "rows", "values", "content", "payload", "body"}
    if any(k for k in value.keys() if k.lower() in forbidden_nested):
        return False

    return True

# ============================================================================
# 全局开关：DATA_INTERCEPTION_ENABLED=0 关闭所有数据扫描与拦截。
# ============================================================================
def _egress_enabled(context: Dict[str, Any] | None = None) -> bool:
    """请求态开关优先，环境变量仅作为无上下文调用的部署默认值。"""
    value = (context or {}).get("dataInterceptionEnabled")
    if isinstance(value, bool):
        return value
    return os.environ.get("DATA_INTERCEPTION_ENABLED", "1") != "0"


# ============================================================================
# 临床数据专用识别算法
# ============================================================================

# 数据值判定预编译正则（FIX-10）。键路径段脱敏已改白名单式（ST-P1-7），
# 不再依赖 DLP 模式匹配键名。

# 不可见/格式控制字符 (ST-P1-2)：零宽空格族 U+200B-200F、词连接符 U+2060、
# BOM/零宽不折行空格 U+FEFF、软连字符 U+00AD、蒙古元音分隔符 U+180E、
# bidi 控制符 U+202A-202E/U+2066-2069。剥离后复用同一模式库识别绕过形态。
_INVISIBLE_RE = re.compile(
    "[\u200b-\u200f\u2060\ufeff\u00ad\u180e\u202a-\u202e\u2066-\u2069]"
)
_DATA_VALUE_RES = [
    re.compile(r'\d{4}-\d{2}-\d{2}'),  # 日期
    re.compile(r'\b[A-Z]\d{6,}', re.IGNORECASE),  # 编号（认小写）
    re.compile(r'\d{3,}-\d{3,}'),      # 复合编号
]

# 方案/规格文档术语形态（"Visit Date(D1)"、"D56" 等访视窗标签不是数据值）。
_SPEC_TERM_RE = re.compile(r'^[A-Za-z][A-Za-z()\-+/&~ ]*$')
_SPEC_LABEL_RE = re.compile(r'^[A-Za-z]{1,12}(?:\([A-Za-z]?\d{0,3}\))?[+\-]?$')
_DAY_LABEL_RE = re.compile(r'^[A-Za-z]\d{1,3}$')

# 代码模板占位符：f-string/str.format 的 {}、%-格式化、shell/env 的 ${}。
# 用于把"构造表达式"与"字面数据值"分开（见 _looks_like_data_value）。
_TEMPLATE_PLACEHOLDER_RE = re.compile(
    r'\{[^{}]*\}|%\(?[A-Za-z_]\w*\)?[sdrfgex]|\$\{?\w+\}?'
)

# GenerateOptions 已知字段白名单 (FIX-2 / FR-12-05)：
# 审计 payload_fields 只呈现白名单内的字段名，未知字段仅记录截断哈希。
KNOWN_GENERATE_FIELDS = frozenset({
    "provider", "model", "messages", "system", "tools", "stop",
    "temperature", "topP", "maxTokens", "presencePenalty", "frequencyPenalty",
    "responseFormat", "purpose", "stream", "seed", "metadata", "toolChoice",
    "sessionId",
})


# 审计路径可原样保留的结构键白名单 (ST-P1-7)：GenerateOptions 与 message/
# content block 的已知结构字段名。这些是协议结构而非数据，可读且不含临床值。
# 任何其他键名（含中文业务键、未知键）在审计 location 中一律哈希，绝不出现原文。
_SAFE_PATH_KEYS = KNOWN_GENERATE_FIELDS | frozenset({
    "role", "content", "text", "type", "name", "description", "parameters",
    "arguments", "id", "reasoning", "tool_call_id", "toolCallId",
    "function", "index", "input", "output", "result",
})


def _audit_payload_fields(payload: Any) -> List[str]:
    if not isinstance(payload, dict):
        return []
    fields = []
    for key in payload:
        name = str(key)
        if name in KNOWN_GENERATE_FIELDS:
            fields.append(name)
        else:
            fields.append("sha256:" + stable_hash(name))
    return sorted(fields)


# 系统元数据字段（E2E-4）：这些键的标量值是消息/工具调用标识符，不可能承载
# 临床数据，但形态（UUID、call id、序号）易被受试者/日期模式误命中，整轮对话被
# 误 BLOCK。对元数据键的标量值跳过内容 DLP，仅对内容字段做检测。
_METADATA_KEY_FIELDS = frozenset({
    "id", "rpcid", "rpc_id", "callid", "call_id", "requestid", "request_id",
    "toolcallid", "tool_call_id", "toolcallids", "messageid", "message_id",
    "uuid", "traceid", "trace_id", "spanid", "span_id", "seq", "nonce",
    "timestamp", "createdat", "created_at", "updatedat", "updated_at",
})

# 2026-08-23 FIX: 临床防护标记字段
# 这些字段标识内容已经过安全验证，不需要再次扫描
_CLINICAL_GUARD_FIELDS = frozenset({
    "clinicalguard", "clinical_guard", "trustedcontroltoken", "trusted_control_token",
    "trusteddocumenttoken", "trusted_document_token", "dataclass", "data_class",
    "schemafingerprint", "schema_fingerprint", "auditid", "audit_id",
})

# 受控 listing 工具产生的结构化收据。收据是控制面元数据，不是临床记录，
# 但只有同时满足完整形状时才可以跳过递归 DLP；单独出现 marker 不构成信任。
_TRUSTED_LISTING_MARKERS = frozenset({
    "CLINICAL_LISTING_INSPECTION",
    "CLINICAL_LISTING_PLAN_RECEIPT",
    # execute 收据经 tool-result-guard.js 的 projectExecuteReceipt 白名单投影后
    # 才会带上这个 marker 与 METADATA_ONLY。投影是"未列出即不存在"，产物内容、
    # payload、rows 已在 Node 侧被丢弃，出域侧不必再扫一遍产物文件名与行列统计。
    "CLINICAL_LISTING_RECEIPT",
})


def _is_trusted_listing_receipt(value: Any) -> bool:
    """验证 listing 收据的安全形状，避免把 marker 当作通用白名单。

    P0-1 Fix: 添加 HMAC 签名验证，防止伪造攻击。
    - 签名字段必须是有效的 HMAC-16
    - 不允许在收据中混入 data/records/rows 等数据字段

    这份形状校验与 src/tool-result-guard.js 的 isTrustedListingReceipt 是两道
    独立防线，各自维护一份字段闭集。任一侧漏字段都会让真实收据失信：Node 侧失信
    收据被 token 化，出域侧失信则收据被递归 DLP 扫描后 BLOCK 或降级——两种结果
    都让 harness 读不到 spec 与 schema。改生产者字段时必须同步两侧，
    test_listing_receipt_keys_stay_within_whitelists 会守住这条约束。
    """
    if not isinstance(value, dict):
        return False
    marker = value.get("clinicalGuard") or value.get("clinical_guard")
    if marker not in _TRUSTED_LISTING_MARKERS:
        return False
    if value.get("dataClass") != "METADATA_ONLY":
        return False
    fingerprint = value.get("schemaFingerprint") or value.get("schema_fingerprint")
    if not isinstance(fingerprint, str) or not fingerprint:
        return False

    if not _verify_clinical_guard_signature(value):
        return False

    schema = value.get("schema")
    if marker == "CLINICAL_LISTING_INSPECTION":
        if value.get("stage") != "inspect" or not isinstance(schema, dict) or any(
            not isinstance(dataset, str)
            or not isinstance(columns, list)
            or any(not isinstance(column, str) for column in columns)
            for dataset, columns in schema.items()
        ):
            return False
    elif marker == "CLINICAL_LISTING_RECEIPT":
        if value.get("stage") not in {"execute", "publish"} or value.get("status") not in {
            "completed", "failed", "rejected"
        }:
            return False
    elif marker == "CLINICAL_LISTING_CODE_RECEIPT":
        if value.get("stage") != "run" or value.get("status") not in {
            "ok", "rejected", "error"
        }:
            return False
    elif value.get("stage") != "validate" or value.get("status") not in {
        "validated", "invalid", "rejected"
    }:
        return False
    allowed = {
        "clinicalGuard", "clinical_guard", "status", "stage", "project",
        "scenario", "inferredScenario", "scenarioConfidence", "scenarioCandidates", "supportData",
        "documents", "datasets", "schema", "schemaFingerprint",
        "schema_fingerprint", "missing", "warnings", "dataClass",
        "validation", "plan", "result", "audit_id", "auditId", "outputCount",
        "artifact", "artifacts", "note",
        "code", "path", "message",
        "outputs", "datasetsTouched", "errorType",
        "signature", "sig",
    }
    return set(value).issubset(allowed)


# CDISC 字段组合正则，模块级预编译（FIX-10 / NFR-1: 正常请求 <10ms，含冷启动）。
_CDISC_FIELD_RE = re.compile(
    r'\b(' + "|".join(sorted(CDISC_CORE_FIELDS, key=len, reverse=True)) + r')\b[:\s]*([^\s,;]+)',
    re.IGNORECASE,
)


class ClinicalDataSignature:
    """临床试验数据特征库

    基于CDISC标准、ICH指南、EDC导出规范构建的识别模式。
    与通用PII检测的区别：这里的模式专门针对临床试验场景。
    """

    # CDISC SDTM 标准字段（最常见的受试者标识、日期、事件字段）
    CDISC_CORE_FIELDS = CDISC_CORE_FIELDS
    SAS_CLINICAL_DOMAINS = SAS_CLINICAL_DOMAINS
    SUBJECT_ID_PATTERNS = SUBJECT_ID_PATTERNS
    CLINICAL_DATETIME_PATTERNS = DATE_PATTERNS
    MEDICAL_CODING_PATTERNS = MEDICAL_CODE_PATTERNS
    CLINICAL_TERMS = CLINICAL_TERMS

    # 敏感列名组合（表头特征）
    SENSITIVE_COLUMN_COMBINATIONS = [
        # 组合1：受试者+日期
        ({"subject", "usubjid", "subjid"}, {"date", "dtc", "visit"}),

        # 组合2：站点+受试者
        ({"site", "siteid"}, {"subject", "subjid", "screenid"}),

        # 组合3：事件+日期
        ({"event", "ae", "cm", "ex"}, {"start", "end", "dtc"}),
    ]


@dataclass
class EgressThreat:
    """出境威胁检测结果"""
    threat_type: str  # subject_id | clinical_date | cdisc_field | medical_term | composite
    confidence: float  # 0.0-1.0
    evidence: str  # 脱敏后的证据
    location: str  # 在payload的位置
    pattern_name: str  # 命中的模式名
    recommendation: str  # BLOCK | SCRUB | WARN


class ClinicalDataRecognizer:
    """临床数据专用识别器

    与通用PII检测的区别：
    1. 专用模式：CDISC字段、SAS域名、临床编号规则
    2. 上下文感知：识别"受试者ID+日期"组合（单独日期可能无害）
    3. 高精度：针对临床试验场景优化，降低误报
    """

    def __init__(self):
        self.sig = ClinicalDataSignature()
        self._context_cache = []  # 上下文窗口（检测组合模式用）
        self._cdisc_field_re = _CDISC_FIELD_RE  # 模块级预编译（FIX-10 NFR-1）

    @staticmethod
    def _safe_key(key: str) -> str:
        """ST-P1-7 (FR-12-05 / R-6): 键路径段脱敏改白名单式——只有已知协议结构键
        原样保留；其余一切键名（含中文业务键、命中 DLP 的键、任意未知键）一律以
        [KEY:哈希] 呈现，审计 location 中绝不出现任意键名原文。"""
        if not key:
            return "<empty>"
        if key in _SAFE_PATH_KEYS:
            return key
        return "[KEY:" + stable_hash(key, length=8) + "]"

    def scan_text(self, text: str, location: str = "") -> List[EgressThreat]:
        """扫描文本，返回所有检测到的威胁。

        P1 改进：使用上下文感知扫描。
        - 元数据上下文（路径、列名、Sheet名）→ 大幅放宽检测
        - 单元格值上下文 → 完整 DLP 检测
        """
        if not text or not isinstance(text, str):
            return []

        # P1 精准检测：上下文感知扫描
        # 先判断文本是否处于"元数据"上下文，如果是则大幅放宽
        from security.patterns import is_metadata_context

        # 只有可证明的路径、文件名、列名和技术标识才是元数据。短文本恰恰是
        # 受试者号、日期和医学编码的常见载体，不能仅凭长度提前放行。
        if is_metadata_context(text):
            return []

        # UUID（消息/调用 id 等技术标识）统一剥离后再扫：E2E-4 口径——技术
        # 标识不承载临床数据。在入口剥离同时覆盖原文与 normalized 拼接形态
        # （'id c25e2638-...' 归一化融合成 'idc25e2638-...' 后按位置豁免会
        # 因越界失效）。真实 USUBJID 是 010-001-1001 型短编号，非 8-4-4-4-12 hex。
        text = strip_uuids(text)
        if not text.strip():
            return []

        # 操作性标识区间（用户规则：路径/文件名是辅助读取的操作数据，原样放行）：
        # 覆盖 meta.lines 投影等写入侧脱敏不可达的文本。区间内的受试者号/日期
        # 形态命中不是临床数据值。数据值（无路径/文件名形态）照旧拦截。
        op_spans = operational_spans(text)

        threats = []

        # 绕过归一化 (ST-P1-2 / BY-11)：NFKC 折叠全角/兼容变体，剥离零宽与格式控制
        # 字符（零宽空格族、U+FEFF BOM、U+00AD 软连字符、U+180E、bidi 控制符）。
        # 空格压缩归一化已移除（2026-08-20 决断）：全局/定向删除空格都会把英文
        # 散文拼成伪标识（CGB3002-TESTseemstobeacopy...、inRT01and...、ofD1 三例
        # 实测误拦）。拆分形态 "A 1234567" 的防线在写入侧 despaced token 化与
        # 工具参数 quickGuard；连写形态 A1234567 在本车道照常拦截。
        normalized = unicodedata.normalize("NFKC", text)
        normalized = _INVISIBLE_RE.sub('', normalized)
        if normalized != text:
            threats.extend(self.scan_text(normalized, f"{location}.normalized"))

        # Base64 是验收矩阵明确覆盖的封装形态。仅解码可完整解码且可转 UTF-8
        # 的候选串，解码结果仍进入同一套临床数据识别。
        # FIX-11 (NFR-2): 候选 token 总长（含 padding）≥24 才进入解码，降低短串误报；
        # 16 字节载荷编码后为 22 数据字符 + 2 padding = 24，仍然覆盖（BY-1）。
        for token in re.findall(r"(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/=])", text):
            if len(token) < 24:
                continue
            try:
                decoded = base64.b64decode(token, validate=True).decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                continue
            decoded_threats = self.scan_text(decoded, f"{location}.base64")
            if decoded_threats:
                threats.extend(decoded_threats)

        # 1. CDISC标准字段检测（列名）— 预编译组合正则（FIX-10 NFR-1）
        for match in self._cdisc_field_re.finditer(text):
            field = match.group(1).lower()
            value = match.group(2)
            # 检查value是否疑似数据（不是description）
            if self._looks_like_data_value(value):
                threats.append(EgressThreat(
                    threat_type="cdisc_field",
                    confidence=0.9,
                    evidence=f"{field.upper()}: [REDACTED]",
                    location=location,
                    pattern_name=f"CDISC字段:{field}",
                    recommendation="BLOCK"
                ))

        # 2. 受试者编号检测
        for pattern, desc in self.sig.SUBJECT_ID_PATTERNS:
            for match in pattern.finditer(text):
                matched_text = match.group(0)
                # 排除误报：文件名中的日期（如v2024-08-18.docx）
                if self._is_false_positive_context(text, match):
                    continue
                # 真实缺陷修复：'标识+YYYYMMDD' 文档版本号（DVP20260610）不是受试者
                # 编号。纯格式判据，无关键词豁免。该串仍会被下方 DATE_PATTERNS 以
                # 日期口径检出（纯日期=WARN），不会静默放行。
                if desc == "字母前缀编号" and is_document_version_number(matched_text):
                    continue
                # 操作性标识（路径/文件名）区间内的命中不是受试者编号
                if in_operational_span(op_spans, match.start(), match.end()):
                    continue
                # 编号结构判据（审计 20260820_150945）：USUBJID 末段是序号（数字），
                # 文档/项目编号末段是语义段（纯字母）——DS5565-0002-NIS-MA、
                # CGB3002-TEST。DSH meta.lines 投影在 post-execute 之后附加，
                # 写入侧 token 化不可达，出域侧是唯一关卡：字母末段降 WARN+
                # 审计，数字末段（真实 USUBJID）保持 BLOCK。
                if desc == "USUBJID格式" and ends_with_alpha_segment(matched_text):
                    threats.append(EgressThreat(
                        threat_type="doc_id",
                        confidence=0.6,
                        evidence="[DOCID]",
                        location=location,
                        pattern_name="文档编号",
                        recommendation="WARN"
                    ))
                    continue
                threats.append(EgressThreat(
                    threat_type="subject_id",
                    confidence=0.95,
                    evidence="[SUBJ]",
                    location=location,
                    pattern_name=desc,
                    recommendation="BLOCK"
                ))

        # 3. 临床日期时间检测
        for pattern, desc in self.sig.CLINICAL_DATETIME_PATTERNS:
            for match in pattern.finditer(text):
                matched_text = match.group(0)
                # 豁免：文件名/路径中的版本日期
                if self._is_metadata_date(text, match):
                    continue
                # 豁免：操作性标识（路径/文件名）区间内的日期形态
                if in_operational_span(op_spans, match.start(), match.end()):
                    continue
                threats.append(EgressThreat(
                    threat_type="clinical_date",
                    confidence=0.8,
                    evidence="[DATE]",
                    location=location,
                    pattern_name=desc,
                    # 真实缺陷修复（crViewer.xls）：含时间成分的日期（ISO8601 T /
                    # 08 Jun 2026 05:19:50）是数据导出特征，必须 BLOCK；
                    # 纯日期（可能是文档日期）保持 WARN 与其他信号复合。
                    recommendation="BLOCK" if (":" in matched_text or "T" in matched_text) else "WARN"
                ))

        # 4. 医学编码检测
        for pattern, desc in self.sig.MEDICAL_CODING_PATTERNS:
            if pattern.search(text):
                threats.append(EgressThreat(
                    threat_type="medical_coding",
                    confidence=0.95,
                    evidence="[CODE]",
                    location=location,
                    pattern_name=desc,
                    recommendation="BLOCK"
                ))

        # 5. 临床术语检测（配合其他信号）
        text_lower = text.lower()
        term_count = sum(1 for term in CLINICAL_TERMS_LOWER if term in text_lower)
        if term_count >= 3:  # 多个术语同时出现
            threats.append(EgressThreat(
                threat_type="clinical_term_cluster",
                confidence=0.7,
                evidence=f"{term_count}个临床术语",
                location=location,
                pattern_name="术语聚集",
                recommendation="WARN"
            ))

        return threats

    def scan_structured(self, payload: Any, path: str = "") -> List[EgressThreat]:
        """递归扫描结构化数据（dict/list）

        FIX-2 (R-7 / FR-09-03): 任意嵌套对象的键名与字符串值执行同一套 DLP 扫描，
        键名路径段经 _safe_key 脱敏，审计中不出现键名原文。
        """
        threats = []

        if isinstance(payload, dict):
            # 每次递归入口都验证收据。这样 inspection/validation 等嵌套收据
            # 在历史重扫时仍保持控制面语义；未通过完整验证的伪造对象照常扫描。
            if _is_trusted_listing_receipt(payload):
                return threats
            for key, value in payload.items():
                key_str = str(key)
                key_lower = key_str.lower()
                safe_key = self._safe_key(key_str)
                child_path = f"{path}.{safe_key}"

                # 任意键名扫描：键名本身可能是受试者编号/临床日期（如顶层键 A1234567）
                for threat in self.scan_text(key_str, child_path):
                    threats.append(threat)

                # E2E-4: 系统元数据字段（消息/工具调用 id 等）的标量值不承载临床
                # 数据，跳过内容 DLP，避免 UUID/call id 被受试者号模式误 BLOCK。
                # GenerateOptions 顶层 sessionId 同理；只豁免精确顶层路径，避免嵌套
                # 业务对象伪装同名键绕过内容扫描。嵌套结构仍递归。
                is_top_level_session_id = path == "payload" and key_lower in ("sessionid", "session_id")
                if (key_lower in _METADATA_KEY_FIELDS or is_top_level_session_id) \
                        and not isinstance(value, (dict, list)):
                    continue

                # 键名本身是CDISC字段
                if key_lower in self.sig.CDISC_CORE_FIELDS:
                    if self._looks_like_data_value(str(value)):
                        threats.append(EgressThreat(
                            threat_type="cdisc_field",
                            confidence=0.95,
                            evidence=f"{safe_key.upper()}: [REDACTED]",
                            location=child_path,
                            pattern_name=f"CDISC字段键:{safe_key}",
                            recommendation="BLOCK"
                        ))

                # 键名是SAS域
                if key_lower in self.sig.SAS_CLINICAL_DOMAINS:
                    threats.append(EgressThreat(
                        threat_type="sas_domain",
                        confidence=0.9,
                        evidence=f"SAS域:{safe_key}",
                        location=child_path,
                        pattern_name="SAS数据集",
                        recommendation="WARN"  # 域名本身不是数据，但是强信号
                    ))

                # 递归扫描值
                threats.extend(self.scan_structured(value, child_path))

        elif isinstance(payload, list):
            for i, item in enumerate(payload):
                threats.extend(self.scan_structured(item, f"{path}[{i}]"))

        elif isinstance(payload, str):
            threats.extend(self.scan_text(payload, path))

        return threats

    def detect_composite_threat(self, threats: List[EgressThreat]) -> Optional[EgressThreat]:
        """检测复合威胁：多个单独不确定的信号组合成高置信威胁

        例如：受试者ID + 临床日期 + 医学术语 → 确定是临床数据
        """
        threat_types = {t.threat_type for t in threats}

        # 组合1：受试者ID + 日期
        if "subject_id" in threat_types and "clinical_date" in threat_types:
            return EgressThreat(
                threat_type="composite",
                confidence=0.98,
                evidence="受试者ID + 日期组合",
                location="payload",
                pattern_name="复合威胁:ID+日期",
                recommendation="BLOCK"
            )

        # 组合2：CDISC字段 + 受试者ID
        if "cdisc_field" in threat_types and "subject_id" in threat_types:
            return EgressThreat(
                threat_type="composite",
                confidence=0.98,
                evidence="CDISC字段 + 受试者ID",
                location="payload",
                pattern_name="复合威胁:CDISC+ID",
                recommendation="BLOCK"
            )

        # 组合3：多个高置信威胁
        block_count = sum(1 for t in threats if t.recommendation == "BLOCK")
        if block_count >= 2:
            return EgressThreat(
                threat_type="composite",
                confidence=0.95,
                evidence=f"{block_count}个独立威胁",
                location="payload",
                pattern_name="复合威胁:多信号",
                recommendation="BLOCK"
            )

        return None

    def _looks_like_data_value(self, text: str) -> bool:
        """判断字符串是否像数据值（而非描述性文本）"""
        if not text or len(text) > 100:
            return False

        # 真实缺陷修复（审计 20260820_150945-85697ec72e）：PDF 规格文档的访视
        # 窗口术语 "Visit Date(D1)"、"Visit Date- Screening" 被判为数据行，
        # 13 次 BLOCK + 复合威胁把整个请求拦死。用户规则明确 spec/方案文档可读。
        # 纯格式判据（无关键词豁免，ST-D-5 教训）：
        #   - 字母开头的术语/短语（可含括号、加减号、斜杠）且不含任何数字
        #     → 描述性文本（原逻辑此处也放行，显式化）；
        #   - "单词(字母+≤3位数字)" 括号标签形态（Date(D1)）与裸天数标签（D56）
        #     → 方案访视窗术语，不是受试者数据值。
        # 真实数据不受影响：纯数字（VISIT: 3 / VISITNUM 4.0）、日期、字母数字
        # ID（A1234567、101-001）仍判数据值。
        stripped = text.strip()
        if _SPEC_TERM_RE.match(stripped) and not any(c.isdigit() for c in stripped):
            return False
        if _SPEC_LABEL_RE.match(stripped) or _DAY_LABEL_RE.match(stripped):
            return False
        # 代码标识排除（审计 20260820_155650）：读代码文件结果里的注释
        # "cohort per subject (DSCOHORT@5218; STD@5278)" 中，CDISC 字段后跟
        # 代码变量注解 (DSCOHORT@5218。CDISC 导出的数据值形态从不包含 @
        # （纯数字/日期/短字母数字 ID），含 @ 一律是代码/注解标识。
        if '@' in stripped:
            return False

        # 2026-08-21 修复：纯英文字母短语（如 "SUBJECT"、"VISIT"、"STATUS"）
        # 在 prompts/system 中被误判为 CDISC 字段+数据值。数据值必然含数字：
        # 编号（A1234567）、日期（2026-01-01）、测量值（37.2）。纯字母短语
        # 是提示词模板/SQL 别名/CDISC 字段名，不是临床数据。
        if stripped.isalpha():
            return False

        # 代码符号排除（2026-08-21 RBQM_test 实测：真实执行器脚本被拦死）：
        # 生成器代码里的 `USUBJID=f'{STUDYID}-{site}-{i:03d}'`（构造表达式）与
        # `USUBJID=u` / `USUBJID=x['USUBJID']`（变量引用）承载的是符号而非
        # 患者级字面值。旧判据只看"短且含数字"，把格式说明符 03d 当数据值 →
        # BLOCK，agent 写不出任何执行器脚本。
        # 纯格式判据（非关键词豁免）：剥掉 f-string/format/shell 占位符后若不再
        # 含任何字面数字，该串是代码符号。真实数据不受影响——字面 USUBJID
        # `010-001-1001`、日期 `2026-03-18` 无占位符，剥离后数字仍在；混合形态
        # f'{STUDY}-001-1001' 的字面尾段 -001-1001 保留，同样判数据值。
        without_placeholders = _TEMPLATE_PLACEHOLDER_RE.sub('', stripped)
        if not any(c.isdigit() for c in without_placeholders):
            return False

        # 短且含数字/日期 → 疑似数据
        if len(text) < 20 and any(c.isdigit() for c in text):
            return True

        return any(pattern.search(text) for pattern in _DATA_VALUE_RES)

    def _is_false_positive_context(self, text: str, match) -> bool:
        """P1-5: 只豁免完整文件名形态中的版本日期，不靠宽泛关键词豁免。
        格式判据: 日期前后紧跟文件名字符并整体含文件扩展名。"""
        return is_safe_filename_date(text, match.start(), match.end())

    def _is_metadata_date(self, text: str, match) -> bool:
        """日期只允许完整文件名形态豁免。"""
        return is_safe_filename_date(text, match.start(), match.end())


# ============================================================================
# 出境检查点（硬拦截）
# ============================================================================

def _dedupe_threats(threats: List[EgressThreat]) -> List[EgressThreat]:
    """按 (threat_type, pattern_name) 去重，保留首个命中（含最早 location）。"""
    seen: set = set()
    unique: List[EgressThreat] = []
    for threat in threats:
        key = (threat.threat_type, threat.pattern_name)
        if key in seen:
            continue
        seen.add(key)
        unique.append(threat)
    return unique


class EgressViolation(Exception):
    """出境违规异常 - 检测到临床数据试图发送给LLM"""
    def __init__(self, threats: List[EgressThreat], audit_id: str):
        self.threats = threats
        self.audit_id = audit_id
        max_threat = max(threats, key=lambda t: t.confidence)
        super().__init__(
            f"🚫 红线1违规：检测到临床数据试图出域\n"
            f"威胁类型: {max_threat.threat_type}\n"
            f"置信度: {max_threat.confidence:.0%}\n"
            f"位置: {max_threat.location}\n"
            f"审计ID: {audit_id}\n"
            f"建议: {max_threat.recommendation}"
        )


class EgressCheckpoint:
    """出境检查点 - LLM请求的最后一道防线

    所有发送给LLM的请求必须调用 check() 方法。
    这是架构约束，在LLM provider层强制执行。

    使用方式：
        checkpoint = EgressCheckpoint()
        checkpoint.check(messages)  # 抛异常 = 拦截成功
    """

    def __init__(self, audit_dir: str = None):
        self.recognizer = ClinicalDataRecognizer()
        # FIX-12 (FR-16-07): 审计 root 可经 EMERALD_AUDIT_ROOT 配置。
        # 默认目录位于系统项目内 var/，禁止落用户主目录，
        # 主目录在 C 盘，系统不往 C 盘写任何数据）。
        _pkg_root = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
        self.audit_dir = audit_dir or os.environ.get("EMERALD_AUDIT_ROOT") or os.path.join(
            _pkg_root, "var", "egress_audit"
        )
        os.makedirs(self.audit_dir, exist_ok=True)
        harden_permissions(self.audit_dir, 0o700)

    def check(self, payload: Any, context: Dict[str, Any] = None) -> Dict[str, Any]:
        """检查payload是否包含临床数据

        Args:
            payload: 要发送给LLM的内容（通常是messages列表）
            context: 上下文信息（tool名称、session_id等）

        Raises:
            EgressViolation: 检测到临床数据，拦截请求
        """
        # 数据拦截关闭时完全旁路，不扫描也不记录检测审计。
        if not _egress_enabled(context):
            try:
                evidence = self._request_evidence(payload)
            except Exception:
                evidence = {}
            return {"audit_id": "disabled", **evidence, "egress_disabled": True}

        # 1. 扫描威胁
        threats = self.recognizer.scan_structured(payload, path="payload")

        # 1.5 威胁去重（真实缺陷：同一 (类型,模式) 在一段文本里重复命中 N 次
        # 被当作 N 个独立信号——13 个 visit 或 108 个字母前缀编号直接顶穿
        # 复合威胁 block_count>=2 阈值。多信号的本意是"多类"信号，
        # 同类命中无论多少次至多贡献一个信号位。任一 BLOCK 即拦的判定
        # 不受去重影响，检出率不削弱。）
        threats = _dedupe_threats(threats)

        # 2. 检测复合威胁
        composite = self.recognizer.detect_composite_threat(threats)
        if composite:
            threats.append(composite)

        blocking_threats = [t for t in threats if t.recommendation == "BLOCK"]

        # 4. 记录审计（即使没拦截也记录，用于调优）
        # E2E-2: 指纹计算可能抛异常（如载荷含孤立代理无法编码），审计落盘必须
        # 用 try/finally 保证——"因异常被拦的请求"恰是最需留痕的一类。指纹失败时
        # 以 fingerprint_error 占位，审计仍然写入。
        try:
            request_evidence = self._request_evidence(payload)
        except Exception as exc:
            request_evidence = {
                "payload_sha256": None,
                "payload_bytes": None,
                "payload_fields": [],
                "message_count": (
                    len(payload["messages"])
                    if isinstance(payload, dict) and isinstance(payload.get("messages"), list)
                    else None
                ),
                "fingerprint_error": type(exc).__name__,
            }
        audit_id = self._log_audit(threats, blocking_threats, context, request_evidence)

        # 5. 拦截
        if blocking_threats:
            raise EgressViolation(blocking_threats, audit_id)
        return {"audit_id": audit_id, **request_evidence}

    @staticmethod
    def _request_evidence(payload: Any) -> Dict[str, Any]:
        """生成无原文的模型请求指纹，用于证明检查对象是完整出境请求。

        FIX-2 (FR-12-05): payload_fields 只呈现 GenerateOptions 已知字段白名单，
        未知字段仅记录截断哈希，审计文件中不出现未知键名原文。
        """
        canonical = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        return {
            "payload_sha256": hashlib.sha256(canonical).hexdigest(),
            "payload_bytes": len(canonical),
            "payload_fields": _audit_payload_fields(payload),
            "message_count": (
                len(payload["messages"])
                if isinstance(payload, dict) and isinstance(payload.get("messages"), list)
                else None
            ),
        }

    def _log_audit(self, all_threats: List[EgressThreat],
                   blocking_threats: List[EgressThreat],
                   context: Dict[str, Any],
                   request_evidence: Dict[str, Any]) -> str:
        """记录审计日志（零数据值）

        Returns:
            audit_id: 审计记录ID（用于事后溯源）
        """
        audit_id = datetime.now().strftime("%Y%m%d_%H%M%S") + "-" + uuid.uuid4().hex[:10]
        context = self._sanitize_context(context)

        audit_record = {
            "audit_id": audit_id,
            "timestamp": datetime.now().isoformat(),
            "action": "BLOCKED" if blocking_threats else ("OBSERVED" if all_threats else "ALLOWED"),
            "threat_count": len(all_threats),
            "blocking_threat_count": len(blocking_threats),
            "request_evidence": dict(request_evidence),
            "threats_summary": [
                {
                    "type": t.threat_type,
                    "confidence": t.confidence,
                    "pattern": t.pattern_name,
                    "recommendation": t.recommendation,
                    "location": t.location,
                    "evidence": t.evidence,  # 已脱敏
                }
                for t in blocking_threats
            ] if blocking_threats else [
                {
                    "type": t.threat_type,
                    "confidence": t.confidence,
                    "pattern": t.pattern_name,
                }
                for t in all_threats[:5]  # 只记前5个
            ],
            "context": {
                "tool": context.get("tool") if context else None,
                # FIX-9 (BR-06.5): 同时接受 snake_case / camelCase 上下文键名，
                # 身份以统一 stable_hash 呈现（与授权记录同一哈希上下文，可关联）。
                "session_id": self._identity_hash(context, "session_id", "sessionId"),
                "user_id": self._identity_hash(context, "user_id", "userId"),
            }
        }

        # 审计失败必须向上抛出，由插件以 fail-closed 方式拒绝继续处理。
        write_audit_record(self.audit_dir, "egress", audit_record)
        return audit_id

    @staticmethod
    def _identity_hash(context: Dict[str, Any] | None, *keys: str) -> Optional[str]:
        """从上下文取第一个非空身份值并返回统一哈希（BR-06.5：非空串哈希）。"""
        if not context:
            return None
        for key in keys:
            value = context.get(key)
            if value is not None and str(value) != "":
                return "sha256:" + stable_hash(value)
        return None

    @staticmethod
    def _sanitize_context(context: Dict[str, Any] | None) -> Dict[str, Any]:
        """审计上下文只保留枚举、布尔与单向哈希，避免用户头泄露数据值。"""
        if not context:
            return {}
        result: Dict[str, Any] = {}
        for key, value in context.items():
            if isinstance(value, (bool, int, float)) or value in ("enforce", "shadow"):
                result[str(key)] = value
            elif value is not None:
                result[str(key)] = "sha256:" + stable_hash(value)
        return result


# ============================================================================
# 全局单例（确保只有一个检查点）
# ============================================================================

import threading

_GLOBAL_CHECKPOINT = None
_GLOBAL_CHECKPOINT_LOCK = threading.Lock()

def get_egress_checkpoint() -> EgressCheckpoint:
    """获取全局出境检查点单例（ST-P3-x：双重检查锁，线程安全）。"""
    global _GLOBAL_CHECKPOINT
    if _GLOBAL_CHECKPOINT is None:
        with _GLOBAL_CHECKPOINT_LOCK:
            if _GLOBAL_CHECKPOINT is None:
                _GLOBAL_CHECKPOINT = EgressCheckpoint()
    return _GLOBAL_CHECKPOINT


def check_egress_v2(payload: Any, context: Dict[str, Any] = None) -> Dict[str, Any]:
    """检查完整待发送载荷；只允许或阻断，永不改写后继续发送。

    开启时同时检查受保护来源标记与 payload 中的真实临床 data。关闭时完全
    旁路，不扫描、不投影、不写检测审计。Harness 引导和本地 Listing 工作流
    不由本函数控制。
    """
    if not _egress_enabled(context):
        return {"audit_id": "disabled", "egress_disabled": True}

    checkpoint = get_egress_checkpoint()
    protected_source = str((context or {}).get("protectedDataSource", "")).casefold()
    threats = checkpoint.recognizer.scan_structured(payload, path="payload")
    if protected_source in {"sas", "external_excel"}:
        threats.append(EgressThreat(
            threat_type="protected_data_source", confidence=1.0,
            evidence="受保护数据来源", location="payload",
            pattern_name="来源边界", recommendation="BLOCK"))
    threats = _dedupe_threats(threats)
    composite = checkpoint.recognizer.detect_composite_threat(threats)
    if composite:
        threats.append(composite)
    blocking = [t for t in threats if t.recommendation == "BLOCK"]
    try:
        evidence = checkpoint._request_evidence(payload)
    except Exception as exc:
        evidence = {"fingerprint_error": type(exc).__name__}
    audit_id = checkpoint._log_audit(
        threats, blocking, context, evidence)
    if blocking:
        raise EgressViolation(blocking, audit_id)
    return {"audit_id": audit_id, **evidence}


# 保留 v1 check_egress 作为 EMERALD_EGRESS_V2=0 的回退路径。

def check_egress(payload: Any, context: Dict[str, Any] = None) -> Dict[str, Any]:
    """便捷函数：检查出境内容

    这是所有LLM请求必须调用的函数。

    Raises:
        EgressViolation: 检测到临床数据
    """
    checkpoint = get_egress_checkpoint()
    return checkpoint.check(payload, context)
