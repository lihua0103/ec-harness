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
import hashlib
import base64
import io
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
from edc_profiles import load_profiles, match_profile
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
    sheets = _read_excel_sheets(path)
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
                    RuntimeError("archive members not extracted (wrong password or corrupt member)"),
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

#: 已知 EDC 设计表（ALS）的表头适配器：表头包含该列集合即判为设计 sheet，
#: 并按各系统的列语义抽取映射/码表（比结构推断更完整：能拿到 label、码表
#: 解码）。2026-09-07 用 8 个真实项目核对，覆盖 Medidata Rave、太美、
#: ODM-DED 中文导出与最早的合成格式 Dataset Name / Variable Name / Label。
#: 这不是判定的全部：未命中适配器的工作簿（新 EDC）由 design_inference 在
#: 数据集加载后按值与数据集结构的关系推断，不依赖任何列名。
_DESIGN_SHEET_SIGNATURES: tuple[tuple[str, frozenset[str]], ...] = (
    ("legacy-mapping", frozenset({"Dataset Name", "Variable Name"})),
    ("rave-fields", frozenset({"FormOID", "FieldOID"})),
    ("rave-forms", frozenset({"OID", "DraftFormName"})),
    ("rave-folders", frozenset({"OID", "FolderName"})),
    ("rave-dictionary-entries", frozenset({"DataDictionaryName", "CodedData", "UserDataString"})),
    ("rave-dictionaries", frozenset({"DataDictionaryName", "OID"})),
    ("rave-unit-dictionaries", frozenset({"UnitDictionaryName"})),
    ("rave-matrices", frozenset({"MatrixName", "OID"})),
    ("rave-draft", frozenset({"DraftName", "ProjectName"})),
    ("taimei-datastructure", frozenset({"FormOID", "SASDatasetName", "SASFieldName"})),
    ("taimei-formitem", frozenset({"FormOID", "ItemOID"})),
    ("taimei-items", frozenset({"ItemOID", "SASFieldName"})),
    ("taimei-forms", frozenset({"FormOID", "FormName"})),
    ("taimei-codelist-items", frozenset({"CodeListOID", "DisplayValue", "CodedValue"})),
    ("taimei-codelist", frozenset({"OID", "Name", "DataType"})),
    ("taimei-units", frozenset({"UnitGroupOID"})),
    ("taimei-draft", frozenset({"DraftName", "StudyName"})),
    ("taimei-formsets", frozenset({"FormsetOID"})),
    ("taimei-events", frozenset({"EventOID", "FormOID"})),
    ("taimei-checks", frozenset({"CheckOID"})),
    ("taimei-derivations", frozenset({"DerivationOID"})),
    ("taimei-analytes", frozenset({"AnalytesCode", "AnalytesName"})),
    ("odm-forms", frozenset({"表单代码", "表单名称", "数据集名称"})),
    ("odm-visits", frozenset({"访视编号", "表单代码"})),
)

#: 强锚点：工作簿含任一强锚点 sheet 才启用"同簿弱识别"（Matrix* 网格、
#: ODM-DED 表头写在首行的中文 sheet、含 OID 列的其他设计 sheet）。
_DESIGN_ANCHOR_KINDS = frozenset({
    "legacy-mapping", "rave-fields", "taimei-datastructure", "taimei-formitem", "odm-forms",
})
_ODM_DED_UNNAMED_SHEETS = frozenset({
    "变量列表", "受控术语", "页面事件设置", "前端逻辑设置", "Editcheck设置", "邮件通知",
})
#: 受试者级列：只要出现就绝不是设计 sheet（审计轨迹/质疑日志等导出也带 FormOID/ItemOID）。
_SUBJECT_LEVEL_HEADERS = frozenset({
    "Subject", "Subject Name", "SubjectName", "USUBJID", "SUBJID", "Patient", "Patient Name",
    "受试者", "受试者编号", "筛选号", "随机号",
})
_EMPTY_CELL_TEXTS = frozenset({"", "nan", "none", "null"})


def _cell_text(value: Any) -> str:
    """单元格的裁剪字符串；空缺（None/NaN）与其字符串形态一律回空串。"""
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    return "" if text.lower() in _EMPTY_CELL_TEXTS else text


def _header_texts(frame: pd.DataFrame) -> list[str]:
    return [str(column).strip() for column in frame.columns]


def _signature_kind(headers: list[str]) -> Optional[str]:
    header_set = set(headers)
    for kind, required in _DESIGN_SHEET_SIGNATURES:
        if required <= header_set:
            return kind
    return None


def _classify_design_sheets(
    sheets: dict[str, pd.DataFrame],
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    """返回 ({sheet 名: 设计 sheet 类型}, {sheet 名: 学习到的列角色})；
    未识别的 sheet 不在结果里（照常按业务值保护）。

    类型来源两路：手写适配器签名，以及 edc_profiles 学习型注册表（类型
    "learned:<id>"，由 design_inference 在先前项目里推断后登记）。受试者级
    列（Subject/USUBJID/筛选号…）一票否决，两路都不例外。
    """
    kinds: dict[str, str] = {}
    learned_roles: dict[str, dict[str, str]] = {}
    profiles = _learned_profiles()
    for name, frame in sheets.items():
        headers = _header_texts(frame)
        if headers and headers[0].startswith("Matrix:"):
            kinds[str(name)] = "rave-matrix"          # 先于受试者列判定：Matrix 的 Subject 是文件夹 OID
            continue
        if _SUBJECT_LEVEL_HEADERS & set(headers):
            continue
        kind = _signature_kind(headers)
        if kind is None and profiles:
            profile = match_profile(headers, profiles)
            if profile is not None:
                kind = f"learned:{profile['id']}"
                learned_roles[str(name)] = dict(profile.get("roles") or {})
        if kind is not None:
            kinds[str(name)] = kind
    anchored = bool(_DESIGN_ANCHOR_KINDS & set(kinds.values())) or any(
        kind.startswith("learned:") for kind in kinds.values())
    if not anchored:
        # 没有强锚点时 Matrix 网格单独出现不可信（可能是业务表恰好如此命名）
        return {name: kind for name, kind in kinds.items() if kind != "rave-matrix"}, learned_roles
    for name, frame in sheets.items():
        if str(name) in kinds:
            continue
        headers = _header_texts(frame)
        if _SUBJECT_LEVEL_HEADERS & set(headers):
            continue
        if str(name) in _ODM_DED_UNNAMED_SHEETS and "odm-forms" in kinds.values():
            kinds[str(name)] = "odm-unnamed"
        elif any(header == "OID" or header.endswith("OID") for header in headers):
            kinds[str(name)] = "design-oid"
    return kinds, learned_roles


def _learned_profiles() -> list[dict[str, Any]]:
    """学习型注册表读取失败只等于"没有学习过"，不影响读取流程。"""
    try:
        return load_profiles()
    except Exception:  # noqa: BLE001
        return []


def _first_text(row: pd.Series, *columns: str) -> str:
    for column in columns:
        if column in row.index:
            text = _cell_text(row[column])
            if text:
                return text
    return ""


def _als_semantics(
    sheets: dict[str, pd.DataFrame],
) -> tuple[list[dict[str, str]], set[str], dict[str, str], dict[str, list[dict[str, str]]]]:
    """从 ALS 设计表提取语义：变量映射、数据集名、设计 sheet 类型、码表。

    映射三元组保持 datasetName/sourceColumn/label 口径（消费方与投影白名单
    不变）；码表按 {码表名: [{code, decode}]} 组织。设计表的值是研究方案的
    结构描述（表单、字段、访视、码表），不是受试者数据——它们必须披露给
    模型才能识别表单字段，也必须从保护值索引里排除，否则每个正常引用表单
    名/字段标签的通用工具结果都被误判为泄露。
    """
    mappings: list[dict[str, str]] = []
    names: set[str] = set()
    codelists: dict[str, list[dict[str, str]]] = {}
    kinds, learned_roles = _classify_design_sheets(sheets)

    def add_mapping(dataset: str, variable: str, label: str) -> None:
        dataset = dataset.upper()
        if not dataset or not variable:
            return
        names.add(dataset)
        mappings.append({"datasetName": dataset, "sourceColumn": variable, "label": label})

    def add_code(name: str, code: str, decode: str) -> None:
        if not name or not (code or decode):
            return
        codelists.setdefault(name, []).append({"code": code, "decode": decode})

    for sheet_name, frame in sheets.items():
        kind = kinds.get(str(sheet_name))
        if kind is None:
            continue
        if kind == "legacy-mapping":
            for _, row in frame.iterrows():
                add_mapping(_first_text(row, "Dataset Name"), _first_text(row, "Variable Name"),
                            _first_text(row, "Label"))
        elif kind == "rave-fields":
            for _, row in frame.iterrows():
                add_mapping(_first_text(row, "FormOID"),
                            _first_text(row, "FieldOID", "VariableOID"),
                            _first_text(row, "DraftFieldName", "PreText", "SASLabel"))
        elif kind in {"taimei-datastructure", "taimei-formitem"}:
            for _, row in frame.iterrows():
                add_mapping(_first_text(row, "SASDatasetName", "FormOID"),
                            _first_text(row, "SASFieldName", "ItemOID"),
                            _first_text(row, "SASLabel", "ItemName"))
        elif kind == "rave-dictionary-entries":
            for _, row in frame.iterrows():
                add_code(_first_text(row, "DataDictionaryName"), _first_text(row, "CodedData"),
                         _first_text(row, "UserDataString"))
        elif kind == "taimei-codelist-items":
            for _, row in frame.iterrows():
                add_code(_first_text(row, "CodeListOID"), _first_text(row, "CodedValue"),
                         _first_text(row, "DisplayValue"))
        elif kind == "odm-unnamed" and str(sheet_name) == "变量列表":
            _odm_variable_mappings(frame, add_mapping)
        elif kind == "odm-unnamed" and str(sheet_name) == "受控术语":
            _odm_codelists(frame, add_code)
        elif kind.startswith("learned:"):
            roles = learned_roles.get(str(sheet_name), {})
            if roles.get("variable"):
                for _, row in frame.iterrows():
                    add_mapping(_first_text(row, roles.get("dataset", "")),
                                _first_text(row, roles["variable"]),
                                _first_text(row, roles.get("label", "")))
    return mappings, names, kinds, codelists


def _odm_variable_mappings(frame: pd.DataFrame, add_mapping) -> None:
    """ODM-DED 变量列表：表头写在首列列名（"Common--系统变量"），各表单以
    "FORM--名称" 段头分节，段内行是 变量名称/变量标签/变量类型/变量格式。"""
    headers = _header_texts(frame)
    dataset = headers[0].split("--", 1)[0].strip() if headers and "--" in headers[0] else ""
    for row in frame.itertuples(index=False, name=None):
        cells = [_cell_text(value) for value in row]
        if not cells or not cells[0]:
            continue
        rest = [cell for cell in cells[1:] if cell]
        if not rest and "--" in cells[0]:
            dataset = cells[0].split("--", 1)[0].strip()
            continue
        if cells[0] in {"变量名称", "Variable Name"}:
            continue
        add_mapping(dataset, cells[0], cells[1] if len(cells) > 1 else "")


def _odm_codelists(frame: pd.DataFrame, add_code) -> None:
    """ODM-DED 受控术语：段头列名 "FORM--问题文本, 变量名"，段内行 Code Value/Code Text。"""
    headers = _header_texts(frame)
    name = headers[0].rsplit(",", 1)[-1].strip() if headers else ""
    for row in frame.itertuples(index=False, name=None):
        cells = [_cell_text(value) for value in row]
        if not cells or not cells[0]:
            continue
        if len(cells) < 2 or not cells[1]:
            if "--" in cells[0]:
                name = cells[0].rsplit(",", 1)[-1].strip()
            continue
        if cells[0] in {"Code Value", "Code"}:
            continue
        add_code(name, cells[0], cells[1])


def _als_mappings(sheets: dict[str, pd.DataFrame]) -> tuple[list[dict[str, str]], set[str]]:
    """兼容入口：只取映射与数据集名。"""
    mappings, names, _, _ = _als_semantics(sheets)
    return mappings, names


def _excel_type(semantics: dict[str, Any]) -> str:
    """提取到变量映射或码表才算 ALS；只匹配到表头签名的空表仍是普通 excel。"""
    return "als" if semantics.get("mappings") or semantics.get("codelists") else "excel"


def _als_payload_fields(sheets: dict[str, pd.DataFrame]) -> dict[str, Any]:
    """ALS 语义字段（映射/数据集/设计 sheet 清单/码表）；非设计工作簿返回空字典。"""
    mappings, names, kinds, codelists = _als_semantics(sheets)
    fields: dict[str, Any] = {}
    if kinds:
        fields["designSheets"] = sorted(kinds)
    if mappings:
        fields["mappings"] = mappings
        fields["datasets"] = sorted(names)
    if codelists:
        fields["codelists"] = codelists
    return fields


def _sheet_rows(sheets: dict[str, pd.DataFrame]) -> list[dict[str, Any]]:
    """doc/ Excel 整表行值；这是需求材料，不属于数据红线。

    必须按列位置逐行取值（itertuples）：to_dict("records") 会把重复列名
    静默并列丢失，SpreadsheetML/HTML 表里重复表头很常见，属于内容缺失。
    """
    return [
        {
            "sheet": str(name),
            "columns": [str(column) for column in frame.columns],
            "rows": [
                [jsonable(value) for value in row]
                for row in frame.itertuples(index=False, name=None)
            ],
        }
        for name, frame in sheets.items()
    ]


def _is_aux_excel(path: Path, project: Path) -> bool:
    return classify_project_file(path, project) == "aux-excel"


def _doc_file_fingerprints(project: Path) -> tuple[set[str], set[tuple[int, str]]]:
    """doc/ 需求域文件指纹：basename 集合 + (大小, md5) 集合。

    doc/ 是需求理解域（模型必读、业务词必然进程序），与 doc/ 文件同名或
    同内容的文件是需求文档的根目录副本/历史版本，不是辅助数据引用；
    其业务单元格值不得进保护值索引——用模型本来就能读到的需求文本去拦
    通用工具结果，会把整个会话的通用通道封死（实测 DVP 根目录副本把
    Condition/Column Heading 需求词注册成保护值后，读程序/write 回执全拦）。
    """
    names: set[str] = set()
    fps: set[tuple[int, str]] = set()
    doc_dir = project / "doc"
    if not doc_dir.is_dir():
        return names, fps
    for path in doc_dir.rglob("*"):
        if not path.is_file():
            continue
        names.add(path.name)
        try:
            data = path.read_bytes()
            fps.add((len(data), hashlib.md5(data).hexdigest()))
        except OSError:
            continue
    return names, fps


def _is_requirement_copy(path: Path, doc_names: set[str],
                         doc_fps: set[tuple[int, str]]) -> bool:
    if path.name in doc_names:
        return True
    try:
        data = path.read_bytes()
    except OSError:
        return False
    return (len(data), hashlib.md5(data).hexdigest()) in doc_fps


def read_aux_excel_files(
    project: Path, include_rows: bool = False, include_errors: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """读取 data/、spec/ 辅助 Excel；开关开启时不构建业务 rows。"""
    project = Path(project).resolve()
    documents: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    doc_names, doc_fps = _doc_file_fingerprints(project)
    candidates = sorted(
        (path for path in project.rglob("*")
         if path.is_file() and _is_aux_excel(path, project)
         and not _is_requirement_copy(path, doc_names, doc_fps)),
        key=str,
    )
    for path in candidates:
        try:
            sheets = _read_excel_sheets(path)
            semantics = _als_payload_fields(sheets)
            payload: dict[str, Any] = {
                "path": path.relative_to(project).as_posix(),
                "type": _excel_type(semantics),
                "size": path.stat().st_size,
                "structure": {"sheets": [
                    _sheet_structure(name, frame) for name, frame in sheets.items()
                ]},
                **semantics,
            }
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
                semantics = _als_payload_fields(sheets)
                payload: dict[str, Any] = {
                    "documentId": f"doc-{index:06d}",
                    "path": path.relative_to(doc_dir).as_posix(),
                    "type": _excel_type(semantics),
                    "size": path.stat().st_size,
                    "structure": {"sheets": [
                        _sheet_structure(name, frame) for name, frame in sheets.items()
                    ]},
                    **semantics,
                }
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


def _sniff_head(path: Path, size: int = 512) -> bytes:
    """文件头（去 BOM/空白）。内容识别的唯一依据，扩展名只作参考——
    交付材料里 .xls 常是 SpreadsheetML/HTML/文本导出，与真实格式无关。"""
    with path.open("rb") as stream:
        prefix = stream.read(size)
    return prefix.lstrip(b"\xef\xbb\xbf\r\n \t")


def _looks_like_spreadsheet_ml(path: Path) -> bool:
    """按文件头识别 SpreadsheetML，不依赖 pandas 的异常分类。"""
    return _sniff_head(path).startswith((b"<?xml", b"<Workbook"))


_HTML_HEAD_SIGNATURES = (b"<!doctype html", b"<html", b"<table")


def _looks_like_html_table(path: Path) -> bool:
    """按文件头识别 HTML 表格导出（旧系统常用它冒名 .xls/.xlsx）。"""
    head = _sniff_head(path, 2048).lower()
    return head.startswith(_HTML_HEAD_SIGNATURES) or b"<table" in head[:1024]


def _read_html_sheets(path: Path) -> dict[str, pd.DataFrame]:
    """HTML 表格：每张 <table> 成为一个 sheet；header=0 与 read_excel 口径一致。"""
    frames = pd.read_html(path, header=0)
    return {f"Table{index}": frame for index, frame in enumerate(frames, start=1)}


_DELIMITER_CANDIDATES = ("\t", ",", ";", "|")


def _looks_like_delimited_text(path: Path) -> bool:
    """按内容识别冒名 .xls 的分隔符文本（TSV/CSV 导出）：无 NUL 且首行含分隔符。"""
    head = _sniff_head(path, 2048)
    if b"\x00" in head:
        return False
    first_line = head.split(b"\n", 1)[0]
    return any(marker.encode("ascii") in first_line for marker in _DELIMITER_CANDIDATES)


def _decode_text_bytes(raw: bytes) -> str:
    """与 doc/ 文本一致的编码回退链：UTF-8 → BOM 判 UTF-16 → GBK 兜底。"""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
            return raw.decode("utf-16")
        return raw.decode("gbk", errors="replace")


def _read_delimited_sheets(path: Path) -> dict[str, pd.DataFrame]:
    """分隔符文本：分隔符按首行出现次数选取（TSV/CSV/分号/竖线）。"""
    text = _decode_text_bytes(path.read_bytes())
    first_line = text.lstrip("\ufeff\r\n \t").split("\n", 1)[0]
    delimiter = max(_DELIMITER_CANDIDATES, key=lambda marker: first_line.count(marker))
    frame = pd.read_csv(io.StringIO(text), sep=delimiter)
    return {path.stem: frame}


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
    """通用表格读取入口：只认文件内容，不认扩展名。

    真实 OLE2 .xls（xlrd）与 .xlsx/.xlsm（openpyxl）交 pandas；冒名的
    SpreadsheetML/HTML/分隔符文本与行范围 AutoFilter 的 xlsx 按文件头
    识别后走对应解析器。doc/ 需求、辅助 Excel、结构扫描三条路径都必须
    经过这里，不允许直接调 pd.read_excel。
    """
    if _looks_like_spreadsheet_ml(path):
        return _read_spreadsheet_ml(path)
    try:
        return pd.read_excel(path, sheet_name=None)
    except Exception as exc:
        # 门必须是宽异常：openpyxl InvalidFileException、xlrd XLRDError、
        # zipfile.BadZipFile 都不继承 ValueError，窄接会让冒名文件绕过内容
        # 识别回退链、以笼统读取失败逃逸（与 pyzipper BadZipFile 同族缺陷）。
        if _looks_like_spreadsheet_ml(path):
            # 兼容无 XML 声明但仍是 SpreadsheetML 的历史文件。
            return _read_spreadsheet_ml(path)
        if _looks_like_html_table(path):
            return _read_html_sheets(path)
        if zipfile.is_zipfile(path):
            try:
                with tempfile.TemporaryDirectory(prefix="dsh-xlsx-autofilter-") as temp_dir:
                    normalized = Path(temp_dir) / path.name
                    if _normalize_xlsx_row_autofilters(path, normalized):
                        return pd.read_excel(normalized, sheet_name=None)
            except Exception:
                # 损坏的 xlsx 成员不阻断回退链，继续尝试其余内容识别。
                pass
        if _looks_like_delimited_text(path):
            return _read_delimited_sheets(path)
        raise
