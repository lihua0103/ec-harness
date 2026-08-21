"""smart_guard 回归测试 — 历史线上事故全集 + 白名单架构不变量。

每个用例对应一次真实事故（patterns.py/egress_checkpoint.py 病历本）或一条
架构不变量。旧体系里这些事故各自吃掉一个正则补丁；新架构下它们必须
全部由同一套白名单判据覆盖，不允许再按场景加分支。

运行: python -m pytest tests/unit/test_smart_guard.py -q
  或: python tests/unit/test_smart_guard.py
"""
import re
import sys

import pytest

sys.path.insert(0, __file__.rsplit("tests", 1)[0])

from security.smart_guard import (
    ScrubStats,
    is_mass_data_dump,
    smart_scrub_structure,
    smart_scrub_text,
)

TOKEN_RE = re.compile(r'\[[A-Z]{2,6}:[0-9a-f]{8}\]')


def scrub(text, profile='strict'):
    return smart_scrub_text(text, profile)


# ============================================================================
# 不变量 1：幂等性 —— 任何输出重扫不变（会话自愈的根基，历史"钉死"根因）
# ============================================================================

IDEMPOTENCY_CORPUS = [
    "101-001 | 08 Jun 2026 | Screening | mild headache | 张三",
    "The subject listing shall be sorted by visit date for all subjects.",
    "Visit Date(D1) | Day 14 | Week 12",
    "PT-2026-XY-0099\t2026/6/8\t37.2\tfemale",
    r"G:\data\CGB3002-TEST\A1234567.xlsx not found",
    "Per DVP20260610 see DS5565-0002-NIS-MA.",
    "USUBJID: CGB3002-01-001 randomized 2026-06-08T10:00:00",
]


@pytest.mark.parametrize("text", IDEMPOTENCY_CORPUS)
def test_idempotent(text):
    once, _ = scrub(text)
    twice, stats2 = scrub(once)
    assert twice == once
    thrice, _ = scrub(twice)
    assert thrice == once


# ============================================================================
# 不变量 2：零出域 —— 数据值原文绝不出现在输出里
# ============================================================================

DATA_ROWS = [
    # (输入, 不允许出现在输出的原文片段)
    ("101-001 | 08 Jun 2026 | Screening | mild headache",
     ["101-001", "08 Jun 2026", "headache"]),
    # crViewer.xls 事故：Rave/EDC 导出日期时间
    ("Entry 08 Jun 2026 05:19:50 status enrolled subject 01001",
     ["08 Jun 2026", "05:19:50", "01001"]),
    # 新形态编号（不在任何 SUBJECT_ID 正则里）——白名单兜底必须抓住
    ("PT-2026-XY-0099\t2026/6/8\t37.2\tfemale",
     ["0099", "2026/6/8", "37.2"]),
    # 中文姓名/术语随行连坐
    ("102-003 | 2026-06-08 | 严重不良事件 | 张三",
     ["102-003", "2026-06-08", "张三"]),
    # 小写绕过 (ST-P1-1)
    ("a1234567 visited 01jan2024 site 101-001",
     ["a1234567", "01jan2024", "101-001"]),
    # CDISC 字段+值
    ("USUBJID: CGB3002-01-001 RFSTDTC: 2026-06-08",
     ["CGB3002-01-001", "2026-06-08"]),
]


@pytest.mark.parametrize("text,secrets", DATA_ROWS)
def test_no_egress(text, secrets):
    out, stats = scrub(text)
    for secret in secrets:
        assert secret not in out, f"数据值原文出域: {secret!r} in {out!r}"
    assert stats.tokens_hashed > 0


def test_unknown_format_still_tokenized():
    """架构核心：从未见过的编号/日期格式不需要新正则，默认 token 化。"""
    novel = "ZZZQ=88.77.66 [08-VI-2026] measure=99,4 unit"
    out, stats = scrub(novel)
    for secret in ("88.77.66", "08-VI-2026", "99,4"):
        assert secret not in out
    assert stats.tokens_hashed >= 3


# ============================================================================
# 不变量 3：无 BLOCK —— 除体量红线外任何内容都能产出可放行文本
# ============================================================================

def test_only_mass_dump_blocks():
    small = "\n".join(f"101-{i:03d} | 2026-06-01 | enrolled" for i in range(20))
    _, st = scrub(small)
    assert not is_mass_data_dump(st)
    big = "\n".join(f"101-{i:03d} | 2026-06-01 | enrolled" for i in range(250))
    _, st = scrub(big)
    assert is_mass_data_dump(st)


# ============================================================================
# 历史误报事故回归（旧体系每条 = 一次会话钉死；新体系必须原样放行）
# ============================================================================

def test_incident_visit_date_labels():
    """审计 20260820_150945：PDF spec 访视窗术语 13 连 BLOCK。"""
    out, st = scrub("Visit Date(D1) | Visit Date- Screening | Day 14 | Week 12 | C2")
    assert out == "Visit Date(D1) | Visit Date- Screening | Day 14 | Week 12 | C2"
    assert st.data_lines == 0


def test_incident_doc_version_numbers_in_spec():
    """DVP20260610 / SPEC20260610 文档版本号（字母前缀编号误报事故）。"""
    text = "Per DVP20260610 the template applies to this study."
    out, _ = scrub(text)
    assert "DVP20260610" in out


def test_incident_doc_id_alpha_tail_in_spec():
    """DS5565-0002-NIS-MA / CGB3002-TEST：字母末段文档编号（USUBJID 误报事故）。"""
    text = "The DS5565-0002-NIS-MA deliverable follows the CGB3002-TEST layout as planned."
    out, _ = scrub(text)
    assert "DS5565-0002-NIS-MA" in out and "CGB3002-TEST" in out


def test_incident_prose_not_merged_into_pseudo_ids():
    """2026-08-20 空格归一化事故：英文散文绝不该被处置。"""
    text = "The CGB3002 test seems to be a copy of the related project in RT01 and D1."
    out, st = scrub(text)
    assert st.data_lines == 0
    assert "seems to be a copy" in out


def test_incident_operational_paths_preserved():
    """路径 token 化事故：假路径断工作流。路径/文件名必须原样。"""
    text = r"read G:\home\DM\CGB3002-TEST\A1234567.xlsx and .\sub\DM Status Report_14Aug2026.xlsx"
    out, _ = scrub(text)
    assert r"G:\home\DM\CGB3002-TEST\A1234567.xlsx" in out


def test_incident_uuid_metadata_untouched():
    """E2E-4：消息/调用 UUID 是技术标识。"""
    payload = {"messages": [{"role": "user", "content": "check tool result"}],
               "id": "c25e2638-0ced-4330-86ae-728287fcdeaa",
               "tool_call_id": "call_991-223-11", "temperature": 0.2}
    out, _ = smart_scrub_structure(payload)
    assert out["id"] == "c25e2638-0ced-4330-86ae-728287fcdeaa"
    assert out["tool_call_id"] == "call_991-223-11"
    assert out["temperature"] == 0.2


def test_header_row_passes():
    """需求3：表头结构字段（含多表头场景的纯字段行）必须可读。"""
    for header in [
        "USUBJID | VISIT | VISITNUM | AESTDTC | LBORRES",
        "Subject\tSite\tScreening Date\tStatus",
        "受试者编号 | 访视 | 状态",
    ]:
        out, st = scrub(header)
        assert out == header, f"表头被改写: {out!r}"
        assert st.data_lines == 0


def test_spec_prose_chinese_passes():
    text = "本列表需按受试者编号与访视日期排序，筛选失败的受试者不纳入本次交付。"
    out, st = scrub(text)
    assert out == text
    assert st.data_lines == 0


# ============================================================================
# token 语义与可推理性
# ============================================================================

def test_same_value_same_token():
    """同值同 token：LLM 可 join/去重/计数。"""
    out, _ = scrub("101-001 | 2026-06-08 | enrolled\n101-001 | 2026-06-09 | visit2")
    tokens = TOKEN_RE.findall(out)
    lines = out.splitlines()
    subj0 = TOKEN_RE.findall(lines[0])[0]
    subj1 = TOKEN_RE.findall(lines[1])[0]
    assert subj0 == subj1
    assert subj0.startswith("[SUBJ:")


def test_semantic_prefixes():
    out, _ = scrub("101-001 | 08 Jun 2026 | PT: 10019211")
    assert "[SUBJ:" in out and "[DATE:" in out and "[CODE:" in out


# ============================================================================
# 结构化载荷（llm/stream 出域形态）
# ============================================================================

def test_structure_scrub_and_stats():
    payload = {"messages": [
        {"role": "system", "content": "You generate clinical listings from specs."},
        {"role": "user", "content": "row: 101-001 | 2026-06-08 | mild"},
    ]}
    out, stats = smart_scrub_structure(payload)
    text = str(out)
    assert "101-001" not in text and "2026-06-08" not in text
    assert "clinical listings" in text
    assert stats.data_lines == 1


def test_stats_merge():
    a, b = ScrubStats(1, 1, 1, 2), ScrubStats(2, 0, 1, 3)
    a.merge(b)
    assert (a.lines_total, a.data_lines, a.tokens_hashed) == (3, 2, 5)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
