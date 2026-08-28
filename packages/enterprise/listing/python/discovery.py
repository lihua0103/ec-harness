"""全量读取层：list_files / scan_excel_structures / load_datasets / read_spec_files。

读取永远全量（R1：doc/ 的文本**与 Excel** 都让 AI 看到全文；数据集整表进
会话供 sandbox 计算）。值是否出域与本层无关——由 data_guard 按源头投影决定
（2026-08-28 第三版：只剩 dataset 一条；doc/ 零拦截，ADR-0007）。

构建期节流（开关开时）只作用于数据集行样本（``dataset_payloads``）。
doc/ 的截断上限（文本字符数 / Excel 单元格数）是**协议护栏**不是拦截：
触限时回执显式带 truncated 标记，模型可经自身文件工具继续读取。

本层数据载荷的 ``_source`` 标记仅作审计溯源：
- 数据集 DataFrame / dataset 载荷 → ``dataset``（唯一投影场景）
- doc/ Excel 与结构扫描 → ``aux-excel``（不在投影表 = 直通）
- doc/ 文本 → ``spec-document``（不在投影表 = 直通）
"""
import datetime
import decimal
import math
from pathlib import Path
from typing import Any, Iterable, Optional

import numpy as np
import pandas as pd

from archive_passwords import extract_with_password
from source_registry import DataSource, tag_dataframe, tag_payload

DATA_EXTENSIONS = {".sas7bdat", ".xpt", ".csv"}
EXCEL_EXTENSIONS = {".xlsx", ".xls", ".xlsm"}
TEXT_EXTENSIONS = {".txt", ".md"}
SCAN_IGNORE_PARTS = {".clinical-listing", "_work"}

#: spec 文本回执上限（协议护栏，非拦截）：超出显式标记 truncated，
#: 模型可经自身文件工具读取剩余部分（doc/ 已零拦截）。
MAX_TEXT_CHARS = 200_000
#: spec xlsx 单元格回执上限（协议护栏，非拦截）：保护 NDJSON 协议行长度。
MAX_SPEC_CELLS = 20_000
#: 拦截关闭时随回执送出的 sas 行样本行数（"含 sas 行"裁决保留）。
MAX_SAMPLE_ROWS = 3
#: excel 结构扫描读取的表头带行数（表头是结构，不是值）。
STRUCTURE_HEADER_ROWS = 2


def normalize_extensions(values: Optional[Iterable[str]]) -> Optional[set[str]]:
    """宿主下发的扩展名表（DataSecurityService 单源）→ 规范化小写集合。

    None / 空 / 全非法 → None（调用方回落到本模块默认 DATA_EXTENSIONS）。
    """
    if not values:
        return None
    normalized = {str(value).strip().lower() for value in values if str(value).strip()}
    return normalized or None


# ---------------------------------------------------------------------------
# JSON 安全转换：回执要过 json.dumps，NaN/Timestamp/np 标量必须先落地
# ---------------------------------------------------------------------------

def jsonable(value: Any) -> Any:
    """把任意 pandas/numpy 标量转成 JSON 可序列化的等价值。"""
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


def list_files(project: Path, subdir: str = "") -> list[dict[str, Any]]:
    """列出项目文件（AI 可调）：路径/大小/种类。文件清单不含数据值。"""
    root = (project / subdir) if subdir else project
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
    """sheet 结构摘要。

    pd.read_excel 把第 1 行吃成列名，因此：rowCount 补回表头行；
    headerRows 首行恒为列名行（真实表头），其后是首批数据行——
    多层/不规则表头的第 2 层会以数据行形态出现在这里。
    """
    data_rows = [
        [jsonable(value) for value in frame.iloc[index].tolist()]
        for index in range(min(max(STRUCTURE_HEADER_ROWS - 1, 0), len(frame)))
    ]
    return {
        "name": str(name),
        "rowCount": int(len(frame)) + 1,
        "columnCount": int(frame.shape[1]),
        "headerRows": [[str(column) for column in frame.columns], *data_rows],
    }


# ---------------------------------------------------------------------------
# 数据集加载（sas/xpt/csv + 加密归档）——源头 sas-dataset
# ---------------------------------------------------------------------------

def _failure(path: Path, root: Path, stage: str, exc: Exception) -> dict[str, str]:
    try:
        display = path.relative_to(root).as_posix()
    except ValueError:
        display = str(path)
    return {"path": display, "stage": stage, "reason": str(exc)}


def _read_frame(path: Path) -> pd.DataFrame:
    if path.suffix.lower() == ".csv":
        return pd.read_csv(path)
    return pd.read_sas(path, encoding="utf-8")


def _plain_sources(project: Path, extensions: Optional[set[str]] = None) -> list[Path]:
    wanted = extensions or DATA_EXTENSIONS
    return sorted(
        (p for p in project.rglob("*")
         if p.is_file() and p.suffix.lower() in wanted
         and not (SCAN_IGNORE_PARTS & set(p.parts))),
        key=str,
    )


def _archives(project: Path) -> list[Path]:
    return sorted(
        (p for p in project.rglob("*.zip")
         if p.is_file() and ".clinical-listing" not in p.parts),
        key=str,
    )


def _register_source(sources: dict[str, str], name: str, display: str) -> None:
    previous = sources.get(name)
    if previous is not None:
        raise ValueError(f"DATASET_NAME_CONFLICT: {name}: {previous}; {display}")
    sources[name] = display


def _extracted_sources(
    project: Path, credential: Optional[str], failures: list[dict[str, str]],
    extensions: Optional[set[str]] = None,
) -> list[tuple[Path, str]]:
    wanted = extensions or DATA_EXTENSIONS
    result: list[tuple[Path, str]] = []
    for index, archive in enumerate(_archives(project)):
        extract_dir = project / ".clinical-listing" / "_work" / f"{index:04d}-{archive.stem}"
        try:
            extract_with_password(archive, extract_dir, project, credential)
            for path in sorted(extract_dir.rglob("*"), key=str):
                if path.is_file() and path.suffix.lower() in wanted:
                    result.append((
                        path,
                        f"archive/{archive.relative_to(project).as_posix()}/{path.relative_to(extract_dir).as_posix()}",
                    ))
        except Exception as exc:
            failures.append(_failure(archive, project, "extract-archive", exc))
    return result


def load_datasets(
    project: Path, credential: Optional[str] = None,
    extensions: Optional[set[str]] = None,
) -> tuple[dict[str, pd.DataFrame], list[dict[str, str]], dict[str, str]]:
    """全量加载数据集（原始行保留在会话里供 sandbox 计算），每张 df 标记 dataset。

    ``extensions`` 是宿主下发的扩展名表（DataSecurityService 单源）；
    None 时用本模块默认 DATA_EXTENSIONS。
    """
    datasets: dict[str, pd.DataFrame] = {}
    failures: list[dict[str, str]] = []
    sources: dict[str, str] = {}
    candidates = [(path, path.relative_to(project).as_posix()) for path in _plain_sources(project, extensions)]
    candidates.extend(_extracted_sources(project, credential, failures, extensions))
    for path, display in candidates:
        name = path.stem.upper()
        try:
            _register_source(sources, name, display)
            datasets[name] = tag_dataframe(_read_frame(path), DataSource.DATASET)
        except ValueError:
            raise
        except Exception as exc:
            failures.append(_failure(Path(display), project, "read-dataset", exc))
    return datasets, failures, sources


def dataset_payloads(
    datasets: dict[str, pd.DataFrame], sources: dict[str, str], with_sample: bool = True,
) -> list[dict[str, Any]]:
    """把会话数据集转成回执载荷。

    构建期节流（开关开 → ``with_sample=False``）：行样本根本不构建，
    省内存省协议行——投影层仍是双保险。
    """
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
        if with_sample:
            sample_frame = frame.head(MAX_SAMPLE_ROWS)
            payload["sample"] = {
                str(column): [jsonable(value) for value in sample_frame[column].tolist()]
                for column in frame.columns
            }
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


def _sheet_rows(sheets: dict[str, pd.DataFrame]) -> tuple[list[dict[str, Any]], bool]:
    """整表行值（doc/ 零拦截，ADR-0007：全量读是正确口径）。

    上限是**协议护栏**：触限返回 truncated=True，回执显式标记，
    模型可经自身文件工具继续读（doc/ 已无任何拦截）。
    """
    rows: list[dict[str, Any]] = []
    cells = 0
    truncated = False
    for name, frame in sheets.items():
        sheet_rows: list[list[Any]] = []
        for record in frame.to_dict(orient="records"):
            row_values: list[Any] = []
            for value in record.values():
                if cells >= MAX_SPEC_CELLS:
                    truncated = True
                    break
                row_values.append(jsonable(value))
                cells += 1
            sheet_rows.append(row_values)
            if truncated:
                break
        rows.append({"sheet": str(name), "rows": sheet_rows})
        if truncated:
            break
    return rows, truncated


def read_spec_files(
    doc_dir: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """全量读取 doc/ 下 spec：文本全文（≤200K 协议护栏）+ xlsx 整表。

    2026-08-28 第三版口径（ADR-0007）：**doc/ 零拦截**——文本与 Excel
    的单元格值都全量进回执，与数据安全开关无关；截断上限只作协议护栏
    且显式标记 truncated（模型可经自身文件工具继续读）。
    ``_source`` 标记（spec-document / aux-excel）仅作审计溯源，均不在
    投影表里。
    """
    documents: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    if not doc_dir.exists():
        return documents, failures
    for path in sorted(doc_dir.rglob("*"), key=str):
        if not path.is_file():
            continue
        try:
            suffix = path.suffix.lower()
            if suffix in TEXT_EXTENSIONS:
                raw = path.read_text(encoding="utf-8", errors="ignore")
                content = raw[:MAX_TEXT_CHARS]
                documents.append(tag_payload({
                    "path": path.relative_to(doc_dir).as_posix(),
                    "type": "text",
                    "size": path.stat().st_size,
                    "lineCount": content.count("\n") + 1,
                    "content": content,
                    **({"truncated": True} if len(raw) > MAX_TEXT_CHARS else {}),
                }, DataSource.SPEC_DOCUMENT))
            elif suffix in EXCEL_EXTENSIONS:
                sheets = pd.read_excel(path, sheet_name=None)
                mappings, names = _als_mappings(sheets)
                payload: dict[str, Any] = {
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
                rows, truncated = _sheet_rows(sheets)
                payload["rows"] = rows
                if truncated:
                    payload["truncated"] = True
                documents.append(tag_payload(payload, DataSource.AUX_EXCEL))
        except Exception as exc:
            failures.append(_failure(path, doc_dir, "read-spec", exc))
    return documents, failures
