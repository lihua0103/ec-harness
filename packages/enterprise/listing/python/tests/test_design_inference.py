"""名字无关的 ALS 设计表推断：一个从未见过的 EDC（任意中文列名）也要能
识别设计 sheet、给出映射，同时质疑日志/受试者级导出绝不被判为设计表。"""
import json

import pandas as pd
from openpyxl import Workbook

import worker
from design_inference import (
    enrich_design_semantics,
    infer_mappings,
    is_design_sheet,
    row_identifier_values,
    structural_vocabulary,
)


def _datasets() -> dict[str, pd.DataFrame]:
    subjects = [f"S{index:03d}-{index * 7:04d}" for index in range(1, 31)]
    ae = pd.DataFrame({
        "SUBJID": subjects, "SITEID": ["01"] * 15 + ["02"] * 15,
        "AETERM": [f"Headache grade {index}" for index in range(30)],       # 高基数：逐行不同
        "AESTDTC": [f"2026-01-{index + 1:02d}" for index in range(30)],
        "AEACN": ["Dose Not Changed"] * 30,
    })
    dm = pd.DataFrame({
        "SUBJID": subjects, "SITEID": ["01"] * 15 + ["02"] * 15,
        "BRTHDTC": ["1980-05-05"] * 30, "SEX": ["F"] * 30,
    })
    return {"AE": ae, "DM": dm}


# 一个虚构的新 EDC：列名全中文、与 Rave/太美/ODM-DED 都不同
UNKNOWN_ALS_ROWS = [
    ["AE", "SUBJID", "受试者编号", "文本"],
    ["AE", "AETERM", "不良事件名称", "文本"],
    ["AE", "AESTDTC", "开始日期", "日期"],
    ["AE", "AEACN", "对研究药物采取的措施", "下拉"],
    ["DM", "BRTHDTC", "出生日期", "日期"],
    ["DM", "SEX", "性别", "下拉"],
    ["DM", "SITEID", "中心编号", "文本"],
]

# 受试者级业务导出：带受试者号 + 日期 + 质疑文本，也带表单/字段 OID
QUERY_LOG_ROWS = [
    [f"S{index:03d}-{index * 7:04d}", "AE", "AETERM", f"2026-02-{index:02d}",
     f"请核实不良事件描述 QRY-{index}"] for index in range(1, 21)
]


def test_row_identifier_values_come_from_high_cardinality_columns():
    values = row_identifier_values(_datasets())
    assert "S001-0007" in values
    assert "01" not in values                   # SITEID 低基数
    assert "Dose Not Changed" not in values     # AEACN 单值


def test_unknown_edc_design_sheet_detected_and_query_log_rejected():
    datasets = _datasets()
    vocabulary = structural_vocabulary(datasets)
    row_values = row_identifier_values(datasets)
    assert is_design_sheet(UNKNOWN_ALS_ROWS, vocabulary, row_values) is True
    assert is_design_sheet(QUERY_LOG_ROWS, vocabulary, row_values) is False
    # 没有数据集结构可对照时不做任何推断（只信适配器，fail-closed）
    assert is_design_sheet(UNKNOWN_ALS_ROWS, set(), set()) is False


def test_infer_mappings_from_unknown_edc():
    mappings = infer_mappings(UNKNOWN_ALS_ROWS, _datasets())
    assert {"datasetName": "AE", "sourceColumn": "AETERM", "label": "不良事件名称"} in mappings
    assert {"datasetName": "DM", "sourceColumn": "SEX", "label": "性别"} in mappings
    assert len(mappings) == 7


def test_enrich_marks_inferred_sheets_and_keeps_query_log_protected():
    datasets = _datasets()
    document = {"path": "unknown_edc.xlsx", "type": "excel", "rows": [
        {"sheet": "字段清单", "rows": UNKNOWN_ALS_ROWS},
        {"sheet": "质疑", "rows": QUERY_LOG_ROWS},
    ]}
    enrich_design_semantics(datasets, [document])
    assert document["designSheets"] == ["字段清单"]
    assert document["inferredDesignSheets"] == ["字段清单"]
    assert document["type"] == "als"
    assert document["datasets"] == ["AE", "DM"]

    hashes = worker.protected_value_hashes(datasets, [document])
    scan = lambda text: worker.text_contains_protected_value(text, hashes)  # noqa: E731
    assert scan("检查 不良事件名称 与 对研究药物采取的措施 字段") is False   # 设计词已披露
    assert scan("请核实不良事件描述 QRY-7") is True                        # 质疑文本受保护
    assert scan("subject S003-0021 enrolled") is True                       # 受试者号受保护
    assert scan("Headache grade 2") is True                                 # 数据集行值受保护


def test_inferred_sheet_is_learned_and_recognized_without_datasets(tmp_path):
    """第一次靠结构推断（需数据集）；登记后同一表头在 discovery 层直接命中，
    数据集不在场也能识别并抽取映射——注册表只含表头与角色，无单元格值。"""
    import json as _json

    import discovery
    from edc_profiles import load_profiles, profiles_path

    headers = ["表单代号", "字段代号", "字段中文说明", "控件"]
    document = {"path": "unknown_edc.xlsx", "type": "excel",
                "structure": {"sheets": [{"name": "字段清单", "headerRows": [headers]}]},
                "rows": [{"sheet": "字段清单", "rows": UNKNOWN_ALS_ROWS}]}
    enrich_design_semantics(_datasets(), [document])
    assert document["learnedEdcProfiles"]
    profiles = load_profiles()
    assert len(profiles) == 1
    assert profiles[0]["roles"] == {"variable": "字段代号", "dataset": "表单代号", "label": "字段中文说明"}
    registry_text = profiles_path().read_text(encoding="utf-8")
    assert "AETERM" not in registry_text and "QRY" not in registry_text   # 无单元格值

    # 第二个项目：同一 EDC、列顺序变了、多了一列——无数据集也能识别
    frame = pd.DataFrame(
        [["文本", "DM", "SEX", "性别", "备注"], ["下拉", "AE", "AESEV", "严重程度", ""]],
        columns=["控件", "表单代号", "字段代号", "字段中文说明", "备注"])
    fields = discovery._als_payload_fields({"字段清单": frame})
    assert fields["designSheets"] == ["字段清单"]
    assert {"datasetName": "DM", "sourceColumn": "SEX", "label": "性别"} in fields["mappings"]
    assert _json.loads(registry_text)[0]["seen"] == 1

    # 再学一次同形态：只累计次数，不重复登记
    enrich_design_semantics(_datasets(), [dict(document, designSheets=[])])
    assert load_profiles()[0]["seen"] == 2 and len(load_profiles()) == 1


def test_subject_level_sheet_never_matches_learned_profile():
    """已学习表头 + 受试者级列（USUBJID/受试者）的导出仍是业务表。"""
    import discovery
    from edc_profiles import learn_profile

    learn_profile("字段清单", ["表单代号", "字段代号", "字段中文说明"],
                  {"dataset": "表单代号", "variable": "字段代号", "label": "字段中文说明"})
    frame = pd.DataFrame([["AE", "AETERM", "头痛", "S001-0007"]],
                         columns=["表单代号", "字段代号", "字段中文说明", "受试者"])
    assert discovery._als_payload_fields({"导出": frame}) == {}


def test_unwritable_registry_does_not_break_inspect(tmp_path, monkeypatch):
    monkeypatch.setenv("DSH_EDC_PROFILES", str(tmp_path / "doc"))   # 指向一个目录：写必失败
    (tmp_path / "doc").mkdir()
    document = {"path": "x.xlsx", "type": "excel",
                "structure": {"sheets": [{"name": "字段清单",
                                          "headerRows": [["表单代号", "字段代号", "字段中文说明", "控件"]]}]},
                "rows": [{"sheet": "字段清单", "rows": UNKNOWN_ALS_ROWS}]}
    enrich_design_semantics(_datasets(), [document])
    assert document["inferredDesignSheets"] == ["字段清单"]
    assert "learnedEdcProfiles" not in document


def test_real_shape_unknown_edc_through_inspect(tmp_path):
    """端到端：inspect 后 read_metadata 披露推断映射，行值/质疑值不出域。"""
    (tmp_path / "doc").mkdir()
    (tmp_path / "doc" / "spec.txt").write_text("需求", encoding="utf-8")
    for name, frame in _datasets().items():
        frame.to_csv(tmp_path / f"{name}.csv", index=False)
    wb = Workbook()
    ws = wb.active
    ws.title = "字段清单"
    ws.append(["表单代号", "字段代号", "字段中文说明", "控件"])
    for row in UNKNOWN_ALS_ROWS:
        ws.append(row)
    log = wb.create_sheet("质疑")
    log.append(["受试者", "表单", "字段", "日期", "质疑内容"])
    for row in QUERY_LOG_ROWS:
        log.append(row)
    wb.save(tmp_path / "new_edc_design.xlsx")

    result = worker.dispatch({"operation": "listing_inspect", "project": str(tmp_path)})
    assert result["ok"] is True
    payload = json.dumps(result, ensure_ascii=False)
    assert "QRY-7" not in payload and "S003-0021" not in payload
    aux = result["inspection"]["auxiliaryDocuments"][0]
    assert aux["type"] == "als"
    assert aux["inferredDesignSheets"] == ["字段清单"]
    assert {"datasetName": "AE", "sourceColumn": "AETERM", "label": "不良事件名称"} in aux["mappings"]
    assert "rows" not in aux

    metadata = worker.dispatch({"operation": "listing_read_metadata", "project": str(tmp_path)})
    assert "QRY-7" not in json.dumps(metadata, ensure_ascii=False)
    scan = worker.dispatch({"operation": "listing_scan_text", "project": str(tmp_path),
                            "text": "leak 请核实不良事件描述 QRY-7"})
    assert scan == {"ok": True, "containsProtectedValue": True}