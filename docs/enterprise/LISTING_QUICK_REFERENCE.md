# 临床 Listing 数据识别问题 - 快速参考

## 问题示意图

```
当前问题：AI混淆数据对象
┌─────────────────────────────────────┐
│  项目目录                           │
│  ├── doc/                           │
│  │   ├── als.xlsx        ← spec文档 │
│  │   └── template.xlsx   ← 模板    │
│  └── data.zip                       │
│      ├── ae.sas7bdat     ← rawdata │
│      └── vs.sas7bdat     ← rawdata │
└─────────────────────────────────────┘
              ↓
        AI 调用 inspect
              ↓
    ❌ AI混淆：哪些是要处理的数据？
    - als.xlsx 是数据吗？
    - template 是数据吗？
    - ae/vs 才是数据？
```

## 解决方案示意图

```
方案：多层次引导
┌──────────────────────────────────────────┐
│ 层次1：响应结构（dataClassification）    │
│ ┌──────────────────────────────────────┐ │
│ │ rawdata: {                           │ │
│ │   datasets: ["ae", "vs"]  ← 要处理  │ │
│ │   note: "只有这些可访问"             │ │
│ │ }                                    │ │
│ │ specDocuments: {                     │ │
│ │   files: ["als.xlsx"]    ← 规则     │ │
│ │   note: "不在datasets中"            │ │
│ │ }                                    │ │
│ └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│ 层次2：系统提示（明确说明三类数据）       │
│ - rawdata ← 要处理的核心数据            │
│ - spec ← 处理规则                       │
│ - template ← 格式参考                   │
├──────────────────────────────────────────┤
│ 层次3：辅助函数（运行时帮助）             │
│ - show_rawdata_info() 显示可用数据      │
├──────────────────────────────────────────┤
│ 层次4：工具描述（强化角色说明）           │
└──────────────────────────────────────────┘
              ↓
        AI 调用 inspect
              ↓
    ✅ AI明确知道：
    - ae 和 vs 是 rawdata（要处理）
    - als.xlsx 是 spec（规则）
    - template 是格式参考
              ↓
    ✅ 正确生成代码：
       ae_raw = datasets['ae']
       vs_raw = datasets['vs']
```

## 实施清单

### 🔴 高优先级（立即实施）

- [ ] **方案1**：修改 `packages/enterprise/listing/python/worker.py`
  - 在 `inspect` 方法返回值中增加 `dataClassification` 字段
  - 增加 `validationWarnings` 字段
  - 预计修改：~30行代码

- [ ] **方案2**：修改 `packages/enterprise/listing/src/index.ts`
  - 在 `apply` 函数中增加新的 `systemPrompt.section`
  - 设置 `order: 89`（在现有提示之前）
  - 预计修改：~20行代码

### 🟡 中优先级（观察效果后决定）

- [ ] **方案3**：在 worker.py 中注入 `show_rawdata_info()` 函数
- [ ] **方案4**：强化 `enterprise_listing_inspect` 工具描述

## 测试验证表

| 场景 | 项目结构 | 期望行为 | 状态 |
|------|---------|----------|------|
| 1. 典型场景 | doc/als.xlsx + data.zip | AI识别ae/vs为rawdata | ⬜️ 待测 |
| 2. 数据缺失 | 仅doc/spec.xlsx | validationWarnings提示 | ⬜️ 待测 |
| 3. 加密压缩包 | encrypted.zip + .txt密码 | 正确解压识别 | ⬜️ 待测 |

## 预期效果对比

| 维度 | 实施前 | 实施后 |
|------|--------|--------|
| 数据识别 | ❌ 混淆rawdata和spec | ✅ 明确区分三类数据 |
| 代码生成 | ❌ datasets["als"] 错误 | ✅ datasets["ae"] 正确 |
| 用户体验 | ❌ 反复调试 | ✅ 一次成功 |

## 快速链接

- 📄 完整技术方案：`docs/enterprise/LISTING_DATA_CLASSIFICATION_GUIDE.md`
- 📋 解决方案总结：`docs/enterprise/LISTING_PROBLEM_SOLUTION.md`
- 📖 插件ADR：`docs/enterprise/adr/0003-enterprise-listing-plugin.md`

## 关键代码位置

```
packages/enterprise/listing/
├── python/
│   └── worker.py          ← 方案1：增强inspect响应
└── src/
    └── index.ts           ← 方案2：增强系统提示
```

## 一句话总结

**通过在响应中增加 `dataClassification` 结构化字段，配合系统提示明确说明，让AI清楚知道压缩包中的SAS数据集是要处理的rawdata，而spec文档只是处理规则。**
