"""全量读取层：doc/ 文本全文 / xlsx 整表 / 源头标注 / 构建期节流 / 密码推导。"""
import json
import struct
import zipfile
import zlib

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


# ---------------------------------------------------------------------------
# BUG-R2（2026-08-30）：真实中文 Windows zip（GBK 条目名 + ZipCrypto 加密）
# 解压健壮性——错误密码碰巧通过校验头后 zlib.error 冒泡、GBK 名乱码落盘
# ---------------------------------------------------------------------------

_CRC_TABLE: list[int] | None = None


def _crc_primitive(ch: int, crc: int) -> int:
    """ZipCrypto 用的 CRC32 单字节 primitive（同 zipfile 内部实现）。"""
    global _CRC_TABLE
    if _CRC_TABLE is None:
        table = []
        for index in range(256):
            value = index
            for _ in range(8):
                value = (value >> 1) ^ 0xEDB88320 if value & 1 else value >> 1
            table.append(value)
        _CRC_TABLE = table
    return (crc >> 8) ^ _CRC_TABLE[(crc ^ ch) & 0xFF]


class _ZipCryptoEncrypter:
    """PKWARE 传统加密（ZipCrypto）对称加密器。

    zipfile 只内置解密器；加密 keystream / keys 更新与解密完全对称
    （keys 以明文字节更新），供测试构造真实形态的加密归档。
    """

    def __init__(self, pwd: bytes):
        self.key0, self.key1, self.key2 = 305419896, 591751049, 878082192
        for byte in pwd:
            self._update(byte)

    def _update(self, plain: int) -> None:
        self.key0 = _crc_primitive(plain, self.key0)
        self.key1 = (self.key1 + (self.key0 & 0xFF)) & 0xFFFFFFFF
        self.key1 = (self.key1 * 134775813 + 1) & 0xFFFFFFFF
        self.key2 = _crc_primitive((self.key1 >> 24) & 0xFF, self.key2)

    def encrypt(self, data: bytes) -> bytes:
        out = bytearray()
        for byte in data:
            key = self.key2 | 2
            out.append(byte ^ (((key * (key ^ 1)) >> 8) & 0xFF))
            self._update(byte)
        return bytes(out)


def _build_legacy_zip(path, entries, pwd, corrupt_payload=False):
    """造 GBK 条目名 + ZipCrypto 加密的传统 zip（模拟中文 Windows 打包）。

    标准库 zipfile 无法写加密成员，且非 ASCII 名会强制 0x800+UTF-8 旗标
    ——因此手动拼 local header / central directory / EOCD：条目名以 GBK
    字节写入、不置 0x800、置加密旗标 0x1（zipfile 读侧即按 cp437 解名 +
    ZipCrypto 校验字节解密，与真实归档形态一致）。
    ``corrupt_payload=True`` 破坏 deflate 流尾（确定性触发解压期 zlib
    失败——测密码候选循环对"解压报错"类失败的健壮性）。
    """
    pwd_bytes = pwd.encode("utf-8")
    local_parts, central_parts = [], []
    offset = 0
    dostime = (3 << 11) | (4 << 5) | 3
    dosdate = ((2024 - 1980) << 9) | (1 << 5) | 2
    for name, content in entries:
        name_bytes = name.encode("gbk")
        crc = zlib.crc32(content) & 0xFFFFFFFF
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
        payload = compressor.compress(content) + compressor.flush()
        if corrupt_payload:
            payload = payload[:-1] + bytes([payload[-1] ^ 0xFF])
        header = bytes(range(11)) + bytes([(crc >> 24) & 0xFF])   # 12 字节加密头，校验字节=CRC 高位
        stream = _ZipCryptoEncrypter(pwd_bytes).encrypt(header + payload)
        flags = 0x1                                                # bit0 加密；不置 0x800
        local = struct.pack("<4s5H3L2H", b"PK\x03\x04", 20, flags, 8,
                            dostime, dosdate, crc, len(stream), len(content),
                            len(name_bytes), 0)
        central = struct.pack("<4s6H3L5H2L", b"PK\x01\x02", 20, 20, flags, 8,
                              dostime, dosdate, crc, len(stream), len(content),
                              len(name_bytes), 0, 0, 0, 0, 0, offset)
        local_parts.append(local + name_bytes + stream)
        central_parts.append(central + name_bytes)
        offset += len(local_parts[-1])
    body = b"".join(local_parts)
    central_dir = b"".join(central_parts)
    path.write_bytes(body + central_dir + struct.pack(
        "<4s4H2LH", b"PK\x05\x06", 0, 0, len(entries), len(entries),
        len(central_dir), len(body), 0))


def test_extract_gbk_named_encrypted_archive_end_to_end(tmp_path):
    """BUG-R2 复现（合成）：GBK 条目名 + ZipCrypto 密码归档。修复点：
    ① 错误候选（project.name 等推导密码）解压失败被跳过，直到 sidecar
    正确密码候选成功；② 条目名 cp437→GBK 兜底还原（不再乱码落盘）；
    ③ discovery 全链路从加密归档扫出数据集。"""
    csv_bytes = "USUBJID,AETERM\nSUBJ-777,合成不良事件\nSUBJ-888,恶心\n".encode("utf-8")
    archive = tmp_path / "raw.zip"
    _build_legacy_zip(archive, [
        ("试验数据集/ae数据集.csv", csv_bytes),
        ("试验数据集/说明文件.txt", "非数据成员".encode("utf-8")),
    ], pwd="SideCarPW99!")
    (tmp_path / "raw.txt").write_text("SideCarPW99!", encoding="utf-8")   # sidecar 密码

    datasets, failures, sources = load_datasets(tmp_path)
    assert failures == []
    assert sources == {"AE数据集": "archive/raw.zip/试验数据集/ae数据集.csv"}
    assert list(datasets["AE数据集"]["USUBJID"]) == ["SUBJ-777", "SUBJ-888"]
    work_root = tmp_path / ".clinical-listing" / "_work"
    extracted = sorted(path.relative_to(work_root).as_posix()
                       for path in work_root.rglob("*.csv"))
    assert extracted == ["0000-raw/试验数据集/ae数据集.csv"]   # GBK 名还原落盘


def test_extract_corrupt_stream_reports_credential_not_resolved(tmp_path):
    """BUG-R2 根因锁定：解压期 zlib/BadZipFile 类失败（错误密码碰巧通过
    ZipCrypto 1 字节校验头后数据解压报错 / 数据损坏）不得冒泡——该候选
    被跳过继续尝试，全部候选失败后统一抛凭据未解析信号（旧实现直接把
    zlib.error 冒给调用方，即真实项目的"非凭据类解压错误"）。"""
    from archive_passwords import extract_with_password

    archive = tmp_path / "raw.zip"
    _build_legacy_zip(archive, [("数据集/dm.csv", "ID\n1\n".encode("utf-8"))],
                      pwd="SideCarPW99!", corrupt_payload=True)
    (tmp_path / "raw.txt").write_text("SideCarPW99!", encoding="utf-8")
    with pytest.raises(RuntimeError, match="Archive credential was not resolved"):
        extract_with_password(archive, tmp_path / "_extract", tmp_path, "SideCarPW99!")


def test_archive_password_env_override(tmp_path, monkeypatch):
    """DSH_ARCHIVE_PASSWORD 注入密码：推导候选全覆盖不到时的逃生通道
    （候选优先级：显式凭据 > 环境变量 > 推导候选 > 无密码）。"""
    from archive_passwords import ARCHIVE_PASSWORD_ENV, extract_with_password, password_candidates

    archive = tmp_path / "raw.zip"
    _build_legacy_zip(archive, [("数据集/lb.csv", "ID\n7\n".encode("utf-8"))], pwd="EnvPW42!")
    monkeypatch.setenv(ARCHIVE_PASSWORD_ENV, "EnvPW42!")
    decoded = [value.decode() for value in password_candidates(tmp_path, archive)
               if value is not None]
    assert decoded[0] == "EnvPW42!"                       # env 候选排在推导候选之前
    extract_with_password(archive, tmp_path / "_extract", tmp_path)
    assert (tmp_path / "_extract" / "数据集" / "lb.csv").read_text(encoding="utf-8") == "ID\n7\n"


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
