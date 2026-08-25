# dsh-guard 项目审计总结报告

**审计日期**: 2026-08-22  
**审计方法**: 代码审查 + 真实项目数据运行验证  
**测试项目**: RBQM_test, GQ1005-301 (G:\home\Clinical-Data)  
**判决**: **FAIL - 系统在基础层面不可用**

---

## 执行摘要

你说的对：**"每次说测试全绿，结果特么的全是 bug"**

### 根本原因

不是"安全措施太严"，而是：
1. **基础依赖缺失** → 代码 import 立即崩溃
2. **真实数据规模未测试** → 遇到真实数据立即失败
3. **测试全是合成小数据** → 零真实项目覆盖
4. **架构与需求相反** → 职责倒挂

### 真实运行结果

| 项目 | 预期 | 实际结果 | 失败点 |
|---|---|---|---|
| RBQM_test | 生成 RBQM listing | ❌ ModuleNotFoundError: pyreadstat | 依赖缺失 |
| RBQM_test | 解压 ZIP | ❌ PathPolicyError: file exceeds limit | 7.1GB 文件超 512MB 限制 |
| RBQM_test | 清理临时目录 | ❌ Operation not permitted | Windows 权限映射问题 |
| GQ1005-301 | 解析 ALS | ❌ mappings: 0 | ALS 格式不支持 |
| GQ1005-301 | 读取 MM Listing 需求 | ⚠️ 466 行真实受试者数据泄露 | 文件级判断失效 |

---

## 致命发现（8 个已验证证据）

### E1: 仓库中唯一真实收据是失败收据
- 文件: `.tmp-real-replay/receipt.json`
- 状态: `needs_input` (失败)
- 说明: 仓库从未成功完成过一次真实 listing

### E2: 真实 ALS 解析必然失败 (mappings = 0)
- **RBQM_test**: ALS.xlsx 解析 → `mappings: []`
- **GQ1005-301**: ALS_V1.0_20241219.xlsx → `mappings: []`
- 原因: Items sheet 只有表头行 (rowCount=1)，被当作空 sheet 跳过

### E3: 中文规则触发主动拒绝
- 文件: emerald_listing_generator.py L411-424
- 规则: "New\Modified的信息请标识"
- 触发: `medical_rule_provenance` 异常 → 拒绝执行

### E4: Spec 文件内嵌 466 行真实受试者数据 ✅ 已复现
- 文件: GQ1005-301_MM Listing要求_20250211.xlsx
- Sheet: SV (466 行)
- 内容: SUBJID 列包含真实受试者编号 (000, 004, 01010, 01027...)
- 问题: planes.js 按文件级判断，doc/ 下的 xlsx → 全文放行 → **数据泄露**

### E5: 零真实数据测试
- 所有测试用例使用合成小数据
- 真实数据规模问题完全未覆盖

### E6: 真实 ZIP 文件无法解压 ✅ 已复现
```
lab.sas7bdat: 7.1 GB  (超过 512MB 限制)
cm.sas7bdat:  1.1 GB
ec.sas7bdat:  342 MB
```
- 错误: `PathPolicyError: archive member exceeds the size limit`
- 配置: `MAX_ARCHIVE_FILE_BYTES = 512 * 1024 * 1024`

### E7: 3 个关键依赖缺失 ✅ 已复现
```python
ModuleNotFoundError: No module named 'pyreadstat'
ModuleNotFoundError: No module named 'xlwt'
ModuleNotFoundError: No module named 'pyzipper'
```
- 测试报告: "58/60 全绿"
- 真相: 2 个用例**静默跳过**（假绿）

### E8: 临时目录无法清理 ✅ 已复现
```
PermissionError: [Errno 1] Operation not permitted: '.extract-cv1i5omy'
```
- 影响: 工作区永久污染
- 位置: `.clinical-listing/.listing-catalog-*/.extract-*`
- 用户也无法删除 (`rm -rf` 同样失败)

---

## 架构性缺陷（为什么"到处都是问题"）

### A1: 职责倒挂 - AI 被禁止做它唯一擅长的事

**现状**:
```python
# listing_workflow.py L132-140
receipt["requirements"] = {
    "documents": [{
        "summary": {
            "forms": 0,
            "datasets": 0,
            "requirements": 476  # 只给数字，不给内容！
        }
    }]
}
```

**后果**: 
- AI 最擅长的（理解中文需求）→ 被屏蔽
- 硬编码生成器做不了的（理解"New\Modified的信息请标识"）→ 硬塞给它

### A2: 文件级判断失效 - Spec 与数据混排

**假设**: Spec 文件 ≠ 数据文件
**真相**: GQ1005-301_MM Listing要求.xlsx 同时包含：
- Sheet "MM listing要求": 需求说明 ✅
- Sheet "SV": 466 行真实受试者数据 ❌

**当前实现**: planes.js 按**文件级**判断
```javascript
// doc/ 下的文件 → spec plane → 全文放行
if (inside(config.documentPlaneRoots, target)) return 'document';
```

**正确边界**: 必须是 **sheet 级/行级**判断

### A3: 四层拦截 + 破坏性脱敏

```
用户输入
   ↓
① quickGuard (JS) → "2024-01-01" 被拦
   ↓
② pre-execute → 数据域路径拒绝 (这个对)
   ↓
③ post-execute → "DatasetName" → "COLUMN_3"
   ↓
④ llm/stream → "失访率" → "[TEXT:a1b2c3d4]"
   ↓
模型（已无法理解）
```

### A4: 双车道不通

- **通用读取通道** (index.js): doc/ 文件可以全文读取 ✅
- **listing 工具通道** (listing_workflow.py): 主动屏蔽内容只给计数 ❌

两条通道互不相通！用户无论走哪条路都是死胡同。

---

## 真实缺陷清单（13 个）

| ID | 缺陷 | 复现 |
|---|---|---|
| B1 | ALS 解析 mappings = 0 | ✅ 2 项目 |
| B2 | MAX_DEFINITIONS 截断无告警 | ✅ fields:2000 |
| B3 | needs_input 无结构化说明 | ✅ |
| B4 | sheet 名黑名单误杀 | 未测试 |
| B5 | 3 个依赖缺失 | ✅ |
| B6 | shadow 模式未激活 | 未测试 |
| B7 | 横向表头列索引错位 | 未测试 |
| B8 | JS/Python 豁免不对称 | 未测试 |
| B9 | 双车道割裂 | ✅ |
| B10 | ZIP 512MB 限制 | ✅ 7.1GB 失败 |
| B11 | 临时目录清理失败 | ✅ |
| B12 | 错误信息被抹平 | ✅ |
| B13 | ALS 表头行被跳过 | ✅ |

---

## 为什么测试会"全绿"

### 测试用的数据

```python
# 合成小数据
demo.sas7bdat: 100 行, 5 MB
test_ALS.xlsx: 10 个 sheet, 每个 < 50 行
```

### 真实数据规模

```
lab.sas7bdat: 7,149,992,960 字节 (7.1 GB)
cm.sas7bdat: 1,127,567,360 字节 (1.1 GB)
ALS.xlsx: 23 sheets, 大部分只有表头
```

### 测试覆盖缺口

| 真实场景 | 测试覆盖 | 实际结果 |
|---|---|---|
| ZIP > 4GB | ❌ | 立即失败 (B10) |
| 单文件 > 512MB | ❌ | 立即失败 (B10) |
| ALS 只有表头 | ❌ | mappings=0 (B1, B13) |
| 临时目录清理 | ❌ | 永久污染 (B11) |
| 跨平台权限 | ❌ | Operation not permitted |
| 依赖完整性 | ❌ 假绿 | import 崩溃 (B5) |
| Spec 内嵌数据 | ❌ | 数据泄露 (E4) |

---

## 修复优先级

### P0 - 立即修复（否则完全不可用）

1. ✅ 补齐依赖: `pip install pyreadstat xlwt pyzipper`
2. ✅ 提高 ZIP 限制: `MAX_ARCHIVE_FILE_BYTES = 10 * 1024**3` (10GB)
3. ✅ 修复临时目录清理（Windows 兼容）
4. ✅ 修复 ALS 解析：支持只有表头的 sheet
5. ✅ 保留原始错误信息（不要抹平）

### P1 - 本周修复（核心功能）

6. Sheet 级数据检测（替代文件级）
7. listing 收据包含需求文本（受控数量）
8. 移除 medical_rule_provenance 主动拒绝
9. header_detect 白名单扩充（ALS 核心列名）

### P2 - 改进可用性

10. 激活 shadow 模式（cordis.patch.yml）
11. JS/Python 豁免口径对齐
12. 增加真实数据规模测试

### P3 - 根治（架构重构）

13. "计划-执行"两段式架构（参考 EMERALD_PROVENANCE_ARCHITECTURE）

---

## 结论

### 判决

**FAIL - 系统在多个基础层面不可用**

### 根本问题

1. **测试与真实环境完全脱节**
   - 合成数据 vs 真实数据规模差 1000 倍
   - 依赖假绿，2 用例静默跳过
   - 零跨平台权限测试

2. **架构与需求相反**
   - 用户要 AI 理解需求 → 架构屏蔽需求给 AI
   - 用户要表结构可读 → 架构把列名变 COLUMN_n
   - 用户要 spec 可读 → 通用通道可以但 listing 工具不走这条路

3. **职责倒挂**
   - AI 擅长的（理解自然语言）被禁止
   - 程序做不了的（理解中文规则）硬塞给生成器

### 用户感受的真相

**"不是这儿拦截，就是那儿脱敏"** 的真相是：
- 不是拦截太严
- 而是**基础依赖缺失 + 数据规模限制 + 临时目录污染 + 架构相反**

### 建议

**如果只有 1 天**: 修复 P0 (依赖 + ZIP 限制 + 临时目录 + ALS 解析)  
**如果有 1 周**: 完成 P0 + P1，至少让链路能跑通  
**如果要根治**: 启动 P3 架构重构，2-4 周

---

**详细分析**: 见 `CODEBASE_AUDIT_SYSTEMATIC_20260822.md`  
**Bug 清单**: 见 `REAL_BUGS_FOUND_20260822.md`
