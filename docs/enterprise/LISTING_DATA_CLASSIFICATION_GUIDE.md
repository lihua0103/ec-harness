# 临床 Listing 数据识别与流程引导增强方案

## 问题现状

当前AI在处理临床listing时存在**数据对象混淆**问题：

### 三类数据的角色
1. **rawdata（原始临床数据）**：压缩包中的 .sas7bdat / .xpt 文件 ← **这才是要处理的数据**
2. **spec/ALS 文档**：规格说明文档（字段映射表）← 这是处理规则
3. **template 文档**：输出格式模板 ← 这是格式参考

**问题表现**：AI没有正确识别压缩包中的SAS数据集为rawdata，可能误以为spec文档本身就是要处理的数据。

---

## 解决方案：多层次流程引导

### 方案1：增强 inspect 响应 - 明确数据分类 ⭐⭐⭐

**修改文件**：`packages/enterprise/listing/python/worker.py`

在 `inspect` 方法的返回值中增加数据分类标记，明确告诉AI哪些是rawdata、哪些是spec文档。

**实施代码**：

```python
# 在 inspect 方法的 return 语句前增加
data_classification = {
    "rawdata": {
        "description": "原始临床数据（从压缩包或目录中加载的SAS/XPT/CSV数据集）- 这是你要处理的核心数据对象",
        "datasets": list(frames.keys()),
        "totalRows": sum(len(df) for df in frames.values()),
        "source": "压缩包解压或项目目录扫描",
        "note": "只有这里列出的数据集可以通过 datasets[名称] 访问"
    },
    "specDocuments": {
        "description": "规格说明文档 - 用于理解字段映射关系，不是要处理的数据源",
        "files": [doc["name"] for doc in documents if doc["kind"] in ["spec", "als"]],
        "purpose": "提供 mappings（sourceColumn → displayLabel）映射关系",
        "note": "spec文档不在 datasets 字典中，不能作为 DataFrame 访问"
    },
    "templateDocuments": {
        "description": "输出格式模板 - 定义最终Excel的列顺序，不是数据源",
        "files": [self.template_name] if self.template_name else [],
        "purpose": "提供输出列结构的参考"
    }
}

# 增加数据验证警告
validation_warnings = []
if not frames:
    validation_warnings.append(
        "⚠️ 未找到任何rawdata数据集！请检查：(1)压缩包是否在项目目录 (2)是否需要密码文件"
    )
if documents and not frames:
    validation_warnings.append(
        "⚠️ 找到spec文档但没有rawdata。spec不是数据源，请确认是否遗漏包含SAS数据集的压缩包。"
    )

return {
    "ok": True,
    "dataClassification": data_classification,
    "validationWarnings": validation_warnings,
    # ... 原有字段（documents, datasets, scenario等）
}
```

---

### 方案2：增强系统提示 - 数据对象识别指引 ⭐⭐⭐

**修改文件**：`packages/enterprise/listing/src/index.ts`

在现有systemPrompt之前（order: 89）增加数据分类引导。

**实施代码**：

```typescript
disposers.push(
  systemPrompt.section({
    name: 'tool:enterprise-listing-data-classification',
    order: 89,  // 在原有的 order: 90 之前
    text:
      '【重要：数据对象识别】临床 Listing 涉及三类数据，必须明确区分：\n\n' +
      
      '1. **rawdata（原始临床数据）** ← 这是你要处理和转换的核心数据\n' +
      '   • 来源：压缩包（.zip）内的 .sas7bdat / .xpt / .csv 文件\n' +
      '   • 识别：inspect 响应中 dataClassification.rawdata.datasets 数组\n' +
      '   • 访问：在 run_code 中用 datasets["数据集名"] 获取 DataFrame\n' +
      '   • 示例：ae.sas7bdat → datasets["ae"]，vs.xpt → datasets["vs"]\n\n' +
      
      '2. **spec/ALS 文档** ← 处理规则的来源，不是数据\n' +
      '   • 来源：doc/ 目录中的规格说明 .xlsx 文档\n' +
      '   • 识别：dataClassification.specDocuments.files\n' +
      '   • 作用：提供字段映射（sourceColumn → displayLabel）和需求说明\n' +
      '   • 注意：spec 文档本身不在 datasets 中，不能作为 DataFrame 访问\n\n' +
      
      '3. **template 文档** ← 输出格式参考，不是数据源\n' +
      '   • 识别：dataClassification.templateDocuments.files\n' +
      '   • 作用：定义最终输出的列顺序和表头样式\n\n' +
      
      '【正确的处理流程】\n' +
      '① inspect 后，查看 dataClassification.rawdata.datasets 确认有哪些数据集\n' +
      '② 如果 rawdata.datasets 为空但有 spec 文档，说明数据文件缺失或未正确解压\n' +
      '③ 从 spec 的 mappings 理解字段映射关系（哪些列要输出、表头叫什么）\n' +
      '④ 在 run_code 中从 datasets[名称] 读取 rawdata DataFrame 并转换\n' +
      '⑤ 调用 save_listing() 将转换后的结果输出为 Excel\n\n' +
      
      '【常见错误模式】\n' +
      '❌ 错误1：把 spec 文档当数据 - datasets["als"] 或 datasets["spec"] 不存在\n' +
      '❌ 错误2：把 template 当数据 - datasets["template"] 不存在\n' +
      '✅ 正确：只从 dataClassification.rawdata.datasets 中选择数据集名称'
  })
)
```

---

### 方案3：在 run_code 中注入辅助函数 ⭐⭐

**修改文件**：`packages/enterprise/listing/python/worker.py`

在命名空间中注入 `show_rawdata_info()` 函数。

**实施代码**：

```python
def show_rawdata_info():
    """显示当前会话中可用的原始数据集（rawdata）信息"""
    if not self.catalog:
        print("❌ 会话未初始化，请先调用 enterprise_listing_inspect")
        return
    
    frames = self.catalog.load()
    if not frames:
        print("❌ 未找到任何 rawdata 数据集")
        print("提示：rawdata 来自压缩包或项目目录中的 .sas7bdat / .xpt / .csv 文件")
        return
    
    print("=" * 60)
    print("可用的 rawdata 数据集（这些是你要处理的数据）：")
    print("=" * 60)
    for idx, (name, df) in enumerate(frames.items(), 1):
        print(f"\n{idx}. 数据集名称: {name}")
        print(f"   数据规模: {len(df)} 行 × {len(df.columns)} 列")
        print(f"   列名（前10列）: {', '.join(df.columns[:10].tolist())}")
        if len(df.columns) > 10:
            print(f"   ... 共 {len(df.columns)} 列")
    
    print("\n" + "=" * 60)
    print("使用方式: df = datasets['数据集名']")
    print("示例: ae_data = datasets['ae']")
    print("=" * 60)

# 在 run 方法的命名空间中注入
self.namespace["show_rawdata_info"] = show_rawdata_info
```

---

## 实施优先级

### 🔴 高优先级（立即实施，效果最明显）
1. **方案1**：增强 inspect 响应的数据分类标记
2. **方案2**：增强系统提示的数据对象识别指引

这两个方案直接作用于 AI 的理解层，能立即改善数据识别问题。

### 🟡 中优先级（短期实施）
3. **方案3**：注入辅助函数
4. **方案4**：强化工具描述

---

## 预期效果

实施后，AI 的处理流程应为：

```
阶段1：inspect
  AI: 调用 enterprise_listing_inspect
  响应: {
    dataClassification: {
      rawdata: {
        datasets: ["ae", "vs"],  ← AI识别：这是要处理的数据
        source: "压缩包解压"
      },
      specDocuments: {
        files: ["als.xlsx"],  ← AI识别：这是映射规则
        note: "不在 datasets 中"
      }
    },
    validationWarnings: []
  }
  
  AI理解：
  ✅ ae 和 vs 是 rawdata（压缩包中的SAS数据集）
  ✅ als.xlsx 是 spec 文档（提供字段映射）
  ✅ 我要处理的是 ae 和 vs，不是 als

阶段2：run_code
  # AI 生成的正确代码
  ae_raw = datasets['ae']  # ✅ 从 rawdata 读取
  vs_raw = datasets['vs']
  
  # 根据 spec 的 mappings 转换
  ae_output = ae_raw[['USUBJID', 'AETERM']].copy()
  save_listing('AE清单', ae_output)
```

---

## 测试验证场景

### 场景1：典型场景
- **项目结构**：doc/als.xlsx + data.zip（内含 ae.sas7bdat, vs.sas7bdat）
- **期望行为**：AI 识别 ae 和 vs 为 rawdata，als 为 spec

### 场景2：缺失数据
- **项目结构**：仅有 doc/spec.xlsx，无压缩包
- **期望行为**：validationWarnings 提示缺少 rawdata

### 场景3：加密压缩包
- **项目结构**：encrypted.zip + encrypted.txt（密码文件）
- **期望行为**：正确解压并识别为 rawdata

---

## 核心原则

**问题**：AI 混淆了 rawdata（要处理的数据）和 spec（处理规则）

**解决**：通过多层次引导明确区分三类数据的角色
- 响应结构（dataClassification）
- 系统提示（明确说明）
- 工具描述（强化角色）
- 辅助函数（运行时帮助）

**实施**：优先方案1和2，观察效果后决定是否需要方案3和4
