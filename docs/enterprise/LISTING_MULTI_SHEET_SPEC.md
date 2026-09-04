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

`report`、`rbqm` 不强制这些列。AI 可对单个表设置
`DataFrame.attrs["_skip_default_template"] = True` 跳过审核列注入（模板
是输出标准，但不是强制；见 ADR-0005 / ADR-0020）。

## 3.1 自定义排版（`_layout`）

默认模板之外，AI 可通过 `DataFrame.attrs["_layout"]` 接管业务 Sheet 的
排版决策（样式原子不变，仍是标准字体/颜色/边框）：

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `header_rows` | int ≥ 1 | 1（无 header_columns 时） | 表头带行数 |
| `header_columns` | list[list[str]] | 无（末行回退 attrs["labels"]） | 逐行表头标签；同行同值相邻自动横向合并 |
| `anchor_cell` | [row, col]（1 基） | 表头带下一行首列 | 数据起始锚点；不得落在表头带内 |
| `freeze_panes` | str | 锚点行 | 如 "A4" |
| `back_link` | {cell, formula} / null | A1 返回 Content 链接 | 显式 null = 不写返回链接 |
| `column_widths` | list[float] | 按末行表头自适应 | 逐列宽度 |

格式非法一律发布失败（fail-closed）。带 `_layout` 的业务页在重跑
publish 时不与上一版做行级比较（无稳定回读结构），变化统计按全量新增
计入 `Content`。

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
2. `enterprise_listing_read_document`
3. `enterprise_listing_run_code`
4. `enterprise_listing_publish`

`run_code` 必须定义非空 `outputs: dict[str, pandas.DataFrame]`。`publish`
是唯一交付路径，并以原子替换方式发布最终工作簿；`to_excel`、
`ExcelWriter` 不用于交付物，中间/临时文件可自行生成。

`inspect` 返回 `doc/**` 的 requirement manifest，不直接携带需求内容。每个
文件必须从 chunk 0 读到 `isFinal`；分片按顺序拼接后 JSON parse 得到完整
需求对象。分片是协议传输单位，不是截断；全部需求分片未读完时不得
`run_code`。

## 7. 数据边界（2026-08-28 现行口径，ADR-0010）

读取层永远全量；拦截只发生在回执出口。数据安全开关由宿主设置页控制，
默认开启，关闭后零拦截。开启时判据是项目路径与数据源头，不是字段名，
也没有内容模式扫描：

| 场景 | 源头（`_source`） | 回执形态 |
|---|---|---|
| 数据集原始行值 | `dataset` | 元数据：名称/路径/列名/行数/dtype/nullCount/uniqueCount；行样本默认不构建 |
| doc 外辅助 Excel 单元格值 | `aux-excel` | 结构、统计与 ALS 三元组；rows 默认不构建 |
| doc 所有文件 | `spec-document` | manifest 后经 read_document 全量分片，无损还原 |
| AI 产物 | `model-output` | 只含输出数量、行数、列数、dtype 与空值统计 |

- 开关开启时，run_code 的 stdout/stderr、动态异常文本、输出名与列名不进入
  回执；publish 回执不携带 sheet 名。开关关闭时这些原始载荷照常返回，且
  tool-audit 零拦截。
- 模型请求没有开关旗标；TS 入口只把宿主 `isEnabled()` 结果作为内部
  `hostDataInterception` 下发 Worker，伪造 `dataInterception=false` 无效。
- sandbox 执行面按 ADR-0009/0010 全量放开：标准 builtins、任意 import、
  文件 IO 与 `read_*/to_*` 均不受数据边界限制；`list_files`/
  `scan_excel_structures` 仅作为便利助手保留项目根围栏。通用工具的动态
  绕过由 tool-audit 在开关开启且受保护的项目内封堵。
- 投影发生时写 `.clinical-listing/audit.jsonl`（无数据值：时间/操作/被投影
  载荷的 source 与 path）。
