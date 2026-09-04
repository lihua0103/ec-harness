"""数据拦截层：两类受保护数据值的固定白名单投影。"""

import data_guard
import discovery
import sandbox
import worker
from data_guard import AUX_EXCEL_KEYS, DATASET_KEYS, PROJECTION, sanitize_receipt


def test_dataset_payload_projected_to_metadata_only():
    payload = {
        "_source": "dataset",
        "name": "AE",
        "path": "raw/ae.sas7bdat",
        "columns": ["USUBJID", "AETERM"],
        "rowCount": 100,
        "dtypes": {"USUBJID": "object"},
        "nullCount": {"USUBJID": 0},
        "uniqueCount": {"USUBJID": 2},
        "sample": {"USUBJID": ["SUBJ-777"]},
    }
    out = sanitize_receipt({"inspection": {"datasets": [payload]}})
    projected = out["inspection"]["datasets"][0]
    assert projected == {
        "name": "AE", "path": "raw/ae.sas7bdat",
        "columns": ["USUBJID", "AETERM"], "rowCount": 100,
        "dtypes": {"USUBJID": "object"}, "nullCount": {"USUBJID": 0},
        "uniqueCount": {"USUBJID": 2}, "_source": "dataset",
    }


def test_aux_excel_projected_to_structure_and_semantics():
    payload = {
        "_source": "aux-excel",
        "path": "als.xlsx",
        "type": "als",
        "size": 123,
        "structure": {"sheets": [{"name": "ALS", "headerRows": [["Dataset Name"]]}]},
        "mappings": [{"datasetName": "AE", "sourceColumn": "AETERM", "label": "Term"}],
        "datasets": ["AE"],
        "rows": [{"sheet": "ALS", "rows": [["SECRET-CELL"]]}],
    }
    out = sanitize_receipt({"documents": [payload]})
    projected = out["documents"][0]
    assert projected["path"] == "als.xlsx"
    assert projected["structure"]["sheets"][0]["headerRows"] == [["Dataset Name"]]
    assert projected["mappings"] == [{"datasetName": "AE", "sourceColumn": "AETERM", "label": "Term"}]
    assert projected["datasets"] == ["AE"]
    assert "rows" not in projected
    assert "SECRET-CELL" not in str(projected)


def test_doc_text_passthrough_full_content():
    payload = {"_source": "spec-document", "path": "spec.txt",
               "content": "全文" * 5000, "lineCount": 300}
    out = sanitize_receipt({"documents": [payload]})
    assert out["documents"][0] is payload
    assert len(out["documents"][0]["content"]) == 10_000


def test_model_output_passthrough_identity():
    receipt = {"receipt": {"_source": "model-output", "outputs": {"AE": {"rowCount": 3}}}}
    assert sanitize_receipt(receipt) is receipt


def test_disabled_interception_returns_receipt_identity():
    dataset = {"_source": "dataset", "name": "AE", "sample": ["SUBJ-777"]}
    aux = {"_source": "aux-excel", "path": "a.xlsx", "rows": [["SECRET-CELL"]]}
    receipt = {"datasets": [dataset], "documents": [aux]}
    audit: list = []
    assert sanitize_receipt(receipt, False, audit=audit) is receipt
    assert audit == []


def test_untagged_receipt_identity_and_dates_survive():
    receipt = {
        "ok": True,
        "reason": "处理完成，报告日期 2026-08-28",
        "failures": [{"path": "raw/ae.sas7bdat", "stage": "read-dataset"}],
    }
    assert sanitize_receipt(receipt) is receipt


def test_projection_nested_in_lists():
    receipt = {"a": [[{"_source": "dataset", "sample": ["v"]}], "keep"]}
    out = sanitize_receipt(receipt)
    assert "sample" not in out["a"][0][0]
    assert out["a"][0][0]["_source"] == "dataset"
    assert out["a"][1] == "keep"


def test_sanitize_does_not_mutate_input_receipt():
    dataset = {"_source": "dataset", "name": "AE", "sample": ["SUBJ-777"]}
    aux = {"_source": "aux-excel", "path": "a.xlsx", "rows": [["v"]]}
    datasets_list = [dataset]
    receipt = {"datasets": datasets_list, "documents": [aux]}
    out = sanitize_receipt(receipt)
    assert "sample" in dataset and "rows" in aux
    assert "sample" not in out["datasets"][0] and "rows" not in out["documents"][0]
    assert receipt["datasets"] is datasets_list
    assert datasets_list[0] is dataset


def test_sanitize_projects_every_tagged_sibling_in_list():
    receipt = {"datasets": [
        {"_source": "dataset", "sample": ["A"]},
        {"_source": "dataset", "sample": ["B"]},
    ]}
    out = sanitize_receipt(receipt)
    assert all("sample" not in item for item in out["datasets"])


def test_sanitize_keeps_untouched_siblings_identical():
    keep = {"anything": ["2026-08-28"]}
    receipt = {"a": {"_source": "dataset", "sample": [1]}, "keep": keep}
    out = sanitize_receipt(receipt)
    assert out["keep"] is keep


def test_audit_collects_all_projected_sources():
    audit: list = []
    receipt = {"datasets": [{"_source": "dataset", "name": "AE", "path": "AE.csv", "sample": [1]}],
               "documents": [{"_source": "aux-excel", "path": "a.xlsx", "rows": [[1]]}]}
    sanitize_receipt(receipt, audit=audit)
    assert audit == [
        {"source": "dataset", "path": "AE.csv"},
        {"source": "aux-excel", "path": "a.xlsx"},
    ]


def test_projection_table_is_exactly_two_rules():
    assert PROJECTION == {
        "dataset": DATASET_KEYS,
        "aux-excel": AUX_EXCEL_KEYS,
    }
    assert AUX_EXCEL_KEYS == ("path", "type", "size", "structure", "mappings", "datasets")


def test_no_preview_no_pattern_scan():
    for module in (data_guard, discovery, sandbox, worker):
        assert not hasattr(module, "OUT_BOUND_FORBIDDEN_FIELDS"), module.__name__
    for name in ("PHI_PATTERNS", "PREVIEW_CHARS", "STRUCTURE_KEYS"):
        assert not hasattr(data_guard, name), name
