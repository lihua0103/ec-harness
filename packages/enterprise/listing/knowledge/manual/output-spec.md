# 输出规格（manual 场景，dsh LISTING_MULTI_SHEET_SPEC + 项目确认的用户偏好）

每次 publish 只产出一个工作簿：`<OUTPUT_STEM>_Manual Listing_<数据日期>.xlsx`
（+ 同名 RDS 供新旧比对）。

## Content 首页（第一个 sheet，固定）

- A1:G1 合并，标题 `Comparison Summary`，Times New Roman 16 加粗、**水平垂直居中**
  （2026-09-10 对齐 EDC 模板实测：center/center）。
- 第 2 行固定 7 列：`Listing Seq. / Form Name / New/Modified ? / Total / New / Modified / Old`。
- 第 3 行起每个业务 listing 一行；Form Name 为跳转该 sheet 的链接，**显示文本 =
  ALS 官方中文表名**（2026-09-10 定案：实验室类=ALS 访视表"访视内显示名称"（模块名），
  其余=ALS"表名"原样（含编号表名），合并 sheet 各名 `+` 连接；同名标题自动追加
  （sheet 名）后缀去重，与 spec Unique ID 互查）。核查节以 `LISTING_TITLES`
  （按 sheet 名键控）提供，输出循环取用、缺项回退 sheet 名。
- 首次交付 `New/Modified ?`=New，Modified/Old=0；有旧版时由 compare 结果填充。
- 冻结 A3；列宽（写入值）= 16 / 50 / 18 / 9 / 8 / 12 / 8（openxlsx 自动 +0.71）。

## 业务页（每 DVP 行一个）

- 第 1 行：A1 `go back` 返回链接；B1:F1 合并显示**中文表名页名**（与 Content
  Form Name 完全同款，含同名（sheet 名）去重后缀——由 Content 循环经 ttl 参数
  传入；缺项回退 LISTING_TITLES/sheet 名；TNR 14 加粗）。
- 第 2 行：Label 表头（变量 attr 中文标签，TNR 13 加粗、`#EDF2F9` 填充、居中、
  行高 60、自动换行；缺失回退变量名）。
- 第 3 行起数据：TNR 13、四边细边框；冻结 A3；筛选从第 2 行覆盖到末行。
- 末尾固定追加审核列：`FLAG(New/Modified/Old)`、`Update Detail`、
  `Review Comments`、`Initial/Date`（不注入空 Flag1——flag 列仅 Condition
  明确要求时存在）。
- 空 listing：写一行带边框的「无数据记录」占位行。

## 用户偏好（覆盖规范的地方）

- **网格线保持 Excel 默认显示**（规范为隐藏；已按用户要求改回，代码留注释）。
- 页名/Content Form Name **不带 `Manual_` 前缀**；RDS 对象名保留 `Manual_*`
  （兼容 compare_data）。
- 返回链接文本 **`go back`**（不是 "Content"）。

## 落盘

- xlsx/RDS → `Output/04_Out/Manual listing/`；`setwd(work_root)` 后相对路径写。
- 保存后自检：sheet 数 = listing 数 + 1，不符告警并列出全部 sheet 名。
- 日期列写前转文本（`"%Y-%m-%d %H:%M:%S"`），避免 openxlsx 数字化。

## 中心编号必须并排中心名称（2026-09-14，RBQM KRI 首用验证）

- 所有含中心编号列（SITE/SITEID/中心号）的 listing 输出，**编号右侧必须并排一列
  中心名称**（约定列名 `SITE_NAME`）；图表与汇报展示用名称，编号用于对键。
- 映射唯一权威源 = 受试者花名册（subj）的 `StudyEnvSiteNumber → Site`；
  实现：`site_map <- subj %>% distinct(StudyEnvSiteNumber, Site)`，
  `add_site_name(df) = left_join(df, site_map, by="SITE") %>% relocate(SITE_NAME, .after=SITE)`。
- 非 SAS 来源（如 Query_Details.xlsx 的 Site Number 末3位）同样用该 SAS site_map
  反查，**禁止各表各自从导出列取名**——保证跨 listing、跨文件名称一致。
- 首次实施：RBQM KRI 9 条输出（KRI_010~KRI_020）全部套用。
