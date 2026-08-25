---
name: "clinical-guard-e2e-test"
description: "运行临床数据守护系统的完整 E2E 测试，通过 DSH Web UI 监控整个测试流程。"
---

# 临床数据守护系统 - E2E 测试流程

## 测试流程

### 阶段 1: TypeScript 单元测试 (必须)

```bash
cd packages/enterprise/clinical-guard
npx vitest run tests/unit/
```

预期: 34/34 测试通过

### 阶段 2: Python 后端测试

```bash
cd packages/enterprise/clinical-guard
$env:PYTHONPATH="python"
python tests/unit/test_code_sandbox.py
```

预期: 19/19 测试通过

### 阶段 3: 完整 Python 测试套件

```bash
cd packages/enterprise/clinical-guard
$env:PYTHONPATH="python"
python tests/run_all.py
```

### 最终报告

生成完整的测试报告，包括：
- 通过的测试数量
- 失败的测试
- 系统状态评估

## 成功标准

最低标准（可以上线）:
- ✅ TypeScript 单元测试 100% 通过
- ✅ Python 代码沙箱测试通过
