"""全量读取层：list_files / scan_excel_structures / load_datasets / read_spec_files。

数据集整表永远进会话供 sandbox 计算；doc/ 是需求域，所有文件完整解析后
按分片协议出域。宿主开关开启时，doc/ 外 spec 辅助 Excel 只构建结构与
ALS 语义、数据集回执只构建元数据；开关关闭时完整行值照常构建。

本层数据载荷的 ``_source`` 标记仅作审计溯源：
- 数据集 DataFrame / dataset 载荷 → ``dataset``
- data/spec 辅助 Excel → ``aux-excel``
- doc/ 文本与 Excel → ``spec-document``（不在投影表 = 全量直通）
"""
import datetime
import decimal
import base64
import xml.etree.ElementTree as ET
import math
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

from archive_passwords import ArchivePasswordRequired, InvalidArchive, extract_with_password
from source_registry import DataSource, tag_dataframe, tag_payload

DATA_EXTENSIONS = frozenset({".sas7bdat", ".xpt", ".csv"})
EXCEL_EXTENSIONS = {".xlsx", ".xls", ".xlsm"}
TEXT_EXTENSIONS = {".txt", ".md"}
SCAN_IGNORE_PARTS = {".clinical-listing"}


class DatasetSourceConflict(ValueError):
    """兼容旧错误类型；重复物理来源现在由加载器去重，不再抛出。"""


def jsonable(value: Any) -> Any:
    """把 pandas/numpy 标量转换为 JSON 可序列化的等价值。"""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, (pd.Timestamp, datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return str(value)
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, np.ndarray):
        return [jsonable(item) for item in value.tolist()]
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value)


# ---------------------------------------------------------------------------
# 文件发现
# ---------------------------------------------------------------------------

def _file_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in DATA_EXTENSIONS:
        return "dataset"
    if suffix in EXCEL_EXTENSIONS:
        return "excel"
    if suffix in TEXT_EXTENSIONS:
        return "text"
    if suffix == ".zip":
        return "archive"
    return "other"


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _is_generated_output(path: Path, project: Path) -> bool:
    return _is_relative_to(path, project / ".clinical-listing" / "output")


def _is_archive_workspace(path: Path, project: Path) -> bool:
    # 仅识别本插件生成的缓存目录；真实项目输入目录不因名称相似被误删。
    return _is_relative_to(path, project / ".clinical-listing" / "_work")


def classify_project_file(path: Path, project: Path) -> str:
    """按项目角色分类；doc/ 需求域优先于扩展名。"""
    path, project = Path(path), Path(project)
    if _is_relative_to(path, project / "doc"):
        return "spec-document"
    if _is_generated_output(path, project):
        return "generated-output"
    suffix = path.suffix.lower()
    if suffix in DATA_EXTENSIONS:
        return "dataset"
    if suffix in EXCEL_EXTENSIONS:
        return "aux-excel"
    return "passthrough"


def list_files(project: Path, subdir: str = "") -> list[dict[str, Any]]:
    """列出项目文件（AI 可调）：路径/大小/种类。文件清单不含数据值。"""
    project = Path(project).resolve()
    root = (project / subdir).resolve()
    if root != project and project not in root.parents:
        raise ValueError(f"ESCAPE_PROJECT_ROOT: {subdir!r}")
    entries: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*"), key=str):
        if not path.is_file():
            continue
        if any(part in SCAN_IGNORE_PARTS for part in path.parts):
            continue
        try:
            size = path.stat().st_size
        except OSError:
            continue                                # V-7b：并发删除竞态,跳过而非整单失败
        entries.append({
            "path": path.relative_to(project).as_posix(),
            "size": size,
            "kind": _file_kind(path),
        })
    return entries


def scan_excel_structures(path: Path) -> dict[str, Any]:
    """扫描 excel 表结构（AI 可调）：sheet 维度 + 表头带。只产结构，不产行值。"""
    path = Path(path)
    if path.suffix.lower() not in EXCEL_EXTENSIONS:
        raise ValueError(f"NOT_EXCEL: {path.name}")
    sheets = pd.read_excel(path, sheet_name=None)
    return tag_payload({
        "path": path.name,
        "structure": {"sheets": [_sheet_structure(name, frame) for name, frame in sheets.items()]},
    }, DataSource.AUX_EXCEL)


def _sheet_structure(name: str, frame: pd.DataFrame) -> dict[str, Any]:
    """sheet 结构摘要；只返回列名行，不返回任何数据行。"""
    return {
        "name": str(name),
        "rowCount": int(len(frame)) + 1,
        "columnCount": int(frame.shape[1]),
        "headerRows": [[str(column) for column in frame.columns]],
    }


# ---------------------------------------------------------------------------
# 数据集加载（sas/xpt/csv + 加密归档）——源头 sas-dataset
# ---------------------------------------------------------------------------

def _failure(
    path: Path, root: Path, stage: str, exc: Exception, include_error: bool = False,
    code: Optional[str] = None,
) -> dict[str, str]:
    try:
        display = path.relative_to(root).as_posix()
    except ValueError:
        display = str(path)
    # 异常文本可能包含解析出的单元格/行值；失败回执只保留结构字段。
    failure: dict[str, str] = {"path": display, "stage": stage}
    if code:
        failure["code"] = code
    if include_error:
        failure["error"] = str(exc)
    return failure


def _read_frame(path: Path) -> pd.DataFrame:
    if path.suffix.lower() == ".csv":
        try:
            return pd.read_csv(path, encoding="utf-8")
        except UnicodeDecodeError:
            return pd.read_csv(path, encoding="gbk")
    return pd.read_sas(path, encoding="utf-8")


def _plain_sources(project: Path) -> list[Path]:
    return sorted(
        (p for p in project.rglob("*")
         if p.is_file()
         and classify_project_file(p, project) == "dataset"
         and not _is_archive_workspace(p, project)),
        key=str,
    )


def _archives(project: Path) -> list[Path]:
    return sorted(
        (p for p in project.rglob("*")
         if p.is_file()
         and p.suffix.lower() == ".zip"
         and not _is_relative_to(p, project / "doc")
         and not _is_generated_output(p, project)),
        key=str,
    )


def _register_source(
    sources: dict[str, str], name: str, display: str,
) -> bool:
    """注册逻辑数据集；重复物理表示跳过，绝不让模型处理输入文件。

    一个项目常同时携带 SAS、XPT 或归档缓存的同名成员。扫描顺序已经
    排序并因此是稳定优先级；首个来源成为逻辑数据集，后续来源只作为
    重复候选被忽略，避免覆盖或因重复表示导致整单失败。
    """
    if name in sources:
        return False
    sources[name] = display
    return True


def _extracted_sources(
    project: Path, credential: Optional[str], failures: list[dict[str, str]],
    extract_root: Path, include_errors: bool = False,
) -> list[tuple[Path, str]]:
    result: list[tuple[Path, str]] = []
    archives = _archives(project)
    if len(archives) > MAX_OUTER_ARCHIVES:
        _append_archive_failure(
            failures, "archives/*", "ARCHIVE_COUNT_LIMIT",
            RuntimeError(f"{len(archives)} archives exceed limit {MAX_OUTER_ARCHIVES}"),
            include_error=include_errors)
        archives = archives[:MAX_OUTER_ARCHIVES]
    for index, archive in enumerate(archives):
        extract_dir = extract_root / f"{index:04d}-{archive.stem}"
        try:
            extraction = extract_with_password(archive, extract_dir, project, credential)
            if extraction.has_password_required:
                failures.append(_failure(
                    archive, project, "extract-archive",
                    RuntimeError("mixed archive contains password-protected members"),
                    include_error=include_errors, code="ARCHIVE_PASSWORD_PARTIAL"))
            archive_display = f"archive/{archive.relative_to(project).as_posix()}"
            display_roots = _extract_nested_archives(
                extract_dir, archive_display, project, credential,
                failures, include_errors=include_errors,
            )
            extracted = [
                path for path in sorted(extract_dir.rglob("*"), key=str)
                if path.is_file() and path.suffix.lower() in DATA_EXTENSIONS
            ]
            if not extracted:
                failures.append(_failure(
                    archive, project, "extract-archive", RuntimeError("no dataset members"),
                    include_error=include_errors, code="ARCHIVE_NO_DATASETS"))
                continue
            for path in extracted:
                containing_roots = []
                for root in display_roots:
                    try:
                        path.relative_to(root)
                        containing_roots.append(root)
                    except ValueError:
                        continue
                display_root = max(
                    containing_roots,
                    key=lambda item: len(item.parts),
                    default=extract_dir,
                )
                result.append((
                    path,
                    f"{display_roots.get(display_root, archive_display)}/{path.relative_to(display_root).as_posix()}",
                ))
        except ArchivePasswordRequired as exc:
            failures.append(_failure(
                archive, project, "extract-archive", exc,
                include_error=include_errors, code="ARCHIVE_PASSWORD_REQUIRED"))
        except InvalidArchive as exc:
            failures.append(_failure(
                archive, project, "extract-archive", exc,
                include_error=include_errors, code="ARCHIVE_INVALID"))
        except Exception as exc:
            failures.append(_failure(
                archive, project, "extract-archive", exc,
                include_error=include_errors, code="ARCHIVE_EXTRACT_FAILED"))
    return result


MAX_NESTED_ARCHIVE_DEPTH = 5
MAX_EXTRACTED_ARCHIVES = 1_000
#: 顶层归档数量上限：归档风暴（数万个 zip）会把一次 inspect 拖死。
MAX_OUTER_ARCHIVES = 200

def _append_archive_failure(
    failures: list[dict[str, str]], display: str, code: str,
    exc: Exception | None = None, include_error: bool = False,
) -> None:
    failure: dict[str, str] = {"path": display, "stage": "extract-archive", "code": code}
    if include_error and exc is not None:
        failure["error"] = str(exc)
    failures.append(failure)


def _extract_nested_archives(
    container: Path, container_display: str, project: Path,
    credential: Optional[str], failures: list[dict[str, str]],
    *, include_errors: bool = False,
) -> dict[Path, str]:
    """递归解压嵌套 ZIP；逻辑显示路径保留完整归档链，不暴露临时目录。"""
    display_roots: dict[Path, str] = {container: container_display}
    nested_root = container / ".dsh-nested-archives"
    queue: list[tuple[Path, Path, str, int]] = [
        (path, container, f"{container_display}/{path.relative_to(container).as_posix()}", 1)
        for path in sorted(container.rglob("*"), key=str)
        if path.is_file() and path.suffix.lower() == ".zip"
    ]
    extracted_count = 0
    while queue:
        archive, parent, display, depth = queue.pop(0)
        if depth > MAX_NESTED_ARCHIVE_DEPTH:
            _append_archive_failure(
                failures, display, "ARCHIVE_NESTING_TOO_DEEP", include_error=include_errors)
            continue
        if extracted_count >= MAX_EXTRACTED_ARCHIVES:
            _append_archive_failure(
                failures, display, "ARCHIVE_COUNT_LIMIT", include_error=include_errors)
            break
        destination = nested_root / f"{extracted_count:06d}-{archive.stem}"
        extracted_count += 1
        try:
            extraction = extract_with_password(archive, destination, project, credential)
            if extraction.has_password_required:
                _append_archive_failure(
                    failures, display, "ARCHIVE_PASSWORD_PARTIAL", include_error=include_errors)
        except ArchivePasswordRequired as exc:
            _append_archive_failure(
                failures, display, "ARCHIVE_PASSWORD_REQUIRED", exc, include_errors)
            continue
        except InvalidArchive as exc:
            _append_archive_failure(failures, display, "ARCHIVE_INVALID", exc, include_errors)
            continue
        except Exception as exc:
            _append_archive_failure(
                failures, display, "ARCHIVE_EXTRACT_FAILED", exc, include_errors)
            continue
        display_roots[destination] = display
        queue.extend(
            (path, destination, f"{display}/{path.relative_to(destination).as_posix()}", depth + 1)
            for path in sorted(destination.rglob("*"), key=str)
            if path.is_file() and path.suffix.lower() == ".zip"
        )
    return display_roots


def load_datasets(
    project: Path, credential: Optional[str] = None, include_errors: bool = False,
) -> tuple[dict[str, pd.DataFrame], list[dict[str, str]], dict[str, str]]:
    """全量加载数据集（原始行保留在会话里供 sandbox 计算），每张 df 标记 dataset。

    数据集扩展名固定为本模块的 DATA_EXTENSIONS，不能由请求或配置删减。
    """
    datasets: dict[str, pd.DataFrame] = {}
    failures: list[dict[str, str]] = []
    sources: dict[str, str] = {}
    candidates = [(path, path.relative_to(project).as_posix()) for path in _plain_sources(project)]
    # 每次调用都解压到新的进程临时目录；不写入项目，也不复用历史 _work。
    with tempfile.TemporaryDirectory(prefix="dsh-listing-extract-") as extract_dir:
        candidates.extend(_extracted_sources(
            project, credential, failures, Path(extract_dir), include_errors=include_errors))
        for path, display in candidates:
            name = path.stem.upper()
            try:
                if not _register_source(sources, name, display):
                    continue
                datasets[name] = tag_dataframe(_read_frame(path), DataSource.DATASET)
            except Exception as exc:
                failures.append(_failure(
                    Path(display), project, "read-dataset", exc, include_error=include_errors))
    return datasets, failures, sources


def dataset_payloads(
    datasets: dict[str, pd.DataFrame], sources: dict[str, str],
    include_values: bool = False,
) -> list[dict[str, Any]]:
    """把会话数据集转成回执载荷；开关开启时不构建行值。"""
    payloads: list[dict[str, Any]] = []
    for name, frame in datasets.items():
        payload: dict[str, Any] = {
            "name": name,
            "path": sources.get(name),
            "columns": [str(column) for column in frame.columns],
            "rowCount": int(len(frame)),
            "dtypes": {str(column): str(frame[column].dtype) for column in frame.columns},
            "nullCount": {str(column): int(frame[column].isna().sum()) for column in frame.columns},
            "uniqueCount": {str(column): int(frame[column].nunique()) for column in frame.columns},
        }
        if include_values:
            payload["rows"] = [
                [jsonable(value) for value in record.values()]
                for record in frame.to_dict(orient="records")
            ]
        payloads.append(tag_payload(payload, DataSource.DATASET))
    return payloads


# ---------------------------------------------------------------------------
# spec / ALS 辅助文件读取——源头 spec-document
# ---------------------------------------------------------------------------

def _als_mappings(sheets: dict[str, pd.DataFrame]) -> tuple[list[dict[str, str]], set[str]]:
    mappings: list[dict[str, str]] = []
    names: set[str] = set()
    for frame in sheets.values():
        for _, row in frame.iterrows():
            dataset = str(row.get("Dataset Name", "")).strip().upper()
            variable = str(row.get("Variable Name", "")).strip()
            if dataset and variable and dataset != "NAN" and variable != "nan":
                names.add(dataset)
                mappings.append({
                    "datasetName": dataset,
                    "sourceColumn": variable,
                    "label": str(row.get("Label", "")).strip(),
                })
    return mappings, names


def _sheet_rows(sheets: dict[str, pd.DataFrame]) -> list[dict[str, Any]]:
    """doc/ Excel 整表行值；这是需求材料，不属于数据红线。"""
    return [
        {
            "sheet": str(name),
            "rows": [
                [jsonable(value) for value in record.values()]
                for record in frame.to_dict(orient="records")
            ],
        }
        for name, frame in sheets.items()
    ]


def _is_aux_excel(path: Path, project: Path) -> bool:
    return classify_project_file(path, project) == "aux-excel"


def read_aux_excel_files(
    project: Path, include_rows: bool = False, include_errors: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """读取 data/、spec/ 辅助 Excel；开关开启时不构建业务 rows。"""
    project = Path(project).resolve()
    documents: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    candidates = sorted(
        (path for path in project.rglob("*")
         if path.is_file() and _is_aux_excel(path, project)),
        key=str,
    )
    for path in candidates:
        try:
            sheets = pd.read_excel(path, sheet_name=None)
            mappings, names = _als_mappings(sheets)
            payload: dict[str, Any] = {
                "path": path.relative_to(project).as_posix(),
                "type": "als" if mappings else "excel",
                "size": path.stat().st_size,
                "structure": {"sheets": [
                    _sheet_structure(name, frame) for name, frame in sheets.items()
                ]},
            }
            if mappings:
                payload["mappings"] = mappings
                payload["datasets"] = sorted(names)
            if include_rows:
                payload["rows"] = _sheet_rows(sheets)
            documents.append(tag_payload(payload, DataSource.AUX_EXCEL))
        except Exception as exc:
            failures.append(_failure(
                path, project, "read-aux-excel", exc, include_error=include_errors))
    return documents, failures


def read_spec_files(
    doc_dir: Path, include_errors: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """全量读取 doc/ 需求材料：文本与 Excel 均完整进入回执。

    doc/ 是需求理解与表单字段识别输入，不属于数据拦截域；这里不做截断、
    不做投影、不做内容模式扫描。``include_errors=False``（数据安全开关
    开启）时失败回执不含异常文本——异常文本可能携带解析出的单元格值。
    """
    documents: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    if not doc_dir.exists():
        return documents, failures
    for index, path in enumerate(sorted(doc_dir.rglob("*"), key=str), start=1):
        if not path.is_file():
            continue
        try:
            suffix = path.suffix.lower()
            if suffix in TEXT_EXTENSIONS:
                # 中国区 Windows 交付材料常见 GBK/ANSI 文本；UTF-8 失败回退
                # GBK（与 CSV 的回退策略一致），避免需求文本变 U+FFFD 乱码。
                # UTF-16（BOM）在 GBK 下"能解码但全是乱码"，按 BOM 显式走
                # UTF-16，不能交给 GBK 兜底。
                try:
                    content = path.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    head = path.read_bytes()[:2]
                    if head in (b"\xff\xfe", b"\xfe\xff"):
                        content = path.read_text(encoding="utf-16")
                    else:
                        content = path.read_text(encoding="gbk", errors="replace")
                documents.append(tag_payload({
                    "documentId": f"doc-{index:06d}",
                    "path": path.relative_to(doc_dir).as_posix(),
                    "type": "text",
                    "size": path.stat().st_size,
                    "lineCount": content.count("\n") + 1,
                    "content": content,
                }, DataSource.SPEC_DOCUMENT))
            elif suffix in EXCEL_EXTENSIONS:
                sheets = _read_excel_sheets(path)
                mappings, names = _als_mappings(sheets)
                payload: dict[str, Any] = {
                    "documentId": f"doc-{index:06d}",
                    "path": path.relative_to(doc_dir).as_posix(),
                    "type": "als" if mappings else "excel",
                    "size": path.stat().st_size,
                    "structure": {"sheets": [
                        _sheet_structure(name, frame) for name, frame in sheets.items()
                    ]},
                }
                if mappings:
                    payload["mappings"] = mappings
                    payload["datasets"] = sorted(names)
                payload["rows"] = _sheet_rows(sheets)
                documents.append(tag_payload(payload, DataSource.SPEC_DOCUMENT))
            else:
                content = base64.b64encode(path.read_bytes()).decode("ascii")
                documents.append(tag_payload({
                    "documentId": f"doc-{index:06d}",
                    "path": path.relative_to(doc_dir).as_posix(),
                    "type": "binary",
                    "size": path.stat().st_size,
                    "encoding": "base64",
                    "content": content,
                }, DataSource.SPEC_DOCUMENT))
        except Exception as exc:
            failures.append(_failure(path, doc_dir, "read-spec", exc, include_error=include_errors))
    return documents, failures


#: SpreadsheetML 防护上限：ss:Index 超界 / 文件超大都会把持久 worker OOM。
MAX_SSML_COLUMN_INDEX = 16_384
MAX_SSML_PARSE_BYTES = 256 * 1024 * 1024


def _read_spreadsheet_ml(path: Path) -> dict[str, pd.DataFrame]:
    """兼容实际项目里 BOM + SpreadsheetML 2003 的 .xls 需求文件。"""
    if path.stat().st_size > MAX_SSML_PARSE_BYTES:
        raise ValueError(f"SpreadsheetML 文件超过解析上限: {path.stat().st_size} bytes")
    root = ET.parse(path).getroot()
    namespace = "urn:schemas-microsoft-com:office:spreadsheet"
    worksheet_tag = f"{{{namespace}}}Worksheet"
    table_tag = f"{{{namespace}}}Table"
    row_tag = f"{{{namespace}}}Row"
    cell_tag = f"{{{namespace}}}Cell"
    data_tag = f"{{{namespace}}}Data"
    index_attribute = f"{{{namespace}}}Index"
    sheets: dict[str, pd.DataFrame] = {}
    for worksheet in root.findall(worksheet_tag):
        name = str(worksheet.get(f"{{{namespace}}}Name", "Sheet"))
        records: list[list[Any]] = []
        table = worksheet.find(table_tag)
        if table is not None:
            for row in table.findall(row_tag):
                values: list[Any] = []
                cursor = 0
                for cell in row.findall(cell_tag):
                    explicit_index = cell.get(index_attribute)
                    if explicit_index is not None:
                        cursor = max(0, int(explicit_index) - 1)
                        if cursor >= MAX_SSML_COLUMN_INDEX:
                            raise ValueError(
                                f"SpreadsheetML ss:Index 超出列上限 {MAX_SSML_COLUMN_INDEX}")
                    while len(values) <= cursor:
                        values.append(None)
                    data = cell.find(data_tag)
                    values[cursor] = "" if data is None else "".join(data.itertext())
                    cursor += 1
                records.append(values)
        width = max((len(record) for record in records), default=0)
        normalized = [record + [None] * (width - len(record)) for record in records]
        frame = pd.DataFrame(normalized[1:], columns=normalized[0] if normalized else None)
        sheets[name] = frame
    return sheets


def _looks_like_spreadsheet_ml(path: Path) -> bool:
    """按文件头识别 SpreadsheetML，不依赖 pandas 的异常分类。"""
    with path.open("rb") as stream:
        prefix = stream.read(512)
    return prefix.lstrip(b"\xef\xbb\xbf\r\n \t").startswith((b"<?xml", b"<Workbook"))


_ROW_AUTOFILTER_PATTERN = re.compile(rb'(?<=ref=")(\d+):(\d+)(?=")')


def _normalize_xlsx_row_autofilters(path: Path, target: Path) -> bool:
    """复制 XLSX 并把 Excel 兼容的行范围 AutoFilter 规范化为单元格范围。"""
    changed = False
    with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(
        target, "w", compression=zipfile.ZIP_DEFLATED
    ) as destination:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename.lower().endswith(".xml"):
                data, count = _ROW_AUTOFILTER_PATTERN.subn(rb"A\1:XFD\2", data)
                changed = changed or count > 0
            destination.writestr(info, data)
    return changed


def _read_excel_sheets(path: Path) -> dict[str, pd.DataFrame]:
    if _looks_like_spreadsheet_ml(path):
        return _read_spreadsheet_ml(path)
    try:
        return pd.read_excel(path, sheet_name=None)
    except ValueError as exc:
        if _looks_like_spreadsheet_ml(path):
            # 兼容无 XML 声明但仍是 SpreadsheetML 的历史文件。
            return _read_spreadsheet_ml(path)
        if zipfile.is_zipfile(path):
            with tempfile.TemporaryDirectory(prefix="dsh-xlsx-autofilter-") as temp_dir:
                normalized = Path(temp_dir) / path.name
                if _normalize_xlsx_row_autofilters(path, normalized):
                    return pd.read_excel(normalized, sheet_name=None)
        raise
