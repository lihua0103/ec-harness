"""数据拦截层（2026-08-28 第三版口径，ADR-0007）：单规则投影 + 宿主开关 + 审计。"""
import data_guard
from data_guard import PROJECTION, sanitize_receipt


def test_dataset_payload_projected_to_metadata_only():
    payload = {
        "_source": "dataset",
        "name": "AE",
        "path": "raw/ae.sas7bdat",
        "columns": ["USUBJID", "AETERM"],
        "rowCount": 100,
        "dtypes": {"USUBJID": "object"},
        "sample": {"USUBJID": ["SUBJ-777"]},
    }
    out = sanitize_receipt({"inspection": {"datasets": [payload]}}, True)
    projected = out["inspection"]["datasets"][0]
    assert projected == {
        "name": "AE", "path": "raw/ae.sas7bdat",
        "columns": ["USUBJID", "AETERM"], "rowCount": 100,
        "dtypes": {"USUBJID": "object"}, "_source": "dataset",
    }  # sample（行值）被剥


def test_aux_excel_payload_full_passthrough():
    """ADR-0007：doc/ 零拦截——aux-excel 标记不再投影，对象恒等直通。"""
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
    out = sanitize_receipt({"documents": [payload]}, True)
    assert out["documents"][0] is payload                    # 对象恒等，一个字节不动
    assert out["documents"][0]["rows"][0]["rows"] == [["SECRET-CELL"]]


def test_doc_text_passthrough_full_content():
    """R1：doc/ 文本全量读——spec-document 标记不在投影表 = 不碰。"""
    payload = {"_source": "spec-document", "path": "spec.txt",
               "content": "全文" * 5000, "lineCount": 300}
    out = sanitize_receipt({"documents": [payload]}, True)
    projected = out["documents"][0]
    assert projected is payload                           # 对象恒等，一个字节不动
    assert len(projected["content"]) == 10_000


def test_model_output_passthrough_identity():
    receipt = {"receipt": {"_source": "model-output", "outputs": {"AE": {"rowCount": 3}}}}
    assert sanitize_receipt(receipt, True) is receipt


def test_untagged_receipt_identity_and_dates_survive():
    receipt = {
        "ok": True,
        "reason": "处理完成，报告日期 2026-08-28，受试者 USUBJID 列已识别",
        "stdout": "SUBJ-777 print 输出原样",
        "failures": [{"path": "raw/ae.sas7bdat", "reason": "bad bytes"}],
    }
    assert sanitize_receipt(receipt, True) is receipt


def test_switch_off_zero_interception():
    payload = {"_source": "dataset", "sample": ["SUBJ-777"]}
    receipt = {"datasets": [payload]}
    out = sanitize_receipt(receipt, False)
    assert out is receipt
    assert out["datasets"][0]["sample"] == ["SUBJ-777"]


def test_projection_nested_in_lists():
    receipt = {"a": [[{"_source": "dataset", "sample": ["v"]}], "keep"]}
    out = sanitize_receipt(receipt, True)
    assert out["a"][0][0].get("sample") is None
    assert out["a"][0][0]["_source"] == "dataset"
    assert out["a"][1] == "keep"


def test_untagged_dict_nested_in_lists_identity():
    """嵌套在 list 里的未标记 dict 也必须恒等直通（doc/ 零拦截的递归面）。"""
    aux = {"_source": "aux-excel", "rows": [["v"]]}
    receipt = {"a": [[aux], "keep"]}
    out = sanitize_receipt(receipt, True)
    assert out["a"][0][0] is aux
    assert out["a"][1] == "keep"


def test_sanitize_does_not_mutate_input_receipt():
    dataset = {"_source": "dataset", "name": "AE", "sample": ["SUBJ-777"]}
    aux = {"_source": "aux-excel", "path": "a.xlsx", "rows": [["v"]]}
    datasets_list = [dataset]
    receipt = {"datasets": datasets_list, "documents": [aux], "stdout": "raw"}
    out = sanitize_receipt(receipt, True)
    assert "sample" in dataset and "rows" in aux          # 原对象不被破坏
    assert "sample" not in out["datasets"][0] and out["documents"][0] is aux
    assert out["stdout"] == "raw"
    assert receipt["datasets"] is datasets_list           # 纯函数性：容器引用不被改写
    assert datasets_list[0] is dataset


def test_sanitize_projects_every_tagged_sibling_in_list():
    receipt = {"datasets": [
        {"_source": "dataset", "sample": ["A"]},
        {"_source": "dataset", "sample": ["B"]},
    ]}
    out = sanitize_receipt(receipt, True)
    assert all("sample" not in item for item in out["datasets"])
    assert out["datasets"][0]["_source"] == "dataset"


def test_sanitize_keeps_untouched_siblings_identical():
    keep = {"anything": ["2026-08-28"]}
    receipt = {"a": {"_source": "dataset", "sample": [1]}, "keep": keep}
    out = sanitize_receipt(receipt, True)
    assert out["keep"] is keep


def test_audit_collects_projected_dataset_only():
    """审计只记被投影的 dataset 载荷；aux-excel 直通不产生审计行。"""
    audit: list = []
    receipt = {"datasets": [{"_source": "dataset", "name": "AE", "path": "AE.csv", "sample": [1]}],
               "documents": [{"_source": "aux-excel", "path": "a.xlsx", "rows": [[1]]}]}
    sanitize_receipt(receipt, True, audit=audit)
    assert audit == [{"source": "dataset", "path": "AE.csv"}]


def test_projection_table_is_exactly_one_rule():
    """【2026-08-30 重构改写】投影表仍只此一条规则；profile（列级语义
    画像：形态类/格式骨架/派生计数，零真实值）随白名单元数据放行。"""
    assert PROJECTION == {
        "dataset": ("name", "path", "columns", "rowCount", "dtypes",
                    "nullCount", "uniqueCount", "profile"),
    }
    assert data_guard.AUX_EXCEL_KEYS == ()               # 场景②退役：兼容别名恒空


def test_projection_keeps_profile_with_metadata():
    """profile 与列名/dtype 同级放行（零瞎供给）；sample（行值）仍被剥。"""
    payload = {
        "_source": "dataset", "name": "AE",
        "columns": ["USUBJID"],
        "profile": {"USUBJID": {"shape": "identifier-like", "pattern": "AA####-####",
                                "sampled": 10, "sampleUniqueCount": 10}},
        "sample": {"USUBJID": ["SUBJ-777"]},
    }
    out = sanitize_receipt({"inspection": {"datasets": [payload]}}, True)
    projected = out["inspection"]["datasets"][0]
    assert projected["profile"]["USUBJID"]["shape"] == "identifier-like"
    assert projected["profile"]["USUBJID"]["pattern"] == "AA####-####"
    assert "sample" not in projected


def test_no_preview_no_pattern_scan():
    """200 字预览与 PHI 模式兜底都已移除（2026-08-28 口径）。"""
    import discovery
    import sandbox
    import worker

    for module in (data_guard, discovery, sandbox, worker):
        assert not hasattr(module, "OUT_BOUND_FORBIDDEN_FIELDS"), module.__name__
    for name in ("PHI_PATTERNS", "PREVIEW_CHARS", "STRUCTURE_KEYS"):
        assert not hasattr(data_guard, name), name
