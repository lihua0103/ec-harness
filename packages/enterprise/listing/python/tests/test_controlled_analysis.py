"""受控分析操作合同（方案 §6，T06）：只返回计数；输入必须是已登记句柄；
声明式算子白名单；键不唯一显式失败。全部使用合成数据。"""
from typing import Any

import pandas as pd
import pytest

import worker
from controlled_analysis import (
    AnalyzeRequestError,
    op_compare_artifacts,
    op_join_check,
    op_key_check,
    op_rule_check,
    op_schema,
)

DATASETS: dict[str, pd.DataFrame] = {
    "AE": pd.DataFrame({
        "USUBJID": ["S1", "S1", "S2", None],
        "AETERM": ["HA", "FEVER", "HA", "xx"],
        "SEV": [1, 2, 3, -4],
    }),
    "DM": pd.DataFrame({
        "USUBJID": ["S1", "S2", "S3"],
        "AGE": [50, 60, 70],
    }),
}


def test_key_check_counts_missing_and_duplicates():
    result = op_key_check(DATASETS, "AE", ["USUBJID"])
    assert result["totalRowCount"] == 4
    assert result["missingKeyRowCount"] == 1
    assert result["duplicateGroupCount"] == 1
    assert result["duplicateRowCount"] == 2
    assert result["uniqueConclusion"] == "duplicated"


def test_key_check_unique_conclusion():
    result = op_key_check(DATASETS, "DM", ["USUBJID"])
    assert result["uniqueConclusion"] == "unique"


def test_join_check_counts_and_cardinality_conflicts():
    result = op_join_check(DATASETS, "AE", "DM",
                           [{"leftField": "USUBJID", "rightField": "USUBJID"}],
                           "n:1", "never_match")
    # AE: S1,S1,S2 匹配；NA 键永不匹配
    assert result["leftMatchedRowCount"] == 3
    assert result["leftUnmatchedRowCount"] == 0
    assert result["nullKeyLeftCount"] == 1
    assert result["joinedPairCount"] == 3  # S1×2 + S2×1
    # n:1 只要求右侧唯一：S1/S2/S3 右侧各出现 1 次 → 零冲突
    assert result["cardinalityConflictKeyCount"] == 0


def test_join_check_conflict_on_1_to_1():
    result = op_join_check(DATASETS, "AE", "DM",
                           [{"leftField": "USUBJID", "rightField": "USUBJID"}],
                           "1:1", "never_match")
    # 左侧 S1 出现 2 次 → 1:1 冲突键 1 个
    assert result["cardinalityConflictKeyCount"] == 1


def test_join_check_never_match_vs_match():
    never = op_join_check(DATASETS, "AE", "AE",
                          [{"leftField": "USUBJID", "rightField": "USUBJID"}],
                          "n:n", "never_match")
    match = op_join_check(DATASETS, "AE", "AE",
                          [{"leftField": "USUBJID", "rightField": "USUBJID"}],
                          "n:n", "match")
    assert never["joinedPairCount"] == 5  # S1:2×2 + S2:1×1
    assert match["joinedPairCount"] == 6  # 再加 NA×NA 一对


def test_rule_check_operators_and_rejection():
    not_null = op_rule_check(DATASETS, "AE", {"op": "not_null", "column": "USUBJID"})
    assert not_null["examinedCount"] == 4 and not_null["failCount"] == 1

    unique = op_rule_check(DATASETS, "AE", {"op": "unique", "columns": ["USUBJID"]})
    assert unique["failCount"] == 2

    equal = op_rule_check(DATASETS, "AE", {"op": "equal_columns", "left": "AETERM", "right": "AETERM"})
    assert equal["failCount"] == 0

    non_negative = op_rule_check(DATASETS, "AE", {"op": "non_negative", "column": "SEV"})
    assert non_negative["failCount"] == 1

    with pytest.raises(AnalyzeRequestError):
        op_rule_check(DATASETS, "AE", {"op": "eval", "expression": "1+1"})
    with pytest.raises(AnalyzeRequestError):
        op_rule_check(DATASETS, "AE", {"op": "not_null", "column": "NOT_A_COLUMN"})


def test_schema_returns_registered_structure_only():
    result = op_schema(DATASETS, ["DM"])
    assert result["datasets"][0]["rowCount"] == 3
    assert result["datasets"][0]["columns"][0]["name"] == "USUBJID"


def test_unregistered_input_rejected():
    with pytest.raises(AnalyzeRequestError):
        op_key_check(DATASETS, "SECRET.csv", ["USUBJID"])


def test_compare_artifacts_counts_and_key_uniqueness():
    left = pd.DataFrame({"K": ["a", "b", "c"], "V": [1, 2, 3]})
    right = pd.DataFrame({"K": ["a", "b", "d"], "V": [1, 9, 4]})
    result = op_compare_artifacts({"L": left, "R": right}, "L", "R", ["K"])
    assert result["commonKeyRowCount"] == 2
    assert result["modifiedRowCount"] == 1
    assert result["differingCellCount"] == 1
    assert result["addedRowCount"] == 1
    assert result["removedRowCount"] == 1

    duplicated = pd.DataFrame({"K": ["a", "a"], "V": [1, 2]})
    with pytest.raises(AnalyzeRequestError):
        op_compare_artifacts({"L": duplicated, "R": right}, "L", "R", ["K"])


def test_operation_analyze_dispatch_and_guard(project, monkeypatch):
    monkeypatch.setattr(worker, "_session_project", project)
    monkeypatch.setattr(worker, "_session_datasets", DATASETS)
    monkeypatch.setattr(worker, "_session_snapshot_id", "snap-x")
    receipt = worker.operation_analyze({
        "project": str(project), "analyzeOperation": "key_check",
        "input": "AE", "keys": ["USUBJID"]})
    assert receipt["ok"] is True
    assert receipt["receipt"]["uniqueConclusion"] == "duplicated"
    assert receipt["receipt"]["snapshotId"] == "snap-x"

    bad = worker.operation_analyze({
        "project": str(project), "analyzeOperation": "key_check",
        "input": "SECRET.csv", "keys": ["USUBJID"]})
    assert bad["ok"] is False and bad["code"] == "INVALID_ANALYZE_REQUEST"

    unknown = worker.operation_analyze({
        "project": str(project), "analyzeOperation": "head_samples"})
    assert unknown["ok"] is False and unknown["code"] == "INVALID_ANALYZE_REQUEST"

    wrong_project = worker.operation_analyze({
        "project": str(project / "elsewhere"), "analyzeOperation": "run_status"})
    assert wrong_project["ok"] is False
