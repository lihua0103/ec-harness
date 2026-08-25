"""
模拟用户在 Web UI 中的完整操作流程
完整的 inspect -> run -> publish E2E 测试
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from security.worker import _handle
import openpyxl
import json

def test_project_e2e(project: str, data_root: Path):
    """测试单个项目的完整流程"""
    print(f"\n{'='*70}")
    print(f"Testing Project: {project}")
    print('='*70)
    
    context = {
        'localDataAccess': 'uat-local',
        'localDataRoot': str(data_root),
        'sessionId': f'test-{project}',
        'mode': 'enforce'
    }
    
    try:
        # Step 1: Inspect
        print("\n[1/4] Inspect Phase...")
        inspect_result = _handle({
            'operation': 'listing_inspect',
            'project': project,
            'context': context
        })
        
        inspection = inspect_result.get('inspection', {})
        status = inspection.get('status')
        scenario = inspection.get('scenario', '')
        datasets = inspection.get('datasets', [])
        
        print(f"  Status: {status}")
        print(f"  Scenario: {scenario}")
        print(f"  Datasets: {len(datasets)}")
        
        for ds in datasets[:3]:  # 显示前3个
            print(f"    - {ds.get('dataset')}: {ds.get('label', 'N/A')}")
        
        if status != 'ready':
            print(f"  FAIL Inspect status is {status}, expected 'ready'")
            return False
        
        if not datasets:
            print("  FAIL No datasets found")
            return False
        
        print("  PASS Inspect phase")
        
        # Step 2: Run Code
        print("\n[2/4] Run Code Phase...")
        
        # 使用第一个数据集
        first_dataset = datasets[0]['dataset']
        code = f"result = datasets['{first_dataset}']\n"
        
        print(f"  Executing code with dataset: {first_dataset}")
        
        run_result = _handle({
            'operation': 'listing_run_code',
            'project': project,
            'scenario': scenario,
            'code': code,
            'context': context
        })
        
        receipt = run_result.get('receipt', {})
        outputs = receipt.get('outputs', {})
        
        print(f"  Outputs: {len(outputs)}")
        for name, meta in outputs.items():
            rows = meta.get('rowCount', 0)
            cols = meta.get('columnCount', 0)
            print(f"    {name}: {rows} rows x {cols} columns")
        
        if not outputs:
            print("  FAIL No outputs generated")
            return False
        
        print("  PASS Run Code phase")
        
        # Step 3: Publish
        print("\n[3/4] Publish Phase...")
        
        publish_result = _handle({
            'operation': 'listing_publish',
            'project': project,
            'context': context
        })
        
        artifact = publish_result.get('artifact', {})
        artifact_path = artifact.get('path', '')
        sheets = artifact.get('sheets', [])
        
        print(f"  Output file: {artifact_path}")
        print(f"  Sheets: {len(sheets)}")
        
        if not artifact_path:
            print("  FAIL No artifact path returned")
            return False
        
        print("  PASS Publish phase")
        
        # Step 4: Verify
        print("\n[4/4] Verification Phase...")
        
        output_path = data_root / project / '.clinical-listing' / 'output' / 'medical' / 'MEDICAL_LISTINGS.xlsx'
        
        if not output_path.exists():
            print(f"  FAIL Output file not found: {output_path}")
            return False
        
        print(f"  PASS File exists: {output_path.name}")
        
        # 验证 Excel 内容
        wb = openpyxl.load_workbook(output_path, read_only=True)
        print(f"  Sheets found: {', '.join(wb.sheetnames)}")
        
        if len(wb.sheetnames) < 2:
            print(f"  FAIL Expected at least 2 sheets, got {len(wb.sheetnames)}")
            wb.close()
            return False
        
        # 检查数据表
        data_sheet = wb[wb.sheetnames[1]]
        print(f"  Data sheet: {data_sheet.title}")
        print(f"  Rows: {data_sheet.max_row}")
        print(f"  Columns: {data_sheet.max_column}")
        
        if data_sheet.max_row < 2:
            print(f"  FAIL Expected at least 2 rows (header + data), got {data_sheet.max_row}")
            wb.close()
            return False
        
        wb.close()
        
        print(f"\n  PASS All verification checks passed")
        print(f"\nPASS Project {project} E2E test completed successfully")
        return True
        
    except Exception as e:
        print(f"\nFAIL Exception occurred: {type(e).__name__}: {e}")
        return False

def main():
    print("="*70)
    print("Clinical Guard System - Full E2E Test")
    print("Simulating user workflow in Web UI")
    print("="*70)
    
    # 检查 clinical-data 目录
    data_root = Path('clinical-data')
    if not data_root.exists():
        print(f"\nFAIL clinical-data directory not found: {data_root.absolute()}")
        print("Please ensure clinical-data directory exists in project root")
        return 1
    
    print(f"\nData root: {data_root.absolute()}")
    
    # 获取可用项目
    projects = [p.name for p in data_root.iterdir() if p.is_dir() and not p.name.startswith('.')]
    
    if not projects:
        print("\nFAIL No projects found in clinical-data directory")
        return 1
    
    print(f"\nAvailable projects ({len(projects)}):")
    for i, proj in enumerate(sorted(projects), 1):
        print(f"  {i}. {proj}")
    
    # 测试项目（优先使用 CGB3002-TEST）
    if 'CGB3002-TEST' in projects:
        test_projects = ['CGB3002-TEST']
        print(f"\nTesting primary test project: CGB3002-TEST")
    else:
        test_projects = [projects[0]]
        print(f"\nNo CGB3002-TEST found, using: {test_projects[0]}")
    
    passed = 0
    failed = 0
    
    for project in test_projects:
        if test_project_e2e(project, data_root):
            passed += 1
        else:
            failed += 1
    
    # 总结
    print(f"\n{'='*70}")
    print("Test Summary")
    print('='*70)
    print(f"Passed: {passed}")
    print(f"Failed: {failed}")
    print(f"Total: {passed + failed}")
    
    if failed == 0:
        print("\nRESULT: PASS - All E2E tests passed")
        print("System is production ready for real user workflows")
        return 0
    else:
        print(f"\nRESULT: FAIL - {failed} test(s) failed")
        return 1

if __name__ == '__main__':
    sys.exit(main())
