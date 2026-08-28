# 临床 Listing 代码车道

## 固定流程

模型处理 Listing 时必须依次调用：

1. `enterprise_listing_inspect(project)`：读取 spec/ALS，扫描原始数据集。
2. `enterprise_listing_run_code(project, code)`：生成全部业务 Listing。
3. `enterprise_listing_publish(project, scenario)`：统一发布一个 Excel 工作簿。

## 数据角色

- rawdata：SAS/XPT/CSV，是 `datasets` 中的处理对象。
- spec/ALS：字段和业务规则，不是数据源。
- 标准范例：只定义工作簿结构和样式，不是数据源。

## 数据拦截（2026-08-28 现行口径，ADR-0007/0009）

拦截只剩一种场景，按数据源头判定，不按字段名，无模式扫描：

- **dataset**：数据集（sas7bdat/xpt/csv，含加密归档解出）的原始行值不出域 → inspect 回执只含元数据（列名/行数/dtype/nullCount/uniqueCount），行样本默认根本不构建。

其余一律不碰：**doc/ 整目录零拦截**——文本与 Excel（ALS/DVP 等）单元格值全量直通（截断上限只作协议护栏并显式标记 truncated）、run_code 的 stdout/stderr 原样、AI 产物与 publish 回执原样、错误消息原样。

通用工具（shell/文件读写）触碰数据集文件会被 tool-audit 护栏拒绝（同一开关；enterprise_* 车道豁免）。

开关是**宿主侧**的（设置页 DataSecurityService，模型不可见）：默认开、fail-closed；关闭 = 零拦截（含通用车道护栏）。sandbox 执行面按 ADR-0009 全量放开：标准 builtins、任意 import、文件 IO 与 DataFrame 读写方法都可用，且开关节不触碰执行面。`list_files`/`scan_excel_structures` 仍限项目根内，这是便利助手契约；run_code 中的 `open`/`os` 等标准能力不受该围栏限制。

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
