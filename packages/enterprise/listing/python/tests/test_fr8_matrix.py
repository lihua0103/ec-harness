"""FR-8 值遮蔽独立攻击测试（T3，测试经理，2026-08-29）。

唯一红线：数据集（sas7bdat/xpt/csv，含归档解出）行值 0 泄露给 AI——
回执任何字符串字段（stdout/stderr/reason/traceback/environmentHint/
outputs 列名/错误信息等）命中已加载单元格值必须替换 ``[DATA]``。

攻击矩阵（A-1~A-15 + 补充 + 探索 E-*）：全部合成数据，只测不修。
口径备忘：精确匹配=大小写敏感、len<4 短值豁免、doc/ 载荷豁免直通、
开关关闭零拦截——均为可接受口径（非 bug），仅在用例中显式锁定语义。
"""
import io
import json
import zipfile

import pytest

import worker


#: 靶场数据集的全部行值（合成）——回执出域必须零出现。
SECRET_VALUES = ("SUBJ-777", "SUBJ-888", "Headache", "Nausea", "12345")


@pytest.fixture()
def fr8_project(tmp_path):
    """标准靶场：AE.csv(含数值列) + doc 文本 + doc xlsx(独特单元格值)。"""
    from openpyxl import Workbook
    (tmp_path / "doc").mkdir()
    (tmp_path / "doc" / "spec.txt").write_text("需求文档 REQUIREMENT-TAIL", encoding="utf-8")
    wb = Workbook(); ws = wb.active; ws.title = "Notes"
    ws.append(["note"]); ws.append(["DOC-CELL-ZULU-77"])
    wb.save(tmp_path / "doc" / "notes.xlsx")
    (tmp_path / "AE.csv").write_text(
        "USUBJID,AETERM,DOSE\nSUBJ-777,Headache,12345\nSUBJ-888,Nausea,12345\n",
        encoding="utf-8")
    return tmp_path


def _payload(result) -> str:
    return json.dumps(result, ensure_ascii=False)


def _assert_zero_leak(result) -> None:
    payload = _payload(result)
    for value in SECRET_VALUES:
        assert value not in payload, f"数据集行值出域: {value}"


# ---------------------------------------------------------------------------
# A-1 inspect 回执：行值零出现，仅 7 键白名单 + _source
# ---------------------------------------------------------------------------

def test_a01_inspect_receipt_whitelist_only(fr8_project):
    result = worker.dispatch({"operation": "listing_inspect", "project": str(fr8_project)})
    assert result["ok"] is True, result
    _assert_zero_leak(result)
    dataset = result["inspection"]["datasets"][0]
    # 【2026-08-30 重构改写】白名单 + _source + profile（列级语义画像：
    # 值形态/格式骨架/派生计数，不含真实值——零瞎供给与列名同级放行）
    assert set(dataset) == {
        "name", "path", "columns", "rowCount", "dtypes", "nullCount", "uniqueCount",
        "profile", "_source"}
    assert "sample" not in dataset                 # 构建期节流：行样本根本不构建
    assert set(dataset["profile"]) == {"USUBJID", "AETERM", "DOSE"}   # 列全覆盖


# ---------------------------------------------------------------------------
# A-2 run_code：print(df.iloc[0]) 遮蔽；outputs 元数据零行值
# ---------------------------------------------------------------------------

def test_a02_run_code_print_row_and_outputs_metadata(fr8_project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'print(datasets["AE"].iloc[0])\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    stdout = result["receipt"]["stdout"]
    assert stdout.count("[DATA]") == 3              # SUBJ-777 / Headache / 12345 各命中一次
    assert "USUBJID" in stdout and "AETERM" in stdout   # 列名（元数据）零误伤
    assert result["receipt"]["outputs"]["AE"]["rowCount"] == 2
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# A-3 衍生 df（filter/merge 后 print）同样遮蔽
# ---------------------------------------------------------------------------

def test_a03_derived_dataframe_print_masked(fr8_project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'ae = datasets["AE"]\n'
                'sub = ae[ae["AETERM"] == "Headache"]\n'
                'merged = sub.merge(ae, on="USUBJID", suffixes=("_l", "_r"))\n'
                'print(sub)\n'
                'print(merged.iloc[0])\n'
                'outputs = {"DERIVED": sub.reset_index(drop=True)}\n'})
    assert result["ok"] is True, result
    assert "[DATA]" in result["receipt"]["stdout"]
    assert result["receipt"]["outputs"]["DERIVED"]["rowCount"] == 1
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# A-4 列名走私：outputs 列名 = 单元格值 → 回执 columns 中被遮蔽
# ---------------------------------------------------------------------------

def test_a04_column_name_smuggling_masked(fr8_project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'smug = pd.DataFrame({v: [1, 2], "PLAIN_COL": [3, 4]})\n'
                'outputs = {"SMUG": smug}\n'})
    assert result["ok"] is True, result
    names = [column["name"] for column in result["receipt"]["outputs"]["SMUG"]["columns"]]
    assert names == ["[DATA]", "PLAIN_COL"]         # 走私列名遮蔽，正常列名原样
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# A-5 print(单元格值) → [DATA]；无关调试文本原样（零误伤）
# ---------------------------------------------------------------------------

def test_a05_print_cell_masked_debug_text_untouched(fr8_project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'print(datasets["AE"].iloc[0]["AETERM"])\n'
                'print("MODEL_STDOUT")\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "[DATA]\nMODEL_STDOUT\n"


# ---------------------------------------------------------------------------
# A-6 publish 回执零行值（仅元信息）
# ---------------------------------------------------------------------------

def test_a06_publish_receipt_zero_row_values(fr8_project):
    worker.dispatch({"operation": "listing_inspect", "project": str(fr8_project)})
    run = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'out = datasets["AE"].copy()\n'
                'out.attrs["labels"] = {"USUBJID": "S", "AETERM": "T", "DOSE": "D"}\n'
                'outputs = {"AE": out}\n'})
    assert run["ok"] is True, run
    result = worker.dispatch({
        "operation": "listing_publish", "project": str(fr8_project), "scenario": "medical"})
    assert result["ok"] is True, result
    assert (fr8_project / result["receipt"]["outputFile"]).exists()
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# A-8 归档 zip 解出的数据集值遮蔽
# ---------------------------------------------------------------------------

def test_a08_archive_zip_dataset_values_masked(tmp_path):
    with zipfile.ZipFile(tmp_path / "batch.zip", "w") as archive:
        archive.writestr("RAW.csv", "ID,TERM\nARCH-SUBJ-001,Archive-Rash\n")
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(tmp_path),
        "code": 'print(datasets["RAW"].iloc[0]["TERM"])\n'
                'print(datasets["RAW"].iloc[0]["ID"])\n'
                'outputs = {"RAW": datasets["RAW"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "[DATA]\n[DATA]\n"
    payload = _payload(result)
    assert "ARCH-SUBJ-001" not in payload and "Archive-Rash" not in payload


# ---------------------------------------------------------------------------
# A-9 开关关闭 dataInterception=false → stdout 原样含行值（正确语义）
# ---------------------------------------------------------------------------

def test_a09_switch_off_passthrough(tmp_path):
    (tmp_path / "AE.csv").write_text(
        "USUBJID,AETERM\nSUBJ-777,Headache\nSUBJ-888,Nausea\n", encoding="utf-8")
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(tmp_path),
        "dataInterception": False,
        "code": 'print(datasets["AE"].iloc[0]["AETERM"])\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "Headache\n"     # 零拦截 = 原样回执


# ---------------------------------------------------------------------------
# A-10 请求缺旗标 → fail-closed 遮蔽生效
# ---------------------------------------------------------------------------

def test_a10_missing_flag_fail_closed(fr8_project):
    assert "dataInterception" not in {"operation": "x"}     # 语义自证：请求不带旗标
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'print(datasets["AE"].iloc[0]["AETERM"])\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "[DATA]\n"
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# A-11 doc/ xlsx 单元格值与 txt 文本全量直通（豁免，零误伤）
# ---------------------------------------------------------------------------

def test_a11_doc_payloads_full_passthrough(tmp_path):
    from openpyxl import Workbook
    (tmp_path / "doc").mkdir()
    (tmp_path / "doc" / "spec.txt").write_text("需求文档 REQUIREMENT-TAIL", encoding="utf-8")
    wb = Workbook(); ws = wb.active; ws.title = "Notes"
    ws.append(["note"]); ws.append(["DOC-CELL-ZULU-77"]); ws.append(["Headache"])
    wb.save(tmp_path / "doc" / "notes.xlsx")
    (tmp_path / "AE.csv").write_text(
        "USUBJID,AETERM\nSUBJ-777,Headache\n", encoding="utf-8")
    result = worker.dispatch({"operation": "listing_inspect", "project": str(tmp_path)})
    assert result["ok"] is True, result
    payload = _payload(result)
    assert "DOC-CELL-ZULU-77" in payload            # doc 单元格值全量直通
    assert "REQUIREMENT-TAIL" in payload            # doc 文本全量直通
    assert "Headache" in payload                    # doc 同值单元格豁免直通（ADR-0007）
    assert "SUBJ-777" not in payload                # 数据集行值仍零泄露


# ---------------------------------------------------------------------------
# A-12 执行自由：import os、open 读写、to_csv 往返、subprocess 可用
# ---------------------------------------------------------------------------

def test_a12_execution_freedom_os_open_csv_subprocess(fr8_project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'import os, subprocess, sys, tempfile\n'
                'os.environ["FR8_PROBE"] = "1"\n'
                'work = tempfile.mkdtemp()\n'
                'scratch = os.path.join(work, "scratch.txt")\n'
                'with open(scratch, "w", encoding="utf-8") as fh:\n'
                '    fh.write("MODEL-WRITE")\n'
                'with open(scratch, encoding="utf-8") as fh:\n'
                '    assert fh.read() == "MODEL-WRITE"\n'
                'df = datasets["AE"].copy()\n'
                'csv_path = os.path.join(work, "rt.csv")\n'
                'df.to_csv(csv_path, index=False)\n'
                'back = pd.read_csv(csv_path)\n'
                'assert len(back) == 2\n'
                'proc = subprocess.run(\n'
                '    [sys.executable, "-c", "print(\'SUBPROC-OK\')"],\n'
                '    capture_output=True, text=True)\n'
                'assert proc.returncode == 0\n'
                'print("ROUNDTRIP-MODEL-WRITE")\n'
                'print(proc.stdout.strip())\n'
                'outputs = {"AE": back}\n'
                'import shutil; shutil.rmtree(work)\n'})
    assert result["ok"] is True, result
    stdout = result["receipt"]["stdout"]
    assert "ROUNDTRIP-MODEL-WRITE" in stdout and "SUBPROC-OK" in stdout
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# A-13 数据集元数据 7 键正常放行（列名与单元格值不重叠）
# ---------------------------------------------------------------------------

def test_a13_dataset_metadata_seven_keys_pass(fr8_project):
    result = worker.dispatch({"operation": "listing_inspect", "project": str(fr8_project)})
    assert result["ok"] is True, result
    dataset = result["inspection"]["datasets"][0]
    assert dataset["name"] == "AE"
    assert dataset["path"] == "AE.csv"
    assert dataset["columns"] == ["USUBJID", "AETERM", "DOSE"]
    assert dataset["rowCount"] == 2
    assert set(dataset["dtypes"]) == {"USUBJID", "AETERM", "DOSE"}
    assert dataset["nullCount"] == {"USUBJID": 0, "AETERM": 0, "DOSE": 0}
    assert dataset["uniqueCount"] == {"USUBJID": 2, "AETERM": 2, "DOSE": 1}


# ---------------------------------------------------------------------------
# A-15 run_code 内 subprocess：捕获通道遮蔽 / 继承 fd 通道不得泄露
# ---------------------------------------------------------------------------

def test_a15a_subprocess_captured_output_masked(fr8_project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'import subprocess, sys\n'
                'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'proc = subprocess.run(\n'
                '    [sys.executable, "-c", "import sys; print(sys.argv[1])", v],\n'
                '    capture_output=True, text=True)\n'
                'print(proc.stdout.strip())\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "[DATA]\n"    # 捕获后经 Python print → 遮蔽
    _assert_zero_leak(result)


def test_a15b_subprocess_inherited_fd_stdout_masked(fr8_project, capfd):
    """A-15b：子进程继承 fd 级 stdout 直打数据集值 → 不得出域。

    真实部署中 worker 的 fd1 即 NDJSON 协议管道：子进程直写 fd1 会绕过
    回执层遮蔽直接进入协议流。此处以 fd 级捕获模拟该通道。
    """
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'import subprocess, sys\n'
                'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'subprocess.run(\n'
                '    [sys.executable, "-c", "import sys; print(sys.argv[1])", v])\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert "Headache" not in _payload(result)          # 回执本身干净（捕获流收不到 fd 输出）
    fd_out = capfd.readouterr().out
    assert "Headache" not in fd_out, "A-15b 子进程继承 fd1 绕过回执遮蔽直写出域"


# ---------------------------------------------------------------------------
# 补充：异常路径 reason/traceback 遮蔽 + WORKER_ERROR 兜底
# ---------------------------------------------------------------------------

def test_supp_exception_reason_masked(fr8_project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'raise ValueError(datasets["AE"].iloc[0]["AETERM"])'})
    assert result["ok"] is False
    assert result["code"] == "CODE_EXECUTION_ERROR"
    assert result["reason"] == "代码执行失败: [DATA]"
    _assert_zero_leak(result)


def test_supp_exception_fstring_reason_masked(fr8_project):
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": "raise ValueError(f\"bad id {datasets['AE'].iloc[0]['USUBJID']}\")"})
    assert result["ok"] is False
    assert result["reason"] == "代码执行失败: bad id [DATA]"
    _assert_zero_leak(result)


def test_supp_worker_error_fallback_masks_reason_and_traceback(fr8_project, monkeypatch, capsys):
    """main() 兜底 WORKER_ERROR 分支：reason/traceback 同样遮蔽后才能出域。"""
    worker.dispatch({"operation": "listing_inspect", "project": str(fr8_project)})  # 种会话值集

    def boom(request):
        raise RuntimeError("publish crash on SUBJ-777 and Headache")
    monkeypatch.setattr(worker, "operation_publish", boom)
    request = json.dumps({"operation": "listing_publish", "project": str(fr8_project)})
    monkeypatch.setattr("sys.stdin", io.StringIO(request + "\n"))
    worker.main()
    out = capsys.readouterr().out
    assert "WORKER_ERROR" in out
    assert "SUBJ-777" not in out and "Headache" not in out
    assert "[DATA]" in out
    assert out.count("\n") == 1                       # NDJSON 单行协议不破


# ---------------------------------------------------------------------------
# 探索性攻击 E-*：实现口径边界
# ---------------------------------------------------------------------------

def test_e01_fstring_path_smuggling_masked(fr8_project):
    """E-1：值经 f-string 拼进路径字符串（单 token 嵌入）→ 长值兜底遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'v = datasets["AE"].iloc[0]["USUBJID"]\n'
                'h = datasets["AE"].iloc[0]["AETERM"]\n'
                'print(f"out_{v}.csv")\n'
                'print(f"prefix_{h}_suffix")\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "out_[DATA].csv\nprefix_[DATA]_suffix\n"
    _assert_zero_leak(result)


def test_e02_repr_print_masked(fr8_project):
    """E-2：值经 repr()/容器 repr 打印（包裹标点形态）→ 遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'print(repr(v))\n'
                'print([v])\n'
                'print({v: 1})\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    # 首轮预期笔误修正：dict repr 的 {} 不在 _WRAPPED_PUNCT，仅替换命中子串
    # → 残形包裹标点保留（值本身零泄露，见下行全量断言）。
    assert result["receipt"]["stdout"] == "[DATA]\n[DATA]\n{'[DATA]': 1}\n"
    _assert_zero_leak(result)


def test_e03_output_table_name_smuggling(fr8_project):
    """E-3：数据集单元格值作为 outputs 表名（回执 dict 的 key）走私 → 必须遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'df = pd.DataFrame({"K": [1]})\n'
                'outputs = {v: df}\n'})
    assert result["ok"] is True, result
    payload = _payload(result)
    assert "Headache" not in payload, "E-3 outputs 表名（dict key）走私数据集行值出域"
    assert "[DATA]" in payload


def test_e04_case_sensitive_exact_match_accepted(fr8_project):
    """E-4：大小写变体不遮（精确匹配=大小写敏感是可接受口径，仅锁定语义）。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'print("subj-777")\n'
                'print(datasets["AE"].iloc[0]["USUBJID"])\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "subj-777\n[DATA]\n"   # 变体原样，原值遮蔽
    assert "SUBJ-777" not in _payload(result)


def test_e05_numeric_cell_str_masked(fr8_project):
    """E-5：数值单元格（12345）str 化入集，print 同样遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'print(datasets["AE"].iloc[0]["DOSE"])\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "[DATA]\n"
    _assert_zero_leak(result)


def test_e06_stderr_channel_masked(fr8_project):
    """E-6：stderr 通道写数据集值 → 回执 stderr 同样遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'import sys\n'
                'sys.stderr.write("probe " + datasets["AE"].iloc[0]["AETERM"] + chr(10))\n'
                'print("STDOUT-LANE")\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stderr"] == "probe [DATA]\n"
    assert result["receipt"]["stdout"] == "STDOUT-LANE\n"
    _assert_zero_leak(result)


def test_e07_short_value_exemption_boundary(tmp_path):
    """E-7：len<4 短值豁免（口径：误伤面>泄露面）——锁定语义，非 bug。"""
    (tmp_path / "S.csv").write_text("V\nabc\nwxyz\n", encoding="utf-8")
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(tmp_path),
        "code": 'print(datasets["S"].iloc[0]["V"])\n'
                'print(datasets["S"].iloc[1]["V"])\n'
                'outputs = {"S": datasets["S"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "abc\n[DATA]\n"   # len3 原样，len4 遮蔽


def test_e08_multiline_repeat_values_masked(fr8_project):
    """E-8：多行/重复打印值 → 每次出现都遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(fr8_project),
        "code": 'v = datasets["AE"].iloc[0]["USUBJID"]\n'
                'for _ in range(3):\n'
                '    print(v)\n'
                'print(v, v)\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "[DATA]\n[DATA]\n[DATA]\n[DATA] [DATA]\n"
    _assert_zero_leak(result)
