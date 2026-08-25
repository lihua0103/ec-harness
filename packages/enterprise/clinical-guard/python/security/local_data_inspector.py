"""Safe local metadata inspector for UAT clinical data.

This module is intentionally a data-plane boundary rather than a generic file
reader. It opens approved local source files only to derive structural metadata:
file type, table/sheet names, row counts and column names. It never serializes
cell values, records, subject identifiers, dates, query text, or medical terms
into its response.

The caller must supply an explicit local root. All targets are canonicalized
and rejected unless they are descendants of that root.
"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from security.path_policy import (
    PathPolicyError,
    relative_display_path,
    resolve_under_root,
)


class LocalDataInspectionError(ValueError):
    """A safe, data-free rejection reason for a local inspection request."""


def resolve_local_data_path(root: str, requested_path: str) -> Path:
    try:
        target = resolve_under_root(root, requested_path, allow_root=False)
    except (PathPolicyError, TypeError) as exc:
        raise LocalDataInspectionError("requested path violates the local data policy") from exc
    if not target.is_file():
        raise LocalDataInspectionError("requested path is not a regular file")
    return target


def _header_projection(values: tuple[Any, ...] | list[Any]) -> tuple[list[str], bool]:
    """返回安全列名以及该行是否可被证明为表头。"""
    from security.header_detect import header_names
    return header_names(list(values or []), with_verdict=True)


def _xlsx_metadata(path: Path) -> dict[str, Any]:
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        sheets: list[dict[str, Any]] = []
        for worksheet in workbook.worksheets:
            # 360-style exports frequently carry an unreliable declared dimension
            # (read_only then reports max_row=1 and a truncated first row), so the
            # dimension is never trusted: reset it and derive header + row count by
            # streaming actual rows. Values are only counted/inspected for
            # emptiness, never serialized into the response.
            reset = getattr(worksheet, "reset_dimensions", None)
            if callable(reset):
                reset()
            header: list[str] | None = None
            data_rows = 0
            for values in worksheet.iter_rows(values_only=True):
                if header is None:
                    if any(value not in (None, "") for value in values):
                        header, is_header = _header_projection(values)
                        if not is_header:
                            data_rows += 1
                    continue
                if any(value not in (None, "") for value in values):
                    data_rows += 1
            sheets.append({
                "name": worksheet.title,
                "rowCount": data_rows,
                "columns": header or [],
            })
        return {"fileType": "xlsx", "sheets": sheets}
    finally:
        workbook.close()


def _xls_metadata(path: Path) -> dict[str, Any]:
    import xlrd

    workbook = xlrd.open_workbook(path, on_demand=True)
    try:
        sheets: list[dict[str, Any]] = []
        for name in workbook.sheet_names():
            worksheet = workbook.sheet_by_name(name)
            raw_header = worksheet.row_values(0) if worksheet.nrows else []
            header, is_header = _header_projection(raw_header)
            sheets.append({
                "name": name,
                "rowCount": max(0, worksheet.nrows - (1 if is_header else 0)),
                "columns": header,
            })
        return {"fileType": "xls", "sheets": sheets}
    finally:
        workbook.release_resources()


def _csv_metadata(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.reader(handle)
        raw_header = next(reader, [])
        header, is_header = _header_projection(raw_header)
        row_count = sum(1 for _ in reader)
        if raw_header and not is_header:
            row_count += 1
    return {
        "fileType": "csv",
        "sheets": [{"name": "data", "rowCount": row_count, "columns": header}],
    }


def _sas_metadata(path: Path) -> dict[str, Any]:
    try:
        import pyreadstat
    except ImportError as exc:
        raise LocalDataInspectionError("SAS metadata support is unavailable; install the project-pinned pyreadstat dependency") from exc

    try:
        _, meta = pyreadstat.read_sas7bdat(str(path), metadataonly=True)
    except TypeError:
        # Older pyreadstat variants lack metadataonly. Reading no rows still lets
        # the library parse the descriptor, while avoiding record materialization.
        _, meta = pyreadstat.read_sas7bdat(str(path), row_limit=0)
    # pyreadstat 的 column_names 来自 SAS/XPT descriptor，而不是记录值。
    # 这是数据集的结构元数据，必须原样保留；通用表头 DLP 投影会把诸如
    # AEACN、AECONTRT 这类合法字段错误改成 COLUMN_n。
    columns = [str(column).strip()[:256] for column in (meta.column_names or []) if str(column).strip()]
    row_count = int(meta.number_rows or 0)
    return {
        "fileType": "sas7bdat",
        "sheets": [{"name": path.stem, "rowCount": row_count, "columns": columns}],
    }


def _xpt_metadata(path: Path) -> dict[str, Any]:
    try:
        import pyreadstat
        _, meta = pyreadstat.read_xport(str(path), metadataonly=True)
    except TypeError:
        _, meta = pyreadstat.read_xport(str(path), row_limit=0)
    except Exception as exc:
        raise LocalDataInspectionError("XPT metadata support is unavailable") from exc
    # XPT descriptor 同样是安全结构元数据，不能套用面向未知表格首行的
    # 数据值保护启发式。
    columns = [str(column).strip()[:256] for column in (meta.column_names or []) if str(column).strip()]
    return {
        "fileType": "xpt",
        "sheets": [{"name": path.stem, "rowCount": int(meta.number_rows or 0), "columns": columns}],
    }


def inspect_local_data(root: str, requested_path: str) -> dict[str, Any]:
    """Return only safe schema metadata for one source file under ``root``."""
    target = resolve_local_data_path(root, requested_path)
    suffix = target.suffix.lower()
    if suffix == ".xlsx":
        result = _xlsx_metadata(target)
    elif suffix == ".xls":
        result = _xls_metadata(target)
    elif suffix == ".csv":
        result = _csv_metadata(target)
    elif suffix == ".sas7bdat":
        result = _sas_metadata(target)
    elif suffix == ".xpt":
        result = _xpt_metadata(target)
    else:
        raise LocalDataInspectionError("supported local data formats are xlsx, xls, csv, sas7bdat, and xpt")

    # The requested display path is retained only as a root-relative path; an
    # absolute local filesystem location never becomes model-visible.
    try:
        result["path"] = relative_display_path(root, target)
    except PathPolicyError as exc:
        raise LocalDataInspectionError("result path violates the local data policy") from exc
    return result
