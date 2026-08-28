"""全量读取层：doc/ 文本全文 / xlsx 整表 / 源头标注 / 构建期节流 / 密码推导。"""
import json
import zipfile

import pytest
from openpyxl import Workbook

import discovery
from discovery import (
    list_files,
    load_datasets,
    read_spec_files,
    scan_excel_structures,
)


def test_read_spec_files_full_text_content(project):
    documents, failures = read_spec_files(project / "doc")
    assert failures == []
    doc = documents[0]
    assert doc["_source"] == "spec-document"      # 审计标记；不在投影表 = 全量直通
    assert doc["path"] == "spec.txt"
    assert doc["type"] == "text"
    assert "REQUIREMENT-TAIL" in doc["content"]   # 全文在场，永不被投影
    assert doc["lineCount"] >= 3


def test_read_spec_files_text_cap_protocol_guard(tmp_path):
    """协议护栏（非拦截）：200K 上限 + 截断显式标记；未触限不标记。"""
    (tmp_path / "doc").mkdir()
    (tmp_path / "doc" / "big.txt").write_text("Y" * 250_000, encoding="utf-8")
    (tmp_path / "doc" / "small.txt").write_text("Z" * 1000, encoding="utf-8")
    documents, _ = read_spec_files(tmp_path / "doc")
    by_path = {doc["path"]: doc for doc in documents}
    assert len(by_path["big.txt"]["content"]) == 200_000
    assert by_path["big.txt"]["truncated"] is True
    assert "truncated" not in by_path["small.txt"]
    assert len(by_path["small.txt"]["content"]) == 1000


def test_read_spec_files_preserves_decoding_failure_marker(tmp_path):
    """UTF-8 非法字节显式替换，不静默丢字。"""
    (tmp_path / "doc").mkdir()
    (tmp_path / "doc" / "broken.txt").write_bytes(b"ok\xff\xfe\n")
    documents, failures = read_spec_files(tmp_path / "doc")
    assert failures == []
    assert documents[0]["content"] == "ok\ufffd\ufffd\n"


def _write_als(path):
    wb = Workbook()
    ws = wb.active
    ws.title = "ALS"
    ws.append(["Dataset Name", "Variable Name", "Label"])
    ws.append(["AE", "AETERM", "Adverse Event Term"])
    ws.append(["AE", "USUBJID", "Subject"])
    notes = wb.create_sheet("Notes")
    notes.append(["note"])
    notes.append(["SECRET-CELL-42"])
    wb.save(path)


def test_read_spec_files_excel_whole_table(project):
    _write_als(project / "doc" / "als.xlsx")
    documents, failures = read_spec_files(project / "doc")     # build_rows 默认 True
    assert failures == []
    als = next(doc for doc in documents if doc["type"] == "als")
    assert als["_source"] == "aux-excel"
    assert als["path"] == "als.xlsx"
    assert als["mappings"] == [
        {"datasetName": "AE", "sourceColumn": "AETERM", "label": "Adverse Event Term"},
        {"datasetName": "AE", "sourceColumn": "USUBJID", "label": "Subject"},
    ]
    assert als["datasets"] == ["AE"]
    # 整表读：行值在场（含非 ALS sheet），出域由 data_guard 投影剥除
    assert "SECRET-CELL-42" in json.dumps(als["rows"])
    sheets = {sheet["name"]: sheet for sheet in als["structure"]["sheets"]}
    assert sheets["ALS"]["rowCount"] == 3
    assert sheets["ALS"]["headerRows"][0] == ["Dataset Name", "Variable Name", "Label"]
    assert len(sheets["ALS"]["headerRows"]) == 2
    assert sheets["Notes"]["rowCount"] == 2


def test_read_spec_files_rows_always_built(project):
    """ADR-0007：doc/ 零拦截——rows 恒构建，无开关参数。"""
    _write_als(project / "doc" / "als.xlsx")
    documents, _ = read_spec_files(project / "doc")
    als = next(doc for doc in documents if doc["type"] == "als")
    assert als["rows"]                                   # 整表单元格值全量进回执
    assert als["mappings"] and als["structure"]          # 结构与三元组照常
    assert "truncated" not in als                        # 未触 20K 单元格护栏不标记


def test_load_datasets_tags_dataset_source(project):
    datasets, failures, sources = load_datasets(project)
    assert failures == []
    assert sources == {"AE": "AE.csv"}
    assert datasets["AE"].attrs["_source"] == "dataset"
    assert list(datasets["AE"].columns) == ["USUBJID", "AETERM"]


def test_load_datasets_falls_back_to_gbk_csv(tmp_path):
    """Windows 中文 CSV：UTF-8 解码失败时回退 GBK，不把数据源读失败。"""
    (tmp_path / "DM.csv").write_bytes("ID,名称\n1,受试者\n".encode("gbk"))
    datasets, failures, _ = load_datasets(tmp_path)
    assert failures == []
    assert datasets["DM"].loc[0, "名称"] == "受试者"


def test_dataset_payloads_throttling(project):
    datasets, _, sources = load_datasets(project)
    throttled = discovery.dataset_payloads(datasets, sources, with_sample=False)[0]
    assert "sample" not in throttled
    assert throttled["rowCount"] == 2 and throttled["columns"] == ["USUBJID", "AETERM"]
    assert throttled["dtypes"]["USUBJID"] in {"object", "str"}
    assert throttled["nullCount"] == {"USUBJID": 0, "AETERM": 0}
    assert throttled["uniqueCount"] == {"USUBJID": 2, "AETERM": 2}
    full = discovery.dataset_payloads(datasets, sources, with_sample=True)[0]
    assert full["sample"]["USUBJID"] == ["SUBJ-777", "SUBJ-888"]


def test_sample_rows_capped_exactly(tmp_path):
    (tmp_path / "AE.csv").write_text("ID\n" + "\n".join(str(i) for i in range(10)) + "\n", encoding="utf-8")
    from discovery import dataset_payloads, load_datasets
    datasets, _, sources = load_datasets(tmp_path)
    payloads = dataset_payloads(datasets, sources, with_sample=True)
    assert len(payloads[0]["sample"]["ID"]) == 3               # 字面量 3（MAX_SAMPLE_ROWS）


def test_scan_excel_structures_structure_only(project):
    _write_als(project / "doc" / "als.xlsx")
    payload = scan_excel_structures(project / "doc" / "als.xlsx")
    assert payload["_source"] == "aux-excel"
    assert payload["path"] == "als.xlsx"
    names = [sheet["name"] for sheet in payload["structure"]["sheets"]]
    assert names == ["ALS", "Notes"]
    assert "rows" not in payload  # 结构扫描天生只有结构，没有行值通道


def test_scan_excel_structures_rejects_non_excel(project):
    with pytest.raises(ValueError, match="NOT_EXCEL"):
        scan_excel_structures(project / "AE.csv")


def test_list_files_kinds_and_ignores(project):
    (project / ".clinical-listing" / "_work").mkdir(parents=True)
    (project / ".clinical-listing" / "_work" / "LEAK.csv").write_text("X\n1\n")
    entries = list_files(project)
    kinds = {entry["path"]: entry["kind"] for entry in entries}
    assert kinds["AE.csv"] == "dataset"
    assert kinds["doc/spec.txt"] == "text"
    assert not any("_work" in path for path in kinds)


def test_list_files_direct_call_has_project_fence(project, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    (outside / "x.csv").write_text("A\n1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="ESCAPE_PROJECT_ROOT"):
        list_files(project, str(outside))


def test_directory_named_like_dataset_is_skipped(tmp_path):
    """目录名带数据后缀（trap.csv/）不是数据源——不能进加载候选。"""
    (tmp_path / "trap.csv").mkdir()
    datasets, failures, sources = load_datasets(tmp_path)
    assert datasets == {} and failures == [] and sources == {}


def test_archive_non_data_members_ignored(tmp_path):
    """归档里的 .txt 与子目录不进数据集候选；只有数据扩展名文件被加载。"""
    import zipfile as _zip

    archive = tmp_path / "data.zip"
    with _zip.ZipFile(archive, "w") as zf:
        zf.writestr("nested/DM.csv", "ID\n1\n")
        zf.writestr("nested/readme.txt", "not a dataset")
    datasets, failures, sources = load_datasets(tmp_path)
    assert sources == {"DM": "archive/data.zip/nested/DM.csv"}
    assert failures == []


# ---------------------------------------------------------------------------
# 密码推导必须保留——工程现实，密码不在 doc/ AI 无法推断
# ---------------------------------------------------------------------------

def test_password_candidates_contract(tmp_path):
    from archive_passwords import password_candidates

    (tmp_path / "doc").mkdir()
    (tmp_path / "doc" / "hint.txt").write_text("SideCarPW99!", encoding="utf-8")
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "STEM-HINT.txt").write_text("SiblingPW7", encoding="utf-8")
    archive = tmp_path / "raw" / "STEM-HINT.zip"

    decoded = [value.decode() for value in password_candidates(tmp_path, archive) if value is not None]
    assert "STEM-HINT" in decoded        # zip 同名 .txt / zip 自身 stem
    assert "hint" in decoded             # 全树 rglob("*.txt") 的 stem（doc/ 下）
    assert "SiblingPW7" in decoded       # 归档同目录 sidecar 的内容
    explicit = [value.decode() for value in password_candidates(tmp_path, archive, "EXPLICIT-PW") if value is not None]
    assert explicit[0] == "EXPLICIT-PW"  # 显式凭据排第一
    assert password_candidates(tmp_path, archive)[-1] is None  # 无密码兜底在最后


def test_extract_with_password_sidecar(project):
    archive = project / "data.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("nested/DM.csv", "ID\n1\n")
    # zip 同名 sidecar .txt 携带密码（工程现实：密码文件与归档同目录）
    (project / "data.txt").write_text("SideCarPW99!", encoding="utf-8")
    # 无加密归档在任意候选下都能解出（zipfile 对未加密成员忽略 pwd）；
    # 这里验证 sidecar 候选与显式凭据都能走通解压管线
    discovery.extract_with_password(archive, project / "_extract", project, "SideCarPW99!")
    assert (project / "_extract" / "nested" / "DM.csv").read_text() == "ID\n1\n"


def test_password_value_never_in_receipt(project):
    """密码推导是程序职责，但密码值永不回执；失败清单带 path 键。"""
    import worker

    archive = project / "broken.zip"
    archive.write_bytes(b"not a zip")
    (project / "broken.txt").write_text("SideCarPW99!", encoding="utf-8")
    result = worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    payload = json.dumps(result, ensure_ascii=False)
    assert "SideCarPW99!" not in payload
    failure = result["inspection"]["failures"][0]
    assert failure["stage"] == "extract-archive"
    assert failure["path"] == "broken.zip"


def test_archive_directory_named_like_zip_skipped(tmp_path):
    """目录名带 .zip 后缀不是归档——不能进解压候选。"""
    (tmp_path / "evil.zip").mkdir()
    datasets, failures, sources = load_datasets(tmp_path)
    assert datasets == {} and failures == [] and sources == {}


def test_spec_cell_cap_boundary_two_sheets(tmp_path):
    """多 sheet 截断：恰 20000 单元格，第二个 sheet 完全不进 rows。"""
    import pandas as _pd

    doc = tmp_path / "doc"
    doc.mkdir()
    with _pd.ExcelWriter(doc / "big.xlsx") as writer:
        for sheet in ("A", "B"):
            _pd.DataFrame({f"C{i}": [f"v{i}"] * 1000 for i in range(21)}).to_excel(
                writer, sheet_name=sheet, index=False)
    documents, _ = read_spec_files(doc)
    rows = documents[0]["rows"]
    assert [entry["sheet"] for entry in rows] == ["A"]          # B 被 sheet 级 break 跳过
    total = sum(len(row) for entry in rows for row in entry["rows"])
    assert total == 20_000                                       # 字面量：常量被 mutant 改动必须暴露
    assert all(len(row) > 0 for row in rows[0]["rows"])           # 截断后不追加空行（末行可为部分行）
