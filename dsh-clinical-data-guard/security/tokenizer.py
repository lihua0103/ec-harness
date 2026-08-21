"""临床数据的会话级 HMAC token 化 (数据脱敏引擎)。

设计目标（用户方案）：数据区单元格值一律替换为不可逆 token，spec/需求文本放行。

为什么用 HMAC 而不是裸 SHA-256：
临床数据是低熵的（受试者号几千个、日期约 3.6 万个、AE 分级就几档），裸哈希
可被攻击者穷举建字典秒级反查。HMAC(会话密钥, 值) 引入 256-bit 会话密钥后：
  1. 不可逆：无密钥无法从 token 还原值，也无法建字典（密钥每会话不同）。
  2. 抗字典/彩虹表：同一值在不同会话得到不同 token。
  3. 保结构：同一会话内同值同 token，LLM 仍可 join/去重/计数/推理，不丢分析能力。

会话密钥仅存在于 worker 进程内存（os.urandom(32)），绝不落盘、绝不出域。
进程退出即失效，历史 token 无法再被关联——满足红线 R-6（审计不含可逆身份）。
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re

# 会话密钥：worker 进程启动时一次性生成，仅内存。绝不落盘/出域/写审计。
_SESSION_KEY = os.urandom(32)

# token 短长度：8 hex = 32 bit，足够在单会话内避免碰撞，又不冗长。
_TOKEN_LEN = 8


def _normalize(value: str) -> str:
    """归一化后再 token 化：确保 " A1234567 "、"a1234567" 映射到同一 token
    （大小写、首尾空白无关），与检测侧大小写无关口径一致。"""
    return value.strip().casefold()


def token_for(value: object, kind: str = "VAL") -> str:
    """把一个数据值替换为不可逆、可关联的 token。

    Args:
        value: 原始单元格值（任意类型，内部字符串化）。
        kind:  语义前缀（SUBJ/DATE/CODE/NUM/TEXT），便于 LLM 理解 token 的角色。

    Returns:
        形如 ``[SUBJ:a3f9c2b1]`` 的 token。同一会话内同值同 token。
    """
    digest = hmac.new(_SESSION_KEY, _normalize(str(value)).encode("utf-8"), hashlib.sha256)
    return f"[{kind}:{digest.hexdigest()[:_TOKEN_LEN]}]"


def token_sub(pattern: re.Pattern, text: str, kind: str) -> str:
    """把 text 中所有命中 pattern 的片段替换为各自的 token（同值同 token）。"""
    return pattern.sub(lambda m: token_for(m.group(0), kind), text)


# ---------------------------------------------------------------------------
# 临床值 token 化单一来源 (双车道口径统一)
# ---------------------------------------------------------------------------
# 历史缺陷：post-execute 车道（data_egress_guard._light_scrub）做 token 化脱敏，
# 而 llm/stream 出域车道（egress_checkpoint）只有"放行/抛异常"两个动作，从不
# token 化。结果是写入车道宽、读出车道严，原值进了会话历史却永远出不去，
# 一条误报即把整个会话永久钉死。两车道现在共用下面这一个函数，口径不再漂移。


# token 形态: [KIND:hex8]，KIND 为 SUBJ/DATE/CODE/NUM/TEXT/VAL 等语义前缀。
TOKEN_RE = re.compile(r'^\[[A-Z]{2,6}:[0-9a-f]{%d}\]$' % _TOKEN_LEN)


def is_token(value: object) -> bool:
    """判断字符串是否已是本模块产出的脱敏 token。

    已 token 化的值是脱敏产物、不是临床数据值。检测侧必须承认这一点，否则
    "字段名 + token" 仍被判为"字段名 + 数据值"而阻断——脱敏保底就永远无法
    让请求通过，token 化等于白做。
    """
    return bool(TOKEN_RE.match(str(value).strip()))


def _token_sub_despaced(pattern: re.Pattern, text: str, kind: str) -> str:
    """同 token_sub，但哈希前先剥离命中片段内的空白。

    使 "DVP 20260610" 与 "DVP20260610" 映射到同一 token（同一标识的不同书写
    形态在单会话内保持可关联），并让脱敏覆盖检测侧归一化能拼出的形态。
    """
    return pattern.sub(
        lambda m: token_for(re.sub(r"[ \t]+", "", m.group(0)), kind), text)


def tokenize_clinical_text(text: str) -> str:
    """把文本中的临床数据值替换为不可逆 HMAC token，保留非数据文本原样。

    替换顺序是语义正确性的关键：先替换格式更具体的日期与医学编码，再替换
    受试者编号——否则过宽的 USUBJID 三段式正则会把 2024-01-15 抢标成 SUBJ，
    令 token 语义前缀失真、误导 LLM（数据仍安全，仅前缀错）。

    Args:
        text: 原始文本（任意来源：单元格值、工具结果、消息内容）。

    Returns:
        数据值已 token 化的文本。同一会话内同值同 token，LLM 仍可 join/去重/计数。
    """
    from security.patterns import DATE_PATTERNS, _UUID_RE

    if not text or not isinstance(text, str):
        return text
    # UUID（消息/调用 id 等技术标识）不 token 化：stash 后还原，
    # 避免 LLM 丢失对消息 id 的引用（E2E-4 口径：技术标识不承载临床数据）。
    stashed: list = []
    def _stash_uuid(m):
        stashed.append(m.group(0))
        return f'\x00U{len(stashed) - 1}\x00'
    s = _UUID_RE.sub(_stash_uuid, text)
    # 全部临床日期 → token（模式库顺序：带时间在前，长格式先替换）
    for pattern, _label in DATE_PATTERNS:
        s = token_sub(pattern, s, 'DATE')
    # 医学编码 (PT:/LLT:/WHO:) → token — IGNORECASE 与检测侧口径一致
    s = token_sub(re.compile(r'\b(?:PT|LLT):\s*\d{8}\b', re.IGNORECASE), s, 'CODE')
    s = token_sub(re.compile(r'\bWHO:\s*\d{6}\b', re.IGNORECASE), s, 'CODE')
    # 受试者编号（字母前缀+数字）→ token — IGNORECASE 认小写绕过。
    # 允许字母与数字之间有空白：检测侧 scan_text 的归一化会删掉字母数字之间的
    # 空格（防 "A123 4567" 拆分绕过），因此 "DVP 20260610" 会被归一化拼成
    # "DVP20260610" 而命中。脱敏侧必须覆盖同样的形态，否则归一化制造出的命中
    # 无法被 token 化消除，rescan 仍然阻断，会话依旧钉死。
    # 哈希取空白剥离后的值，使 "DVP 20260610" 与 "DVP20260610" 得到同一 token。
    s = _token_sub_despaced(re.compile(r'\b[A-Z]{1,4}[ \t]*\d{6,8}\b', re.IGNORECASE), s, 'SUBJ')
    # 站点-编号格式 → token（同样容忍内部空白）
    s = _token_sub_despaced(re.compile(r'\b\d{3,4}[ \t]*-[ \t]*\d{3,6}\b'), s, 'SUBJ')
    # USUBJID 复合格式 (STUDY001-SITE01-SUBJ001) → token（放最后，最宽）
    s = token_sub(re.compile(r'\b[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+\b', re.IGNORECASE), s, 'SUBJ')
    return re.sub(r'\x00U(\d+)\x00', lambda m: stashed[int(m.group(1))], s)


def tokenize_structure(payload):
    """递归 token 化任意嵌套结构中的字符串值与键名。

    用于 llm/stream 出域保底：命中临床数据时不再一刀切拒绝整个请求，而是把
    数据值换成不可逆 token 后放行，模型拿到的是可推理但不可还原的形态。

    token 形态 ``[SUBJ:a3f9c2b1]`` 不匹配任何原始检测模式（无连字符、hex 混合
    字母数字），因此脱敏是幂等的：下一轮重扫同一段历史不会再次命中，会话
    可自愈——这正是"全量历史重扫钉死会话"的根治点。
    """
    if isinstance(payload, str):
        return tokenize_clinical_text(payload)
    if isinstance(payload, dict):
        return {tokenize_clinical_text(str(k)): tokenize_structure(v) for k, v in payload.items()}
    if isinstance(payload, list):
        return [tokenize_structure(item) for item in payload]
    return payload
