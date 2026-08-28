"""Worker 端到端：三操作调度 + 数据拦截出口 + 会话语义 + 审计。"""
import json

import worker


def test_inspect_default_projected_and_text_full(project):
    """默认（缺省旗标 = 拦截开，fail-closed）：数据集行值不出域；
    doc/ 零拦截（ADR-0007）——文本与 Excel 单元格值全量直通。
    """
    from openpyxl import Workbook
    wb = Workbook(); ws = wb.active; ws.title = "ALS"
    ws.append(["Dataset Name", "Variable Name", "Label"])
    ws.append(["AE", "AETERM", "Term"])
    notes = wb.create_sheet("Notes")
    notes.append(["note"])
    for _ in range(3):
        notes.append(["padding"])
    notes.append(["SECRET-CELL-42"])
    wb.save(project / "doc" / "als.xlsx")

    result = worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    payload = json.dumps(result, ensure_ascii=False)
    assert result["ok"] is True
    assert "SUBJ-777" not in payload and "SUBJ-888" not in payload     # 数据集行值
    assert "SECRET-CELL-42" in payload                                 # doc/ 单元格值全量直通
    assert "REQUIREMENT-TAIL" in payload                               # doc/ 文本全量直通（R1）
    inspection = result["inspection"]
    assert inspection["dataInterception"] is True
    assert inspection["inferredScenario"] == "manual"
    datasets = inspection["datasets"][0]
    assert datasets["name"] == "AE" and datasets["rowCount"] == 2
    assert datasets["columns"] == ["USUBJID", "AETERM"]
    assert "sample" not in datasets                                    # 构建期节流：根本没建
    als = next(doc for doc in inspection["documents"] if doc["type"] == "als")
    assert als["rows"] and als["mappings"][0]["datasetName"] == "AE"   # 整表值在回执里


def test_inspect_switch_off_zero_interception(project):
    from openpyxl import Workbook
    wb = Workbook(); wb.active.append(["note"]); wb.active.append(["SECRET-CELL-42"])
    wb.save(project / "doc" / "notes.xlsx")

    result = worker.dispatch(
        {"operation": "listing_inspect", "project": str(project), "dataInterception": False})
    payload = json.dumps(result, ensure_ascii=False)
    assert "SUBJ-777" in payload and "REQUIREMENT-TAIL" in payload
    assert "SECRET-CELL-42" in payload                                 # xlsx rows 已构建并放行
    inspection = result["inspection"]
    assert inspection["datasets"][0]["sample"]["USUBJID"] == ["SUBJ-777", "SUBJ-888"]
    assert any("rows" in doc for doc in inspection["documents"])


def test_inspect_writes_audit_jsonl(project):
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    audit_file = project / ".clinical-listing" / "audit.jsonl"
    assert audit_file.exists()
    record = json.loads(audit_file.read_text(encoding="utf-8").splitlines()[-1])
    assert record["operation"] == "listing_inspect"
    assert record["dataInterception"] is True
    assert {"source": "dataset", "path": "AE.csv"} in record["projections"]
    assert json.dumps(record).count("SUBJ") == 0                       # 审计无数据值
    # 第二次投影不因目录已存在而失败（exist_ok）
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    assert len(audit_file.read_text(encoding="utf-8").splitlines()) == 2


def test_audit_writes_non_ascii_path_raw(tmp_path):
    (tmp_path / "受试.csv").write_text("ID\n1\n", encoding="utf-8")
    worker.dispatch({"operation": "listing_inspect", "project": str(tmp_path)})
    raw = (tmp_path / ".clinical-listing" / "audit.jsonl").read_text(encoding="utf-8")
    assert "受试.csv" in raw                                        # ensure_ascii=False：中文原样落审计


def test_inspect_no_audit_when_switch_off(project):
    worker.dispatch({"operation": "listing_inspect", "project": str(project), "dataInterception": False})
    assert not (project / ".clinical-listing" / "audit.jsonl").exists()


def test_inspect_seeds_session_so_run_code_skips_reload(project):
    assert worker.dispatch({"operation": "listing_inspect", "project": str(project)})["ok"]
    # 数据文件在 inspect 后消失：run_code 用会话数据照常工作（免二次读取）
    (project / "AE.csv").unlink()
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'out = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"S"}\noutputs={"AE":out}'})
    assert result["ok"] is True, result
    assert result["receipt"]["outputCount"] == 1


def test_run_code_collects_when_session_cold(project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'out = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"S"}\noutputs={"AE":out}'})
    assert result["ok"] is True, result
    envelope = result["receipt"]["outputs"]["AE"]
    assert envelope["rowCount"] == 2
    assert [(column["name"], column["nullCount"]) for column in envelope["columns"]] == [
        ("USUBJID", 0), ("AETERM", 0)]
    assert {column["dtype"] for column in envelope["columns"]} <= {"object", "str"}
    assert result["receipt"]["publishReady"] is True


def test_run_code_stdout_passthrough(project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'print(datasets["AE"].iloc[0]["AETERM"])\n'
                'out = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"S"}\noutputs={"AE":out}'})
    assert result["receipt"]["stdout"] == "Headache\n"


def test_run_code_requires_outputs(project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project), "code": "x = 1"})
    assert result["ok"] is False
    assert result["code"] == "OUTPUTS_REQUIRED"
    assert result["reason"] == "代码必须定义 outputs: dict[str, pandas.DataFrame]"
    assert result["stdout"] == "" and result["stderr"] == ""
    assert "datasets" in result["environmentHint"]                    # 环境自描述（信息供给）


def test_run_code_rejects_invalid_outputs(project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project), "code": "outputs = {'bad': 42}"})
    assert result["code"] == "INVALID_OUTPUTS"


def test_run_code_fail_closed_on_collection_failure(tmp_path):
    (tmp_path / "AE.csv").write_text("ID\n1\n", encoding="utf-8")
    (tmp_path / "broken.zip").write_bytes(b"not a zip")
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(tmp_path), "code": "outputs = {}"})
    assert result["code"] == "DATASET_LOAD_FAILED"
    assert result["failures"][0]["stage"] == "extract-archive"


def test_publish_flow_and_fingerprint(project):
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'out = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"S","AETERM":"T"}\noutputs={"AE":out}'})
    result = worker.dispatch({
        "operation": "listing_publish", "project": str(project), "scenario": "medical",
        "trackChanges": False})
    assert result["ok"] is True, result
    receipt = result["receipt"]
    assert receipt["format"] == "single-workbook-multi-sheet-xlsx"
    assert receipt["outputFile"] == ".clinical-listing/output/medical/MEDICAL_LISTINGS.xlsx"
    assert (project / receipt["outputFile"]).exists()
    assert receipt["statistics"]["sheetNames"] == ["Content", "AE"]


def test_publish_requires_successful_run(project):
    result = worker.dispatch({"operation": "listing_publish", "project": str(project), "scenario": "manual"})
    assert result["code"] == "NO_SUCCESSFUL_RUN"


def test_publish_rejects_invalid_scenario_before_output_path(project):
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'out = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"S"}\noutputs={"AE":out}'})
    result = worker.dispatch({
        "operation": "listing_publish", "project": str(project), "scenario": "invalid"})
    assert result["ok"] is False
    assert result["code"] == "INVALID_SCENARIO"
    assert not (project / ".clinical-listing" / "output").exists()


def test_publish_project_mismatch(project, tmp_path_factory):
    other = tmp_path_factory.mktemp("other-project")
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'out = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"S"}\noutputs={"AE":out}'})
    result = worker.dispatch({
        "operation": "listing_publish", "project": str(other), "scenario": "manual"})
    assert result["ok"] is False
    assert result["code"] == "PROJECT_SESSION_MISMATCH"


def test_unknown_operation():
    assert worker.dispatch({"operation": "listing_nope"})["code"] == "UNKNOWN_OPERATION"


def test_project_not_found(tmp_path):
    result = worker.dispatch({"operation": "listing_inspect", "project": str(tmp_path / "missing")})
    assert result["code"] == "PROJECT_NOT_FOUND"


def test_scenario_inference_from_project_name(tmp_path):
    medical = tmp_path / "XX-Medical-Study"
    (medical / "raw").mkdir(parents=True)
    (medical / "raw" / "AE.csv").write_text("ID\n1\n", encoding="utf-8")
    result = worker.dispatch({"operation": "listing_inspect", "project": str(medical)})
    assert result["inspection"]["inferredScenario"] == "medical"


def test_error_receipts_untouched_by_interception(project):
    """错误回执也走统一出口，但不越权处理未标记内容。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project), "code": "1/0"})
    assert result["ok"] is False
    assert "division by zero" in result["reason"]   # 错误信息原样


def test_run_code_receipt_caps_names(project):
    """V-4:回执内列名/表名显示上限 120(机械上限,压缩隐蔽信道带宽;真实名保留在会话)。"""
    long_name = "V" * 200
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": f"df = datasets['AE'].copy()\ndf = df.rename(columns={{'USUBJID': '{long_name}'}})\ndf.attrs['labels']={{'{long_name}':'S','AETERM':'T'}}\noutputs={{'OK表': df}}"})
    assert result["ok"] is True, result
    names = [c["name"] for c in result["receipt"]["outputs"]["OK表"]["columns"]]
    assert all(len(n) <= 120 for n in names)
    assert any(n.endswith("…") for n in names)       # 超限截断有显式标记
