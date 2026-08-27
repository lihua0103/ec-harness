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
- 禁止自行调用 `to_excel`、`ExcelWriter` 或生成其他 Excel。
- 发布结果始终是一个 `{SCENARIO}_LISTINGS.xlsx`。

## 场景规则

- manual / medical：固定 `Content` 结构、RT01 业务 Sheet 样式，自动补齐比较审核列。
- report：固定 `Cover Page`，业务页采用 DM Status Report 范例的单层表头、行高与列宽，不补比较审核列。封面值可由首个 DataFrame 的 `attrs["report_metadata"]` 提供。
- rbqm：业务结构按需求生成，不强制比较审核列，但套用 RT01 视觉样式。

完整机械契约见 `docs/enterprise/LISTING_MULTI_SHEET_SPEC.md`。
