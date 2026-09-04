# 临床 Listing 代码车道

## 固定流程

模型处理 Listing 时必须依次调用：

1. `enterprise_listing_inspect(project)`：获取 `doc/**` manifest、辅助 Excel 结构与 ALS 语义、数据集元数据。
2. `enterprise_listing_read_document(project, documentId, chunkIndex)`：从 0 到 `isFinal` 读完每个需求文件的全部分片。
3. `enterprise_listing_run_code(project, code)`：生成全部业务 Listing。
4. `enterprise_listing_publish(project, scenario)`：统一发布一个 Excel 工作簿。

## 数据角色

- rawdata：SAS/XPT/CSV，是 `datasets` 中的处理对象。
- spec/ALS：字段和业务规则，不是数据源。
- 标准范例：只定义工作簿结构和样式，不是数据源。

## 数据边界（2026-08-28 现行口径，ADR-0010）

数据安全开关由宿主设置页控制，默认开启；模型请求不能伪造。开启时红线只有两类，按项目路径与数据源头判定，不按字段名，无内容模式扫描：

- **dataset**：数据集（sas7bdat/xpt/csv，含加密归档解出）的原始行值不出域 → inspect 回执只含元数据（列名/行数/dtype/nullCount/uniqueCount），行样本默认根本不构建。
- **aux-excel**：`doc/` 外 spec 需求辅助 Excel 的业务单元格值不出域 → 回执只含结构、统计与 ALS 三元组，rows 默认根本不构建。

`project/doc/**` 是需求理解域：所有文本、Excel、模板与未知二进制文件都必须完整读取。inspect 只返回 manifest；read_document 返回 256K canonical JSON 分片，按顺序拼接并解析后无损还原。分片不是截断，也不做摘要。

开关开启时，run_code 的 stdout/stderr、动态异常文本、输出名与列名不进入回执；这些载荷可能由模型改写为数据值通道，因此回执中根本不构建。publish 回执也只含路径、场景、格式与数量。开关关闭时不做任何形式拦截，上述原始载荷照常回执。

开关开启时，通用工具出口有双层防护：调用参数中显式引用数据集/归档/doc 外辅助 Excel 文件时，monotonic guard 直接拒绝并给出改道指引（内容型参数、doc/ 与系统输出引用、enterprise_* 车道放行）；结果文本经专用扫描 Worker 的保护值精确匹配（含相邻 bigram），命中两类受保护数据值的结果整体被拦截、不进入模型上下文；未命中全放行，不做其他内容判定。扫描 Worker 与主车道计算分进程，长 run_code 不阻塞扫描。开关关闭时两道防线零处理。listing sandbox 自身保持标准 builtins、任意 import、文件 IO 与 DataFrame 读写全开。`list_files`/`scan_excel_structures` 仍限项目根内，这是便利助手契约；run_code 中的 `open`/`os` 等标准能力不受该围栏限制。doc/ 的防洗白边界：会话建立时登记 doc/ 文件指纹基线，项目原始输入直接信任；会话期间新增或被改写的 doc 文件在重装载时做保护值精确匹配，命中即剔除（PROTECTED_DOCUMENT_CONTENT）。

## AI 输出合同

代码必须定义：

```python
outputs = {
    "LISTING_AE_01": ae_listing,
    "LISTING_CM_01": cm_listing,
}

ae_listing.attrs["labels"] = {
    "USUBJID": "Subject name or identifier",
    "AETERM": "Reported Term for the Adverse Event",
}
```

- `outputs` 的每个值必须是 pandas DataFrame。
- 一次需求的所有 Listing 必须放进同一个 `outputs`。
- 不要用 `to_excel`、`ExcelWriter` 等写交付文件；中间/临时文件可自行生成。
- 发布结果始终是一个 `{SCENARIO}_LISTINGS.xlsx`。
- 可选：`attrs["_skip_default_template"] = True` 跳过审核列注入；
  `attrs["_layout"] = {header_rows, header_columns, anchor_cell, freeze_panes,
  back_link, column_widths}` 接管业务页排版（非法即发布失败）。

## 场景规则

- manual / medical：固定 `Content` 结构、RT01 业务 Sheet 样式（2 行表头：第 1 行标题/返回链接，第 2 行 Label，第 3 行起数据；不再单独展示变量名 oid），自动补齐比较审核列。
- report：固定 `Cover Page`，业务页采用 DM Status Report 范例的单层表头、行高与列宽，不补比较审核列，不展示变量名 oid。封面值可由首个 DataFrame 的 `attrs["report_metadata"]` 提供。
- rbqm：业务结构按需求生成，不强制比较审核列，但套用 RT01 视觉样式。

完整机械契约见 `docs/enterprise/LISTING_MULTI_SHEET_SPEC.md`。
