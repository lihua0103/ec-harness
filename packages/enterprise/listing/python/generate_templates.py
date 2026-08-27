"""
示例：生成标准模板 Excel 文件

展示三个场景的标准输出格式
"""
import pandas as pd
from pathlib import Path
import sys

# 添加 styles 模块路径
sys.path.insert(0, str(Path(__file__).parent))

from styles import create_multi_sheet_excel


def create_manual_template():
    """创建 Manual 场景模板"""
    # 示例数据
    ae_data = {
        "Subject_ID": ["001", "002", "003"],
        "Visit": ["Day 1", "Day 7", "Day 14"],
        "AE_Term": ["Headache", "Nausea", "Fatigue"],
        "Severity": ["Mild", "Moderate", "Mild"],
        "Start_Date": ["2024-01-01", "2024-01-07", "2024-01-14"],
    }
    
    vs_data = {
        "Subject_ID": ["001", "001", "002"],
        "Visit": ["Day 1", "Day 7", "Day 1"],
        "BP_Systolic": [120, 125, 130],
        "BP_Diastolic": [80, 82, 85],
        "Heart_Rate": [72, 75, 78],
    }
    
    outputs = {
        "Adverse_Events": pd.DataFrame(ae_data),
        "Vital_Signs": pd.DataFrame(vs_data),
    }
    
    output_file = Path(__file__).parent / "template_manual.xlsx"
    result = create_multi_sheet_excel(outputs, output_file, "manual", track_changes=False)
    print(f"Manual 模板已生成: {output_file}")
    print(f"统计: {result}")


def create_medical_template():
    """创建 Medical 场景模板"""
    dm_data = {
        "Subject_ID": ["001", "002", "003"],
        "Site_ID": ["Site001", "Site002", "Site001"],
        "Age": [45, 52, 38],
        "Gender": ["M", "F", "M"],
        "Race": ["Asian", "Caucasian", "Asian"],
    }
    
    outputs = {
        "Demographics": pd.DataFrame(dm_data),
    }
    
    output_file = Path(__file__).parent / "template_medical.xlsx"
    result = create_multi_sheet_excel(outputs, output_file, "medical", track_changes=False)
    print(f"Medical 模板已生成: {output_file}")
    print(f"统计: {result}")


def create_rbqm_template():
    """创建 RBQM 场景模板"""
    risk_data = {
        "Site_ID": ["Site001", "Site002", "Site003"],
        "Metric": ["Enrollment Rate", "Protocol Deviation", "Query Rate"],
        "Current_Value": [0.85, 0.12, 0.08],
        "Benchmark": [0.90, 0.10, 0.05],
        "Risk_Level": ["Medium", "High", "Medium"],
    }
    
    outputs = {
        "Site_Risk_Assessment": pd.DataFrame(risk_data),
    }
    
    output_file = Path(__file__).parent / "template_rbqm.xlsx"
    result = create_multi_sheet_excel(outputs, output_file, "rbqm", track_changes=False)
    print(f"RBQM 模板已生成: {output_file}")
    print(f"统计: {result}")


def create_report_template():
    """创建 Report 场景模板"""
    summary_data = {
        "Category": ["Enrollment", "Enrollment", "Safety", "Safety"],
        "Metric": ["Total Subjects", "Screening Rate", "AE Count", "SAE Count"],
        "Value": [156, 0.85, 342, 12],
        "Unit": ["subjects", "%", "events", "events"],
    }
    
    outputs = {
        "Study_Summary": pd.DataFrame(summary_data),
    }
    
    output_file = Path(__file__).parent / "template_report.xlsx"
    result = create_multi_sheet_excel(outputs, output_file, "report", track_changes=False)
    print(f"Report 模板已生成: {output_file}")
    print(f"统计: {result}")


if __name__ == "__main__":
    print("生成标准模板文件...")
    create_manual_template()
    create_medical_template()
    create_rbqm_template()
    create_report_template()
    print("所有模板已生成完成！")
