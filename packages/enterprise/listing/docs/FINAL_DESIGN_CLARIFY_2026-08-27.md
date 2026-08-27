# 补充说明：红线精确边界 + 多场景表结构支持

> 在《临床 Listing 插件最终企业级实现方案》基础上的进一步精确化

---

## 1. 红线精确定义

### 1.1 三条边界

| 字段类别 | 是否可送 AI | 例子 |
|---|---|---|
| **结构字段**（表结构 / 文件结构 / 元数据） | ✅ 全送 | 列名 / 表头行数 / 合并单元格 / 方向 / dtype / rowCount / uniqueCount / 文件路径 |
| **数据字段**（具体值） | ❌ 全拦截 | 单元格内容 / 受试者 ID / 日期 / 姓名 / 编号 |
| **统计字段**（聚合后的去标识数字） | ✅ 允许 | min / max / nullCount / uniqueCount（去重后个数，不是值） |

### 1.2 判断口诀

> **结构识别全送，值禁出域；程序操作不受限，限制只在回执字段**。

### 1.3 三个关键澄清

1. **「原始数据」= 单元格值**（cell value）。所有数据行 / 列内容 / 日期 / 姓名 / 编号等具体值都属于「数据」，禁出域。
2. **「Excel 表结构字段」= 表的结构特征**——列名、列顺序、表头行数、表头层级、合并单元格树、数据类型、行数、命名空间、目录结构、sheet 名——属于结构，允许出域。
3. **程序行为不受限**：Worker 可以读 Excel 任何 sheet、解析任何层级、重组数据、写出新文件。**程序对 Excel 的操作完全放开**，只在「最后回执字段」上做拦截。

---

## 2. 多场景表结构识别（全送 AI）

多场景 listing 会遇到各种 Excel 表结构形态，**结构识别全送 AI**：

| 表结构形态 | 识别策略 | 送给 AI 的字段 |
|---|---|---|
| **横向表**（一行 = 一条记录，列展开） | 读第一行作列名 | `columns / rowCount / dtypes` |
| **纵向表**（一列 = 一字段，行堆叠） | 读第一列作字段名 | `rowOrientation / columnCount` |
| **多层表头**（合并单元格跨多行） | 递归读前 N 行作多级列名 | `headerRows / headerLevels / mergedCells` |
| **不规则表**（稀疏合并、跨列跨行） | 读所有合并单元格范围 | `mergedCells / sparseCells / maxRow/maxCol` |
| **跨 sheet 模板** | 读每个 sheet 的结构指纹 | `sheets[*].structure` |

---

## 3. inspect 返回结构示例

```python
{
  "inspection": {
    "datasets": [                                # sas 数据集：仅元数据
      {"name": "DM", "path": "raw/dm.sas7bdat",
       "columns": ["USUBJID", "AGE", "SEX"],     # 列名（结构）
       "rowCount": 1234,                         # 行数（结构）
       "dtypes": {"AGE": "int64"},               # 类型（结构）
       "nullCount": {"AGE": 0},                  # 统计（聚合）
       "uniqueCount": {"SEX": 2}                 # 统计（聚合，不是值）
       # 不含：sample / preview / values
      }
    ],
    "documents": [
      {"path": "spec/RT01.xlsx", "type": "als",
       "structure": {                            # Excel 表结构全识别
         "sheets": [{
           "name": "Sheet1",
           "orientation": "horizontal",
           "headerRows": 3,
           "headerLevels": 2,
           "maxRow": 1500,
           "maxColumn": 24,
           "mergedCells": ["A1:C1", "D1:F1", ...],
           "columnTree": {
             "Subject Information": ["USUBJID", "AGE", "SEX"],
             "Adverse Events": ["AETERM", "AESEV", "AESER"]
           },
           "isIrregular": True
         }]
       },
       "mappings": [...],                        # ALS 三元组（语义，不含值）
       "datasets": ["DM", "AE"]
      }
    ]
  }
}
```

---

## 4. 单向玻璃 sandbox 原语

AI 在 sandbox 内需要"看结构 + 读值"的能力来推理，但读到的值不能回到模型视野：

| 原语 | 行为 | 结果处理 |
|---|---|---|
| `inspect_doc(path, max_chars=4000)` | 读文本全文 | 结果进 stdout（被 `_sanitize_receipt` 拦截） |
| `inspect_xlsx_structure(path)` | 读 xlsx 全结构（程序读，不出值） | **结果可送 AI**（结构字段） |
| `inspect_xlsx_sheet(path, sheet, rows=0)` | `rows=0` 时只读结构；`rows>0` 时返回值 | rows>0 的值进 stdout（被拦截） |
| `list_files(project)` | 列举项目下文件 | 全送 AI（结构） |
| `inspect_pdf(path, page)` | 读 PDF 内容 | 值进 stdout（被拦截） |

**关键**：

- 程序读到的"结构"——结构字段、统计、行数、合并范围、列名、dtype——全部可送 AI
- 程序读到的"值"——单元格内容、字符串值、行数据——全部进 stdout 被拦截

---

## 5. 第 3 层拦截——字段级丢弃黑名单

```python
# 受保护的"值字段"——出现即丢弃（10 个）
_VALUE_FIELD_NAMES = {
    "sample",     # 样本数据
    "preview",    # 预览
    "head",       # 前 N 行
    "values",     # 实际值
    "data",       # 数据
    "content",    # 内容
    "rows",       # 行
    "cells",      # 单元格
    "items",      # 条目
    "records",    # 记录
}
```

**反向逻辑**：除了上述 10 个字段名，其他字段（如 `columns / rowCount / uniqueCount / dtype / structure / orientation / headerRows / mergedCells / path / mappings / datasets`）一律放行——因为它们都是结构或统计。

---

## 6. 程序操作权限（不受限）

| 操作 | 是否受限 |
|---|---|
| Worker 用 openpyxl 读 Excel 所有结构（合并 / 层级 / 公式） | ✅ 不受限 |
| Worker 用 pd.read_sas / pd.read_csv / pd.read_excel | ✅ 不受限 |
| Worker 重组数据 / 计算 / 写出 | ✅ 不受限 |
| Worker 调 tempfile.mkstemp / os.replace | ✅ 不受限 |
| Worker 调 _safe_members 做 Zip Slip 检查 | ✅ 不受限 |
| Worker 调 archive_passwords 解压 | ✅ 不受限 |
| AI 在 sandbox 内 `import os / open / pd.read_csv` | ❌ 受限（沙箱） |

**结论**：**Worker 进程对 Excel / sas / zip / 文件系统完全放开；AI 在 sandbox 内的操作受 safe_builtins 限制；回执字段受 `_VALUE_FIELD_NAMES` 黑名单限制**。

---

## 7. system prompt 必须传达的精确契约

```text
## 数据红线（精确边界）

### 结构识别——全送
- 列名 / 列顺序 / 表头行数 / 表头层级 / 合并单元格范围
- dtype / rowCount / nullCount / uniqueCount
- orientation / headerRows / isIrregular
- 文件路径 / sheet 名 / 目录结构
- ALS 三元组（datasetName / sourceColumn / label）
- 文本 spec 的 200 字 preview

### 值出域——严禁
- 单元格内容 / 字符串值 / 数值 / 日期
- 受试者 ID / 姓名 / 试验编号 / 任何 PHI
- DataFrame 的 head / sample / values / to_dict()
- 不要 print(df) / print(df.head()) / print(df.values)

### 程序操作——不受限
- 你（AI）在 sandbox 里做的事受限：safe_builtins 白名单、屏蔽 __import__/open
- Worker 进程对 Excel / sas / zip / 文件系统的操作不受限
- 但你能"读到"的值不进回执——sandbox 是单向玻璃

### 限制只在回执字段
- sample / preview / head / values / data / content / rows / cells / items / records
- 这十个字段名出现时，回执自动丢弃
- 其他结构字段一律放行

## 工作流

1. enterprise_listing_inspect：拿到数据集列结构 + spec 辅助文件结构 + 上版指纹
   → 不返回任何数据行
   → 多场景表结构（横/纵/多层/不规则）通过 structure.* 字段识别

2. enterprise_listing_run_code：在 sandbox 内写 pandas 代码
   → 可读 datasets[*] / inspect_doc() / inspect_xlsx_structure()
   → 必须定义 outputs: dict[str, DataFrame]
   → 用 df.attrs["_excel_layout"] 控制排版（不是业务定义）
   → 用 df.attrs["labels"] 提供字段 Label

3. enterprise_listing_publish：原子发布 Excel
   → 由 _excel_layout 自决样式，不写死
   → 结构指纹回执，不带数据预览
```

---

## 8. 与早期方案的关键差异（Diff）

| 维度 | 早期方案 | 最终方案（本次补充） |
|---|---|---|
| **红线定义** | "sas 数据集 / spec 辅助文件 / 原始 data" 三句话边界模糊 | 精确到「结构字段 vs 数据字段」二元区分 |
| **Excel 操作权限** | "sandbox 禁 open / __import__" | Worker 对 Excel 完全放开，仅 sandbox 受限；限制只在回执字段 |
| **多场景表结构** | 未提 | 横向 / 纵向 / 多层表头 / 不规则——全结构识别送 AI |
| **inspect_doc 原语** | 仅文本 | 增加 `inspect_xlsx_structure`（读结构可送）/ `inspect_xlsx_sheet(path, rows=0)`（行数可控） |
| **值字段黑名单** | 5 个（sample/preview/head/values/data） | 10 个（+ content/rows/cells/items/records） |
| **统计 vs 值** | 未区分 | 明确：min/max/nullCount/uniqueCount（聚合数）✅ vs 字符串值 ❌ |
| **判定口诀** | 无 | "结构识别全送，值禁出域；程序操作不受限，限制只在回执字段" |

---

## 9. 总结

补充说明把"红线"从"三类数据列表"精确化成**「结构 vs 数据」二元判定**：

- **结构识别全送**——这是 AI 推理的物质基础（不知道表结构就无法写 listing）
- **值禁出域**——这是数据安全的唯一硬约束
- **程序操作不受限**——Worker 该干的活（读 Excel / sas / 解析 / 写出）都让它干
- **限制只在回执字段**——边界清晰、可静态校验（10 个黑名单字段名）

多场景 listing 的横/纵/多层/不规则表结构属于「结构识别」场景——AI 必须看到这些才能正确生成 outputs——所以全送。