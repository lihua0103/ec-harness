# 百奥知 EDC 比对导出 Excel 模板（manual/medical listing 标准载体）

来源：示例项目 EDC 导出 `test.xlsx` 实测（2026-09-10，仅读取表头结构，未读数据行）。
适用：百奥知（BioKnow/Boent eClinical）系统的 manual listing 与 medical listing 两种场景——
两者共用同一套导出模板，差别只在表单集合与审阅方（DM/数统 vs 医学），结构层面完全一致。
同系统下一个项目直接按本文识别与套用，不必重新探测。

## 1. 工作簿结构

- 第一个 sheet 恒为 `Content`（比对汇总页），首格标题 `Comparison Summary`（粗体 16，
  填充 `#EDF2F9`，冻结 `A3`）；后续一个表单一个 sheet，
  **sheet 名 = 表单 OID 代码**（SUBJECT/SV/IC/DM/IE/AE/CM/LB…），
  同域多表用数字后缀区分（VS1~VS6、PC1~PC5、LB3/LB5/LB11~LB14、DS1、PE1、TANNER1）。
- sheet 顺序 = CRF 页顺序（受试者→访视→知情→入排→病史/用药→体征/检查→实验室→
  给药/采样→AE/CM→结束/死亡/随机→筛选期变体）。

### Content 页七列清单（固定）

| # | 列头 | 内容 |
|---|---|---|
| 1 | Listing Seq. | listing 序号 |
| 2 | Form Name | `=HYPERLINK("#'<sheet>'!A1","<表单中文名>")` 内链 |
| 3 | New/Modified ? | sheet 级状态（`New` / `New/Modified` / …） |
| 4 | Total | 该表单总记录数 |
| 5 | New | 新增数 |
| 6 | Modified | 修改数 |
| 7 | Old | 未变数 |

每表单一行，Total = New+Modified+Old（与表单 sheet 的 `__cmp_FLAG__` 计数对账）。

### Form Name 命名方式（模板实证，2026-09-10 用户确认为标准）

1. **中文业务名直名**，无前缀代码（受试者信息/访视日期/人口统计学…）；
2. **问询页/访问页形态**：`表单名+问询页`（既往病史问询页/不良事件询问页）——同一表单
   的入口页与记录页分列；
3. **同名表单挂不同访视**：`表单名（限定词）`（身高（筛选期）/生命体征（筛选期））或
   `表单名+数字`（PK血样采集1）——**以该项目数据库定义的官方表名为准，程序不自造
   限定词**（HXN6005 UAT 1.0 官方为编号式：生命体征1/2/3 等）；
4. **同系列分组命名**：`缩写+血样采集`（PK/PD/ADA血样采集）。
   自建 listing Content 的配套口径：多表单合并 sheet = 各官方名 `+` 连接；同一表单多条
   spec 需求 = 官方名（sheet 名代码）后缀去重；实验室模块表 = 访视表"访视内显示名称"。
   显示名一律 ALS 官方词汇，零自造。

## 2. 表单 sheet 三行表头布局（固定，全 sheet 一致）

| 行 | 内容 | 样式 |
|---|---|---|
| 第 1 行 | col1 = `=HYPERLINK("#'Content'!A1","Go back")` 返回链接；col2 起 = 表单中文名（合并单元格） | 链接：蓝色 13 下划线；标题：粗体 14、填充 `#EDF2F9` |
| 第 2 行 | **OID 变量名**（SITEID/SUBJID/BRTHDAT…） | 粗体 13、填充 `#EDF2F9`、细边框、居中 |
| 第 3 行 | **中文显示名**（中心编号/受试者编号/出生日期…） | 同上 + 自动换行、行高 60 |
| 第 4 行起 | 数据行 | 冻结 `A4`；着色按 §6 比对规则 |

读取约定：程序读表头用第 2 行定位列（OID 稳定），显示名取第 3 行；数据一律从第 4 行起。

## 3. 系统固定列（同系统可复用的模板骨架）

每个表单 sheet 的列 = **前列系统键 + 业务列（ALS 决定）+ 尾部比对四列**：

- **前列系统键**（业务列之前，逐 sheet 略有差别，见附录）：
  - 非访视表（SUBJECT）：`SITEID/SUBJID/STATUS/TNAME…` 系统标识组；
  - 访视表（绝大多数）：`STUDYCODE(部分表)/SITEID/SUBJID/STATUS/VISITNAME/SVNUM/TNAME`；
  - `VISITNAME/SVNUM` 存 OID 编码，另带镜像列 `VISITNAME_OID/SVNUM_OID`（第 3 行显示名
    直接写 OID 本身，不翻译）。
- **尾部比对四列**（所有 sheet 恒定收尾，DM/Medical 审阅工作列）：

| OID（第 2 行） | 显示名（第 3 行） | 用途 |
|---|---|---|
| `__cmp_FLAG__` | FLAG(New/Modified/Old) | 新旧导出比对标记 |
| `__cmp_UpdateDetail__` | Update Detail | 变更明细 |
| `__cmp_RCcomment__` | Review Comments | 审阅意见 |
| `__cmp_Idate__` | Initial/Date | 签名缩写/日期 |

## 4. 列显示口径（重要，勿混）

- 导出模板第 3 行的中文显示名 = **EDC 系统自己的显示口径**，供 DM 在导出上直接核对；
- R listing 交付的**列集合/显示名/列序仍按 ALS（数据库定义 xlsx）处理**
（见 `edc-baiaozhi.md` §9，用户已定口径）；本模板不替代 ALS，
它的价值是：前列系统键 + Content 结构 + 尾部审阅四列这套**系统级骨架**可直接复用。

## 5. 下次同系统项目的接法

1. 拿到导出先认骨架：Content 首页 + sheet 名=表单 OID + 三行表头 + `__cmp_` 尾四列，
   四特征齐全即判定百奥知导出，直接套本模板；
2. 固定列（前列键组/`_OID` 镜像/尾部四列）照抄；业务列集合按该项目 ALS 推导，不抄示例清单；
3. 生成/比对 listing 时以第 2 行 OID 对齐数据集列，第 3 行仅作显示名参考；
4. `__cmp_` 四列是审阅工作列，程序产出 listing 时不自动填值（留给 DM/Medical 人工）。

## 6. 新旧比对逻辑与着色规格（公共，直接套用）

比对语义（键 = 前列系统键 + RECORDID/SUBTRID/CSN，旧快照 vs 新导出）：

| FLAG | 判定 | 着色（实测 hex） |
|---|---|---|
| `New` | 键在新导出、不在旧快照 | **整行**淡紫 `#CCCCFF`（含 `__cmp_` 尾列） |
| `Modified` | 键两侧都有、业务列有变化 | **仅变更单元格**青色 `#33FFFF`，行内其余白 |
| `Old` | 键两侧都有、无变化 | 不着色（白） |

- Modified 的着色粒度是**单元格级**（实测：SUBJECT 4 行仅 `STATUS` 单列变色；
  AE 一行 20 列联动变色 = AETERM + 其 MedDRA 编码伴随列整组）——比对实现必须输出
  "行级 flag + 列级变更集"两层数据，只做行级会丢变更定位。
- 变更集判定要用 OID 层（第 2 行）对齐新旧列，不能用显示名（中文显示名可能重名）。
- sheet 级 `New/Modified ?`（Content 第 3 列）= 该 sheet 是否含 New/Modified 记录的
  汇总标记；Total/New/Modified/Old 四计数与行级 flag 对账。
- 编码列成组联动：`AETERM` 变更时其编码伴随列（`_term/_lltnamecn/_lltnameen/_lltcode/
  _ptnamecn/_ptnameen/_ptcode/_hlt…/_hlgt…/_socnamecn/_socnameen/_socCode/_primarysoccfg/
  _codingdict/_ver`，MedDRA LLT→PT→HLT→HLGT→SOC 全层级 + 字典版本）一起变——
  这是 medical 场景编码复核的形态基础，比对/核对时当一组看。

## 7. 公共函数资产（已抽取，直接引用）

`assets/cmp_export.R`（openxlsx）——与本模板一一对应的可复用函数库：

- `cmp_diff(old, new, keys)`：行级 flag（New/Modified/Old）+ 列级变更集（返回
  list(flag=, changed_cols=)），Modified 的 changed_cols 用于单元格级着色；
- `cmp_export_sheet(wb, sheet_name, title, oid, cn, data, diff)`：按 §2/§6 规格写一个
  表单 sheet（三行表头、Go back 链接、冻结 A4、标签行高 60 换行、`__cmp_` 尾四列、
  New 整行紫 / Modified 变更格青）；
- `cmp_export_content(wb, summaries)`：Content 汇总页（七列清单 + 表单内链 + 计数对账）。

用法：`source` 后三函数串起来即可产出与 EDC 导出同构的比对工作簿；也可只调
`cmp_diff()` 拿 flag/变更集，配 Rcompare 流程（`edc-baiaozhi.md` §8）用。
openxlsx 注意：颜色带 `#`、`createStyle` 无 underline 参数、`writeFormula` 会自动补
等号（HYPERLINK 公式别自己带 `=`）。
验证注意：openxlsx 产物每个 sheet 的 rels 里带未引用的 `drawing/vmlDrawing` 占位
（Excel 正常打开），但 openpyxl 读取会 `KeyError: xl/drawings/drawing1.xml`——
程序化校验前须把这两类 Relationship 从 `xl/worksheets/_rels/*.rels` 剥掉。
已在合成数据上端到端验证（2026-09-10：比对语义/着色/Content 页全 PASS）。

## 附录：示例项目全量表头清单（仅表头，无数据）

说明：业务列部分是**该项目**的表单定义，只作形态参考；同系统新项目业务列以 ALS 为准。

### Content — 比对汇总页（Comparison Summary）

列数 7，结构见 §1 的七列清单；行 = 每表单一行（序号/内链/状态/四计数）。
冻结 A3，首行标题粗体 16 填充 `#EDF2F9`。

### SUBJECT — 受试者信息

列数 15

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | SITEID | 中心编号 | 前列系统键 |
| 2 | SUBJID | 受试者编号 | 前列系统键 |
| 3 | STATUS | 受试者状态 | 前列系统键 |
| 4 | TNAME | 表名称 | 前列系统键 |
| 5 | STUDYID | 研究代码 | 业务列 |
| 6 | SITENAME | 中心名称 | 业务列 |
| 7 | SUBJINIT | 姓名缩写 | 业务列 |
| 8 | SSUBJID | 受试者筛选号 | 业务列 |
| 9 | COUNTRY | 国家 | 业务列 |
| 10 | USUBJID | 唯一受试者代码 | 业务列 |
| 11 | DSTTYPE | 试验阶段 | 业务列 |
| 12 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 13 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 14 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 15 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### SV — 访视日期

列数 14

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | VISDAT | 访视日期 | 业务列 |
| 9 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 10 | SVNUM_OID | SVNUM_OID | 系统列 |
| 11 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 12 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 13 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 14 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### IC — 签署知情同意书

列数 15

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | ICDAT | 知情同意书签署日期 | 业务列 |
| 9 | ICFVERID | 知情同意书版本号 | 业务列 |
| 10 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 11 | SVNUM_OID | SVNUM_OID | 系统列 |
| 12 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 13 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 14 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 15 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### DM — 人口统计学

列数 18

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | BRTHDAT | 出生日期 | 业务列 |
| 9 | AGE | 年龄（岁） | 业务列 |
| 10 | SEX | 性别 | 业务列 |
| 11 | ETHNIC | 民族 | 业务列 |
| 12 | ETHNICOT | 其他，请描述 | 业务列 |
| 13 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 14 | SVNUM_OID | SVNUM_OID | 系统列 |
| 15 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 16 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 17 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 18 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### IE — 入选和排除标准

列数 22

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | IEYN | 受试者是否符合所有入选标准，且不符合所有排除标准的要求？ | 业务列 |
| 9 | IEPRTVER | 方案版本号 | 业务列 |
| 10 | DSFYN | 受试者是否筛选成功？ | 业务列 |
| 11 | DSDECOD | 筛选失败原因 | 业务列 |
| 12 | DSDECODO | 其他，请说明 | 业务列 |
| 13 | SUBTRID | 子表记录ID | 系统列 |
| 14 | CSN | 序号 | 系统列 |
| 15 | IECAT | 若否，请选择不符合的入选标准或符合的排除标准 | 业务列 |
| 16 | IETESTCD | 入选/排除标准编号 | 业务列 |
| 17 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 18 | SVNUM_OID | SVNUM_OID | 系统列 |
| 19 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 20 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 21 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 22 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### RIE — 入组资格确认

列数 14

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | RIEYN | 是否进行入组资格确认？ | 业务列 |
| 9 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 10 | SVNUM_OID | SVNUM_OID | 系统列 |
| 11 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 12 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 13 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 14 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### IE1 — 入选排除标准再次确认

列数 14

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | IEREYN1 | 是否再次确认入选和排除标准？ | 业务列 |
| 9 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 10 | SVNUM_OID | SVNUM_OID | 系统列 |
| 11 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 12 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 13 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 14 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### MHYN — 既往病史问询页

列数 14

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | MHYN | 受试者是否有既往和/或伴随的病史？ | 业务列 |
| 9 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 10 | SVNUM_OID | SVNUM_OID | 系统列 |
| 11 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 12 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 13 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 14 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### MH — 既往病史

列数 40

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | SN | 序号 | 业务列 |
| 9 | MHTERM | 疾病名称 | 业务列 |
| 10 | MHTERM_term | Verbatims | 业务列 |
| 11 | MHTERM_lltnamecn | LLT_CN | 业务列 |
| 12 | MHTERM_lltnameen | LLT_EN | 业务列 |
| 13 | MHTERM_lltcode | LLT Code | 业务列 |
| 14 | MHTERM_ptnamecn | PT_CN | 业务列 |
| 15 | MHTERM_ptnameen | PT_EN | 业务列 |
| 16 | MHTERM_ptcode | PT Code | 业务列 |
| 17 | MHTERM_hltnamecn | HLT_CN | 业务列 |
| 18 | MHTERM_hltnameen | HLT_EN | 业务列 |
| 19 | MHTERM_hltcode | HLT Code | 业务列 |
| 20 | MHTERM_hlgtnamecn | HLGT_CN | 业务列 |
| 21 | MHTERM_hlgtnameen | HLGT_EN | 业务列 |
| 22 | MHTERM_hlgtcode | HLGT Code | 业务列 |
| 23 | MHTERM_socnamecn | SOC_CN | 业务列 |
| 24 | MHTERM_socnameen | SOC_EN | 业务列 |
| 25 | MHTERM_socCode | SOC Code | 业务列 |
| 26 | MHTERM_primarysoccfg | Primary SOC | 业务列 |
| 27 | MHTERM_note | Query | 业务列 |
| 28 | MHTERM_codingdict | Dictionary Name | 业务列 |
| 29 | MHTERM_ver | Dictionary Version | 业务列 |
| 30 | MHSTDAT | 开始日期 | 业务列 |
| 31 | MHONGO | 是否持续 | 业务列 |
| 32 | MHENDAT | 结束日期 | 业务列 |
| 33 | MHCMYN | 是否正在接受药物治疗？ | 业务列 |
| 34 | MHPRYN | 是否正在接受非药物治疗？ | 业务列 |
| 35 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 36 | SVNUM_OID | SVNUM_OID | 系统列 |
| 37 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 38 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 39 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 40 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### MH1 — 过敏史

列数 19

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | MH1YN | 受试者是否有过敏史？ | 业务列 |
| 9 | SUBTRID | 子表记录ID | 系统列 |
| 10 | CSN | 序号 | 系统列 |
| 11 | MHCAT | 过敏原类别 | 业务列 |
| 12 | MHCONTRT | 若为药物过敏，请填入名称 | 业务列 |
| 13 | MH1TERM | 若为其他物质，请填入名称 | 业务列 |
| 14 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 15 | SVNUM_OID | SVNUM_OID | 系统列 |
| 16 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 17 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 18 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 19 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PR — 既往手术史

列数 39

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PRYN | 受试者是否有手术史？ | 业务列 |
| 9 | SUBTRID | 子表记录ID | 系统列 |
| 10 | CSN | 序号 | 系统列 |
| 11 | PRTRT | 手术名称 | 业务列 |
| 12 | PRTRT_term | Verbatims | 业务列 |
| 13 | PRTRT_lltnamecn | LLT_CN | 业务列 |
| 14 | PRTRT_lltnameen | LLT_EN | 业务列 |
| 15 | PRTRT_lltcode | LLT Code | 业务列 |
| 16 | PRTRT_ptnamecn | PT_CN | 业务列 |
| 17 | PRTRT_ptnameen | PT_EN | 业务列 |
| 18 | PRTRT_ptcode | PT Code | 业务列 |
| 19 | PRTRT_hltnamecn | HLT_CN | 业务列 |
| 20 | PRTRT_hltnameen | HLT_EN | 业务列 |
| 21 | PRTRT_hltcode | HLT Code | 业务列 |
| 22 | PRTRT_hlgtnamecn | HLGT_CN | 业务列 |
| 23 | PRTRT_hlgtnameen | HLGT_EN | 业务列 |
| 24 | PRTRT_hlgtcode | HLGT Code | 业务列 |
| 25 | PRTRT_socnamecn | SOC_CN | 业务列 |
| 26 | PRTRT_socnameen | SOC_EN | 业务列 |
| 27 | PRTRT_socCode | SOC Code | 业务列 |
| 28 | PRTRT_primarysoccfg | Primary SOC | 业务列 |
| 29 | PRTRT_note | Query | 业务列 |
| 30 | PRTRT_codingdict | Dictionary Name | 业务列 |
| 31 | PRTRT_ver | Dictionary Version | 业务列 |
| 32 | PRSTDAT | 手术日期 | 业务列 |
| 33 | PRREAS | 手术原因 | 业务列 |
| 34 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 35 | SVNUM_OID | SVNUM_OID | 系统列 |
| 36 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 37 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 38 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 39 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### VS1 — 出生体重和身长

列数 17

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | VS1PERF1 | 是否收集出生体重和身长？ | 业务列 |
| 9 | VSREASND | 否，请说明原因 | 业务列 |
| 10 | WTBTH | 出生体重（Kg） | 业务列 |
| 11 | HTBTH | 出生身长（cm） | 业务列 |
| 12 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 13 | SVNUM_OID | SVNUM_OID | 系统列 |
| 14 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 15 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 16 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 17 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### TANNER — Tanner阶段评估

列数 17

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | TNYN | 是否进行Tanner阶段评估？ | 业务列 |
| 9 | TANREAS | 否，请说明原因 | 业务列 |
| 10 | TNDAT | 评估日期 | 业务列 |
| 11 | TNSTAGE | Tanner 阶段 | 业务列 |
| 12 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 13 | SVNUM_OID | SVNUM_OID | 系统列 |
| 14 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 15 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 16 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 17 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### VS — 生命体征

列数 28

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | VSPERF | 是否采集生命体征数据？ | 业务列 |
| 9 | VSREASN | 否，请说明原因 | 业务列 |
| 10 | SUBTRID | 子表记录ID | 系统列 |
| 11 | CSN | 序号 | 系统列 |
| 12 | VSTEST | 检查项目 | 业务列 |
| 13 | VSSTAT | 未做 | 业务列 |
| 14 | VSREASND | 若未做，请说明原因 | 业务列 |
| 15 | VSDAT | 测量日期 | 业务列 |
| 16 | VSTIM | 测量时间 | 业务列 |
| 17 | VSORRES | 结果 | 业务列 |
| 18 | VSCLSIG | 临床意义 | 业务列 |
| 19 | VSCSCAT | 若异常有临床意义，请选择分类 | 业务列 |
| 20 | VSMHNO | 对应的既往/伴随疾病史 | 业务列 |
| 21 | VSAENO | 对应的不良事件名称 | 业务列 |
| 22 | VSDESC | 其他，请说明 | 业务列 |
| 23 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 24 | SVNUM_OID | SVNUM_OID | 系统列 |
| 25 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 26 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 27 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 28 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### VS2 — 身高

列数 20

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | VSPERF | 是否采集身高？ | 业务列 |
| 9 | VSREASND | 否，请说明原因 | 业务列 |
| 10 | VSDAT | 测量日期 | 业务列 |
| 11 | HEIGHT2 | 身高第一次测量（cm） | 业务列 |
| 12 | HEIGHT3 | 身高第二次测量（cm） | 业务列 |
| 13 | HEIGHT4 | 身高第三次测量（cm） | 业务列 |
| 14 | HEIGHT | 平均身高（cm） | 业务列 |
| 15 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 16 | SVNUM_OID | SVNUM_OID | 系统列 |
| 17 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 18 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 19 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 20 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### VS3 — 身高（筛选期）

列数 24

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | VSPERF | 是否采集身高？ | 业务列 |
| 9 | VSREASND | 否，请说明原因 | 业务列 |
| 10 | VSDAT | 测量日期 | 业务列 |
| 11 | HEIGHT1 | 身高第一次测量(cm) | 业务列 |
| 12 | HEIGHT2 | 身高第二次测量(cm) | 业务列 |
| 13 | HEIGHT3 | 身高第三次测量(cm) | 业务列 |
| 14 | HEIGHT | 平均身高(cm) | 业务列 |
| 15 | HEIGHT4 | 目标身高(cm) | 业务列 |
| 16 | HEIGHTS | 筛选前6-18个月的身高(cm) | 业务列 |
| 17 | VS3DAT | 筛选前6-18个月的身高检查日期 | 业务列 |
| 18 | AHV | AHV | 业务列 |
| 19 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 20 | SVNUM_OID | SVNUM_OID | 系统列 |
| 21 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 22 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 23 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 24 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### VS4 — 体重

列数 17

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | VS4PERF | 是否采集体重？ | 业务列 |
| 9 | VSREASND | 否，请说明原因 | 业务列 |
| 10 | VSDAT | 测量日期 | 业务列 |
| 11 | WEIGHT | 体重 | 业务列 |
| 12 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 13 | SVNUM_OID | SVNUM_OID | 系统列 |
| 14 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 15 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 16 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 17 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### VS5 — 体重（筛选期）

列数 18

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | VS4PERF | 是否采集体重？ | 业务列 |
| 9 | VSREASND | 否，请说明原因 | 业务列 |
| 10 | VSDAT | 测量日期 | 业务列 |
| 11 | WEIGHT | 体重(Kg) | 业务列 |
| 12 | BMI | 体重指数BMI(Kg/m^2) | 业务列 |
| 13 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 14 | SVNUM_OID | SVNUM_OID | 系统列 |
| 15 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 16 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 17 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 18 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PE — 体格检查

列数 26

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PEPERF | 是否进行了体格检查？ | 业务列 |
| 9 | PEREASND | 否，请说明原因 | 业务列 |
| 10 | PEDAT | 检查日期 | 业务列 |
| 11 | SUBTRID | 子表记录ID | 系统列 |
| 12 | CSN | 序号 | 系统列 |
| 13 | PETEST | 检查名称 | 业务列 |
| 14 | PESTAT | 未做 | 业务列 |
| 15 | PESTA_1 | 未做_未做 | 业务列 |
| 16 | PERES | 检查结果 | 业务列 |
| 17 | PEDESC | 异常，请描述 | 业务列 |
| 18 | PECSCAT | 异常有临床意义，请选择分类 | 业务列 |
| 19 | PEMHNO | 对应的既往/伴随疾病史 | 业务列 |
| 20 | PEAENO | 对应的不良事件名称 | 业务列 |
| 21 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 22 | SVNUM_OID | SVNUM_OID | 系统列 |
| 23 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 24 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 25 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 26 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### BA — 骨龄

列数 24

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | BAYN | 是否进行了骨龄测量？ | 业务列 |
| 9 | BAREAS | 否，请说明原因 | 业务列 |
| 10 | SUBTRID | 子表记录ID | 系统列 |
| 11 | CSN | 序号 | 系统列 |
| 12 | BADAT | 测量日期 | 业务列 |
| 13 | BAMETHOD | 测量方法 | 业务列 |
| 14 | BAMETHOT | 其他，请描述 | 业务列 |
| 15 | BAMETHDR | 读片方法 | 业务列 |
| 16 | BAMETDRO | 其他读片方法，请描述 | 业务列 |
| 17 | BARES | 骨龄测量值(岁） | 业务列 |
| 18 | BARES1 | 骨龄测量值(月) | 业务列 |
| 19 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 20 | SVNUM_OID | SVNUM_OID | 系统列 |
| 21 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 22 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 23 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 24 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### MRI — MRI

列数 18

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | MRIPERF | 是否进行了MRI？ | 业务列 |
| 9 | MRIREAS | 否，请说明原因 | 业务列 |
| 10 | MRIDAT | 检查日期 | 业务列 |
| 11 | MRIRES | 检查结果 | 业务列 |
| 12 | MRIDESC | 异常，请描述 | 业务列 |
| 13 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 14 | SVNUM_OID | SVNUM_OID | 系统列 |
| 15 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 16 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 17 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 18 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### EG — 12导联心电图

列数 24

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | EGPERF | 是否进行了ECG检查？ | 业务列 |
| 9 | EGREASND | 否，请说明原因 | 业务列 |
| 10 | EGDAT | 检查日期 | 业务列 |
| 11 | EGTIM | 检查时间 | 业务列 |
| 12 | EGHR | 心率(bpm) | 业务列 |
| 13 | EGPR | PR间期(msec) | 业务列 |
| 14 | EGQRS | QRS间期(msec) | 业务列 |
| 15 | EGQT | QT间期(msec) | 业务列 |
| 16 | EGQTC | QTcF间期(msec) | 业务列 |
| 17 | EGCLSIG | 研究者对于心电图结果的判断 | 业务列 |
| 18 | EGDESC | 异常，请描述 | 业务列 |
| 19 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 20 | SVNUM_OID | SVNUM_OID | 系统列 |
| 21 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 22 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 23 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 24 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### LB — 实验室检查

列数 28

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | LBCAT | 模块名称 | 业务列 |
| 9 | LBPERF | 是否进行检查？ | 业务列 |
| 10 | LBREASND | 否，请说明原因 | 业务列 |
| 11 | LBDAT | 采样日期 | 业务列 |
| 12 | LBTIM | 采样时间 | 业务列 |
| 13 | LBNAM | 实验室名称 | 业务列 |
| 14 | SUBTRID | 子表记录ID | 系统列 |
| 15 | CSN | 序号 | 系统列 |
| 16 | LBTEST | 检查项目 | 业务列 |
| 17 | LBORRES | 结果 | 业务列 |
| 18 | LBORRESU | 单位 | 业务列 |
| 19 | LBCLSIG | 临床意义 | 业务列 |
| 20 | LBORNRLO | 正常值范围-下限 | 业务列 |
| 21 | LBORNRHI | 正常值范围-上限 | 业务列 |
| 22 | LBDESC | 异常有临床意义，请描述 | 业务列 |
| 23 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 24 | SVNUM_OID | SVNUM_OID | 系统列 |
| 25 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 26 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 27 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 28 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### EC — 研究药物给药

列数 32

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | ECYN | 是否给予研究药物？ | 业务列 |
| 9 | ECREASOC | 否，请说明原因 | 业务列 |
| 10 | SUBTRID | 子表记录ID | 系统列 |
| 11 | CSN | 序号 | 系统列 |
| 12 | ECSTDAT | 给药开始日期 | 业务列 |
| 13 | ECSTTIM | 给药开始时间 | 业务列 |
| 14 | ECENDAT | 给药结束日期 | 业务列 |
| 15 | ECWDOSE | 单位体重给药剂量 | 业务列 |
| 16 | ECWDOSEO | 其他单位体重给药剂量 | 业务列 |
| 17 | ECPDOSE | 计划给药剂量(mg) | 业务列 |
| 18 | ECADOSE | 实际给药剂量(mg) | 业务列 |
| 19 | ECDOSFRQ | 给药频率 | 业务列 |
| 20 | ECFRQOTH | 其他，请说明 | 业务列 |
| 21 | ECADJ | 是否发生给药变更？ | 业务列 |
| 22 | ECADJ1 | 变更类型 | 业务列 |
| 23 | ECADJ2 | 其他，请说明 | 业务列 |
| 24 | ECADJREA | 变更原因 | 业务列 |
| 25 | ECAENO | 如为不良事件，请填写不良事件编号 | 业务列 |
| 26 | ECDADJO | 其他，请说明 | 业务列 |
| 27 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 28 | SVNUM_OID | SVNUM_OID | 系统列 |
| 29 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 30 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 31 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 32 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PC — PK血样采集

列数 23

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PCPERF | 是否进行了PK血样采集？ | 业务列 |
| 9 | PCREASN | 否，请说明原因 | 业务列 |
| 10 | SUBTRID | 子表记录ID | 系统列 |
| 11 | CSN | 序号 | 系统列 |
| 12 | PCTPT | 时间点 | 业务列 |
| 13 | PCSTAT | 未做 | 业务列 |
| 14 | PCSTA_1 | 未做_未做 | 业务列 |
| 15 | PCREASND | 若未做，请说明原因 | 业务列 |
| 16 | PCDAT | 采集日期 | 业务列 |
| 17 | PCTIM | 采集时间 | 业务列 |
| 18 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 19 | SVNUM_OID | SVNUM_OID | 系统列 |
| 20 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 21 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 22 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 23 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PC1 — PK血样采集1

列数 16

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PCPERF | 是否进行了PK血样采集？ | 业务列 |
| 9 | PCDAT | 采集日期 | 业务列 |
| 10 | PCTIM | 采集时间 | 业务列 |
| 11 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 12 | SVNUM_OID | SVNUM_OID | 系统列 |
| 13 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 14 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 15 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 16 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PC2 — PD血样采集

列数 23

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PC2PERF | 是否进行了PD血样采集？ | 业务列 |
| 9 | PCREASN | 否，请说明原因 | 业务列 |
| 10 | SUBTRID | 子表记录ID | 系统列 |
| 11 | CSN | 序号 | 系统列 |
| 12 | PC2TPT | 时间点 | 业务列 |
| 13 | PCSTAT | 未做 | 业务列 |
| 14 | PCSTA_1 | 未做_未做 | 业务列 |
| 15 | PCREASND | 若未做，请说明原因 | 业务列 |
| 16 | PCDAT | 采集日期 | 业务列 |
| 17 | PCTIM | 采集时间 | 业务列 |
| 18 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 19 | SVNUM_OID | SVNUM_OID | 系统列 |
| 20 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 21 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 22 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 23 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PC3 — PD血样采集1

列数 16

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PC3PERF | 是否进行了PD血样采集？ | 业务列 |
| 9 | PDDAT | 采集日期 | 业务列 |
| 10 | PDTIM | 采集时间 | 业务列 |
| 11 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 12 | SVNUM_OID | SVNUM_OID | 系统列 |
| 13 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 14 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 15 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 16 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PC4 — ADA血样采集

列数 22

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PC4PERF | 是否采集了ADA血液样本？ | 业务列 |
| 9 | PCREASN | 否，请说明原因 | 业务列 |
| 10 | SUBTRID | 子表记录ID | 系统列 |
| 11 | CSN | 序号 | 系统列 |
| 12 | PC4TPT | 计划时间点 | 业务列 |
| 13 | PCSTAT | 未做 | 业务列 |
| 14 | PCREASND | 若未做，请说明原因 | 业务列 |
| 15 | PCDAT | 采集日期 | 业务列 |
| 16 | PCTIM | 采集时间 | 业务列 |
| 17 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 18 | SVNUM_OID | SVNUM_OID | 系统列 |
| 19 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 20 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 21 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 22 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PC5 — ADA血样采集1

列数 16

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PC5PERF | 是否采集了ADA血液样本？ | 业务列 |
| 9 | PCDAT | 采集日期 | 业务列 |
| 10 | PCTIM | 采集时间 | 业务列 |
| 11 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 12 | SVNUM_OID | SVNUM_OID | 系统列 |
| 13 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 14 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 15 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 16 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### SV1 — 电话访视

列数 16

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | SVYN1 | 是否进行了电话访视？ | 业务列 |
| 9 | SVREASND | 否，请说明原因 | 业务列 |
| 10 | VISDAT | 访视日期 | 业务列 |
| 11 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 12 | SVNUM_OID | SVNUM_OID | 系统列 |
| 13 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 14 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 15 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 16 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### AEYN — 不良事件询问页

列数 14

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | AEYN | 是否经历过任何不良事件？ | 业务列 |
| 9 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 10 | SVNUM_OID | SVNUM_OID | 系统列 |
| 11 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 12 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 13 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 14 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### AE — 不良事件

列数 59

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | SN | 序号 | 业务列 |
| 9 | AETERM | 不良事件名称 | 业务列 |
| 10 | AETERM_term | Verbatims | 业务列 |
| 11 | AETERM_lltnamecn | LLT_CN | 业务列 |
| 12 | AETERM_lltnameen | LLT_EN | 业务列 |
| 13 | AETERM_lltcode | LLT Code | 业务列 |
| 14 | AETERM_ptnamecn | PT_CN | 业务列 |
| 15 | AETERM_ptnameen | PT_EN | 业务列 |
| 16 | AETERM_ptcode | PT Code | 业务列 |
| 17 | AETERM_hltnamecn | HLT_CN | 业务列 |
| 18 | AETERM_hltnameen | HLT_EN | 业务列 |
| 19 | AETERM_hltcode | HLT Code | 业务列 |
| 20 | AETERM_hlgtnamecn | HLGT_CN | 业务列 |
| 21 | AETERM_hlgtnameen | HLGT_EN | 业务列 |
| 22 | AETERM_hlgtcode | HLGT Code | 业务列 |
| 23 | AETERM_socnamecn | SOC_CN | 业务列 |
| 24 | AETERM_socnameen | SOC_EN | 业务列 |
| 25 | AETERM_socCode | SOC Code | 业务列 |
| 26 | AETERM_primarysoccfg | Primary SOC | 业务列 |
| 27 | AETERM_note | Query | 业务列 |
| 28 | AETERM_codingdict | Dictionary Name | 业务列 |
| 29 | AETERM_ver | Dictionary Version | 业务列 |
| 30 | AESTDAT | 开始日期 | 业务列 |
| 31 | AESTTIM | 开始时间 | 业务列 |
| 32 | AEONGO | 是否持续 | 业务列 |
| 33 | AEENDAT | 结束日期 | 业务列 |
| 34 | AEENTIM | 结束时间 | 业务列 |
| 35 | AETOXGR | CTCAE分级 | 业务列 |
| 36 | AEREL | 与研究药物的相关性 | 业务列 |
| 37 | AEACN | 对研究药物采取的措施 | 业务列 |
| 38 | AECONTRT | 是否给予药物或非药物治疗？ | 业务列 |
| 39 | AECMNO | 药物治疗编号（如适用） | 业务列 |
| 40 | AEPRNO | 非药物治疗编号（如适用） | 业务列 |
| 41 | AEOUT | 转归 | 业务列 |
| 42 | AESER | 是否为严重不良事件？ | 业务列 |
| 43 | AESEV | 严重不良事件标准 | 业务列 |
| 44 | AESEV_1 | 严重不良事件标准_导致死亡 | 业务列 |
| 45 | AESEV_2 | 严重不良事件标准_危及生命 | 业务列 |
| 46 | AESEV_3 | 严重不良事件标准_需要住院治疗或住院时间延长 | 业务列 |
| 47 | AESEV_4 | 严重不良事件标准_永久或显著的功能丧失 | 业务列 |
| 48 | AESEV_5 | 严重不良事件标准_致畸、致出生缺陷 | 业务列 |
| 49 | AESEV_6 | 严重不良事件标准_其它重要医学事件 | 业务列 |
| 50 | AEHOSTDT | 如不良事件引起住院，请填写入院日期 | 业务列 |
| 51 | AEHOENDT | 如不良事件引起住院，请填写出院日期 | 业务列 |
| 52 | AEDIS | 不良事件是否导致研究中止？ | 业务列 |
| 53 | AETOXGRC | 严重程度是否变更？ | 业务列 |
| 54 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 55 | SVNUM_OID | SVNUM_OID | 系统列 |
| 56 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 57 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 58 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 59 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### CMYN — 既往及合并用药询问页

列数 14

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | CMYN | 是否服用了任何药物？ | 业务列 |
| 9 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 10 | SVNUM_OID | SVNUM_OID | 系统列 |
| 11 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 12 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 13 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 14 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### CM — 既往及合并用药

列数 63

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | SN | 序号 | 业务列 |
| 9 | CMTRT | 药物名称 | 业务列 |
| 10 | CMTRT_term | Verbatims | 业务列 |
| 11 | CMTRT_termcn | Verbatims Comments | 业务列 |
| 12 | CMTRT_indication | Indications | 业务列 |
| 13 | CMTRT_route | Route | 业务列 |
| 14 | CMTRT_drugnamecn | Drug Name_CN | 业务列 |
| 15 | CMTRT_drugnameen | Drug Name_EN | 业务列 |
| 16 | CMTRT_drugcode | Drug Code | 业务列 |
| 17 | CMTRT_preferrednamecn | Preferred Name_CN | 业务列 |
| 18 | CMTRT_preferrednameen | Preferred Name_EN | 业务列 |
| 19 | CMTRT_preferredcode | Preferred Code | 业务列 |
| 20 | CMTRT_preferredbasecn | Preferred Base_CN | 业务列 |
| 21 | CMTRT_preferredbaseen | Preferred Base_EN | 业务列 |
| 22 | CMTRT_preferredbasecode | Preferred Base code | 业务列 |
| 23 | CMTRT_atccode | ATCCODE | 业务列 |
| 24 | CMTRT_atcnamecn | ATC_CN | 业务列 |
| 25 | CMTRT_atcnameen | ATC_EN | 业务列 |
| 26 | CMTRT_atc1code | ATC1CODE | 业务列 |
| 27 | CMTRT_atc1namecn | ATC1_CN | 业务列 |
| 28 | CMTRT_atc1nameen | ATC1_EN | 业务列 |
| 29 | CMTRT_atc2code | ATC2CODE | 业务列 |
| 30 | CMTRT_atc2namecn | ATC2_CN | 业务列 |
| 31 | CMTRT_atc2nameen | ATC2_EN | 业务列 |
| 32 | CMTRT_atc3code | ATC3CODE | 业务列 |
| 33 | CMTRT_atc3namecn | ATC3_CN | 业务列 |
| 34 | CMTRT_atc3nameen | ATC3_EN | 业务列 |
| 35 | CMTRT_atc4code | ATC4CODE | 业务列 |
| 36 | CMTRT_atc4namecn | ATC4_CN | 业务列 |
| 37 | CMTRT_atc4nameen | ATC4_EN | 业务列 |
| 38 | CMTRT_generic | Generic | 业务列 |
| 39 | CMTRT_note | Query | 业务列 |
| 40 | CMTRT_codingdict | Dictionary Name | 业务列 |
| 41 | CMTRT_ver | Dictionary Version | 业务列 |
| 42 | CMDSTXT | 单次剂量 | 业务列 |
| 43 | CMDOSU | 剂量单位 | 业务列 |
| 44 | CMDSUOTH | 其他剂量单位 | 业务列 |
| 45 | CMDOSFRM | 剂型 | 业务列 |
| 46 | CMFRMOTH | 其他剂型，请描述 | 业务列 |
| 47 | CMDOSFRQ | 频率 | 业务列 |
| 48 | CMFRQOTH | 其他频率，请描述 | 业务列 |
| 49 | CMROUTE | 给药途径 | 业务列 |
| 50 | CMRUOTH | 其他给药途径，请描述 | 业务列 |
| 51 | CMINDC | 用药目的 | 业务列 |
| 52 | CMINDCO | 其他，请描述 | 业务列 |
| 53 | CMMHNO | 病史编号（如适用） | 业务列 |
| 54 | CMAENO | 不良事件编号（如适用） | 业务列 |
| 55 | CMSTDAT | 开始日期 | 业务列 |
| 56 | CMONGO | 是否持续 | 业务列 |
| 57 | CMENDAT | 结束日期 | 业务列 |
| 58 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 59 | SVNUM_OID | SVNUM_OID | 系统列 |
| 60 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 61 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 62 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 63 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PR1YN — 既往及合并非药物治疗询问页

列数 14

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PRYN | 是否使用了任何非药物治疗？ | 业务列 |
| 9 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 10 | SVNUM_OID | SVNUM_OID | 系统列 |
| 11 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 12 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 13 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 14 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PR1 — 既往及合并非药物治疗

列数 42

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | SN | 序号 | 业务列 |
| 9 | PRTRT | 治疗名称 | 业务列 |
| 10 | PRTRT_term | Verbatims | 业务列 |
| 11 | PRTRT_lltnamecn | LLT_CN | 业务列 |
| 12 | PRTRT_lltnameen | LLT_EN | 业务列 |
| 13 | PRTRT_lltcode | LLT Code | 业务列 |
| 14 | PRTRT_ptnamecn | PT_CN | 业务列 |
| 15 | PRTRT_ptnameen | PT_EN | 业务列 |
| 16 | PRTRT_ptcode | PT Code | 业务列 |
| 17 | PRTRT_hltnamecn | HLT_CN | 业务列 |
| 18 | PRTRT_hltnameen | HLT_EN | 业务列 |
| 19 | PRTRT_hltcode | HLT Code | 业务列 |
| 20 | PRTRT_hlgtnamecn | HLGT_CN | 业务列 |
| 21 | PRTRT_hlgtnameen | HLGT_EN | 业务列 |
| 22 | PRTRT_hlgtcode | HLGT Code | 业务列 |
| 23 | PRTRT_socnamecn | SOC_CN | 业务列 |
| 24 | PRTRT_socnameen | SOC_EN | 业务列 |
| 25 | PRTRT_socCode | SOC Code | 业务列 |
| 26 | PRTRT_primarysoccfg | Primary SOC | 业务列 |
| 27 | PRTRT_note | Query | 业务列 |
| 28 | PRTRT_codingdict | Dictionary Name | 业务列 |
| 29 | PRTRT_ver | Dictionary Version | 业务列 |
| 30 | PRINDC | 治疗目的 | 业务列 |
| 31 | PRINDCOT | 其他，请描述 | 业务列 |
| 32 | PRMHNO | 病史编号（如适用） | 业务列 |
| 33 | PRAENO | 不良事件编号（如适用） | 业务列 |
| 34 | PRSTDAT | 开始日期 | 业务列 |
| 35 | PRONGO | 是否持续 | 业务列 |
| 36 | PRENDAT | 结束日期 | 业务列 |
| 37 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 38 | SVNUM_OID | SVNUM_OID | 系统列 |
| 39 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 40 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 41 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 42 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### DS — 研究结束

列数 20

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | DSCOMPYN | 受试者是否完成全部试验？ | 业务列 |
| 9 | DSSTDAT | 完成/退出日期 | 业务列 |
| 10 | DSDECOD | 提前退出试验的主要原因 | 业务列 |
| 11 | DSWICDAT | 撤回知情同意日期 | 业务列 |
| 12 | DSAENO | 不良事件编号 | 业务列 |
| 13 | DSLSTDAT | 最后联系日期 | 业务列 |
| 14 | DSTERM | 其他，请描述 | 业务列 |
| 15 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 16 | SVNUM_OID | SVNUM_OID | 系统列 |
| 17 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 18 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 19 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 20 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### DD — 死亡

列数 17

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | DDYN | 是否死亡？ | 业务列 |
| 9 | DTHDAT | 死亡日期 | 业务列 |
| 10 | DTHTIM | 死亡时间 | 业务列 |
| 11 | DTHREAS | 死亡原因 | 业务列 |
| 12 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 13 | SVNUM_OID | SVNUM_OID | 系统列 |
| 14 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 15 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 16 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 17 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### SVN — 下一个访视

列数 14

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | SVNYN | 是否进入下一个访视？ | 业务列 |
| 9 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 10 | SVNUM_OID | SVNUM_OID | 系统列 |
| 11 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 12 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 13 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 14 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### RD — 随机

列数 19

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | DSTTYPE | 试验阶段 | 业务列 |
| 9 | DSPERF | 是否随机？ | 业务列 |
| 10 | RANDGH1 | GH峰值 | 业务列 |
| 11 | DSGROUP | 组别 | 业务列 |
| 12 | DSSTDAT | 随机日期 | 业务列 |
| 13 | DSREFID | 随机编号 | 业务列 |
| 14 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 15 | SVNUM_OID | SVNUM_OID | 系统列 |
| 16 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 17 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 18 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 19 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### LB5 — 病毒及血清学检查

列数 30

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | LBPERF | 是否进行了血清学检测？ | 业务列 |
| 9 | LBREASND | 否，请说明原因 | 业务列 |
| 10 | LBDAT | 采集日期 | 业务列 |
| 11 | LBORS1 | 乙型肝炎表面抗原 | 业务列 |
| 12 | LBORS5 | 乙型肝炎表面抗体 | 业务列 |
| 13 | LBORS6 | 乙型肝炎e抗原 | 业务列 |
| 14 | LBORS7 | 乙型肝炎核心抗体 | 业务列 |
| 15 | LBORS8 | 乙型肝炎e抗体 | 业务列 |
| 16 | LBORS2 | 丙型肝炎病毒(HCV)抗体 | 业务列 |
| 17 | LBORS3 | 梅毒螺旋体抗体 | 业务列 |
| 18 | LBORS4 | 艾滋病病毒(HIV)抗体 | 业务列 |
| 19 | SUBTRID | 子表记录ID | 系统列 |
| 20 | CSN | 序号 | 系统列 |
| 21 | LB5TEST | 检测项目 | 业务列 |
| 22 | LBORRES | 结果 | 业务列 |
| 23 | LBORNRLO | 正常值范围-下限 | 业务列 |
| 24 | LBORNRHI | 正常值范围-上限 | 业务列 |
| 25 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 26 | SVNUM_OID | SVNUM_OID | 系统列 |
| 27 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 28 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 29 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 30 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### LB12 — 生长激素激发试验

列数 18

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | LBPERF | 是否进行了生长激素激发试验？ | 业务列 |
| 9 | LBREASND | 否，请说明原因 | 业务列 |
| 10 | LBDAT | 采集日期 | 业务列 |
| 11 | ECTRT | 药物名称（通用名） | 业务列 |
| 12 | LBORRES | GH峰值 | 业务列 |
| 13 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 14 | SVNUM_OID | SVNUM_OID | 系统列 |
| 15 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 16 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 17 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 18 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### LB3 — 尿常规

列数 28

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | LB6CAT | 模块名称 | 业务列 |
| 9 | LBPERF | 是否进行检查？ | 业务列 |
| 10 | LBREASND | 否，请说明原因 | 业务列 |
| 11 | LBNRIND | 实验室编号（Lab ID） | 业务列 |
| 12 | LBDAT | 采集日期 | 业务列 |
| 13 | LBTIM | 采集时间 | 业务列 |
| 14 | SUBTRID | 子表记录ID | 系统列 |
| 15 | CSN | 序号 | 系统列 |
| 16 | LBTEST | 检查项目 | 业务列 |
| 17 | LBORRES | 检查结果 | 业务列 |
| 18 | LBORRESU | 单位 | 业务列 |
| 19 | LBCLSIG | 临床意义判定 | 业务列 |
| 20 | LBORNRLO | 正常值范围-下限 | 业务列 |
| 21 | LBORNRHI | 正常值范围-上限 | 业务列 |
| 22 | LBDESC | 异常有临床意义，请描述 | 业务列 |
| 23 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 24 | SVNUM_OID | SVNUM_OID | 系统列 |
| 25 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 26 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 27 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 28 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### LBO — 其他检查

列数 21

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | LBDAT | 检查日期 | 业务列 |
| 9 | LBTEST | 检查项目 | 业务列 |
| 10 | LBORRES | 检查结果 | 业务列 |
| 11 | LBORRESU | 单位 | 业务列 |
| 12 | LBCLSIG | 临床意义 | 业务列 |
| 13 | LBDESC | 异常有临床意义，请描述 | 业务列 |
| 14 | LBORNRLO | 参考值下限值 | 业务列 |
| 15 | LBORNRHI | 参考值上限值 | 业务列 |
| 16 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 17 | SVNUM_OID | SVNUM_OID | 系统列 |
| 18 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 19 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 20 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 21 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### LB11 — 染色体核型分析

列数 19

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | LBPERF | 是否进行了染色体核型分析? | 业务列 |
| 9 | LBTYPE | 细胞来源 | 业务列 |
| 10 | LBTYPEOT | 其他，请说明 | 业务列 |
| 11 | LBDAT | 分析日期 | 业务列 |
| 12 | LBRES | 染色体核型分析结果 | 业务列 |
| 13 | LBDESC | 异常，请描述 | 业务列 |
| 14 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 15 | SVNUM_OID | SVNUM_OID | 系统列 |
| 16 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 17 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 18 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 19 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### LB13 — 空腹血清皮质醇

列数 37

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | LBCAT | 模块名称 | 业务列 |
| 9 | LBPERF | 是否进行检查？ | 业务列 |
| 10 | LBREASND | 否，请说明原因 | 业务列 |
| 11 | LBDAT | 采样日期 | 业务列 |
| 12 | LBTIM | 采样时间 | 业务列 |
| 13 | LBNAM | 实验室名称 | 业务列 |
| 14 | LBACTH | 是否进行了ACTH刺激试验? | 业务列 |
| 15 | LBACTIM | ACTH注射时间 | 业务列 |
| 16 | SUBTRID | 子表记录ID | 系统列 |
| 17 | CSN | 序号 | 系统列 |
| 18 | LBTEST | 检查项目 | 业务列 |
| 19 | LBORRES | 结果 | 业务列 |
| 20 | LBORRESU | 单位 | 业务列 |
| 21 | LBCLSIG | 临床意义 | 业务列 |
| 22 | LBORNRLO | 正常值范围-下限 | 业务列 |
| 23 | LBORNRHI | 正常值范围-上限 | 业务列 |
| 24 | LBDESC | 异常有临床意义，请描述 | 业务列 |
| 25 | LBACTPT | 时间点 | 业务列 |
| 26 | LB13RES | 血清皮质醇 | 业务列 |
| 27 | LB13RESU | 单位 | 业务列 |
| 28 | LBCLSIG1 | 临床意义 | 业务列 |
| 29 | LBORNRL1 | 正常值范围下限 | 业务列 |
| 30 | LBORNRH1 | 正常值范围上限 | 业务列 |
| 31 | LBDESC1 | 异常有临床意义，请描述 | 业务列 |
| 32 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 33 | SVNUM_OID | SVNUM_OID | 系统列 |
| 34 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 35 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 36 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 37 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### LB14 — IGF-1检测

列数 19

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | LBPERF | 是否进行IGF-1检测？ | 业务列 |
| 9 | LBREASND | 否，请说明原因 | 业务列 |
| 10 | LBDAT | 检测日期 | 业务列 |
| 11 | LBORRES | 检测结果 | 业务列 |
| 12 | LBORRESU | 单位 | 业务列 |
| 13 | LBORESUO | 其他单位 | 业务列 |
| 14 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 15 | SVNUM_OID | SVNUM_OID | 系统列 |
| 16 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 17 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 18 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 19 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### DS1 — 治疗结束

列数 16

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | DSEOTYN | 是否提前结束治疗 | 业务列 |
| 9 | DSLSEDAT | 末次用药日期 | 业务列 |
| 10 | DSACVIS | 实际完成的治疗周期数（ week） | 业务列 |
| 11 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 12 | SVNUM_OID | SVNUM_OID | 系统列 |
| 13 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 14 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 15 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 16 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### SR — 注射部位评估

列数 25

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | SRRATYN | 是否进行了注射部位评估？ | 业务列 |
| 9 | SRREASND | 若否，请说明原因 | 业务列 |
| 10 | SRDAT | 评估日期 | 业务列 |
| 11 | SUBTRID | 子表记录ID | 系统列 |
| 12 | CSN | 序号 | 系统列 |
| 13 | SRLOC | 注射部位 | 业务列 |
| 14 | SRLOCOT | 其他，请说明 | 业务列 |
| 15 | SRRES1 | 发红情况 | 业务列 |
| 16 | SRRES2 | 瘀伤情况 | 业务列 |
| 17 | SRRES3 | 肿胀情况 | 业务列 |
| 18 | SRRES4 | 瘙痒情况 | 业务列 |
| 19 | SRRES5 | 疼痛评分 | 业务列 |
| 20 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 21 | SVNUM_OID | SVNUM_OID | 系统列 |
| 22 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 23 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 24 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 25 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### PE1 — 体格检查（筛选期）

列数 25

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | PEPERF | 是否进行了体格检查？ | 业务列 |
| 9 | PEREASND | 否，请说明原因 | 业务列 |
| 10 | PEDAT | 检查日期 | 业务列 |
| 11 | SUBTRID | 子表记录ID | 系统列 |
| 12 | CSN | 序号 | 系统列 |
| 13 | PETEST | 检查名称 | 业务列 |
| 14 | PESTAT | 未做 | 业务列 |
| 15 | PESTA_1 | 未做_未做 | 业务列 |
| 16 | PERES | 检查结果 | 业务列 |
| 17 | PEDESC | 异常，请描述 | 业务列 |
| 18 | PECSCAT | 异常有临床意义，请选择分类 | 业务列 |
| 19 | PEMHNO | 对应的既往/伴随疾病史 | 业务列 |
| 20 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 21 | SVNUM_OID | SVNUM_OID | 系统列 |
| 22 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 23 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 24 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 25 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### VS6 — 生命体征（筛选期）

列数 27

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | VSPERF | 是否采集生命体征数据？ | 业务列 |
| 9 | VSREASN | 否，请说明原因 | 业务列 |
| 10 | SUBTRID | 子表记录ID | 系统列 |
| 11 | CSN | 序号 | 系统列 |
| 12 | VSTEST | 检查项目 | 业务列 |
| 13 | VSSTAT | 未做 | 业务列 |
| 14 | VSREASND | 若未做，请说明原因 | 业务列 |
| 15 | VSDAT | 测量日期 | 业务列 |
| 16 | VSTIM | 测量时间 | 业务列 |
| 17 | VSORRES | 结果 | 业务列 |
| 18 | VSCLSIG | 临床意义 | 业务列 |
| 19 | VSCSCAT | 若异常有临床意义，请选择分类 | 业务列 |
| 20 | VSMHNO | 对应的既往/伴随疾病史 | 业务列 |
| 21 | VS6DESC | 其他，请说明 | 业务列 |
| 22 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 23 | SVNUM_OID | SVNUM_OID | 系统列 |
| 24 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 25 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 26 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 27 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |

### TANNER1 — Tanner 阶段评估（筛选期）

列数 19

| # | OID | 显示名 | 类别 |
|---|---|---|---|
| 1 | STUDYCODE | 研究代码 | 前列系统键 |
| 2 | SITEID | 中心编号 | 前列系统键 |
| 3 | SUBJID | 受试者编号 | 前列系统键 |
| 4 | STATUS | 受试者状态 | 前列系统键 |
| 5 | VISITNAME | 访视名称 | 前列系统键 |
| 6 | SVNUM | 访视内名称 | 前列系统键 |
| 7 | TNAME | 表名称 | 前列系统键 |
| 8 | TNYN | 是否进行Tanner阶段评估？ | 业务列 |
| 9 | TANREAS | 否，请说明原因 | 业务列 |
| 10 | TNDAT | 评估日期 | 业务列 |
| 11 | TNRES1 | 男孩睾丸体积是否<4 ml？ | 业务列 |
| 12 | TNRES2 | 女孩乳房有无可触及的乳房腺体组织？ | 业务列 |
| 13 | TNSTAGE | Tanner 阶段 | 业务列 |
| 14 | VISITNAME_OID | VISITNAME_OID | 系统列 |
| 15 | SVNUM_OID | SVNUM_OID | 系统列 |
| 16 | __cmp_FLAG__ | FLAG(New/Modified/Old) | 比对尾部固定列 |
| 17 | __cmp_UpdateDetail__ | Update Detail | 比对尾部固定列 |
| 18 | __cmp_RCcomment__ | Review Comments | 比对尾部固定列 |
| 19 | __cmp_Idate__ | Initial/Date | 比对尾部固定列 |
