"""DLP 模式库单一来源 (P1-4)

Node.js 插件初筛与 Python 安全内核共用此文件中的定义。
修改模式时只改这一个文件，再运行 scripts/sync_patterns.py 生成 Node 端副本。

导出:
  SUBJECT_ID_PATTERNS  — 受试者编号正则 (compiled)
  DATE_PATTERNS        — 临床日期正则 (compiled)
  MEDICAL_CODE_PATTERNS — 医学编码正则 (compiled)
  CDISC_CORE_FIELDS    — CDISC 标准字段名集合
  CLINICAL_TERMS       — 临床术语集合
  SAS_CLINICAL_DOMAINS — SAS 域名集合
  SAFE_CONTEXT_RE      — 安全上下文正则（版本/文件名日期豁免）
"""
from __future__ import annotations
import hashlib
import re

# ---------------------------------------------------------------------------
# 受试者编号模式
# ---------------------------------------------------------------------------
SUBJECT_ID_PATTERNS: list[tuple[re.Pattern, str]] = [
    # 站点-受试者编号 (101-001, 001-0001)
    (re.compile(r'\b\d{3,4}-\d{3,6}\b'), "站点-受试者编号"),
    # 字母前缀+6-8位数字 (A1234567, S0001234) — IGNORECASE 认小写绕过 (ST-P1-1)
    # 真实缺陷修复：本模式会把"标识+YYYYMMDD"的文档版本号（DVP20260610、
    # SPEC20260610）误判为受试者编号。文档编号在 spec/ALS/DVP/template 场景中
    # 高频出现，一条误报即经全量历史重扫把整个会话永久钉死。
    # 判据不是关键词豁免（那是 ST-D-5 泄露通道），而是纯格式：8 位数字若构成
    # 合法 YYYYMMDD（1900-2099）则该串是日期而非受试者编号，交由 DATE_PATTERNS
    # 按日期口径处置（纯日期=WARN，与 ISO 日期一致）。受试者编号形态
    # A1234567（7 位）、S0001234（1234 月非法）不受影响，检出率不削弱。
    (re.compile(r'\b[A-Z]{1,4}\d{6,8}\b', re.IGNORECASE), "字母前缀编号"),
    # 复合编号 (ABC-12-001234)
    (re.compile(r'\b[A-Z]{2,4}-\d{2,4}-\d{3,6}\b', re.IGNORECASE), "复合站点编号"),
    # USUBJID 格式。要么三段都含数字（STUDY001-SITE01-SUBJ001），
    # 要么至少一段是两位以上纯数字（STUDY-SITE-001 / ABC-DEF-001）。
    # 纯平台 kebab-case 标识以及 read-UTF8-text 这类单个版本数字技术标识不得命中。
    # 段长上限 20：真实 CDISC USUBJID 各段（STUDY/SITE/SUBJ 编号）不会超过
    # 20 字符；归一化会把英文散文拼成超长"伪三段式"（CGB3002-TESTseemstobe
    # ...-relatedproject...，2026-08-20 实测误拦），长度界将其排除。纯格式
    # 判据，不削弱真实检出。
    (re.compile(
        r'\b(?:'
        r'(?=[A-Z0-9]*\d)[A-Z0-9]{1,20}-'
        r'(?=[A-Z0-9]*\d)[A-Z0-9]{1,20}-'
        r'(?=[A-Z0-9]*\d)[A-Z0-9]{1,20}'
        r'|(?:'
        r'\d{2,}-[A-Z0-9]{1,20}-[A-Z0-9]{1,20}'
        r'|[A-Z0-9]{1,20}-\d{2,}-[A-Z0-9]{1,20}'
        r'|[A-Z0-9]{1,20}-[A-Z0-9]{1,20}-\d{2,}'
        r')'
        r')\b',
        re.IGNORECASE,
    ), "USUBJID格式"),
]

# 数值型受试者编号在 Excel 中会以 int/float 传入。此模式同时用于单元格字符串化
# 后的扫描，避免只依赖 Python isinstance(str) 判断。
# 前导零 5-8 位（如 01001）是 EDC 站点-受试者编号形态；普通 6-8 位数字沿用。
NUMERIC_SUBJECT_ID_RE = re.compile(r"^(?:0\d{4,7}|\d{6,8})$")

# ---------------------------------------------------------------------------
# 临床日期时间模式
# ---------------------------------------------------------------------------
DATE_PATTERNS: list[tuple[re.Pattern, str]] = [
    # ISO8601 带时间（CDISC 标准）
    (re.compile(r'\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\b'), "ISO8601时间戳"),
    # ISO 日期
    (re.compile(r'\b\d{4}-\d{2}-\d{2}\b'), "ISO日期"),
    # SAS 日期格式 (01JAN2024) — IGNORECASE 认 01jan2024 小写绕过 (ST-P1-1)
    (re.compile(r'\b\d{2}[A-Z]{3}\d{4}\b', re.IGNORECASE), "SAS日期(01JAN2024)"),
    # 临床报告日期时间 (08 Jun 2026 05:19:50) — Rave/EDC 导出常见格式
    (re.compile(r'\b\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2}\b',
                re.IGNORECASE), "临床日期时间(08 Jun 2026 05:19:50)"),
    # 临床报告日期 (08 Jun 2026)
    (re.compile(r'\b\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b',
                re.IGNORECASE), "临床日期(08 Jun 2026)"),
    # 美式日期 MM/DD/YYYY
    (re.compile(r'\b\d{2}/\d{2}/\d{4}\b'), "MM/DD/YYYY"),
    # 中文日期
    (re.compile(r'\b\d{4}年\d{1,2}月\d{1,2}日\b'), "中文日期"),
]

# ---------------------------------------------------------------------------
# 医学编码模式
# ---------------------------------------------------------------------------
MEDICAL_CODE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r'\bPT:\s*\d{8}\b', re.IGNORECASE), "MedDRA PT编码"),
    (re.compile(r'\bLLT:\s*\d{8}\b', re.IGNORECASE), "MedDRA LLT编码"),
    (re.compile(r'\bWHO:\s*\d{6}\b', re.IGNORECASE), "WHO药品编码"),
]

# ---------------------------------------------------------------------------
# CDISC 标准字段名
# ---------------------------------------------------------------------------
CDISC_CORE_FIELDS: set[str] = {
    "usubjid", "subjid", "subject", "siteid", "screenid", "randid",
    "rfstdtc", "rfendtc", "dthdtc", "aestdtc", "aeendtc",
    "cmstdtc", "cmendt", "exstdtc", "exendtc",
    "vsdtc", "lbdtc", "egdtc",
    "visit", "visitnum", "visitdy", "epoch",
    "domain", "studyid",
}

# ---------------------------------------------------------------------------
# 临床术语
# ---------------------------------------------------------------------------
CLINICAL_TERMS: set[str] = {
    "筛选中", "筛选失败", "已入组", "已随机", "基线访视",
    "治疗期", "随访期", "提前终止", "完成研究",
    "screening", "screen failure", "enrolled", "randomized",
    "baseline", "treatment", "follow-up", "early termination",
    "study completion", "discontinued",
    "不良事件", "严重不良事件",
    "adverse event", "serious adverse event",
    "mild", "moderate", "severe",
    "sae", "ae grade",
    "blood pressure", "heart rate", "temperature",
}

CLINICAL_TERMS_LOWER = {term.lower() for term in CLINICAL_TERMS}

# ---------------------------------------------------------------------------
# SAS 域名
# ---------------------------------------------------------------------------
SAS_CLINICAL_DOMAINS: set[str] = {
    "dm", "ae", "cm", "ex", "lb", "vs", "eg", "mh", "pe",
    "qs", "sc", "ds", "sv", "pr", "fa", "ie", "ho",
    "adsl", "adae", "adcm", "adlb", "advs", "adeg",
}

# ---------------------------------------------------------------------------
# 安全上下文：完整文件名形态版本日期（只豁免文件名上下文中的日期）
# 格式: /[\w\-_]+\.\w+$/ 内 \d{4}-\d{2}-\d{2}
# ---------------------------------------------------------------------------
SAFE_FILENAME_CONTEXT_RE = re.compile(
    r'[\w\-_]*\d{4}-\d{2}-\d{2}[\w\-_]*\.\w{1,6}\b'
)

# ---------------------------------------------------------------------------
# Node.js 插件初筛用弱正则子集；scripts/sync_patterns.py 生成 JSON 副本。
# ---------------------------------------------------------------------------
NODE_DLP_PATTERNS = [
    # 基础受试者编号
    {"re": r"\b\d{3,4}-\d{4,6}-\d{3,6}\b",      "label": "SUBJECT_ID"},
    {"re": r"\b\d{3,4}-\d{3,6}\b",               "label": "SITE_SUBJECT_ID"},
    {"re": r"\bUSUBJID\s*[=:]\s*\S+",  "flags": "i", "label": "USUBJID_ASSIGN"},
    {"re": r"\bSUBJID\s*[=:]\s*\S+",   "flags": "i", "label": "SUBJID_ASSIGN"},
    # 扩展：字母前缀编号（同 Python Layer 2）— IGNORECASE 认小写绕过 (ST-P1-1)
    {"re": r"\b[A-Z]{1,4}\d{6,8}\b",   "flags": "i", "label": "ALPHA_SUBJECT_ID"},
    # 前导零受试者编号（EDC 形态，如 01001）
    {"re": r"\b0\d{4,7}\b",                        "label": "LEADING_ZERO_SUBJECT_ID"},
    {"re": r"\b\d{4}-\d{2}-\d{2}\b",              "label": "ISO_DATE"},
    # ISO8601 时间戳
    {"re": r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}",   "label": "ISO8601_DATETIME"},
    # SAS 日期 (01JAN2024 / 01jan2024) — IGNORECASE (ST-P1-1)
    {"re": r"\b\d{2}[A-Z]{3}\d{4}\b", "flags": "i", "label": "SAS_DATE"},
    # 临床报告日期（Rave/EDC 导出格式）
    {"re": r"\b\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b",
     "flags": "i", "label": "DD_MMM_YYYY_DATE"},
    # MedDRA 编码
    {"re": r"\bPT:\s*\d{8}\b",         "flags": "i", "label": "MEDDRA_PT"},
]


# ---------------------------------------------------------------------------
# 字母前缀编号的日期形态排除 (误报治本)
# ---------------------------------------------------------------------------
_YYYYMMDD_RE = re.compile(r'^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$')


def is_document_version_number(matched_text: str) -> bool:
    """判断"字母前缀编号"命中是否其实是"标识+YYYYMMDD"文档版本号。

    纯格式判据，不含任何关键词/上下文豁免（关键词豁免是 ST-D-5 已知泄露通道）：
    尾部 8 位数字构成合法 YYYYMMDD（年 1900-2099、月 01-12、日 01-31）即认定
    为日期而非受试者编号。

    受试者编号不受影响的原因：真实形态如 A1234567 只有 7 位数字；
    S0001234 的"0012"月份非法；A20260610 这类同时是合法日期的形态由
    DATE_PATTERNS 以日期口径处置（纯日期 WARN），仍在检测覆盖之内，
    不会静默放行。
    """
    digits = re.sub(r'^[A-Za-z]+', '', matched_text.strip())
    return len(digits) == 8 and bool(_YYYYMMDD_RE.match(digits))


# ---------------------------------------------------------------------------
# 文档编号 vs USUBJID 的纯格式判据
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 标准 UUID（技术标识）判据 — E2E-4 口径在文本内嵌形态的延伸
# ---------------------------------------------------------------------------
_UUID_RE = re.compile(
    r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE)


def strip_uuids(text: str) -> str:
    """剥离文本中的标准 UUID（消息/调用 id 等技术标识）。"""
    return _UUID_RE.sub(' ', text)


def ends_with_alpha_segment(matched_text: str) -> bool:
    """判断 kebab 多段标识是否以纯字母段结尾（文档/项目编号形态）。

    临床编号结构判据：USUBJID 的最后一段是受试者序号（数字段），
    如 010-001-1001、STUDY-SITE-001、STUDY001-SITE01-SUBJ001；
    项目文档编号以语义段（纯字母）结尾，如 DS5565-0002-NIS-MA、
    CGB3002-TEST。字母段结尾的受试者序号不存在于 CDISC 实践。

    用于 llm/stream 出域侧对 DSH meta.lines 投影（post-execute 之后附加、
    写入侧脱敏不可达）中文档标题的放行；真实 USUBJID 末段为数字，
    不受影响。
    """
    segments = str(matched_text).strip().split('-')
    return bool(segments) and bool(re.fullmatch(r'[A-Za-z]+', segments[-1]))


# ---------------------------------------------------------------------------
# 操作性标识（文件路径/文件名）— agent 必须原样回传给工具，任何车道不得改写
# ---------------------------------------------------------------------------
# 真实缺陷（2026-08-20 工作台实测）：写入侧把路径中的模式形态 token 化，
# 模型拿着 "G:\...\CGB3002-TEST\[SUBJ:d1b1c9f9].txt" 假路径去读文件，
# not found 直接断掉工作流。用户规则：文件路径/文件名是辅助读取的操作性
# 数据，不属于临床数据值，写入/出域/工具参数三车道一律原样放行。
# 覆盖形态：Windows 盘符路径（含 JSON 转义双反斜杠）、UNC、Unix 绝对
# 路径、带扩展名的文件名 token（扩展名须以字母开头——排除 4.0/1.5e3 数值）。
# 接受的残余风险（ST-D-5 同类，用户明示接受）：文件名/路径内嵌的受试者号
# 形态串对模型可见——操作性需要。

_OPERATIONAL_PATH_RES = [
    # Windows 盘符（G:\x\y 或 JSON 转义 G:\\x\\y，容忍正反斜杠混用）
    re.compile(r'[A-Za-z]:[\\/]+(?:[^\\/:*?"<>|\r\n\\/]+[\\/]+)*[^\\/:*?"<>|\r\n\\/]*'),
    # UNC（\\server\share\... 或转义形态）
    re.compile(r'(?:\\\\|//)[^\\/:*?"<>|\r\n\\/]+(?:[\\/]+[^\\/:*?"<>|\r\n\\/]+)+'),
    # Unix 绝对路径（至少两段，避免误吞 "and/or" 类散文）
    re.compile(r'(?<![\w.])(?:/[\w.\-]+)+/?'),
    # 相对多段路径，必须以带扩展名的文件名收尾（ADAV-008-CP4\\...zip、
    # YL202-CN-301-01\\20260318.zip——meta.paths 的真实形态）。收尾约束
    # 排除 "A1234567\\n" 类转义序列被误当路径造成数据值逃逸。
    re.compile(r'[\w\-. ]{1,64}(?:[\\/][\w\-. ]{1,64}){1,}\\[\\/]?'
               r'[\w\-.]{1,120}\.[A-Za-z]\w{0,7}\b'
               r'|[\w\-. ]{1,64}[\\/][\w\-.]{1,120}\.[A-Za-z]\w{0,7}\b'),
]
# 带扩展名的文件名 token（扩展名首字符须为字母）。允许文件名内部空格
# （真实交付物大量含空格：DM Status Report_14Aug2026.xlsx、_14 Aug 2026.xlsx），
# 但紧邻扩展名点的字符必须非空格——排除 "x 101-001 .txt" 式伪造。
_FILENAME_TOKEN_RE = re.compile(r'[\w\-. ]{0,118}[\w\-]\.[A-Za-z]\w{0,7}\b')


def operational_spans(text: str) -> list:
    """文本中操作性标识（路径/文件名）的 (start, end) 区间列表。"""
    spans = []
    for regex in _OPERATIONAL_PATH_RES:
        for m in regex.finditer(text):
            spans.append((m.start(), m.end()))
    for m in _FILENAME_TOKEN_RE.finditer(text):
        spans.append((m.start(), m.end()))
    return spans


def in_operational_span(spans, start: int, end: int) -> bool:
    """命中片段是否完整落在某个操作性标识区间内。"""
    return any(a <= start and end <= b for a, b in spans)


def is_uuid_context(text: str, start: int, end: int) -> bool:
    """命中片段是否完整落在某个标准 UUID 内。

    DSH 消息 id（如 c25e2638-0ced-4330-86ae-728287fcdeaa）会内嵌在工具结果
    的序列化文本里，其前三段（各含数字）被 USUBJID 三段式截取命中。UUID 是
    技术标识而非受试者编号（E2E-4 已确立消息/调用 id 不承载临床数据）。
    真实 USUBJID 是 010-001-1001 型短编号，非 8-4-4-4-12 hex。
    """
    for match in _UUID_RE.finditer(text):
        if start >= match.start() and end <= match.end():
            return True
    return False

def is_safe_filename_date(text: str, start: int, end: int) -> bool:
    """仅当敏感命中完整落在带扩展名的文件名内时豁免。"""
    for match in SAFE_FILENAME_CONTEXT_RE.finditer(text):
        if start >= match.start() and end <= match.end():
            return True
    return False


# ---------------------------------------------------------------------------
# 错误消息统一脱敏 (FIX-3 / R-6 / AR-2.9)
# ---------------------------------------------------------------------------
# 孤立代理字符（\ud800-\udfff）：JSON 传输可携带，UTF-8 编码必崩，必须清除。
_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")

# 路径形态：Windows 盘符路径 / UNC 路径 / Unix 绝对路径（含反斜杠形式）。
_PATH_RES = [
    re.compile(r'[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*'),
    re.compile(r'\\\\[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n]+)+'),
    re.compile(r'(?<![\w.])/(?:[\w.-]+/)+[\w.-]*'),
]


def clean_surrogates(text: object, replacement: str = "\ufffd") -> str:
    """孤立代理字符（lone surrogate，如 \\udcae）统一替换为 U+FFFD。

    JSON 输入可合法携带 \\udXXX 孤立代理（Node JSON.stringify 会原样输出），
    但 Python stdout 以 UTF-8 编码时会抛 UnicodeEncodeError 杀死 worker/extractor。
    所有出域文本（worker 响应、extractor stdout）必须先过本函数。
    """
    return _SURROGATE_RE.sub(replacement, str(text))


def sanitize_error(text: object, limit: int = 200) -> str:
    """错误回执统一脱敏：先清孤立代理，再路径→[PATH]、受试者/日期→占位，截断。"""
    s = clean_surrogates(text)
    for pattern, label in SUBJECT_ID_PATTERNS:
        s = pattern.sub(f"[SUBJ]", s)
    for pattern, _label in DATE_PATTERNS:
        s = pattern.sub("[DATE]", s)
    for pattern in _PATH_RES:
        s = pattern.sub("[PATH]", s)
    s = re.sub(r"[\r\n\t]+", " ", s)
    return s[:limit]


def stable_hash(value: object, length: int = 24) -> str:
    """统一单向哈希上下文 (FIX-9.4)：审计与授权记录使用同一哈希算法，可相互关联。

    ST-P3-x: 加固版——加 HMAC 盐（固定部署内盐，防字典反查低熵身份如 "admin"/"user1"）。
    盐从 EMERALD_HASH_SALT 环境变量读取；无盐时退回纯 SHA-256（兼容无环境变量部署）。
    """
    import os
    import hmac
    raw = str(value if value not in (None, "") else "anonymous").encode("utf-8")
    salt = os.environ.get("EMERALD_HASH_SALT", "").encode("utf-8")
    if salt:
        digest = hmac.new(salt, raw, hashlib.sha256).hexdigest()
    else:
        digest = hashlib.sha256(raw).hexdigest()
    return digest[:length]
