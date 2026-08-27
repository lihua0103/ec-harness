# Clinical Listing 单工作簿输出规范

## 1. 规范来源与适用范围

本规范由 `CGB3002-RT01_Manual Listing_20260721(vs20260721).xlsx` 与
`file_show (6).xlsx` 两个标准范例的工作簿结构和样式提炼而来。提炼过程
只使用 Sheet 结构、标题/表头、样式、合并区域、冻结窗格、筛选和行列尺寸，
不复制范例业务数据。

- `manual`、`medical`：使用 RT01 Manual Listing 固定结构与样式。
- `report`：使用 `file_show (6).xlsx` 提炼的 DM Status Report 结构与样式。
- `rbqm`：业务列结构可按需求定义，但复用 RT01 业务 Sheet 的视觉样式。
- 每次发布只生成一个 `{SCENARIO}_LISTINGS.xlsx`。

## 2. Manual / Medical：固定 Content Sheet

首个 Sheet 固定命名为 `Content`：

- `A1:G1` 合并，标题固定为 `Comparison Summary`。
- 第 2 行固定为：
  1. `Listing Seq.`
  2. `Form Name`
  3. `New/Modified ?`
  4. `Total`
  5. `New`
  6. `Modified`
  7. `Old`
- 第 3 行起每个业务 Sheet 一行；`Form Name` 必须是跳转链接。
- 冻结窗格 `A3`，隐藏网格线。
- 固定列宽为：`16.7109375, 50.7109375, 18.7109375, 9.7109375,
  8.7109375, 12.7109375, 8.7109375`。

## 3. Manual / Medical / RBQM：动态业务 Sheet

业务 Sheet 的名称、数量和数据由 AI 根据 spec/ALS 与原始数据生成，不从
范例写死：

- 第 1 行：`A1` 为返回 `Content` 的链接；`B1:F1` 在列数允许时合并，
  显示当前 Sheet 名。
- 第 2 行：字段 Label。
- 第 3 行起：业务数据。
- 冻结窗格 `A3`；筛选从第 2 行覆盖到最后数据行；隐藏网格线。
- 不再单独展示变量名（oid）行 —— Label 行已携带业务可读语义。
- Label 由模型通过 `DataFrame.attrs["labels"]` 提供；缺失时回退到变量名。

`manual`、`medical` 自动补齐范例中的比较审核列：

| 变量名 | Label |
|---|---|
| `Flag1` | `Flag1` |
| `__cmp_FLAG__` | `FLAG(New/Modified/Old)` |
| `__cmp_UpdateDetail__` | `Update Detail` |
| `__cmp_RCcomment__` | `Review Comments` |
| `__cmp_Idate__` | `Initial/Date` |

`report`、`rbqm` 不强制这些列。

## 4. Report：DM Status Report 结构

`report` 每次仍只生成一个 `REPORT_LISTINGS.xlsx`，但不使用 `Content`：

- 首 Sheet 固定命名为 `Cover Page`。
- `A1:G1` 合并，固定标题为“数据管理状态报告 / DM Status Report”。
- 第 3–6 行固定为 Sponsor、Protocol No、WuXi Project ID、报告生成日期；
  值可由首个 DataFrame 的 `attrs["report_metadata"]` 提供，键分别为
  `sponsor`、`protocol_no`、`project_id`、`report_date`。
- 业务 Sheet 名称与列由 AI/表单数据动态生成；程序不复制范例业务数据。
- 业务 Sheet 第 1 行直接为单层字段表头，第 2 行开始写数据，冻结 `A2`，
  自动筛选覆盖表头与实际数据范围。
- 已知标准 Sheet（Matrix by Study/Site/Subject、Missing Page/Lab、UnSDV Page、
  Queries Not Resolved、All Queries Matrix by page）套用范例对应表头行高与列宽；
  其他动态 Sheet 使用同一表头样式与自适应列宽。

## 5. 场景样式

### Manual / Medical / RBQM

- `Content` 标题：Times New Roman 16，加粗；业务 Sheet 标题：Times New Roman 14，加粗。
- 变量名和 Label：Times New Roman 13，加粗，浅蓝 `#EDF2F9`，居中。
- Label 行高 60，自动换行。
- 数据：Times New Roman 13，白底，Excel 自动色细边框。
- 链接：Times New Roman 13，蓝色；Content 跳转链接带单下划线。
- 隐藏网格线。

### Report

- Cover Page：灰色 `#D9D9D9` 标题/标签区；标题宋体 16 加粗，标签宋体 14 加粗，值区微软雅黑 16 加粗。
- 业务页表头：Calibri 12 加粗，浅蓝 `#C5D9F1`，居中、自动换行，上下细边框。
- 数据：Calibri 11；业务页保留 Excel 默认网格线显示。

## 6. 运行契约

模型必须按以下顺序调用：

1. `enterprise_listing_inspect`
2. `enterprise_listing_run_code`
3. `enterprise_listing_publish`

`run_code` 必须定义非空 `outputs: dict[str, pandas.DataFrame]`。程序拒绝
`result` 兼容路径以及 `to_excel`、`ExcelWriter` 等绕过统一 Writer 的写出。
`publish` 是唯一交付路径，并以原子替换方式发布最终工作簿。
