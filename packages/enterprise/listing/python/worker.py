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
import shutil
import tempfile
import pandas as pd
import numpy as np
import math

# 本地导入
from archive_passwords import extract_with_password


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


# 全局 pandas 会话状态
_session_datasets: dict[str, pd.DataFrame] = {}
_last_successful_code: Optional[str] = None
_last_result: Optional[dict] = None


def operation_run_code(request: dict) -> dict:
    """
    run_code 操作：执行 pandas 代码
    """
    global _session_datasets, _last_successful_code, _last_result
    
    project = request["project"]
    code = request["code"]
    credential_ref = request.get("credentialRef")
    
    project_dir = Path(project).resolve()
    
    # 加载数据集（首次）
    if not _session_datasets:
        _session_datasets = load_datasets(project_dir, credential_ref)
    
    # 白名单检查
    if not validate_code(code):
        return {
            "ok": False,
            "code": "SANDBOX_CODE_REJECTED",
            "reason": "代码包含禁用的语法：import、文件IO、下划线属性或动态执行",
        }
    
    # 执行代码
    try:
        local_env = {
            "datasets": _session_datasets,
            "pd": pd,
            "np": np,
            "math": math,
        }
        
        exec(code, local_env)
        
        # 获取结果
        if "result" in local_env:
            result_df = local_env["result"]
            metadata = extract_metadata({"default": result_df})
        elif "outputs" in local_env:
            outputs = local_env["outputs"]
            metadata = extract_metadata(outputs)
        else:
            return {
                "ok": False,
                "code": "NO_RESULT",
                "reason": "代码未定义 result 或 outputs 变量",
            }
        
        # 保存成功状态
        _last_successful_code = code
        _last_result = metadata
        
        return {
            "ok": True,
            "action": "listing-run-code",
            "receipt": metadata,
        }
    
    except Exception as e:
        return {
            "ok": False,
            "code": "CODE_EXECUTION_ERROR",
            "reason": f"代码执行失败: {str(e)}",
            "retryable": True,
        }


def validate_code(code: str) -> bool:
    """验证代码是否符合白名单"""
    forbidden = [
        "import ",
        "from ",
        "__",
        "open(",
        "read_csv",
        "read_excel",
        "to_csv",
        "to_excel",
        "eval(",
        "exec(",
        "compile(",
        "global ",
        "nonlocal ",
    ]
    
    for pattern in forbidden:
        if pattern in code:
            return False
    
    return True


def load_datasets(project_dir: Path, credential_ref: Optional[str]) -> dict[str, pd.DataFrame]:
    """加载所有数据集到内存"""
    datasets = {}
    
    # 加载明文数据集
    for ext in [".sas7bdat", ".xpt", ".csv"]:
        for file in project_dir.rglob(f"*{ext}"):
            if file.is_file() and ".clinical-listing" not in file.parts and "_work" not in file.parts:
                dataset_name = file.stem.upper()
                try:
                    if ext == ".csv":
                        df = pd.read_csv(file)
                    else:
                        df = pd.read_sas(file, encoding="utf-8")
                    
                    datasets[dataset_name] = df
                except Exception:
                    pass
    
    # 加载归档数据集
    work_dir = project_dir / "_work"
    work_dir.mkdir(exist_ok=True)
    
    for zip_file in project_dir.rglob("*.zip"):
        if zip_file.is_file() and ".clinical-listing" not in zip_file.parts:
            extract_dir = work_dir / f"extracted_{zip_file.stem}"
            try:
                extract_with_password(zip_file, extract_dir, project_dir, credential_ref)
                
                # 读取解压后的数据集
                for ext in [".sas7bdat", ".xpt", ".csv"]:
                    for file in extract_dir.rglob(f"*{ext}"):
                        if file.is_file():
                            dataset_name = file.stem.upper()
                            try:
                                if ext == ".csv":
                                    df = pd.read_csv(file)
                                else:
                                    df = pd.read_sas(file, encoding="utf-8")
                                
                                datasets[dataset_name] = df
                            except Exception:
                                pass
            except Exception:
                pass
    
    return datasets


def extract_metadata(outputs: dict[str, pd.DataFrame]) -> dict:
    """提取元数据（不返回数据值）"""
    metadata = {}
    
    for name, df in outputs.items():
        columns_info = []
        for col in df.columns:
            columns_info.append({
                "name": str(col),
                "dtype": str(df[col].dtype),
                "nullCount": int(df[col].isna().sum()),
            })
        
        metadata[name] = {
            "rowCount": len(df),
            "columns": columns_info,
        }
    
    return metadata


def operation_publish(request: dict) -> dict:
    """
    publish 操作：生成 Excel 输出
    """
    global _last_successful_code, _last_result, _session_datasets
    
    if not _last_successful_code:
        return {
            "ok": False,
            "code": "NO_SUCCESSFUL_RUN",
            "reason": "publish 前必须先成功执行 run_code",
        }
    
    project = request["project"]
    scenario = request.get("scenario", "manual")
    
    project_dir = Path(project).resolve()
    output_dir = project_dir / ".clinical-listing" / "output" / scenario
    output_dir.mkdir(parents=True, exist_ok=True)
    
    output_file = output_dir / f"{scenario.upper()}_LISTINGS.xlsx"
    
    try:
        # 重新执行代码生成结果
        local_env = {
            "datasets": _session_datasets,
            "pd": pd,
            "np": np,
            "math": math,
        }
        
        exec(_last_successful_code, local_env)
        
        # 获取输出
        if "result" in local_env:
            outputs = {"Listing": local_env["result"]}
        elif "outputs" in local_env:
            outputs = local_env["outputs"]
        else:
            return {
                "ok": False,
                "code": "NO_RESULT",
                "reason": "代码未定义 result 或 outputs",
            }
        
        # 写入 Excel
        with pd.ExcelWriter(output_file, engine="openpyxl") as writer:
            # Contents sheet
            contents_data = []
            for idx, (sheet_name, df) in enumerate(outputs.items(), 1):
                contents_data.append({
                    "No.": idx,
                    "Listing": sheet_name,
                    "Description": "",
                    "Rows": len(df),
                    "Columns": len(df.columns),
                })
            
            contents_df = pd.DataFrame(contents_data)
            contents_df.to_excel(writer, sheet_name="Contents", index=False)
            
            # 各个 listing sheets
            for sheet_name, df in outputs.items():
                # 添加系统字段（如果是 medical/rbqm 场景）
                if scenario in ["medical", "rbqm"]:
                    df = df.copy()
                    df["Flag"] = ""
                    df["Update Details"] = ""
                    df["Review Comments"] = ""
                    df["Initial_Date"] = ""
                
                df.to_excel(writer, sheet_name=sheet_name[:31], index=False)
        
        return {
            "ok": True,
            "action": "listing-publish",
            "receipt": {
                "outputFile": str(output_file.relative_to(project_dir)),
                "scenario": scenario,
                "dataClass": "REAL",
            },
        }
    
    except Exception as e:
        return {
            "ok": False,
            "code": "PUBLISH_ERROR",
            "reason": f"发布失败: {str(e)}",
        }


def main():
    """Worker 主入口"""
    try:
        request = json.loads(sys.stdin.read())
        operation = request.get("operation")
        
        if operation == "listing_inspect":
            response = operation_inspect(request)
        elif operation == "listing_run_code":
            response = operation_run_code(request)
        elif operation == "listing_publish":
            response = operation_publish(request)
        else:
            response = {
                "ok": False,
                "code": "UNKNOWN_OPERATION",
                "reason": f"未知操作: {operation}",
            }
        
        print(json.dumps(response))
    
    except Exception as e:
        error_response = {
            "ok": False,
            "code": "WORKER_ERROR",
            "reason": str(e),
            "traceback": traceback.format_exc(),
        }
        print(json.dumps(error_response))


if __name__ == "__main__":
    main()
