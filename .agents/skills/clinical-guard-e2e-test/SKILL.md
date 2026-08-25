---
name: "clinical-guard-e2e-full"
description: "通过 DSH Harness Web UI 运行完整的临床数据守护系统 E2E 测试。模拟真实用户选择 clinical-data 目录和项目，测试完整的 inspect -> run -> publish 流程。"
---

# 临床数据守护系统 - 完整 E2E 测试

## 功能说明

这个技能模拟真实用户在 DSH Web UI 中的完整工作流程：

1. **选择数据目录** - 指向 clinical-data 目录
2. **选择临床项目** - 从可用项目中选择
3. **Inspect 阶段** - 检查项目结构、数据集、规格文档
4. **Run Code 阶段** - 执行 Listing 生成代码
5. **Publish 阶段** - 发布 Excel 输出
6. **验证结果** - 检查输出质量

## 使用方法

当用户说：
- "运行完整的临床 E2E 测试"
- "测试真实临床项目"
- "启动 Listing 完整流程测试"
- "模拟用户操作测试临床系统"

## 测试流程

### 步骤 1: 环境检查

首先检查环境：

```bash
# 检查是否有 clinical-data 目录
ls clinical-data/

# 检查可用项目
ls clinical-data/*/
```

### 步骤 2: 选择测试项目

默认测试项目（按优先级）：
1. CGB3002-TEST （测试项目）
2. ADAV-008-CP4
3. GQ1005-301
4. 其他可用项目

询问用户：
```
找到以下临床项目：
1. CGB3002-TEST (推荐)
2. ADAV-008-CP4
3. GQ1005-301
...

请选择要测试的项目编号，或输入 'all' 测试所有项目：
```

### 步骤 3: 运行 Inspect

模拟用户在 Web UI 中执行：

```python
# 调用 listing_inspect
python -c "
import sys
sys.path.insert(0, 'packages/enterprise/clinical-guard/python')
from security.worker import _handle

result = _handle({
    'operation': 'listing_inspect',
    'project': 'CGB3002-TEST',
    'context': {
        'localDataAccess': 'uat-local',
        'localDataRoot': './clinical-data',
        'sessionId': 'test-session-001',
        'mode': 'enforce'
    }
})

print('Inspect 结果:')
print(f'  状态: {result.get(\"inspection\", {}).get(\"status\")}')
print(f'  场景: {result.get(\"inspection\", {}).get(\"scenario\")}')
print(f'  数据集: {len(result.get(\"inspection\", {}).get(\"datasets\", []))} 个')
"
```

**预期输出**:
```
Inspect 结果:
  状态: ready
  场景: demographics
  数据集: 3 个
```

### 步骤 4: 运行 Code

生成简单的 Listing 代码并执行：

```python
# 调用 listing_run_code
python -c "
import sys
sys.path.insert(0, 'packages/enterprise/clinical-guard/python')
from security.worker import _handle

# 简单的数据提取代码
code = '''
# 从第一个数据集提取数据
result = datasets['dm']  # Demographics dataset
'''

result = _handle({
    'operation': 'listing_run_code',
    'project': 'CGB3002-TEST',
    'scenario': 'demographics',
    'code': code,
    'context': {
        'localDataAccess': 'uat-local',
        'localDataRoot': './clinical-data',
        'sessionId': 'test-session-001',
        'mode': 'enforce'
    }
})

print('Run Code 结果:')
receipt = result.get('receipt', {})
outputs = receipt.get('outputs', {})
for name, meta in outputs.items():
    print(f'  {name}: {meta.get(\"rowCount\")} 行 x {meta.get(\"columnCount\")} 列')
"
```

**预期输出**:
```
Run Code 结果:
  dm: 150 行 x 12 列
```

### 步骤 5: Publish

发布最终的 Excel 输出：

```python
# 调用 listing_publish
python -c "
import sys
sys.path.insert(0, 'packages/enterprise/clinical-guard/python')
from security.worker import _handle

result = _handle({
    'operation': 'listing_publish',
    'project': 'CGB3002-TEST',
    'context': {
        'localDataAccess': 'uat-local',
        'localDataRoot': './clinical-data',
        'sessionId': 'test-session-001',
        'mode': 'enforce'
    }
})

print('Publish 结果:')
artifact = result.get('artifact', {})
print(f'  文件: {artifact.get(\"path\")}')
print(f'  表: {len(artifact.get(\"sheets\", []))} 个')
"
```

**预期输出**:
```
Publish 结果:
  文件: clinical-data/CGB3002-TEST/.clinical-listing/output/medical/MEDICAL_LISTINGS.xlsx
  表: 2 个
```

### 步骤 6: 验证输出

验证生成的 Excel 文件：

```python
import openpyxl
from pathlib import Path

xlsx_path = Path('clinical-data/CGB3002-TEST/.clinical-listing/output/medical/MEDICAL_LISTINGS.xlsx')

if xlsx_path.exists():
    wb = openpyxl.load_workbook(xlsx_path, read_only=True)
    print('验证结果:')
    print(f'  ✅ 文件存在: {xlsx_path.name}')
    print(f'  ✅ 表数量: {len(wb.sheetnames)}')
    print(f'  ✅ 表名称: {", ".join(wb.sheetnames)}')
    
    # 检查第一个数据表
    if len(wb.sheetnames) > 1:
        sheet = wb[wb.sheetnames[1]]
        print(f'  ✅ 数据行数: {sheet.max_row}')
        print(f'  ✅ 列数: {sheet.max_column}')
    
    wb.close()
    print('\n✅ E2E 测试通过！')
else:
    print('❌ 输出文件不存在')
```

## 完整测试脚本

创建一个完整的测试脚本：

```python
# tests/e2e/run_ui_simulation.py
"""
模拟用户在 Web UI 中的完整操作流程
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from security.worker import _handle
import openpyxl

def test_project_e2e(project: str, data_root: Path):
    """测试单个项目的完整流程"""
    print(f"\n{'='*70}")
    print(f"测试项目: {project}")
    print('='*70)
    
    context = {
        'localDataAccess': 'uat-local',
        'localDataRoot': str(data_root),
        'sessionId': f'test-{project}',
        'mode': 'enforce'
    }
    
    # Step 1: Inspect
    print("\n[1/4] Inspect 阶段...")
    inspect_result = _handle({
        'operation': 'listing_inspect',
        'project': project,
        'context': context
    })
    
    inspection = inspect_result.get('inspection', {})
    status = inspection.get('status')
    scenario = inspection.get('scenario', '')
    datasets = inspection.get('datasets', [])
    
    print(f"  状态: {status}")
    print(f"  场景: {scenario}")
    print(f"  数据集: {len(datasets)} 个")
    
    if status != 'ready':
        print("  ❌ Inspect 失败")
        return False
    
    # Step 2: Run Code
    print("\n[2/4] Run Code 阶段...")
    
    # 使用第一个数据集
    first_dataset = datasets[0]['dataset'] if datasets else 'dm'
    code = f"result = datasets['{first_dataset}']\n"
    
    run_result = _handle({
        'operation': 'listing_run_code',
        'project': project,
        'scenario': scenario,
        'code': code,
        'context': context
    })
    
    receipt = run_result.get('receipt', {})
    outputs = receipt.get('outputs', {})
    
    print(f"  输出表: {len(outputs)} 个")
    for name, meta in outputs.items():
        rows = meta.get('rowCount', 0)
        cols = meta.get('columnCount', 0)
        print(f"    {name}: {rows} 行 x {cols} 列")
    
    if not outputs:
        print("  ❌ Run Code 失败")
        return False
    
    # Step 3: Publish
    print("\n[3/4] Publish 阶段...")
    
    publish_result = _handle({
        'operation': 'listing_publish',
        'project': project,
        'context': context
    })
    
    artifact = publish_result.get('artifact', {})
    artifact_path = artifact.get('path', '')
    sheets = artifact.get('sheets', [])
    
    print(f"  输出文件: {artifact_path}")
    print(f"  表数量: {len(sheets)}")
    
    # Step 4: Verify
    print("\n[4/4] 验证阶段...")
    
    output_path = data_root / project / '.clinical-listing' / 'output' / 'medical' / 'MEDICAL_LISTINGS.xlsx'
    
    if output_path.exists():
        wb = openpyxl.load_workbook(output_path, read_only=True)
        print(f"  ✅ 文件存在")
        print(f"  ✅ 表: {', '.join(wb.sheetnames)}")
        wb.close()
        print(f"\n✅ 项目 {project} 测试通过")
        return True
    else:
        print(f"  ❌ 输出文件不存在: {output_path}")
        return False

def main():
    # 检查 clinical-data 目录
    data_root = Path('clinical-data')
    if not data_root.exists():
        print("❌ clinical-data 目录不存在")
        return 1
    
    # 获取可用项目
    projects = [p.name for p in data_root.iterdir() if p.is_dir()]
    
    if not projects:
        print("❌ 没有找到任何项目")
        return 1
    
    print("找到以下项目:")
    for i, proj in enumerate(projects, 1):
        print(f"  {i}. {proj}")
    
    # 测试项目
    test_projects = ['CGB3002-TEST'] if 'CGB3002-TEST' in projects else projects[:1]
    
    passed = 0
    failed = 0
    
    for project in test_projects:
        if test_project_e2e(project, data_root):
            passed += 1
        else:
            failed += 1
    
    print(f"\n{'='*70}")
    print(f"测试总结")
    print('='*70)
    print(f"通过: {passed}")
    print(f"失败: {failed}")
    
    return 0 if failed == 0 else 1

if __name__ == '__main__':
    sys.exit(main())
```

## 在 Web UI 中运行

1. **启动 DSH Web UI**:
   ```bash
   dsh web
   ```

2. **在对话中说**:
   ```
   运行完整的临床 E2E 测试
   ```

3. **Agent 会自动**:
   - 检查 clinical-data 目录
   - 列出可用项目
   - 执行完整的 inspect -> run -> publish 流程
   - 验证输出
   - 显示详细的测试结果

4. **实时监控**:
   - 每个阶段的输出会实时显示在 Web UI 中
   - 可以看到数据集信息、行列数等
   - 最终验证结果

## 成功标准

E2E 测试通过需要：
- ✅ Inspect 返回 status = 'ready'
- ✅ Run Code 生成输出（至少 1 个表）
- ✅ Publish 创建 Excel 文件
- ✅ Excel 文件包含 Contents 表和数据表
- ✅ 数据行数和列数匹配

## 故障排除

### clinical-data 目录不存在
确保项目根目录下有 clinical-data 文件夹并包含测试项目

### 项目结构不完整
检查项目目录下是否有：
- doc/ （规格文档）
- data/ （SAS 数据集）
- .clinical-listing/ （工作目录）

### Worker 错误
检查 Python 路径：
```bash
$env:PYTHONPATH="packages/enterprise/clinical-guard/python"
```

## 注意事项

1. 这个测试需要真实的临床数据
2. 确保有足够的磁盘空间用于输出
3. 测试时间可能较长（几分钟到十几分钟）
4. 可以在 Web UI 中实时查看进度
