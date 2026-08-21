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
import os
from pathlib import Path
from typing import Any


class LocalDataInspectionError(ValueError):
    """A safe, data-free rejection reason for a local inspection request."""


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_local_data_path(root: str, requested_path: str) -> Path:
    if not isinstance(root, str) or not root.strip():
        raise LocalDataInspectionError("local data root is not configured")
    if not isinstance(requested_path, str) or not requested_path.strip():
        raise LocalDataInspectionError("path must be a non-empty string")

    base = Path(root).resolve(strict=True)
    target = Path(requested_path)
    if not target.is_absolute():
        target = base / target
    target = target.resolve(strict=True)
    if not _inside(base, target):
        raise LocalDataInspectionError("requested path is outside the configured local data root")
    if not target.is_file():
        raise LocalDataInspectionError("requested path is not a regular file")
    return target


def _header_names(values: tuple[Any, ...] | list[Any]) -> list[str]:
    """Keep only positional, non-value column labels and bound their size."""
    return [str(value).strip()[:256] if value is not None else "" for value in values]


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
            header: list[str] = []
            data_rows = 0
            for values in worksheet.iter_rows(values_only=True):
                if not header:
                    if any(value not in (None, "") for value in values):
                        header = _header_names(values)
                    continue
                if any(value not in (None, "") for value in values):
                    data_rows += 1
            sheets.append({
                "name": worksheet.title,
                "rowCount": data_rows,
                "columns": header,
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
            header = worksheet.row_values(0) if worksheet.nrows else []
            sheets.append({
                "name": name,
                "rowCount": max(0, worksheet.nrows - (1 if worksheet.nrows else 0)),
                "columns": _header_names(header),
            })
        return {"fileType": "xls", "sheets": sheets}
    finally:
        workbook.release_resources()


def _csv_metadata(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        row_count = sum(1 for _ in reader)
    return {
        "fileType": "csv",
        "sheets": [{"name": "data", "rowCount": row_count, "columns": _header_names(header)}],
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
    columns = list(meta.column_names or [])
    row_count = int(meta.number_rows or 0)
    return {
        "fileType": "sas7bdat",
        "sheets": [{"name": path.stem, "rowCount": row_count, "columns": _header_names(columns)}],
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
    else:
        raise LocalDataInspectionError("supported local data formats are xlsx, xls, csv, and sas7bdat")

    # The requested display path is retained only as a root-relative path; an
    # absolute local filesystem location never becomes model-visible.
    result["path"] = str(target.relative_to(Path(root).resolve(strict=True))).replace(os.sep, "/")
    return result
