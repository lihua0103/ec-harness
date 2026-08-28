"""源头标注层：数据拦截的判定锚点（2026-08-28 三类 + 文本审计标记）。"""
import pandas as pd
import pytest

from source_registry import (
    DataSource,
    derived_from,
    normalize_source,
    source_of,
    tag_dataframe,
    tag_payload,
)


def test_data_source_values():
    assert DataSource.DATASET.value == "dataset"
    assert DataSource.AUX_EXCEL.value == "aux-excel"
    assert DataSource.SPEC_DOCUMENT.value == "spec-document"
    assert DataSource.MODEL_OUTPUT.value == "model-output"


def test_tag_dataframe_sets_source():
    frame = pd.DataFrame({"A": [1]})
    assert tag_dataframe(frame, DataSource.DATASET) is frame
    assert frame.attrs["_source"] == "dataset"
    assert tag_dataframe(pd.DataFrame(), "aux-excel").attrs["_source"] == "aux-excel"


def test_normalize_source_rejects_unknown():
    assert normalize_source("dataset") == "dataset"
    assert normalize_source(DataSource.MODEL_OUTPUT) == "model-output"
    for legacy in ("sas-dataset", "derived", "spec"):
        with pytest.raises(ValueError, match="UNKNOWN_DATA_SOURCE"):
            normalize_source(legacy)


def test_derived_from_inherits_source():
    raw = tag_dataframe(pd.DataFrame({"A": [1]}), DataSource.DATASET)
    merged = derived_from(raw.assign(B=2))
    assert merged.attrs["_source"] == "dataset"


def test_derived_from_untagged_becomes_model_output():
    fresh = derived_from(pd.DataFrame({"A": [1]}))
    assert fresh.attrs["_source"] == "model-output"


def test_tag_payload_and_source_of():
    payload = tag_payload({"path": "a.xlsx"}, DataSource.AUX_EXCEL)
    assert payload["_source"] == "aux-excel"
    assert source_of(payload) == "aux-excel"
    assert source_of(pd.DataFrame()) is None
    assert source_of("not-a-container") is None
