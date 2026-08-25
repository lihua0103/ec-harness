# 真实运行复现的 Bug 清单

**复现日期**: 2026-08-22 23:15  
**测试项目**: RBQM_test (G:\home\Clinical-Data\RBQM_test)  
**方法**: 真实项目数据运行，非合成测试

---

## Bug #1: 缺失依赖导致基线假绿

**现象**:
```
ModuleNotFoundError: No module named 'pyreadstat'
ModuleNotFoundError: No module named 'xlwt'  
ModuleNotFoundError: No module named 'pyzipper'
```

**影响**: 
- listing_executor.py 第 10 行立即崩溃
- 用户看到的测试报告显示"58/60 全绿"，但实际上 2 个用例根本没运行（静默跳过）

**根因**: requirements.txt 缺少这些包

**证据**: 审计报告 B5

---

## Bug #2: ZIP 文件大小限制过严

**现象**:
```python
# path_policy.py L99
raise PathPolicyError("archive member exceeds the size limit")
```

**真实数据**:
```
lab.sas7bdat: 7.1 GB  # 超过 512MB 限制
cm.sas7bdat:  1.1 GB
ec.sas7bdat:  342 MB
```

**配置**:
```python
# path_policy.py L16-17
MAX_ARCHIVE_FILE_BYTES = 512 * 1024 * 1024  # 512MB
MAX_ARCHIVE_TOTAL_BYTES = 4 * 1024 * 1024 * 1024  # 4GB
```

**影响**: **真实临床数据的 ZIP 文件根本无法解压**

**根因**: 硬编码限制未考虑真实临床数据规模

---

## Bug #3: 临时目录清理失败导致权限错误

**现象**:
```
PermissionError: [Errno 1] Operation not permitted: '.extract-cv1i5omy'
```

**位置**: 
- path_policy.py L156: `shutil.rmtree(temporary)` 失败
- archive_passwords.py L109: `shutil.rmtree(attempt_root)` 失败

**影响**: 
- 解压失败后临时目录无法清理
- 第二次运行会遇到残留的临时目录（权限错误）
- **用户无法清理（rm -rf 也报 Operation not permitted）**

**遗留文件**:
```
.clinical-listing/.listing-catalog-*/. listing-zip-*/.extract-*  # 无法删除
.clinical-listing/output/.rbqm-tmp-*/RBQM_*.xlsx  # 无法删除
```

**根因**: 
1. Windows 文件系统通过 WSL/Linux VM 访问时的权限映射问题
2. 异常处理中清理临时目录的逻辑不健壮

---

## Bug #4: 错误处理导致信息丢失

**现象**: worker 返回
```json
{"ok": false, "code": "LISTING_INSPECTION_FAILED", "reason": "listing inspection failed"}
```

**问题**: 
- 真实错误是"archive member exceeds the size limit"
- 但通过 worker.py 返回时被通用包装抹平
- 用户只看到"inspection failed"，无从诊断

**位置**: listing_workflow.py L56-59
```python
except Exception as exc:
    raise ListingWorkflowError(
        "listing inspection failed",  # 原始错误信息丢失！
        code="LISTING_INSPECTION_FAILED") from exc
```

**影响**: 所有底层错误都变成"inspection failed"，无法调试

---

## Bug #5: ZIP 解压逻辑强制运行

**观察**: 
- RBQM_test 项目已经有 `raw/` 目录，包含全部 62 个 .sas7bdat 文件
- 但 `inspect_listing` 仍然尝试解压 `test_20260622_151305.zip`

**问题**: 没有"如果 raw/ 已存在，跳过 ZIP 解压"的逻辑

**影响**: 
- 用户手动解压后，工具仍然强制重新解压
- 遇到 Bug #2 时完全卡死

---

## Bug #6: 实际产出文件无法访问

**观察**: `.clinical-listing/output/rbqm/` 下已经有 20 个 RBQM_*.xlsx 输出文件

```
RBQM_001.xlsx
RBQM_002.xlsx
...
RBQM_020.xlsx
RBQM_SYNTHETIC_MANIFEST.xlsx
```

**问题**: 这些文件标记为 `Operation not permitted`，用户无法读取

**影响**: 即使生成成功，用户也拿不到产物

---

## 测试覆盖缺口总结

| 真实场景 | 测试覆盖 | 实际结果 |
|---|---|---|
| ZIP 文件 > 4GB | ❌ 无 | 立即失败 (Bug #2) |
| 单个文件 > 512MB | ❌ 无 | 立即失败 (Bug #2) |
| raw/ 已存在 | ❌ 无 | 仍然强制解压 (Bug #5) |
| 临时目录清理失败 | ❌ 无 | 永久污染工作区 (Bug #3) |
| 跨平台权限映射 | ❌ 无 | 文件无法删除/读取 (Bug #3, #6) |
| 缺失依赖 | ❌ 假绿 | 2 用例静默跳过 (Bug #1) |

**结论**: 
- 所有测试用例都是合成的小数据集
- **零真实数据规模测试**
- **零跨平台权限测试**
- **零依赖完整性测试**

---

## 与审计报告的对应

| 审计报告中的预测 | 真实复现结果 | 状态 |
|---|---|---|
| E1: 唯一真实收据是失败 | ✅ 确认：无法运行到产生新收据 | 验证 |
| E5: 零真实数据测试 | ✅ 确认：多个真实数据规模问题 | 验证 |
| B5: pyreadstat/xlwt 缺失 | ✅ 确认：立即崩溃 | 验证 |
| 测试假绿 | ✅ 确认：2 用例静默跳过 | 验证 |

---

## 用户感受映射

**用户描述**: "到处都是问题，不是这儿拦截就是那儿脱敏"

**真实原因**:
1. 基础依赖缺失 → 立即崩溃
2. 数据规模限制 → ZIP 解压失败
3. 临时目录清理失败 → 工作区污染
4. 错误信息被抹平 → 无从诊断
5. 权限映射问题 → 文件无法访问

**核心问题**: 不是"拦截太严"，而是**根本跑不起来**

---

## 建议修复优先级

### P0 - 立即修复（当前完全不可用）

1. ✅ 补齐依赖：pyreadstat、xlwt、pyzipper
2. ✅ 提高 ZIP 文件大小限制到 10GB（真实数据规模）
3. ✅ 修复临时目录清理逻辑（Windows 权限兼容）

### P1 - 本周修复

4. 保留原始错误信息（不要通用包装抹平）
5. 支持跳过 ZIP 解压（raw/ 已存在时）
6. 增加真实数据规模测试用例

### P2 - 改进用户体验

7. 更友好的错误提示（告诉用户具体哪个文件超限）
8. 提供手动清理工具（处理权限错误的临时目录）
9. 支持增量解压（不是全部重来）

---

## 修复后验证清单

- [ ] RBQM_test 的 7.1GB lab.sas7bdat 能成功解压
- [ ] 解压失败后临时目录能完全清理
- [ ] raw/ 已存在时不强制重新解压
- [ ] 错误信息包含具体失败原因
- [ ] 所有 pytest 用例真实运行（不是静默跳过）
- [ ] 跨平台测试（Windows/Linux/WSL）
