"""
Listing Worker - 处理 inspect, run_code, publish 操作

沙箱约束：
- SAS 数据行级内容不进入返回值
- 只返回元数据（schema, rowCount, columns）
- pandas 代码白名单执行
"""
import json
import sys
import traceback
from pathlib import Path
from typing import Any, Optional
import zipfile
import pandas as pd
import numpy as np
import math

# 本地导入
from archive_passwords import extract_with_password
from styles import create_multi_sheet_excel


def read_spec_files(doc_dir: Path) -> dict[str, Any]:
    """读取 doc/ 目录下的 spec 文件"""
    documents = []
    
    if not doc_dir.exists():
        return {"documents": documents}
    
    for file in doc_dir.rglob("*"):
        if not file.is_file():
            continue
        
        # 只读取文本和 Excel 文件
        if file.suffix.lower() in {".txt", ".md", ".doc", ".docx"}:
            try:
                content = file.read_text(encoding="utf-8", errors="ignore")
                documents.append({
                    "path": str(file.relative_to(doc_dir)),
                    "type": "text",
                    "content": content[:50000],  # 限制大小
                })
            except Exception:
                pass
        elif file.suffix.lower() in {".xlsx", ".xls", ".xlsm"}:
            # Excel 文件 - 读取 ALS 映射
            try:
                als_data = parse_als_file(file)
                if als_data:
                    documents.append({
                        "path": str(file.relative_to(doc_dir)),
                        "type": "als",
                        "mappings": als_data["mappings"],
                        "datasets": als_data["datasets"],
                    })
            except Exception:
                pass
    
    return {"documents": documents}


def parse_als_file(file_path: Path) -> Optional[dict]:
    """解析 ALS Excel 文件，提取字段映射"""
    try:
        # 读取第一个 sheet
        df = pd.read_excel(file_path, sheet_name=0)
        
        mappings = []
        datasets = set()
        
        # 假设 ALS 格式：Dataset Name, Variable Name, Label, ...
        for _, row in df.iterrows():
            dataset = str(row.get("Dataset Name", "")).strip().upper()
            variable = str(row.get("Variable Name", "")).strip()
            label = str(row.get("Label", "")).strip()
            
            if dataset and variable:
                datasets.add(dataset)
                mappings.append({
                    "datasetName": dataset,
                    "sourceColumn": variable,
                    "label": label,
                })
        
        return {
            "mappings": mappings,
            "datasets": list(datasets),
        }
    except Exception:
        return None


def scan_sas_datasets(project_dir: Path, credential: Optional[str] = None) -> dict[str, Any]:
    """扫描 SAS 数据集和归档文件"""
    schema = {}
    missing = []
    datasets_info = []
    
    # 扫描明文数据集
    for ext in [".sas7bdat", ".xpt", ".csv"]:
        for file in project_dir.rglob(f"*{ext}"):
            if file.is_file() and ".clinical-listing" not in file.parts and "_work" not in file.parts:
                dataset_name = file.stem.upper()
                try:
                    if ext == ".csv":
                        df = pd.read_csv(file, nrows=0)
                    else:
                        df = pd.read_sas(file, encoding="utf-8", chunksize=None, iterator=False)
                        df = df.head(0)  # 只读取列名
                    
                    columns = list(df.columns)
                    schema[dataset_name] = columns
                    datasets_info.append({
                        "name": dataset_name,
                        "path": str(file.relative_to(project_dir)),
                        "type": ext[1:],
                    })
                except Exception:
                    pass
    
    # 扫描归档文件
    for zip_file in project_dir.rglob("*.zip"):
        if zip_file.is_file() and ".clinical-listing" not in zip_file.parts:
            try:
                # 尝试读取 central directory
                with zipfile.ZipFile(zip_file, 'r') as zf:
                    encrypted = any(info.flag_bits & 0x1 for info in zf.infolist())
                    
                    if encrypted:
                        # 加密归档，标记为需要凭据
                        missing.append(f"credential:{zip_file.relative_to(project_dir).as_posix()}")
                    
                    # 列出成员
                    for info in zf.infolist():
                        if not info.is_dir():
                            member_path = Path(info.filename)
                            if member_path.suffix.lower() in {".sas7bdat", ".xpt", ".csv"}:
                                dataset_name = member_path.stem.upper()
                                datasets_info.append({
                                    "name": dataset_name,
                                    "path": f"archive/{zip_file.name}/{info.filename}",
                                    "type": "archived",
                                })
            except Exception:
                missing.append(f"credential:{zip_file.relative_to(project_dir).as_posix()}")
    
    return {
        "schema": schema,
        "datasets": datasets_info,
        "missing": missing,
    }


def operation_inspect(request: dict) -> dict:
    """
    inspect 操作：读取 spec、ALS 和数据集 schema
    """
    project = request["project"]
    credential_ref = request.get("credentialRef")
    
    project_dir = Path(project).resolve()
    if not project_dir.exists():
        return {
            "ok": False,
            "code": "PROJECT_NOT_FOUND",
            "reason": f"项目目录不存在: {project}",
        }
    
    doc_dir = project_dir / "doc"
    
    # 1. 读取 spec 文件
    spec_data = read_spec_files(doc_dir)
    
    # 2. 扫描数据集
    dataset_data = scan_sas_datasets(project_dir, credential_ref)
    
    # 3. 推断场景
    scenario = request.get("scenario")
    inferred_scenario = None
    if not scenario:
        # 按路径推断
        project_name_lower = project_dir.name.lower()
        if "medical" in project_name_lower:
            inferred_scenario = "medical"
        elif "rbqm" in project_name_lower:
            inferred_scenario = "rbqm"
        else:
            inferred_scenario = "manual"
    
    return {
        "ok": True,
        "action": "listing-inspect",
        "inspection": {
            **spec_data,
            **dataset_data,
            "scenario": scenario,
            "inferredScenario": inferred_scenario,
            "dataClass": "METADATA_ONLY",
        },
    }


# 全局 pandas 会话状态（由 NDJSON 主循环在同一进程内持有）
_session_project: Optional[Path] = None
_session_datasets: dict[str, pd.DataFrame] = {}
_last_outputs: Optional[dict[str, pd.DataFrame]] = None


def normalize_outputs(value: Any) -> dict[str, pd.DataFrame]:
    """验证模型输出契约，禁止 Writer 接受模糊或部分结果。"""
    if not isinstance(value, dict) or not value:
        raise ValueError("outputs 必须是非空 dict[str, pandas.DataFrame]")

    normalized: dict[str, pd.DataFrame] = {}
    for raw_name, frame in value.items():
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise ValueError("每个 outputs 键必须是非空工作表名称")
        if not isinstance(frame, pd.DataFrame):
            raise ValueError(f"outputs[{raw_name!r}] 必须是 pandas DataFrame")
        normalized[raw_name.strip()] = frame.copy()
    return normalized


def operation_run_code(request: dict) -> dict:
    """执行 pandas 代码，并保存最后一次符合规范的 outputs。"""
    global _session_project, _session_datasets, _last_outputs

    project_dir = Path(request["project"]).resolve()
    code = request["code"]
    credential_ref = request.get("credentialRef")

    if _session_project != project_dir:
        _session_project = project_dir
        _session_datasets = load_datasets(project_dir, credential_ref)
        _last_outputs = None

    if not validate_code(code):
        return {
            "ok": False,
            "code": "SANDBOX_CODE_REJECTED",
            "reason": "代码包含禁用的文件写出、动态执行或导入语法；请只生成 outputs，由 publish 统一写出",
        }

    try:
        local_env = {
            "datasets": _session_datasets,
            "pd": pd,
            "np": np,
            "math": math,
        }
        exec(code, local_env)
        if "outputs" not in local_env:
            return {
                "ok": False,
                "code": "OUTPUTS_REQUIRED",
                "reason": "代码必须定义 outputs: dict[str, pandas.DataFrame]；publish 不接受 result 或自行写出的文件",
            }

        outputs = normalize_outputs(local_env["outputs"])
        metadata = extract_metadata(outputs)
        _last_outputs = outputs
        return {
            "ok": True,
            "action": "listing-run-code",
            "receipt": {
                "outputCount": len(outputs),
                "outputs": metadata,
                "publishReady": True,
            },
        }
    except Exception as exc:
        return {
            "ok": False,
            "code": "CODE_EXECUTION_ERROR",
            "reason": f"代码执行失败: {exc}",
            "retryable": True,
        }


def validate_code(code: str) -> bool:
    """阻止绕过统一发布路径以及进程级动态执行。"""
    forbidden = [
        "import ",
        "from ",
        "__",
        "open(",
        "read_csv",
        "read_excel",
        "to_csv",
        "to_excel",
        "ExcelWriter",
        "eval(",
        "exec(",
        "compile(",
        "global ",
        "nonlocal ",
    ]
    return not any(pattern in code for pattern in forbidden)


def load_datasets(project_dir: Path, credential_ref: Optional[str]) -> dict[str, pd.DataFrame]:
    """加载所有数据集到内存。"""
    datasets = {}
    for ext in [".sas7bdat", ".xpt", ".csv"]:
        for file in project_dir.rglob(f"*{ext}"):
            if file.is_file() and ".clinical-listing" not in file.parts and "_work" not in file.parts:
                dataset_name = file.stem.upper()
                try:
                    datasets[dataset_name] = pd.read_csv(file) if ext == ".csv" else pd.read_sas(file, encoding="utf-8")
                except Exception:
                    pass

    for zip_file in project_dir.rglob("*.zip"):
        if not zip_file.is_file() or ".clinical-listing" in zip_file.parts:
            continue
        extract_dir = project_dir / ".clinical-listing" / "_work" / zip_file.stem
        try:
            extract_with_password(zip_file, extract_dir, credential_ref)
            for ext in [".sas7bdat", ".xpt", ".csv"]:
                for file in extract_dir.rglob(f"*{ext}"):
                    if not file.is_file():
                        continue
                    try:
                        datasets[file.stem.upper()] = pd.read_csv(file) if ext == ".csv" else pd.read_sas(file, encoding="utf-8")
                    except Exception:
                        pass
        except Exception:
            pass
    return datasets


def extract_metadata(outputs: dict[str, pd.DataFrame]) -> dict:
    """提取每个候选工作表的结构化回执。"""
    return {
        name: {
            "rowCount": len(df),
            "columns": [
                {"name": str(col), "dtype": str(df[col].dtype), "nullCount": int(df[col].isna().sum())}
                for col in df.columns
            ],
        }
        for name, df in outputs.items()
    }


def operation_publish(request: dict) -> dict:
    """通过唯一 Writer 发布当前会话最后一次成功的规范化 outputs。"""
    if _last_outputs is None:
        return {
            "ok": False,
            "code": "NO_SUCCESSFUL_RUN",
            "reason": "publish 前必须在当前会话成功执行定义 outputs 的 run_code",
        }

    project_dir = Path(request["project"]).resolve()
    if _session_project != project_dir:
        return {
            "ok": False,
            "code": "PROJECT_SESSION_MISMATCH",
            "reason": "publish 项目与当前 run_code 会话不一致，请重新 inspect/run_code",
        }

    scenario = request.get("scenario", "manual")
    output_file = project_dir / ".clinical-listing" / "output" / scenario / f"{scenario.upper()}_LISTINGS.xlsx"
    try:
        statistics = create_multi_sheet_excel(
            outputs=_last_outputs,
            output_file=output_file,
            scenario=scenario,
            track_changes=request.get("trackChanges", True),
        )
        return {
            "ok": True,
            "action": "listing-publish",
            "receipt": {
                "outputFile": str(output_file.relative_to(project_dir)),
                "scenario": scenario,
                "dataClass": "REAL",
                "format": "single-workbook-multi-sheet-xlsx",
                "statistics": statistics,
            },
        }
    except Exception as exc:
        return {
            "ok": False,
            "code": "PUBLISH_ERROR",
            "reason": f"发布失败: {exc}",
            "traceback": traceback.format_exc(),
        }


def dispatch(request: dict) -> dict:
    operation = request.get("operation")
    if operation == "listing_inspect":
        return operation_inspect(request)
    if operation == "listing_run_code":
        return operation_run_code(request)
    if operation == "listing_publish":
        return operation_publish(request)
    return {"ok": False, "code": "UNKNOWN_OPERATION", "reason": f"未知操作: {operation}"}


def main():
    """持久 NDJSON Worker 主循环：一个请求对应一行响应。"""
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            response = dispatch(json.loads(line))
        except Exception as exc:
            response = {
                "ok": False,
                "code": "WORKER_ERROR",
                "reason": str(exc),
                "traceback": traceback.format_exc(),
            }
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
