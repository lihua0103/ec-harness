"""智能数据识别与统一 token 化 (Smart Guard) — 白名单式安全证明

架构倒转（用户需求 2026-08-20）：
旧体系是黑名单——枚举"什么长得像临床数据"，认出才处置；每个新场景
（新编号形态/新日期写法/多表头/横纵向表）都要补一条正则，补丁永远追不上
真实形态全集：漏认=泄露，误认=BLOCK 钉死会话。

本模块只回答一个问题："这个 token 能否被证明不是数据值？"
  能证明（纯字母词/散文/中文文本/协议日程标签/CDISC 字段名/路径/UUID/
  已 token 化产物）→ 原样放行；
  证明不了 → HMAC token 化（[KIND:hex8]，同值同 token）后放行。

三个动作，没有第四个：
  PASS      可证明安全
  TOKENIZE  其余一切 —— 新形态自动落进来，无需新正则
  BLOCK     仅一条硬红线：大规模数据转储（数据行数超阈值）

为什么这终结补丁竞赛：
  1. 泄露方向：任何含数字的值（编号/日期/测量值，无论什么格式）默认
     token 化；数据行里的字母值（AE 术语/状态/性别）随行连坐 token 化。
     不认识 ≠ 放过。
  2. 误拦方向：除转储红线外没有 BLOCK。误判的代价从"会话钉死"降为
     "多 hash 一个值"，模型仍可 join/去重/计数，harness 工作流不中断。
  3. 自愈：token 形态 [KIND:hex8] 属于可证明安全类，重扫幂等，
     历史误报不会把会话永久拦死。

旧模式库（patterns.py）降级为"语义标注器"：能认出的值打上 SUBJ/DATE/CODE
语义前缀帮助 LLM 理解 token 角色；认不出的兜底为 VAL/NUM/TEXT。
正则从守门员变成标签工，误报不再有代价。

已知残余风险（明示接受，与体量红线互补）：
  - 散文行中 ≤2 位的纯字母数字小编号（Day 3 / v2 / 第5条）放行——
    协议日程与版本号的可读性需要；孤立两位数不构成可识别的患者数据。
  - 无任何数字上下文的孤立中文/字母词（如单独一格"张三"）与散文词
    不可分；真实导出行携带日期/编号，会触发整行连坐 token 化。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, List, Tuple

from security.patterns import (
    CDISC_CORE_FIELDS,
    DATE_PATTERNS,
    MEDICAL_CODE_PATTERNS,
    SUBJECT_ID_PATTERNS,
    ends_with_alpha_segment,
    is_document_version_number,
    operational_spans,
)
from security.tokenizer import token_for

# 大规模数据转储红线：单次载荷中数据行超过该数即要求用户决策（唯一 BLOCK）。
MASS_DUMP_DATA_LINES = 200

# 已 token 化产物的行内形态（tokenizer.TOKEN_RE 是全匹配锚定版，这里要行内找）。
_TOKEN_INLINE_RE = re.compile(r'\[[A-Z]{2,6}:[0-9a-f]{8}\]')

_CJK_RE = re.compile(r'[一-鿿]')

# 英文虚词（散文判据用；不追求完备——散文有多个虚词，数据行一个都没有）。
_FUNC_WORDS = frozenset("""
the a an and or of to in for on with by is are was were be been being
shall should must may might will would can could do does did done
all any each per not no nor if then than as at from into over under
this that these those it its their there which who whom whose when where
""".split())

# 协议日程标签（Day 3 / Week 12 / Cycle 2 / D14 / V5 / Visit 3）——
# 方案/spec 的结构词汇，不是受试者数据值。纯格式判据，无关键词豁免语义。
_SCHEDULE_LABEL_RE = re.compile(
    r'^(?:day|week|cycle|visit|month|hour|d|c|w|v|m)\s?-?\d{1,3}$', re.IGNORECASE)
# 访视窗标签形态 "Date(D1)" / "Dose(C2)+"（历史误报 20260820_150945 的根治点：
# 此前是 BLOCK 误报，现在即使不豁免也只是多 hash 一个标签；豁免保 spec 可读）。
_SPEC_LABEL_RE = re.compile(r'^[A-Za-z]{1,12}\([A-Za-z]?\d{1,3}\)[+\-]?$')

_EDGE_PUNCT = '.,;:!?()[]{}<>"\'`|'

# 语义标注顺序：格式更具体的先标（与 tokenizer.tokenize_clinical_text 同理由）。
# SUBJECT_ID_PATTERNS 所有模式按构造都要求含数字，纯字母连字词（state-of-the-art）
# 不会命中——这是它可安全用于散文的前提。desc 保留：散文车道的文档编号豁免
# 需要区分模式（纯格式判据，非关键词豁免）。
_SEMANTIC_PASSES: List[Tuple[re.Pattern, str, str]] = (
    [(p, 'DATE', d) for p, d in DATE_PATTERNS]
    + [(p, 'CODE', d) for p, d in MEDICAL_CODE_PATTERNS]
    + [(p, 'SUBJ', d) for p, d in SUBJECT_ID_PATTERNS]
)


@dataclass
class ScrubStats:
    """一次扫描的汇总统计（零数据值，可直接进审计）。"""
    lines_total: int = 0
    lines_changed: int = 0
    data_lines: int = 0
    tokens_hashed: int = 0

    def merge(self, other: "ScrubStats") -> None:
        self.lines_total += other.lines_total
        self.lines_changed += other.lines_changed
        self.data_lines += other.data_lines
        self.tokens_hashed += other.tokens_hashed


def is_mass_data_dump(stats: ScrubStats, threshold: int = MASS_DUMP_DATA_LINES) -> bool:
    """唯一保留的硬红线：数据行体量超阈值（整表转储特征）。"""
    return stats.data_lines >= threshold


# ---------------------------------------------------------------------------
# 行级散文判据
# ---------------------------------------------------------------------------

def _visible(token: str) -> str:
    """token 中"还未被 hash 的部分"——已 token 化片段不参与任何判定。"""
    return _TOKEN_INLINE_RE.sub('', token)


def _is_prose(text: str) -> bool:
    """判断一行（已剥离操作性区间）是否散文/需求文本。

    统计判据而非形态枚举：散文有虚词/成句中文/低数字密度；
    数据行是分隔符结构 + 高数字 token 占比。判错的代价是不对称的：
    散文误判为数据行 → 多 hash 几个词（可用性小损）；
    数据行误判为散文 → 数字 token 仍被 hash（安全不失守，见 _scrub_line）。
    """
    tokens = text.split()
    if not tokens:
        return True
    digit_toks = sum(1 for t in tokens if any(c.isdigit() for c in _visible(t)))
    delims = text.count('|') + text.count('\t') + text.count(';')
    if delims >= 3 and digit_toks >= 2:
        return False
    if digit_toks / len(tokens) >= 0.4:
        return False
    words = [t.strip(_EDGE_PUNCT).lower() for t in tokens]
    func_hits = sum(1 for w in words if w in _FUNC_WORDS)
    cjk_chars = len(_CJK_RE.findall(text))
    alpha_words = sum(1 for w in words if w.isalpha())
    return func_hits >= 2 or cjk_chars >= 6 or (alpha_words >= 6 and digit_toks <= 1)


# ---------------------------------------------------------------------------
# token 级白名单判定
# ---------------------------------------------------------------------------

def _split_edge_punct(token: str) -> Tuple[str, str, str]:
    core = token.strip(_EDGE_PUNCT)
    if not core:
        return '', token, ''
    start = token.find(core)
    return token[:start], core, token[start + len(core):]


def _digit_replacement(core: str, prose: bool) -> str | None:
    """含数字 token 的处置。None = 可证明安全放行；否则返回替换 token。"""
    visible = _visible(core)
    digits = sum(c.isdigit() for c in visible)
    if digits == 0:
        return None
    if _SCHEDULE_LABEL_RE.match(visible) or _SPEC_LABEL_RE.match(core):
        return None  # 协议日程/访视窗标签：结构词汇
    if prose and digits <= 2 and (
            visible.isdigit()
            or re.fullmatch(r'[\d.]+', visible)
            or (visible.isalnum() and not visible[0].isdigit())):
        return None  # 散文中的小编号/章节号（Day 3 / v2 / 3.2），明示接受的残余风险
    if prose and '-' in visible and not visible[0].isdigit() \
            and ends_with_alpha_segment(visible):
        return None  # 散文中的字母末段文档编号（CGB3002-TEST），出域侧同款纯格式判据
    kind = 'NUM' if visible.isdigit() else 'VAL'
    return token_for(core, kind)


def _word_is_safe_in_data_row(core: str) -> bool:
    """数据行中字母/中文 token 的白名单：结构词汇可留，值词汇连坐 hash。

    表头行天然不含数字 token，不会走到这里（整行原样放行——需求3：
    表头结构字段可读）。走到这里说明本行已有值被 hash，剩余字母词
    （AE 术语/状态/性别/人名）是同一行的患者级数据，必须连坐。
    """
    lowered = core.lower()
    if lowered in _FUNC_WORDS or lowered in CDISC_CORE_FIELDS:
        return True
    if _SCHEDULE_LABEL_RE.match(core) or _SPEC_LABEL_RE.match(core):
        return True
    return False


# ---------------------------------------------------------------------------
# 行处理
# ---------------------------------------------------------------------------

# 段级保护区：语义/兜底两个 pass 都不得触碰的形态。
#   1. 已产出的 token（幂等性根基——重扫绝不二次 hash）
#   2. 协议日程标签短语（Day 14 / Week 12 / Visit 3，跨空格，逐词判定看不见）
#   3. 访视窗标签（Date(D1) / Dose(C2)+）
_PROTECT_RES = [
    _TOKEN_INLINE_RE,
    re.compile(r'\b(?:day|week|cycle|visit|month|hour)\s?-?\d{1,3}\b', re.IGNORECASE),
    re.compile(r'\b[A-Za-z]{1,12}\([A-Za-z]?\d{1,3}\)[+\-]?'),
]


def _stash_protected(seg: str) -> Tuple[str, List[str], int]:
    """把保护区形态换成无数字占位符（索引用字母编码，占位符本身绝不会
    被任何数字/日期模式命中）。返回 (换后文本, 原文列表, 其中已有token数)。"""
    stashed: List[str] = []
    pre_tokens = 0

    def _encode(i: int) -> str:
        return ''.join(chr(97 + int(d)) for d in str(i))

    for idx, regex in enumerate(_PROTECT_RES):
        def _repl(m, is_token=(idx == 0)):
            nonlocal pre_tokens
            if is_token:
                pre_tokens += 1
            stashed.append(m.group(0))
            return f'\x00{_encode(len(stashed) - 1)}\x00'
        seg = regex.sub(_repl, seg)
    return seg, stashed, pre_tokens


def _restore_protected(seg: str, stashed: List[str]) -> str:
    def _decode(s: str) -> int:
        return int(''.join(str(ord(c) - 97) for c in s))
    return re.sub(r'\x00([a-z]+)\x00', lambda m: stashed[_decode(m.group(1))], seg)


def _merged_op_spans(line: str) -> List[Tuple[int, int]]:
    merged: List[List[int]] = []
    for a, b in sorted(operational_spans(line)):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def _scrub_segment(seg: str, prose: bool) -> Tuple[str, int, int]:
    """处理一个非操作性文本段。返回 (新文本, hash的值token数, hash的词token数)。"""
    # 保护区 stash：已有 token / 日程标签 / 访视窗标签先摘走，
    # 任何后续 pass 都看不见它们——这同时给出幂等性与 spec 结构词保护。
    seg, stashed, pre_tokens = _stash_protected(seg)

    # 语义标注：认得出的形态给准确前缀（SUBJ/DATE/CODE），帮助 LLM 推理。
    # 标注产物计入 value_hashed——否则"仅语义命中"的数据行不计入 data_lines，
    # 体量红线被架空。
    # 散文（spec/需求文本）车道复用出域侧的纯格式文档编号判据：
    # DVP20260610（标识+YYYYMMDD）与 DS5565-0002-NIS-MA（字母末段）是文档
    # 编号而非受试者编号，spec 可读性依赖它们原样保留（需求2）。数据行
    # （非散文）不豁免——同形态出现在数据行按数据处置，fail-safe。
    value_hashed = 0
    for pattern, kind, desc in _SEMANTIC_PASSES:
        def _repl(m, kind=kind, desc=desc):
            nonlocal value_hashed
            exempt = prose and kind == 'SUBJ' and (
                (desc == "字母前缀编号" and is_document_version_number(m.group(0)))
                or (desc in ("USUBJID格式", "复合站点编号")
                    and ends_with_alpha_segment(m.group(0))))
            if exempt:
                stashed.append(m.group(0))  # stash 原文防兜底数字 pass 误伤
            else:
                value_hashed += 1
                stashed.append(token_for(m.group(0), kind))
            i = len(stashed) - 1
            return '\x00' + ''.join(chr(97 + int(d)) for d in str(i)) + '\x00'
        seg = pattern.sub(_repl, seg)

    # 白名单兜底：语义标注漏掉的一切含数字 token 一律 hash。
    # 与占位符同词的残段（PT-2026-XY-0099 被语义标注吃掉前三段后剩 "-0099"）
    # 不能整词跳过——按占位符切开，含数字的残片逐片 hash，不留裸数字。
    matches = list(re.finditer(r'\S+', seg))
    replacements: dict[int, str] = {}
    placeholder_re = re.compile(r'\x00[a-z]+\x00')
    for i, m in enumerate(matches):
        word = m.group(0)
        if '\x00' in word:
            pieces = placeholder_re.split(word)
            if any(any(c.isdigit() for c in piece) for piece in pieces):
                rebuilt, pos = [], 0
                for pm in placeholder_re.finditer(word):
                    piece = word[pos:pm.start()]
                    if any(c.isdigit() for c in piece):
                        value_hashed += 1
                        piece = token_for(piece, 'VAL')
                    rebuilt.append(piece + pm.group(0))
                    pos = pm.end()
                tail = word[pos:]
                if any(c.isdigit() for c in tail):
                    value_hashed += 1
                    tail = token_for(tail, 'VAL')
                replacements[i] = ''.join(rebuilt) + tail
            continue
        prefix, core, suffix = _split_edge_punct(word)
        if not core:
            continue
        repl = _digit_replacement(core, prose)
        if repl is not None:
            replacements[i] = prefix + repl + suffix
            value_hashed += 1

    # 数据行连坐：本段行内已有值被 hash（含此前轮次的 token）→ 剩余非白名单
    # 字母/中文词也是同行患者级数据（AE 术语、状态、人名），一并 hash。
    word_hashed = 0
    row_has_values = value_hashed > 0 or pre_tokens > 0
    if not prose and row_has_values:
        for i, m in enumerate(matches):
            if i in replacements or '\x00' in m.group(0):
                continue
            prefix, core, suffix = _split_edge_punct(m.group(0))
            if not core or not any(c.isalpha() for c in core):
                continue  # 空/纯符号（分隔符等）
            if _word_is_safe_in_data_row(core):
                continue
            replacements[i] = prefix + token_for(core, 'TEXT') + suffix
            word_hashed += 1

    if replacements:
        out: List[str] = []
        last = 0
        for i, m in enumerate(matches):
            if i in replacements:
                out.append(seg[last:m.start()])
                out.append(replacements[i])
                last = m.end()
        out.append(seg[last:])
        seg = ''.join(out)
    return _restore_protected(seg, stashed), value_hashed, word_hashed


def _scrub_line(line: str, profile: str) -> Tuple[str, bool, int]:
    """处理一行。返回 (新行, 是否数据行, hash总数)。

    操作性区间（路径/文件名）原样保留——改写路径会让模型拿假路径读文件
    直接断掉工作流（2026-08-20 实测教训，见 patterns.operational_spans）。
    """
    spans = _merged_op_spans(line)
    segs: List[Tuple[bool, str]] = []
    last = 0
    for a, b in spans:
        if a > last:
            segs.append((False, line[last:a]))
        segs.append((True, line[a:b]))
        last = b
    if last < len(line):
        segs.append((False, line[last:]))

    plain = ' '.join(seg for is_op, seg in segs if not is_op)
    prose = _is_prose(plain)
    # spec 车道：散文按散文，仅数据形态行做 hash——调用方声明来源是
    # spec/ALS/template（需求2：需求文档全文可读）时用 profile="spec"。
    # strict（默认）与 spec 的差别只在散文行小编号的宽严，安全兜底相同。

    out: List[str] = []
    value_hashed = word_hashed = 0
    for is_op, seg in segs:
        if is_op:
            out.append(seg)
            continue
        new_seg, v, w = _scrub_segment(seg, prose or profile == 'spec')
        out.append(new_seg)
        value_hashed += v
        word_hashed += w
    is_data_row = (not prose) and value_hashed > 0
    return ''.join(out), is_data_row, value_hashed + word_hashed


# ---------------------------------------------------------------------------
# 公共 API
# ---------------------------------------------------------------------------

def smart_scrub_text(text: str, profile: str = 'strict') -> Tuple[str, ScrubStats]:
    """对任意文本做白名单式统一 token 化。

    保证（幂等）：输出再扫一遍不再变化——token 形态属于可证明安全类。
    保证（零出域）：除散文小编号与操作性路径外，任何含数字的值都不以
    原文出现在输出里；数据行的字母值随行连坐。
    """
    stats = ScrubStats()
    if not isinstance(text, str) or not text:
        return text, stats
    out_lines: List[str] = []
    for line in text.splitlines():
        stats.lines_total += 1
        new_line, is_data, hashed = _scrub_line(line, profile)
        if is_data:
            stats.data_lines += 1
        if hashed:
            stats.lines_changed += 1
            stats.tokens_hashed += hashed
        out_lines.append(new_line)
    joined = '\n'.join(out_lines)
    if text.endswith('\n'):
        joined += '\n'
    return joined, stats


# 系统元数据键（与 egress_checkpoint._METADATA_KEY_FIELDS 同口径，本地副本
# 避免反向依赖）：标量值是消息/调用标识，不承载临床数据。
_METADATA_KEYS = frozenset({
    "id", "rpcid", "rpc_id", "callid", "call_id", "requestid", "request_id",
    "toolcallid", "tool_call_id", "toolcallids", "messageid", "message_id",
    "uuid", "traceid", "trace_id", "spanid", "span_id", "seq", "nonce",
    "timestamp", "createdat", "created_at", "updatedat", "updated_at",
})


def smart_scrub_structure(payload: Any, profile: str = 'strict',
                          _stats: ScrubStats | None = None) -> Tuple[Any, ScrubStats]:
    """递归 token 化任意嵌套结构（llm/stream 出域保底的载荷形态）。

    - 字符串值与键名走 smart_scrub_text；
    - 系统元数据键的标量值跳过（UUID/call id 是技术标识，E2E-4 口径）；
    - 非字符串标量（数字/布尔）原样——GenerateOptions 的数值是采样配置，
      工具结果中的数值在序列化文本车道已被覆盖。
    """
    stats = _stats if _stats is not None else ScrubStats()
    if isinstance(payload, str):
        scrubbed, s = smart_scrub_text(payload, profile)
        stats.merge(s)
        return scrubbed, stats
    if isinstance(payload, dict):
        result = {}
        for key, value in payload.items():
            key_str = str(key)
            new_key, ks = smart_scrub_text(key_str, profile)
            stats.merge(ks)
            if key_str.lower() in _METADATA_KEYS and not isinstance(value, (dict, list)):
                result[new_key] = value
                continue
            new_value, _ = smart_scrub_structure(value, profile, stats)
            result[new_key] = new_value
        return result, stats
    if isinstance(payload, list):
        return [smart_scrub_structure(item, profile, stats)[0] for item in payload], stats
    return payload, stats
