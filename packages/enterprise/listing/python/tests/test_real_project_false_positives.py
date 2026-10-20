"""真实项目回归（RT01，2026-10-20）：稀疏列/小表元数据/常量列不得误入保护索引。

这些用例来自真实 Manual Listing 会话的实测缺陷，用合成数据复现同一形态：
- 稀疏码表列（69 行仅 4 个非空、2 个唯一值）曾被按受试者数据保护；
- 小表（<20 行）的 EDC 元数据常量列曾被灌回索引；
- 受试者标识列在极小表下曾被常量豁免（红线回退）。

红线断言与误拦断言成对出现，防止为减少误拦而放宽保护面。
"""
import pandas as pd

import worker


def test_sparse_codelist_column_not_indexed():
    """稀疏列：整列 69 行、仅 4 个非空值、2 个唯一码表值 → 词表，不入索引。"""
    values = ["RELATED", "NOT RELATED", None, None] + [None] * 65
    frame = pd.DataFrame({"AEREL": values, "USUBJID": [f"100{i % 5}" for i in range(69)]})
    hashes = worker.protected_value_hashes({"AE": frame}, [])
    assert worker.text_contains_protected_value("relation RELATED noted", hashes) is False
    # 红线：同表的受试者号仍受保护
    assert worker.text_contains_protected_value("subject 1003", hashes) is True


def test_small_table_edc_metadata_constant_not_indexed():
    """小表（15 行）的 DataPageName 整列同值 → 元数据，不入索引。"""
    frame = pd.DataFrame({
        "DataPageName": ["Adverse Events"] * 15,
        "USUBJID": [f"200{i}" for i in range(15)],
    })
    hashes = worker.protected_value_hashes({"AEYN": frame}, [])
    assert worker.text_contains_protected_value("page Adverse Events opened", hashes) is False
    assert worker.text_contains_protected_value("subject 2007", hashes) is True


def test_constant_column_exemption_requires_evidence_rows():
    """单行/极少行的唯一值不是"常量"证据：SUBJID=1007 必须仍受保护。"""
    frame = pd.DataFrame({"SUBJID": ["1007"], "FORMNM": ["Visit Date"]})
    hashes = worker.protected_value_hashes({"AE": frame}, [])
    assert worker.text_contains_protected_value("subject 1007", hashes) is True


def test_identifier_columns_never_exempt():
    """标识类列名即便整列同值也不豁免（受试者级标识）。"""
    for column in ("USUBJID", "SUBJID", "PATIENT", "DOB"):
        frame = pd.DataFrame({column: ["S-9001"] * 30})
        hashes = worker.protected_value_hashes({"DM": frame}, [])
        assert worker.text_contains_protected_value("id S-9001 seen", hashes) is True, column


def test_study_level_constant_is_not_treated_as_identifier():
    """方案号（PSTUDYID）是整项目常量，不属个体标识，不应被标识闸门误拦。"""
    big = pd.DataFrame({"PSTUDYID": ["GQ1005-301"] * 40,
                        "SUBJID": [f"{1000 + i}" for i in range(40)]})
    hashes = worker.protected_value_hashes({"AE": big}, [])
    assert worker.text_contains_protected_value("project GQ1005-301", hashes) is False
    assert worker.text_contains_protected_value("subject 1017", hashes) is True


def test_high_cardinality_columns_stay_protected():
    """高基数列（逐行数据）任何情况下都必须受保护。"""
    frame = pd.DataFrame({
        "USUBJID": [f"S{index:04d}" for index in range(60)],
        "AETERM": [f"Term {index}" for index in range(60)],
        "LBORRES": [f"{index * 1.5}" for index in range(60)],
    })
    hashes = worker.protected_value_hashes({"LB": frame}, [])
    for probe in ("subject S0017", "term Term 42", "result 63.0"):
        assert worker.text_contains_protected_value(probe, hashes) is True, probe
