"""Listing 持久 Worker：结构化数据加载、受限 pandas 计算和唯一 Excel 发布。"""
import ast
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import math
from pathlib import Path
import sys
import traceback
from typing import Any, Optional
import zipfile

import numpy as np
import pandas as pd

from archive_passwords import extract_with_password
from styles import create_multi_sheet_excel

DATA_EXTENSIONS = {".sas7bdat", ".xpt", ".csv"}
MAX_CAPTURE_CHARS = 16_384
_session_project: Optional[Path] = None
_session_datasets: dict[str, pd.DataFrame] = {}
_last_outputs: Optional[dict[str, pd.DataFrame]] = None


def _failure(path: Path, root: Path, stage: str, exc: Exception) -> dict[str, str]:
    try: display = path.relative_to(root).as_posix()
    except ValueError: display = str(path)
    return {"path": display, "stage": stage, "reason": str(exc)}


def _read_frame(path: Path, metadata_only: bool = False) -> pd.DataFrame:
    if path.suffix.lower() == ".csv":
        return pd.read_csv(path, nrows=0 if metadata_only else None)
    frame = pd.read_sas(path, encoding="utf-8")
    return frame.head(0) if metadata_only else frame


def _plain_sources(project: Path) -> list[Path]:
    return sorted((p for p in project.rglob("*") if p.is_file()
                   and p.suffix.lower() in DATA_EXTENSIONS
                   and ".clinical-listing" not in p.parts and "_work" not in p.parts), key=str)


def _archives(project: Path) -> list[Path]:
    return sorted((p for p in project.rglob("*.zip") if p.is_file()
                   and ".clinical-listing" not in p.parts), key=str)


def _register_source(sources: dict[str, str], name: str, display: str) -> None:
    previous = sources.get(name)
    if previous is not None:
        raise ValueError(f"DATASET_NAME_CONFLICT: {name}: {previous}; {display}")
    sources[name] = display


def _extracted_sources(project: Path, credential: Optional[str], failures: list[dict[str, str]]) -> list[tuple[Path, str]]:
    result: list[tuple[Path, str]] = []
    for index, archive in enumerate(_archives(project)):
        extract_dir = project / ".clinical-listing" / "_work" / f"{index:04d}-{archive.stem}"
        try:
            extract_with_password(archive, extract_dir, project, credential)
            for path in sorted(extract_dir.rglob("*"), key=str):
                if path.is_file() and path.suffix.lower() in DATA_EXTENSIONS:
                    result.append((path, f"archive/{archive.relative_to(project).as_posix()}/{path.relative_to(extract_dir).as_posix()}"))
        except Exception as exc:
            failures.append(_failure(archive, project, "extract-archive", exc))
    return result


def collect_datasets(project: Path, credential: Optional[str], metadata_only: bool) -> tuple[dict[str, pd.DataFrame], list[dict[str, str]], dict[str, str]]:
    datasets: dict[str, pd.DataFrame] = {}
    failures: list[dict[str, str]] = []
    sources: dict[str, str] = {}
    candidates = [(path, path.relative_to(project).as_posix()) for path in _plain_sources(project)]
    candidates.extend(_extracted_sources(project, credential, failures))
    for path, display in candidates:
        name = path.stem.upper()
        try:
            _register_source(sources, name, display)
            datasets[name] = _read_frame(path, metadata_only)
        except ValueError:
            raise
        except Exception as exc:
            failures.append(_failure(Path(display), project, "read-dataset", exc))
    return datasets, failures, sources


def read_spec_files(doc_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    documents, failures = [], []
    if not doc_dir.exists(): return documents, failures
    for path in sorted(doc_dir.rglob("*"), key=str):
        if not path.is_file(): continue
        try:
            if path.suffix.lower() in {".txt", ".md"}:
                documents.append({"path": path.relative_to(doc_dir).as_posix(), "type": "text",
                                  "content": path.read_text(encoding="utf-8", errors="ignore")[:50_000]})
            elif path.suffix.lower() in {".xlsx", ".xls", ".xlsm"}:
                frame = pd.read_excel(path, sheet_name=0)
                mappings, names = [], set()
                for _, row in frame.iterrows():
                    dataset = str(row.get("Dataset Name", "")).strip().upper()
                    variable = str(row.get("Variable Name", "")).strip()
                    if dataset and variable and dataset != "NAN" and variable != "nan":
                        names.add(dataset); mappings.append({"datasetName": dataset, "sourceColumn": variable,
                            "label": str(row.get("Label", "")).strip()})
                if mappings:
                    documents.append({"path": path.relative_to(doc_dir).as_posix(), "type": "als",
                                      "mappings": mappings, "datasets": sorted(names)})
        except Exception as exc:
            failures.append(_failure(path, doc_dir, "read-spec", exc))
    return documents, failures


def operation_inspect(request: dict) -> dict:
    project = Path(request["project"]).resolve()
    if not project.is_dir():
        return {"ok": False, "code": "PROJECT_NOT_FOUND", "reason": f"项目目录不存在: {project}"}
    try:
        documents, spec_failures = read_spec_files(project / "doc")
        datasets, failures, sources = collect_datasets(project, request.get("credentialRef"), True)
    except ValueError as exc:
        return {"ok": False, "code": "DATASET_NAME_CONFLICT", "reason": str(exc)}
    scenario = request.get("scenario")
    inferred = None if scenario else ("medical" if "medical" in project.name.lower() else
        "rbqm" if "rbqm" in project.name.lower() else "manual")
    return {"ok": True, "action": "listing-inspect", "inspection": {
        "documents": documents, "schema": {name: list(frame.columns) for name, frame in datasets.items()},
        "datasets": [{"name": name, "path": source} for name, source in sources.items()],
        "failures": [*spec_failures, *failures], "scenario": scenario,
        "inferredScenario": inferred, "dataClass": "METADATA_ONLY"}}


def normalize_outputs(value: Any) -> dict[str, pd.DataFrame]:
    if not isinstance(value, dict) or not value: raise ValueError("outputs 必须是非空字典")
    result = {}
    for name, frame in value.items():
        if not isinstance(name, str) or not name.strip(): raise ValueError("outputs 键必须是非空字符串")
        if not isinstance(frame, pd.DataFrame): raise ValueError(f"outputs[{name!r}] 不是 DataFrame")
        result[name] = frame.copy()
        result[name].attrs = dict(frame.attrs)
    return result

def operation_run_code(request: dict) -> dict:
    global _session_project, _session_datasets, _last_outputs
    project = Path(request["project"]).resolve()

    if _session_project != project:
        try:
            datasets, failures, _ = collect_datasets(project, request.get("credentialRef"), False)
        except ValueError as exc:
            return {"ok": False, "code": "DATASET_NAME_CONFLICT", "reason": str(exc)}
        if failures:
            return {"ok": False, "code": "DATASET_LOAD_FAILED", "reason": "一个或多个数据源加载失败", "failures": failures}
        _session_project, _session_datasets, _last_outputs = project, datasets, None
    capture_out, capture_err = StringIO(), StringIO()
    safe_builtins = {"len": len, "range": range, "enumerate": enumerate, "zip": zip, "list": list, "dict": dict,
                     "set": set, "tuple": tuple, "str": str, "int": int, "float": float, "bool": bool,
                     "min": min, "max": max, "sum": sum, "abs": abs, "round": round, "sorted": sorted, "print": print,
                     "isinstance": isinstance, "hasattr": hasattr, "callable": callable, "any": any, "all": all,
                     "type": type}
    environment = {"__builtins__": safe_builtins, "datasets": _session_datasets, "pd": pd, "np": np, "math": math}
    try:
        with redirect_stdout(capture_out), redirect_stderr(capture_err):
            exec(compile(request["code"], "<listing-code>", "exec"), environment)
        if "outputs" not in environment:
            return {"ok": False, "code": "OUTPUTS_REQUIRED", "reason": "代码必须定义 outputs: dict[str, pandas.DataFrame]"}
        outputs = normalize_outputs(environment["outputs"])
        _last_outputs = outputs
        metadata = {name: {"rowCount": len(frame), "columns": [{"name": str(column),
            "dtype": str(frame[column].dtype), "nullCount": int(frame[column].isna().sum())} for column in frame.columns]}
            for name, frame in outputs.items()}
        return {"ok": True, "action": "listing-run-code", "receipt": {"outputCount": len(outputs),
            "outputs": metadata, "publishReady": True, "stdout": capture_out.getvalue()[:MAX_CAPTURE_CHARS],
            "stderr": capture_err.getvalue()[:MAX_CAPTURE_CHARS]}}
    except Exception as exc:
        return {"ok": False, "code": "CODE_EXECUTION_ERROR", "reason": f"代码执行失败: {exc}", "retryable": True,
                "stdout": capture_out.getvalue()[:MAX_CAPTURE_CHARS], "stderr": capture_err.getvalue()[:MAX_CAPTURE_CHARS]}


def operation_publish(request: dict) -> dict:
    if _last_outputs is None: return {"ok": False, "code": "NO_SUCCESSFUL_RUN", "reason": "publish 前必须成功执行 run_code"}
    project = Path(request["project"]).resolve()
    if _session_project != project: return {"ok": False, "code": "PROJECT_SESSION_MISMATCH", "reason": "项目与当前会话不一致"}
    scenario = request.get("scenario", "manual")
    output = project / ".clinical-listing" / "output" / scenario / f"{scenario.upper()}_LISTINGS.xlsx"
    try:
        statistics = create_multi_sheet_excel(_last_outputs, output, scenario, track_changes=request.get("trackChanges", True))
        return {"ok": True, "action": "listing-publish", "receipt": {"outputFile": str(output.relative_to(project)),
            "scenario": scenario, "dataClass": "REAL", "format": "single-workbook-multi-sheet-xlsx", "statistics": statistics}}
    except Exception as exc:
        return {"ok": False, "code": "PUBLISH_ERROR", "reason": f"发布失败: {exc}", "traceback": traceback.format_exc()}


def dispatch(request: dict) -> dict:
    operation = request.get("operation")
    if operation == "listing_inspect": return operation_inspect(request)
    if operation == "listing_run_code": return operation_run_code(request)
    if operation == "listing_publish": return operation_publish(request)
    return {"ok": False, "code": "UNKNOWN_OPERATION", "reason": f"未知操作: {operation}"}


def main() -> None:
    for line in sys.stdin:
        if not line.strip(): continue
        try: response = dispatch(json.loads(line))
        except Exception as exc: response = {"ok": False, "code": "WORKER_ERROR", "reason": str(exc), "traceback": traceback.format_exc()}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n"); sys.stdout.flush()

if __name__ == "__main__": main()






