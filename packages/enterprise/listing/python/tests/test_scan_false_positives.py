"""保护值索引按列基数判定（2026-09-07）。

红线：受试者数据（值随行变化的列：受试者号、日期、检验值、自由文本、质疑内容）
必须命中；方案词表（几十上百行只有几个值的列：状态、年份、访视名、表单名、
码表解码）不入索引——模型理解数据必须能提到它们。"""
import pandas as pd

import worker


def _frame(rows: int = 40) -> pd.DataFrame:
    return pd.DataFrame({
        "SUBJID": [f"{1000 + index}" for index in range(rows)],            # 高基数：受试者号
        "AETERM": [f"Headache grade {index}" for index in range(rows)],     # 高基数：自由文本
        "AESTDTC": [f"2026-01-{index + 1:02d}" for index in range(rows)],   # 高基数：日期
        "AESTTM": [f"{9 + index % 12:02d}:{index:02d}" for index in range(rows)],
        "ISDEL": ["False"] * rows,                                          # 词表列
        "YEAR": [2026] * (rows // 2) + [2025] * (rows - rows // 2),         # 词表列
        "VISIT": ["Cycle 1 Day 1", "Screening", "Baseline"] * (rows // 3) + ["Screening"] * (rows % 3),
        "SUBJSTA": ["Enrolled", "Completed"] * (rows // 2),
    })


def test_high_cardinality_row_values_protected():
    hashes = worker.protected_value_hashes({"AE": _frame()}, [])
    scan = lambda text: worker.text_contains_protected_value(text, hashes)  # noqa: E731
    assert scan("subject 1007 enrolled") is True            # 4 位纯数字受试者号
    assert scan("Headache grade 7 reported") is True
    assert scan("onset 2026-01-08") is True
    assert scan("time 12:03 recorded") is True              # 带内部分隔符的整值按原样匹配（index 3）


def test_vocabulary_columns_not_indexed():
    hashes = worker.protected_value_hashes({"AE": _frame()}, [])
    scan = lambda text: worker.text_contains_protected_value(text, hashes)  # noqa: E731
    assert scan("filter VISIT == Cycle 1 Day 1 or Screening") is False
    assert scan("status Enrolled / Completed, year 2026") is False
    assert scan("True False None null") is False
    assert scan("Test Files 2 passed (2) Start at 09:15:16 Duration 842ms") is False


def test_small_tables_are_fully_protected():
    """样本太少无法判定基数、又没有同名列可借证据：非结构列一律按数据保护
    （fail-closed）；结构列（VISIT/SITE 等方案词表）按列名豁免，不受表大小影响。"""
    frame = pd.DataFrame({"SUBJID": ["1007", "1014"], "VISIT": ["Screening", "Screening"]})
    hashes = worker.protected_value_hashes({"AE": frame}, [])
    assert worker.text_contains_protected_value("subject 1007 enrolled", hashes) is True
    assert worker.text_contains_protected_value("visit Screening", hashes) is False


def test_small_table_borrows_pooled_evidence_for_same_named_column():
    """GQ1005-301 实测：PSTUDYID 在 70+ 张表里是常量，但 19 行的 DD 表触发小表兜底
    把方案号灌回索引，目录列表因此被拦。同名列跨数据集汇总后再判基数。"""
    big = pd.DataFrame({"PSTUDYID": ["GQ1005-301"] * 40, "SUBJID": [f"{1000 + i}" for i in range(40)]})
    small = pd.DataFrame({"PSTUDYID": ["GQ1005-301"] * 5, "SUBJID": [f"{2000 + i}" for i in range(5)]})
    hashes = worker.protected_value_hashes({"AE": big, "DD": small}, [])
    scan = lambda text: worker.text_contains_protected_value(text, hashes)  # noqa: E731
    assert scan("project GQ1005-301") is False
    assert scan("subject 2003") is True                     # 小表的高基数列仍保护


def test_project_file_names_are_disclosed_structure(tmp_path):
    """项目目录名/文件名（含分词片段）经 inspect path 已披露，目录列表不构成泄露。"""
    (tmp_path / "GQ1005-301_ALS_V1.0_20241219.xlsx").write_bytes(b"")
    frame = pd.DataFrame({"ICFVER": ["V1.0", "V2.0", "V1.1", "V3.0", "V1.0"],
                          "SUBJID": [f"{1000 + i}" for i in range(5)]})
    hashes = worker.protected_value_hashes({"IC": frame}, [], tmp_path)
    scan = lambda text: worker.text_contains_protected_value(text, hashes)  # noqa: E731
    assert scan("GQ1005-301_ALS_V1.0_20241219.xlsx  12345") is False
    assert scan("version V2.0") is True                     # 未出现在文件名里的行值仍保护


def test_lone_lowercase_word_is_not_identifying():
    """TAISHAN-304 实测：自由文本列里一个单元格恰好是 "text"，普通英文句
    "plain diagnostic text" 因此被拦——孤立小写词无法指认任何数据。"""
    frame = pd.DataFrame({"QSREASND": ["text", "other", "refused"], "SUBJID": ["1007", "1014", "1021"]})
    hashes = worker.protected_value_hashes({"QS": frame}, [])
    scan = lambda text: worker.text_contains_protected_value(text, hashes)  # noqa: E731
    assert scan("plain diagnostic text without any clinical value") is False
    assert scan("subject 1014") is True


def test_value_protected_if_high_cardinality_anywhere():
    """受试者号在 LB 里成千上万次重复，但在 DM 里每行一个：仍受保护。"""
    subjects = [f"{1000 + index}" for index in range(30)]
    dm = pd.DataFrame({"SUBJID": subjects})
    lb = pd.DataFrame({"SUBJID": [subjects[0]] * 60, "LBORRES": [str(i) for i in range(60)]})
    hashes = worker.protected_value_hashes({"DM": dm, "LB": lb}, [])
    assert worker.text_contains_protected_value("subject 1000", hashes) is True


def test_aux_excel_business_rows_by_column_cardinality():
    rows = [[f"QRY-{i}", "AE", f"请核实第 {i} 条不良事件描述", "Open"] for i in range(30)]
    document = {"path": "query_log.xlsx", "rows": [{"sheet": "query", "rows": rows}]}
    hashes = worker.protected_value_hashes({}, [document])
    scan = lambda text: worker.text_contains_protected_value(text, hashes)  # noqa: E731
    assert scan("leak QRY-7") is True
    assert scan("请核实第 7 条不良事件描述") is True
    assert scan("status Open") is False                     # 单值状态列是词表


def test_design_words_disclosed_by_lane_not_blocked():
    frame = pd.DataFrame({"SUBJID": ["1007"], "FORMNM": ["Visit Date"]})
    document = {"path": "als.xlsx", "designSheets": ["Forms"],
                "rows": [{"sheet": "Forms", "rows": [["SV", "Visit Date"]]}]}
    hashes = worker.protected_value_hashes({"AE": frame}, [document])
    assert worker.text_contains_protected_value("open Visit Date form", hashes) is False
    assert worker.text_contains_protected_value("subject 1007", hashes) is True


def test_structural_columns_not_indexed_even_when_high_cardinality():
    """RBQM 实测（2026-09-15，77 次误拦）：SITE_NAME 78 个中心名、FOLDER 多实例
    名超过基数阈值（>30）被误当保护值，中心/文件夹诊断日志被整体拦死。结构列
    （中心/文件夹/访视/表单/时点）按列名放行，不受基数限制；受试者号照旧保护。"""
    frame = pd.DataFrame({
        "SITE_NAME": [f"Cancer Hospital {index}" for index in range(60)],
        "FOLDER": [f"Cycle {index % 12 + 1} Day 1" for index in range(60)],
        "SUBJID": [f"2001{index:03d}" for index in range(60)],
    })
    hashes = worker.protected_value_hashes({"DM": frame}, [])
    scan = lambda text: worker.text_contains_protected_value(text, hashes)  # noqa: E731
    assert scan("site Cancer Hospital 17 enrolled") is False
    assert scan("folder Cycle 5 Day 1 visit done") is False
    assert scan("subject 2001017 enrolled") is True


def test_scan_cache_roundtrip_and_fingerprint(tmp_path):
    """扫描哈希按数据面指纹落盘：重启后秒级恢复，消除 fail-closed 风暴；
    缓存只存 64 位哈希、不含任何数据值；Output/.clinical-listing 不参与指纹。"""
    frame = pd.DataFrame({
        "SUBJID": [f"2001{index:03d}" for index in range(40)],
        "SITE": [f"site {index % 5}" for index in range(40)],
    })
    hashes = worker.protected_value_hashes({"DM": frame}, [])
    worker._save_scan_cache(tmp_path, "fp-1", hashes)
    assert worker._load_scan_cache(tmp_path, "fp-1") == hashes
    assert worker._load_scan_cache(tmp_path, "fp-2") is None
    data_dir = tmp_path / "Project_Data"
    data_dir.mkdir()
    (data_dir / "ae.sas7bdat").write_bytes(b"x")
    fp_a = worker._scan_cache_fingerprint(tmp_path)
    assert worker._scan_cache_fingerprint(tmp_path) == fp_a          # 稳定
    (data_dir / "ae.sas7bdat").write_bytes(b"yy")
    fp_b = worker._scan_cache_fingerprint(tmp_path)
    assert fp_b != fp_a                                              # 内容变→指纹变
    out_dir = tmp_path / "Output"
    out_dir.mkdir()
    (out_dir / "KRI_010.xlsx").write_bytes(b"z")
    assert worker._scan_cache_fingerprint(tmp_path) == fp_b          # 产出目录不计
