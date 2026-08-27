"""
多 Sheet Excel 生成器 - 统一输出规范

核心功能：
1. 将多个 listing 合并到一个 Excel 文件
2. 自动生成 Contents 目录页
3. 应用场景样式规范
4. 支持变化追踪（对比上一版本）
"""
import pandas as pd
from pathlib import Path
from typing import Dict, Optional, List, Any
from openpyxl import load_workbook
from openpyxl.utils.dataframe import dataframe_to_rows
import json
from datetime import datetime


def load_previous_version(output_file: Path) -> Optional[Dict[str, pd.DataFrame]]:
    """加载上一版本的数据（用于变化追踪）"""
    if not output_file.exists():
        return None
    
    try:
        previous_data = {}
        with pd.ExcelFile(output_file) as xls:
            for sheet_name in xls.sheet_names:
                if sheet_name != "Contents":
                    previous_data[sheet_name] = pd.read_excel(xls, sheet_name=sheet_name)
        return previous_data
    except Exception:
        return None


def calculate_changes(
    previous: Optional[Dict[str, pd.DataFrame]],
    current: Dict[str, pd.DataFrame],
    unique_key_columns: Optional[Dict[str, List[str]]] = None
) -> Dict[str, Any]:
    """计算数据变化
    
    Args:
        previous: 上一版本数据
        current: 当前版本数据
        unique_key_columns: 每个 listing 的唯一键列，格式 {sheet_name: [col1, col2]}
    
    Returns:
        变化统计，格式：{
            "sheet_name": {
                "added": 新增行数,
                "deleted": 删除行数,
                "modified": 修改行数,
                "details": ["具体变化描述"]
            }
        }
    """
    if not previous:
        return {}
    
    changes = {}
    
    for sheet_name, current_df in current.items():
        if sheet_name not in previous:
            changes[sheet_name] = {
                "added": len(current_df),
                "deleted": 0,
                "modified": 0,
                "details": [f"新增 listing，共 {len(current_df)} 行"]
            }
            continue
        
        prev_df = previous[sheet_name]
        
        # 简单行数对比
        added = max(0, len(current_df) - len(prev_df))
        deleted = max(0, len(prev_df) - len(current_df))
        
        # 如果提供了唯一键，进行更精确的对比
        if unique_key_columns and sheet_name in unique_key_columns:
            key_cols = unique_key_columns[sheet_name]
            if all(col in current_df.columns and col in prev_df.columns for col in key_cols):
                # 使用唯一键进行对比
                prev_keys = set(prev_df[key_cols].apply(tuple, axis=1))
                curr_keys = set(current_df[key_cols].apply(tuple, axis=1))
                
                added = len(curr_keys - prev_keys)
                deleted = len(prev_keys - curr_keys)
                modified = len(prev_keys & curr_keys)  # 相同键的行可能有字段变化
        
        details = []
        if added > 0:
            details.append(f"新增 {added} 行")
        if deleted > 0:
            details.append(f"删除 {deleted} 行")
        
        changes[sheet_name] = {
            "added": added,
            "deleted": deleted,
            "modified": 0,  # 字段级变化检测需要更复杂的逻辑
            "details": details if details else ["无变化"]
        }
    
    # 检查删除的 sheet
    for sheet_name in previous.keys():
        if sheet_name not in current:
            changes[sheet_name] = {
                "added": 0,
                "deleted": len(previous[sheet_name]),
                "modified": 0,
                "details": ["整个 listing 已删除"]
            }
    
    return changes


def generate_contents_page(
    outputs: Dict[str, pd.DataFrame],
    changes: Optional[Dict[str, Any]] = None
) -> pd.DataFrame:
    """生成 Contents 目录页
    
    Args:
        outputs: 所有 listing 数据
        changes: 变化统计
    
    Returns:
        Contents DataFrame
    """
    contents_data = []
    
    for idx, (sheet_name, df) in enumerate(outputs.items(), 1):
        row = {
            "No.": idx,
            "Listing": sheet_name,
            "Description": "",  # 可从 spec 提取
            "Rows": len(df),
            "Columns": len(df.columns),
            "Status": "Updated" if changes and sheet_name in changes else "New",
            "Last Updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        
        # 添加变化信息
        if changes and sheet_name in changes:
            change_info = changes[sheet_name]
            if change_info["details"]:
                row["Description"] = "; ".join(change_info["details"])
        
        contents_data.append(row)
    
    return pd.DataFrame(contents_data)


def create_multi_sheet_excel(
    outputs: Dict[str, pd.DataFrame],
    output_file: Path,
    scenario: str,
    unique_key_columns: Optional[Dict[str, List[str]]] = None,
    track_changes: bool = True
) -> Dict[str, Any]:
    """创建多 sheet Excel 文件
    
    Args:
        outputs: 所有 listing 数据，格式 {sheet_name: DataFrame}
        output_file: 输出文件路径
        scenario: 场景类型 (manual/medical/rbqm/report)
        unique_key_columns: 唯一键列定义
        track_changes: 是否追踪变化
    
    Returns:
        生成结果统计
    """
    from .formatter import format_workbook
    from .style_spec import get_system_fields
    
    # 1. 加载上一版本（如果存在）
    previous = load_previous_version(output_file) if track_changes else None
    
    # 2. 计算变化
    changes = calculate_changes(previous, outputs, unique_key_columns) if previous else None
    
    # 3. 添加系统字段列
    system_fields = get_system_fields(scenario)
    processed_outputs = {}
    
    for sheet_name, df in outputs.items():
        df_copy = df.copy()
        
        # 添加系统字段（如果不存在）
        for field in system_fields:
            if field not in df_copy.columns:
                df_copy[field] = ""
        
        processed_outputs[sheet_name] = df_copy
    
    # 4. 生成 Contents 页
    contents_df = generate_contents_page(processed_outputs, changes)
    
    # 5. 写入 Excel
    output_file.parent.mkdir(parents=True, exist_ok=True)
    
    with pd.ExcelWriter(output_file, engine="openpyxl") as writer:
        # 写入 Contents 页
        contents_df.to_excel(writer, sheet_name="Contents", index=False)
        
        # 写入数据页
        for sheet_name, df in processed_outputs.items():
            # Sheet 名称最大 31 字符
            safe_sheet_name = sheet_name[:31]
            df.to_excel(writer, sheet_name=safe_sheet_name, index=False)
    
    # 6. 应用样式
    wb = load_workbook(output_file)
    sheet_columns = {name: list(df.columns) for name, df in processed_outputs.items()}
    format_workbook(wb, scenario, sheet_columns)
    wb.save(output_file)
    
    # 7. 保存变化记录
    if changes:
        change_log_file = output_file.parent / f"{output_file.stem}_changes.json"
        with open(change_log_file, 'w', encoding='utf-8') as f:
            json.dump({
                "timestamp": datetime.now().isoformat(),
                "changes": changes
            }, f, indent=2, ensure_ascii=False)
    
    # 8. 返回统计
    return {
        "output_file": str(output_file),
        "total_sheets": len(processed_outputs) + 1,  # +1 for Contents
        "total_rows": sum(len(df) for df in processed_outputs.values()),
        "changes": changes,
        "scenario": scenario
    }


def merge_listing_files(
    listing_dir: Path,
    output_file: Path,
    scenario: str,
    pattern: str = "*.xlsx"
) -> Dict[str, Any]:
    """合并多个单独的 listing 文件到一个 Excel
    
    用于迁移现有的单文件输出模式
    
    Args:
        listing_dir: listing 文件所在目录
        output_file: 输出文件路径
        scenario: 场景类型
        pattern: 文件匹配模式
    
    Returns:
        合并结果统计
    """
    outputs = {}
    
    for file in listing_dir.glob(pattern):
        if file.stem == "Contents" or file == output_file:
            continue
        
        try:
            # 读取第一个 sheet（假设单文件只有一个数据 sheet）
            df = pd.read_excel(file, sheet_name=0)
            sheet_name = file.stem
            outputs[sheet_name] = df
        except Exception as e:
            print(f"Warning: 无法读取 {file}: {e}")
    
    if not outputs:
        raise ValueError(f"在 {listing_dir} 中未找到有效的 listing 文件")
    
    return create_multi_sheet_excel(outputs, output_file, scenario)
