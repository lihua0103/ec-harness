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
- **2026-11-24 起本节边界由数据安全开关控制**（`plugins/dm-dvp/src/data-boundary.ts`，与模型无关）：开关文件 `.runtime/data-boundary.json` 的 `dataSecurity=false`（关闭，命令 `node .runtime/data-boundary.cjs off [--restart]`）时——`dm_dvp_overview / parse_workbook / read_workbook` 对 Cover、Approval、TEST CASE 受试者号与 DM/DBD 评审意见**原值返回**；`dataSecurity=true`（开启，默认；文件缺失或损坏也按开启）即回到上述禁读（插件测试默认锁定开启时的行为）。
- 规则原文、质疑文案、访视/表单清单等临床项目内容：只做本地聚合分析，不写入对话上下文、不复制入本项目仓库。
- 本模板 schema 文档只含列语义、枚举与统计惯例，可安全用于插件开发。

## 9. 真实实例对照与生成惯例（2026-11-21，第二份实物 V6.0 对照蒸馏）

第二份公司实物（V6.0，10 sheet）对照本模板所据实例（V2.0，12 sheet）：**公司内不同项目形态有差量**，下列为跨实例不变量与 V6.0 差量，是生成器与提示词的接地依据。统计口径：V6.0 Edit Checks 866 条全量分析（本节只录惯例与统计，不录规则原文）。

### 9.1 跨实例不变量（生成必须遵守）

状态标注（2026-11-21 知识沉淀，依 §9.4 v1.1 对标回写）：**【已实证】**=v1.1 复跑量化达标；**【差距】**=残留未收敛；**【开放】**=口径未定待收敛。已实证项已沉淀为种子（`dm-dvp.conventions.evidence` 等，见 plugins/dm-dvp）。

- 【已实证】治理三页在前：Approval Form（**首个 sheet**）/ Cover / Version History。**实物中 Cover 值列与版本日期列全空（人类填）**——生成器只写有输入证据的行，禁止编造日期、历史版本、签署人（v1.1 Version History 仅证据行，零编造达成）。
- 【差距】Edit Checks = 跨字段定制检查；Logic 用公司 `fire when` 方言：`<>`/`=`/`AND`/`OR` + `注：` + `【表单.字段】` 跨表引用记法（V6.0 频次：`<>`×428、`AND`×606、`OR`×68、`注：`×69、`【`×75）；字段名用 ALS PreText 中文原文。方言算子/连接词主体已实证；**记法密度未收敛**（【】v1.1×2009 vs 标准×75，全局包裹漂移；`注：`×0）→ 见种子 `dm-dvp.text.density`。
- 【已实证】【差距】差异文本范式（频次即规范，占位符记法）：**97%（843/866）以"请核实"结尾**——v1.1 853/849 行≈100% 达标；三型模板频次对齐（已提供，但 144 vs 138、晚于 18=18、早于 34≈33）；**「请核查」变体未覆盖**（标准 23、v1.1 0）→ 句尾主形态与三型模板见种子 `dm-dvp.conventions.evidence`，变体与密度见 `dm-dvp.text.density`。
- 【已实证】字段级表 = Rave 字段配置元数据（FormOID/FormName/FieldOID/PreText/ControlType/DataFormat/Is Required/Query Future Date/Query Non-Conformance），ControlType 含 CheckBox 与 Dynamic SearchList。三旗标（IsRequired/QueryFutureDate/QueryNonConformance）是**系统原生检查层**，与定制检查分列两 sheet，勿混（v1.1 709=709 且枚举分布逐项相同）。
- 【已实证】Add/Delete/Update 列在基线版全空（866/866；v1.1 双方 0% 填充）。
- 【已实证】【开放】ID 跟随表单缩写：EditCheck=`表单缩写_序号`（跨周期访视可带矩阵后缀 `XX_10_C3_C80`）；Listing=`表单缩写_序号`；Dynamic=`DYN_FIELD_/DSL_/DYN_PAGE_` 前缀 + 表单缩写。主体已实证；**矩阵后缀为开放问题**（标准 49 条、v1.1 命中 10，EX 前缀多 23）→ 见种子 `dm-dvp.id.matrix-suffix`。
- 【已实证】访视列用 `ALL`（实物 99+87 次）与方案真实访视名（筛选期/肿瘤评估/周期访视），**不用"所有访视"**（v1.1 ALL×638、"所有访视"×0）。
- 【已实证】规模纪律：真实 DVP 是**全量清单**（V6.0：Edit Checks 866 / 字段级 709 / Manual Review 92 / Dynamic 216；对照 V2.0：710/1042）——ALS 元数据应机械全量物化，抽样精选即不合格（v1.1 849/866=98%，逐表单计数精确命中）。
- 【差距】访视-表单条目的跨页归类口径：矩阵区放访视展开 + 条件数据表单（标准 44 行、`DYN_VISIT_*`），动态区 Dynamic Visit 严格少用（标准 4 条）；v1.1 把 253 条 Dynamic Visit 塞进动态区、矩阵区 130 行几乎全是访视表单 → 见种子 `dm-dvp.classification.visit-matrix`。Manual Review 列形（标准 29 列 vs v1.1 8 列通用形）为插件配置面迭代，不属于知识沉淀。

### 9.2 V6.0 相对本模板（V2.0 实例）的差量

- **无 Query Type 列**（Edit Checks 9 列中不含）；Query Type 是模板实例的列，非公司不变量——生成器应把该列做成可配置。
- **无 Manual Review for Programming**：单 Manual Review（29 列：Listing ID/Name/Version/CRF Name/Field Name/Visits/Report Description/Discrepancy Text/Review group/Condition/Column Heading + 尾部 UAT/Comments 稀疏列），Review group 区分人群（V6.0 全 DM）。
- 字段级表名 = **Edit Checks Rave**（709 行，无 IsLog 列）。
- **新增 Subject Status**（受试者状态定义：状态名 + `【表单.字段】` 条件记法）与 **Matrix**（`DYN_VISIT_*` × 访视 → 各亚组显示表单矩阵）两 sheet。
- Dynamic 六类全谱：Dynamic Field / Dynamic Page / Dynamic Searchlist / Dynamic Visit / Add Event / Derivation（V6.0: 134/46/24/4/3/3）。

### 9.3 生成器差距与对策（2026-11-21 v1.0 CANDIDATE 实测）

| 维度 | 生成 | 标准（V6.0） | 根因→对策 |
|---|---|---|---|
| Edit Checks 规模 | 68 | 866 | write_workbook 内联 JSON 限单轮吞吐 → 插件加 **bulk 写入路径**（工具从文件/NDJSON 引用展开，模型只产映射不逐条抄写） |
| Version History | 编造 2019–2022 假日期 | 日期列全空 | 零编造违规 → 只写有证据行（协议版本/日期 + 本次生成行） |
| Sheet 清单 | 8 页（自创 Programming 页） | 9 页 | 按 §9.2 实物清单，sheet 集可配置 |
| 访视命名 | "所有访视"×61 | ALL + 真实访视名 | §9.1 惯例注入提示词/种子 |
| ID 约定 | 表单缩写_序号 | 同 + 矩阵后缀 | 已对齐，补后缀规则 |
| 差异文本范式 | "请核实"68/68 | 97% | 基本对齐，补缺失/一致性/时序三型模板 |

对策落点：① 插件 bulk 写入；② sheet 集与列配置化（Query Type 可关、Subject Status/Matrix 可开）；③ §9.1 惯例进会话提示词与知识种子；④ 复跑后与本节量化基线再对比；⑤ 旋钮决策显式汇报——六个 template 旋钮（governanceOrder/editChecksQueryType/fieldLevelSheetName/includeProgramming/includeSubjectStatus/includeMatrix）最终取值与依据须写进交付汇报（识别到哪份实物形态，或「未识别，用默认」），静默套默认视为缺陷。

### 9.4 v1.1 复跑对比（2026-11-21，bulk+模板旋钮升级后，插件写簿实证：mtime 与最后一次 write 调用差 108ms，SHA-256 2AE4D2AB…4B70DAB）

| 维度 | v1.0 | **v1.1** | 标准（V6.0） | 结论 |
|---|---|---|---|---|
| Edit Checks 规模 | 68 | **849** | 866 | 98% 覆盖；逐表单计数精确命中（LB 101=101、TM 91=91、TH 79=79、TE 54=54、FH 52=52） |
| Version History | 编造假日期 | **仅证据行**（V5.0=ALS CopySource 文件名 2023-05-18、V6.0=标准文件名 2025-01-13、两条 CANDIDATE；Modified By 留空） | 日期列全空 | 零编造达成 |
| Query Type 列 | 9 列含 | **8 列不含（模型自选 editChecksQueryType=false）** | 8 列不含 | 旋钮按实物形态正确使用 |
| 访视命名 | "所有访视"×61 | **ALL×638 + 真实访视名，"所有访视"×0** | ALL/All + 真实访视名 | 对齐 |
| ID 约定 | 表单缩写_序号 | 同左 | 同 + 矩阵后缀（SV_×49） | 主体对齐；**SV_ 后缀仅 10 条（缺约 39 条跨周期矩阵规则）、EX 多 23 条**——残留差距 |
| 差异文本范式 | 请核实 68/68 | **请核实 853/849 行、已提供，但×144（标 138）、未提供×522（标 503）、晚于 18=18、早于 34≈33** | 97% 请核实 | 对齐；缺「请核查」变体（标 23/0）与 Logic「注：」注释（标 69/0）；【】记法密度高于标准（2009 vs 75） |
| Edit Checks Rave | — | **709=709 行；ControlType/IsRequired/QueryFutureDate/QueryNonConformance 枚举分布逐项相同（257/142/109/96/53/52、592/117、611/98、514/195）** | 709 行 | 字段级重建精确命中 |
| Manual Review | — | **92=92 行**；列形 8 列通用 | 92 行；29 列（Ver/CRF/Review group/UAT…） | 行数命中，**列形差距未解** |
| Subject Status | 无 | **4=4 行**，【表单.字段】条件记法 | 4 行 | 对齐（我方中文状态 vs 标准英文状态，小差） |
| Matrix / Dynamic 归类 | 无 | Matrix 130 行（forms 几乎全 SV）、Dynamic 715 行（Dynamic Visit 253） | Matrix 44 行（条件表单 CA125/KPS 等）、Dynamic 216（Dynamic Visit 4） | **主要残留差距：访视矩阵条目的跨页归类与条件表单映射口径不同** |
| Sheet 清单 | 8 页自创 | 9 页 | 9 页（含杂项 Sheet2；Rave 在 Edit Checks 前） | 主体一致；页序与杂页属实例差异 |

bulk 路径实测：8 个 NDJSON 规则文件（crossField 849/fieldLevel 709/dynamic 715/matrix 130/manualReview 16/subjectStatus 4/versionHistory 6）经文件引用传入，5 次 write 调用 documentJson 仅 0.8–0.9KB；两次误传非清单参数 `templateDirectory` 后模型自行修正。manualReviewProgramming 区 8 条规则识别标准无此页后未写入（NDJSON 留存，未丢失）。
