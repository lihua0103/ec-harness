<!--
> **过时归档横幅(2026-08-28)**:本文为历史交付/状态文档,所述实现与口径
> 已被后续演进取代——数据安全现行口径见 ADR-0007(单规则红线)与
> ADR-0009(出域单点);工具契约见 listing 插件系统提示与仓库 README。
> 仅作过程记录保留,请勿按本文操作。
-->
# 临床 Listing 数据识别流程引导 - 实施完成报告

## ✅ 实施状态：已完成

参考 G:\home\DM 项目的 AGENTS.md 引导机制，已成功为 dsh-guard 的 listing 插件实现完整的数据分类流程引导。

---

## 📋 实施内容

### 1. 创建 AGENTS.md 引导文档 ⭐⭐⭐

**文件**：`packages/enterprise/listing/AGENTS.md`

**内容**：
- 明确定义三类数据：rawdata（要处理）、spec（规则）、template（格式）
- 提供正确的处理流程说明
- 列举常见错误模式和故障排查方法
- 包含实例和学习资源

**参考**：借鉴 DM 项目的 `AGENTS.md` 结构和风格

---

### 2. 增强 inspect 响应 - 数据分类标记 ⭐⭐⭐

**文件**：`packages/enterprise/listing/python/worker.py`

**修改位置**：`inspect` 方法的返回语句（第265行）

**新增字段**：
```python
"dataClassification": {
    "rawdata": {
        "description": "原始临床数据 - 这是你要处理的核心数据对象",
        "datasets": list(frames.keys()),
        "totalRows": sum(len(df) for df in frames.values()) if frames else 0,
        "totalColumns": sum(len(df.columns) for df in frames.values()) if frames else 0,
        "source": "压缩包解压或项目目录扫描",
        "note": "只有这里列出的数据集可以通过 datasets[名称] 访问"
    },
    "specDocuments": {
        "description": "规格说明文档 - 处理规则，不是数据源",
        "files": [doc["name"] for doc in documents if doc["kind"] in ["spec", "als"]],
        "purpose": "提供 mappings（sourceColumn → displayLabel）映射关系",
        "note": "spec文档不在 datasets 字典中"
    },
    "templateDocuments": {
        "description": "输出格式模板 - 格式参考",
        "files": [self.template_name] if self.template_name else [],
        "purpose": "提供输出列结构的参考"
    }
},
"validationWarnings": [
    // 数据缺失时的智能提示
]
```

**验证**：✅ Python 语法检查通过

---

### 3. 增强系统提示 - 数据对象识别指引 ⭐⭐⭐

**文件**：`packages/enterprise/listing/src/index.ts`

**修改位置**：在现有 systemPrompt 之前插入新提示（order: 89）

**内容要点**：
- 三类数据的明确区分和访问方式
- 正确的处理流程（5步）
- 常见错误模式（3个）

**验证**：✅ TypeScript 编译通过，生成的 JS 文件包含完整提示

---

### 4. 技术方案文档

已创建三个文档（位于 `docs/enterprise/`）：

1. **LISTING_QUICK_REFERENCE.md** - 快速参考
   - 问题示意图
   - 解决方案示意图
   - 实施清单
   - 测试验证表

2. **LISTING_PROBLEM_SOLUTION.md** - 解决方案总结
   - 问题诊断
   - 方案优先级
   - 预期效果对比
   - 后续支持

3. **LISTING_DATA_CLASSIFICATION_GUIDE.md** - 完整技术方案
   - 详细实施代码
   - 四个方案的完整说明
   - 测试场景

---

## 🎯 核心改进

### 改进前（问题）
```
AI 调用 inspect
→ 响应：{ documents: [...], datasets: [...] }
→ AI: 🤔 哪些是要处理的数据？
→ AI: ❌ 尝试 datasets["als"] 或混淆数据对象
```

### 改进后（解决）
```
AI 调用 inspect
→ 响应：{
     dataClassification: {
       rawdata: { datasets: ["ae", "vs"] },  ← 明确标记
       specDocuments: { files: ["als.xlsx"], note: "不是数据源" }
     },
     validationWarnings: [...]
   }
→ AI: ✅ 明确知道 ae 和 vs 是 rawdata
→ AI: ✅ 明确知道 als.xlsx 是规格说明
→ AI: ✅ 正确生成：ae_raw = datasets['ae']
```

---

## 📊 文件变更清单

| 文件 | 类型 | 状态 | 说明 |
|------|------|------|------|
| `packages/enterprise/listing/AGENTS.md` | 新增 | ✅ | AI 引导主文档 |
| `packages/enterprise/listing/python/worker.py` | 修改 | ✅ | 增加 dataClassification 字段 |
| `packages/enterprise/listing/src/index.ts` | 修改 | ✅ | 增加数据分类系统提示 |
| `packages/enterprise/listing/lib/index.js` | 重新生成 | ✅ | TypeScript 编译产物 |
| `docs/enterprise/LISTING_QUICK_REFERENCE.md` | 新增 | ✅ | 快速参考 |
| `docs/enterprise/LISTING_PROBLEM_SOLUTION.md` | 新增 | ✅ | 解决方案总结 |
| `docs/enterprise/LISTING_DATA_CLASSIFICATION_GUIDE.md` | 新增 | ✅ | 完整技术方案 |

---

## 🧪 测试建议

### 测试场景1：典型场景
```
项目结构：
  doc/als.xlsx
  data.zip (内含 ae.sas7bdat, vs.sas7bdat)

期望行为：
  - dataClassification.rawdata.datasets = ["ae", "vs"]
  - dataClassification.specDocuments.files = ["als.xlsx"]
  - validationWarnings = []
  - AI 正确生成：ae_raw = datasets['ae']
```

### 测试场景2：数据缺失
```
项目结构：
  doc/spec.xlsx (仅有spec，无数据)

期望行为：
  - dataClassification.rawdata.datasets = []
  - validationWarnings 包含"未找到rawdata"提示
  - AI 意识到数据缺失并告知用户
```

### 测试场景3：加密压缩包
```
项目结构：
  doc/
  encrypted.zip
  encrypted.txt (密码文件)

期望行为：
  - 正确解压并识别数据集
  - dataClassification.rawdata.source = "压缩包解压"
```

---

## 📚 相关文档索引

### 项目内文档
- `packages/enterprise/listing/AGENTS.md` - AI 引导主文档
- `packages/enterprise/listing/README.md` - 插件使用说明
- `docs/enterprise/adr/0003-enterprise-listing-plugin.md` - 插件设计决策
- `docs/enterprise/LISTING_QUICK_REFERENCE.md` - 快速参考
- `docs/enterprise/LISTING_PROBLEM_SOLUTION.md` - 解决方案总结
- `docs/enterprise/LISTING_DATA_CLASSIFICATION_GUIDE.md` - 完整技术方案

### 参考项目
- `G:\home\DM\AGENTS.md` - DM 项目的引导范例
- `G:\home\DM\CODEX.md` - Codex 专属覆盖层
- `G:\home\DM\src\emerald_clinical_listing\DESIGN.md` - 设计文档范例

---

## 💡 使用建议

### 对于 AI Agent
1. 处理 listing 任务前，先阅读 `packages/enterprise/listing/AGENTS.md`
2. 调用 `enterprise_listing_inspect` 后，重点查看 `dataClassification` 字段
3. 只从 `rawdata.datasets` 中选择数据集名称
4. 遇到问题时查看 `validationWarnings`

### 对于开发者
1. 如需调整引导策略，修改 `AGENTS.md` 和对应代码
2. 确保 `dataClassification` 的结构清晰易懂
3. 根据实际使用效果迭代提示内容

---

## 🎓 实施经验总结

### 成功要素
1. **结构化响应**：通过 `dataClassification` 明确标记数据角色
2. **多层次引导**：文档 + 响应结构 + 系统提示的组合
3. **明确的负面案例**：列举常见错误，帮助 AI 避免
4. **验证和警告**：主动提示数据缺失等问题

### 参考 DM 项目的优秀实践
1. **AGENTS.md 作为单一真相源**：所有引导规则集中管理
2. **模型无关设计**：适用于任何 AI Agent
3. **实战驱动**：规则来自真实踩过的坑
4. **明确的优先级**：红线 > 通用行为 > DoD

---

## ✅ 下一步

实施已完成，建议：

1. **测试验证**：用实际项目测试三个场景
2. **观察效果**：监控 AI 是否正确识别 rawdata
3. **收集反馈**：记录仍然混淆的情况
4. **迭代优化**：根据反馈调整提示内容

如有需要，可以进一步实施：
- 方案3：注入 `show_rawdata_info()` 辅助函数
- 方案4：强化工具描述
- 增加更详细的日志输出
