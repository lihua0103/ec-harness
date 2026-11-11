# 公司 DVP 模板结构（xlsx 工作簿解析）

更新：2026-11-10。来源：用户提供的真实项目工作簿（TAISHAN-304 DVP V2.0，位于 `D:\project\company\epro\Project\304_manual\doc\`，按用户指示**只做结构分析，临床内容不外显**：未读取外显任何规则原文/受试者号/Cover）。本文是 `dm-dvp` 插件生成器的交付模板基准。分析脚本与聚合结果在 `.runtime/dvp-template/`。

---

## 1. 工作簿结构：12 sheet，四层

| 层 | Sheet | 规模（V2.0 实例） | 角色 |
|---|---|---|---|
| 治理 | Cover | 15x2 | 研究信息页（**按既定惯例禁读**） |
| 治理 | DVP Approval Form | 33x6 | 审批签字页 |
| 治理 | Version History | 13x4 | Version / Version Date / Modified By / Comments（V1.0 Final 起） |
| **规则** | **Edit Checks** | 710 规则 × 9 列 | **跨字段逻辑核查（DVP 核心）** |
| **规则** | **Edit Checks(Field Level)** | 1042 字段 × 11 列 | 字段级/前端核查与字段配置 |
| 人工 | Manual Review | 85 行 × 8 列 | 人工审阅列表规格（DM 视角） |
| 人工 | Manual Review for Programming | 129 行 × 13 列 | 编程版人工审阅（含 UAT 用例与分工） |
| 系统功能 | Dynamic | 546 条 × 8 列 | EDC 动态显示/衍生配置 |
| 辅助 | Sheet2、分配、Sheet10（hidden）、WpsReserved_CellImgList（veryHidden） | — | 工作辅助/隐藏中间表 |

四层结构实证了 CDE 的 DVP 定义："依据临床试验方案以及**系统功能**"——Dynamic 与 Field Level 表就是系统功能侧的落点。

## 2. Edit Checks（跨字段核查表，9 列）

| 列 | 语义与约定（V2.0 实例统计） |
|---|---|
| Unique ID (provided by DBD) | 域/表单代码前缀+序号，由 DB 编程分配；实例 47 个前缀，前 5：TR/QS/PR/DS/CF（每表单 15–90 条） |
| Add/Delete/Update | **行内变更控制**：仅在版本变更时填，值形如 `Add/V2.0`、`Update/V2.0`（实例 12 Add + 5 Update）；未变更行为空 |
| Visit(s) Applied To | 适用访视范围（含 `All`） |
| Form Name | 规则绑定表单，710/710 全填 |
| Query Targeted Field | 质疑指向字段 |
| Related Field | 关联字段（跨字段比较对象） |
| Query Type | **4 枚举：Date(492) / Custom(125) / Missing(67) / Range(26)**。表头枚举草案含 Derivation，实际用 Custom 承接（衍生/逻辑矛盾/跨表类归 Custom） |
| Discrepancy Text Message | 质疑文案：**全英文**（0 条含 CJK），长度 27–264，中位 90；不诱导（与 SCDM 措辞规范一致） |
| Logic | **`fire when` 开头的英文谓词伪代码**（672/710），算子 `< > = AND OR NULL`；EDC 无关的业务逻辑层；长度 15–399，中位 85 |

## 3. Edit Checks(Field Level)（字段级表，11 列）

FormOID / Form Name / FieldOID / PreText（字段标签）/ ControlType / DataFormat / IsLog / IsRequired / QueryFutureDate / QueryNonConformance。

- **OID 命名遵循 SDTM 变量名**（如 SUBJ 表的 USUBJID）——FormOID/FieldOID 是 Rave 风格系统标识
- ControlType 8 种：LongText(259) / RadioButton (Vertical)(192) / Text(183) / DropDownList(155) / DateTime(134) / RadioButton(55) / CheckBox(45) / Dynamic SearchList(19)
- DataFormat 19 种：`$N`=文本长度（$200×279、$20、$25…）、纯整数=小数位数（2×251、1×186）、`12.5` 类=数值精度、`dd MMM yyyy` 等日期格式、`HH:nn` 时间
- 四个布尔核查开关（实例比例）：IsRequired 72% / IsLog 45% / QueryNonConformance 25% / QueryFutureDate 11%——**必填、日志、未来日期、不符合项质疑在字段级配置**，不占跨字段规则表

## 4. Manual Review（人工审阅层）

- Manual Review（7 列）：Unique ID / Add-Delete-Update / Visits / Form / Related Fields / Report Description / Discrepancy Text——人工列表审阅的规格（对应 SCDM Manual/Listing checks；实例中 ID 列留空，ID 在编程版维护）
- Manual Review for Programming（13 列）在左侧基础上增加：**assign**（个人代码分工，3 位字母，实例 4 人/组）、**Logic**（程序实现逻辑）、**Column Heading**（列表输出列头，对应 EDCTP Listing Output）、**TEST CASE-Subject ID**（UAT 用例行内记录）、**DM Comments / DBD Comments**（评审留痕）——**测试与评审直接在规则行内留档**，不需要单独 UAT 工作簿

## 5. Dynamic（系统功能层，8 列）

Unique ID / Add-Delete-Update / CRF Page-Domain / Field Name / Type / Visits / Discrepancy Text / Condition(internal)。
Type 8 枚举：Dynamic Field(303) / Dynamic Search list(99) / Dynamic Page(77) / **Derivation(34)** / Dynamic Visit(21) / Participant Status(7) / Dynamic Option(4) / Add Event(1)。Add/Delete/Update 同样行内标记 V2.0 变更。**此表是系统既有配置的登记**（DVP 中"依据系统功能"的部分），插件宜只读参考，不自动生成。

## 6. 与文献模型对照（模板即 EDCTP DVS + SCDM 的公司实现）

| EDCTP DVS / SCDM 字段模型 | 公司模板落点 |
|---|---|
| Check ID | Edit Checks.Unique ID |
| Version / 变更控制 | Version History + 行内 Add/Delete/Update 列 |
| Form/Module、Field/Variable | Form Name / Query Targeted Field / Related Field；字段级表 OID |
| System/Manual | Edit Checks（系统）vs Manual Review（人工）vs Dynamic（系统配置登记） |
| Check Type | Query Type 4 枚举（Custom 承接 SCDM 多类） |
| Description | （无独立列——由 Targeted Field+Related Field+Report Description 组合表达） |
| Logic | `fire when` 伪代码方言 |
| Query Text | Discrepancy Text Message |
| Listing Output | Manual Review(Column Heading, Report Description) |
| 测试记录 | Programming 版 TEST CASE 列 + DM/DBD Comments |
| 例外说明 | 表头惯例（如"已划线不质疑"类补充指令）进 Discrepancy Text/Logic 注释 |

## 7. 对 dm-dvp 生成器的设计含义

1. **交付形态 = 多 sheet xlsx 工作簿**（治理 3 页 + 规则 2 页 + 人工 2 页 + 动态登记页），需 xlsx **写出**能力（现库只有读）。
2. **Logic 中间表示就用公司 `fire when` 方言**——它本身就是 EDC 无关的业务逻辑层；目标 EDC（Rave/太美/Clinflash…）各做渲染适配器。字段级表的 OID/ControlType/DataFormat 是 Rave 风格，多 EDC 支持时这部分按目标系统映射生成。
3. **Query Type 保 4 枚举**（Date/Custom/Missing/Range）对齐公司模板，不引入 SCDM 8 类命名。
4. **行内变更控制** `Add/Update/V<ver>` → 映射 KnowledgeService `CANDIDATE→ACTIVE→SUPERSEDED`，生成器要能按方案/ALS diff 输出变更行标记。
5. **UAT 用例与评审是行内列**（TEST CASE/DM Comments/DBD Comments）——插件输出候选时这些列留空，绝不伪填。
6. 字段级四开关（IsRequired/IsLog/QueryFutureDate/QueryNonConformance）是**方案可达成的布尔判断**（如"某日期不允许未来日期"），生成器可从方案条款直接推断候选值，交人确认。
7. 规模参考：中型项目 V2.0 即 710 跨字段规则 + 1042 字段级行——IR 与检索需按千级条目设计（Unicode 子串检索需升级为索引方案）。

## 8. 数据边界（用户指示，长期有效）

- Cover sheet 与受试者级/原始数据：禁读。
- 规则原文、质疑文案、访视/表单清单等临床项目内容：只做本地聚合分析，不写入对话上下文、不复制入本项目仓库。
- 本模板 schema 文档只含列语义、枚举与统计惯例，可安全用于插件开发。
