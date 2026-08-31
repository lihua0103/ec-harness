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
    worker.dispatch({"operation": "listing_inspect", "project": str(project),
                     "dataInterception": False})
    assert not (project / ".clinical-listing" / "audit.jsonl").exists()


def test_worker_caches_value_mask_matcher_per_session(project):
    """性能修复 2026-08-30：matcher 与值集同槽缓存——同一数据集身份只编译
    一次（inspect 种会话后 run_code 复用同一 matcher 对象）；会话重载
    （另一次 inspect 新数据集字典）后按身份失效重建。"""
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    first = worker._value_mask_matcher()
    cached = worker._value_mask_cache
    assert cached is not None and cached[0] is worker._session_datasets
    second = worker._value_mask_matcher()
    assert second is first                                 # 同会话复用，零重编
    # 回执遮蔽走缓存 matcher：run_code 正常遮蔽（端到端不变）
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'print(datasets["AE"].iloc[0]["USUBJID"])\n'
                'outputs = {"T": pd.DataFrame({"K": [1]})}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "[DATA]\n"
    assert worker._value_mask_matcher() is first           # run_code 未触发重编
    # 会话重载 → 新数据集字典 → matcher 按身份失效重建
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    assert worker._value_mask_matcher() is not first
    assert worker._value_mask_cache[0] is worker._session_datasets


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


def test_run_code_stdout_masks_dataset_values(project):
    """FR-8（2026-08-29 终裁）：stdout 命中数据集单元格值 → [DATA]；
    未命中内容原样回显（零误伤）。
    """
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'print(datasets["AE"].iloc[0]["AETERM"])\n'
                'print("PLAIN-TEXT")\n'
                'out = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"S"}\noutputs={"AE":out}'})
    assert result["receipt"]["stdout"] == "[DATA]\nPLAIN-TEXT\n"
    payload = json.dumps(result, ensure_ascii=False)
    assert "Headache" not in payload and "SUBJ-777" not in payload
    assert "PLAIN-TEXT" in payload


def test_run_code_stdout_switch_off_passthrough(project):
    """开关关（dataInterception=false）→ 遮蔽同步关闭，stdout 原样。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project), "dataInterception": False,
        "code": 'print(datasets["AE"].iloc[0]["AETERM"])\n'
                'out = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"S"}\noutputs={"AE":out}'})
    assert result["receipt"]["stdout"] == "Headache\n"


def test_run_code_error_reason_masks_dataset_values(project):
    """sandbox 异常消息带数据集值 → CODE_EXECUTION_ERROR 的 reason 同样遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'raise ValueError(datasets["AE"].iloc[0]["AETERM"])'})
    assert result["ok"] is False
    assert result["code"] == "CODE_EXECUTION_ERROR"
    assert "[DATA]" in result["reason"]
    assert "Headache" not in json.dumps(result, ensure_ascii=False)


def test_run_code_audit_records_masked_count(project):
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project),
        "code": 'print(datasets["AE"].iloc[0]["AETERM"])\n'
                'out = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"S"}\noutputs={"AE":out}'})
    assert result["receipt"]["stdout"] == "[DATA]\n"
    raw = (project / ".clinical-listing" / "audit.jsonl").read_text(encoding="utf-8")
    record = json.loads(raw.splitlines()[-1])
    assert record["operation"] == "listing_run_code"
    assert record["maskedCount"] >= 1                    # 纯计数，无值内容
    assert "SUBJ" not in raw and "Headache" not in raw


def test_worker_error_receipt_masked_before_stdout(project, monkeypatch, capsys):
    """关键旁路：main() 兜底 WORKER_ERROR（reason/traceback）出域前同样遮蔽。"""
    import io
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})  # 种会话值集

    def boom(code, project_root, datasets):
        raise RuntimeError("crash on Headache")
    monkeypatch.setattr(worker, "run_sandbox_code", boom)
    request = json.dumps({
        "operation": "listing_run_code", "project": str(project), "code": "outputs = {}"})
    monkeypatch.setattr("sys.stdin", io.StringIO(request + "\n"))
    worker.main()
    out = capsys.readouterr().out
    assert "WORKER_ERROR" in out and "[DATA]" in out
    assert "Headache" not in out and "SUBJ-777" not in out
    assert out.count("\n") == 1                           # NDJSON 单行协议不破


def test_worker_error_switch_off_passthrough(project, monkeypatch, capsys):
    """开关关时兜底 WORKER_ERROR 同样不遮蔽（与主路径同一开关）。"""
    import io
    worker.dispatch({"operation": "listing_inspect", "project": str(project)})

    def boom(code, project_root, datasets):
        raise RuntimeError("crash on Headache")
    monkeypatch.setattr(worker, "run_sandbox_code", boom)
    request = json.dumps({
        "operation": "listing_run_code", "project": str(project),
        "dataInterception": False, "code": "outputs = {}"})
    monkeypatch.setattr("sys.stdin", io.StringIO(request + "\n"))
    worker.main()
    out = capsys.readouterr().out
    assert "crash on Headache" in out


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
