# 临床 Listing 数据识别问题解决方案总结

## 📋 问题诊断

您提出的核心问题：

> "当前AI识别时，没有正确将压缩包SAS数据集识别为rawdata，当前处理的除了spec提到的辅助data数据，实际是针对rawdata数据集处理。这个是否能够引进流程引导？"

**问题本质**：AI混淆了三类数据的角色
- ❌ 把压缩包中的 .sas7bdat/.xpt 文件（rawdata）误认为是辅助数据
- ❌ 可能把 spec/ALS 文档（规格说明）误认为是要处理的数据
- ❌ 没有明确区分"要处理的数据"和"处理规则"

---

## ✅ 解决方案

已创建完整的**多层次流程引导方案**，文档位置：
**`docs/enterprise/LISTING_DATA_CLASSIFICATION_GUIDE.md`**

### 核心思路

通过**四个层次**的引导机制，明确区分三类数据：

1. **rawdata（原始临床数据）**
   - 来源：压缩包中的 .sas7bdat / .xpt / .csv 文件
   - 角色：这是AI要处理和转换的核心数据对象
   - 访问：datasets["数据集名"]

2. **spec/ALS 文档**
   - 来源：doc/ 目录中的规格说明文档
   - 角色：提供字段映射关系（处理规则）
   - 注意：不是数据源，不在 datasets 中

3. **template 文档**
   - 来源：doc/ 中的输出格式模板
   - 角色：定义输出列顺序和样式
   - 注意：不是数据源

---

## 🎯 方案优先级

### 🔴 高优先级（建议立即实施）

#### 方案1：增强 inspect 响应 - 明确数据分类
**文件**：`packages/enterprise/listing/python/worker.py`

在 `inspect` 方法的返回值中增加：
```python
return {
    "ok": True,
    "dataClassification": {
        "rawdata": {
            "description": "原始临床数据 - 这是你要处理的核心数据对象",
            "datasets": list(frames.keys()),  # 明确列出可用数据集
            "note": "只有这里的数据集可以通过 datasets[名称] 访问"
        },
        "specDocuments": {
            "description": "规格说明文档 - 处理规则，不是数据源",
            "files": [...],
            "note": "spec文档不在 datasets 中"
        },
        "templateDocuments": {...}
    },
    "validationWarnings": [...]  # 数据缺失时提示
}
```

#### 方案2：增强系统提示 - 数据对象识别指引
**文件**：`packages/enterprise/listing/src/index.ts`

在 order: 89 位置增加系统提示：
```typescript
systemPrompt.section({
  name: 'tool:enterprise-listing-data-classification',
  order: 89,
  text:
    '【重要：数据对象识别】\n' +
    '1. rawdata（原始临床数据）← 这是你要处理的核心数据\n' +
    '   识别：dataClassification.rawdata.datasets\n' +
    '   访问：datasets["数据集名"]\n' +
    '2. spec/ALS 文档 ← 处理规则，不是数据\n' +
    '   注意：不在 datasets 中\n' +
    '【常见错误】\n' +
    '❌ datasets["als"] 不存在\n' +
    '✅ 只从 rawdata.datasets 中选择'
})
```

### 🟡 中优先级（短期实施）

#### 方案3：注入辅助函数
在 `run` 方法中增加 `show_rawdata_info()` 函数，让AI可以查看可用数据集。

#### 方案4：强化工具描述
在 `enterprise_listing_inspect` 的 description 中明确说明三类数据角色。

---

## 📊 预期效果

### 实施前（当前问题）
```
AI: 调用 inspect
响应: { documents: [...], datasets: [...] }  # 不够明确
AI: 🤔 哪些是要处理的数据？spec 是数据吗？
AI: ❌ 尝试 datasets["als"] 或混淆数据对象
```

### 实施后（期望行为）
```
AI: 调用 inspect
响应: {
  dataClassification: {
    rawdata: { datasets: ["ae", "vs"] },  # ← 明确标记
    specDocuments: { files: ["als.xlsx"], note: "不是数据源" }
  }
}
AI: ✅ 明确知道：ae 和 vs 是要处理的 rawdata
AI: ✅ 明确知道：als.xlsx 是规格说明，不是数据
AI: ✅ 正确生成：ae_raw = datasets['ae']
```

---

## 🧪 测试验证

建议用以下场景测试效果：

### 场景1：典型场景
- 项目：doc/als.xlsx + data.zip（含ae.sas7bdat）
- 期望：AI 识别 ae 为 rawdata，als 为 spec

### 场景2：数据缺失
- 项目：仅 doc/spec.xlsx
- 期望：validationWarnings 提示"未找到rawdata"

### 场景3：加密压缩包
- 项目：encrypted.zip + encrypted.txt（密码）
- 期望：正确解压并识别

---

## 📚 相关文档

- **完整方案**：`docs/enterprise/LISTING_DATA_CLASSIFICATION_GUIDE.md`（本文档）
- **ADR-0003**：`docs/enterprise/adr/0003-enterprise-listing-plugin.md`（插件设计决策）
- **插件README**：`packages/enterprise/listing/README.md`（使用说明）

---

## 💡 实施建议

1. **立即实施方案1和2**（高优先级）
   - 修改 worker.py 的 inspect 返回值
   - 修改 index.ts 的系统提示

2. **观察AI行为变化**
   - 是否正确识别 rawdata
   - 是否还会混淆 spec 和 template

3. **根据效果决定是否需要方案3和4**
   - 如果问题基本解决，可暂缓
   - 如果仍有混淆，继续实施

---

## 🎯 核心价值

**问题**：AI 混淆数据对象，不知道要处理什么

**解决**：通过结构化响应 + 系统提示，明确告诉AI：
- 什么是要处理的数据（rawdata）
- 什么是处理规则（spec）
- 什么是格式参考（template）

**效果**：AI 能正确识别并处理压缩包中的SAS数据集（rawdata）

---

## 📞 后续支持

如果实施后仍有问题，可以考虑：
- 在 catalog.py 中增加日志输出
- 在工具回执中增加更明确的提示
- 考虑将 `datasets` 改名为 `rawdata_datasets`（破坏性变更）
