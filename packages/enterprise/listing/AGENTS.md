# 临床 Listing 代码车道

## 固定流程

模型处理 Listing 时必须依次调用：

1. `enterprise_listing_inspect(project)`：获取 `doc/**` manifest、辅助 Excel 结构与 ALS 语义、数据集元数据。
2. `enterprise_listing_read_document(project, documentId, chunkIndex)`：从 0 到 `isFinal` 读完每个需求文件的全部分片。
3. `enterprise_listing_run_code(project, code)`：生成全部业务 Listing。
4. `enterprise_listing_publish(project, scenario)`：统一发布一个 Excel 工作簿。

## 需求理解自审 U-Gate 与交付对账 G-Gate（2026-09-19 定案，r_manual/r_pk 通用）

- **U-Gate（写码前强制，read_document 之后、DSH-BUSINESS-ZONE 生成之前）**：产出
  《需求理解矩阵》——spec 需求逐行/逐变量 `口径判定 → 数据源证据 → 置信级 E(实证)/
  I(推断)/U(未知)`，并红队复查三类必查：①号体系（筛选号/随机号/LIMS 形态两侧键
  实证）②时间戳来源（录入戳 vs 业务时刻，全行恒定差值+时刻分布双重实证）③边界
  off-by-one（时点/访视/窗口枚举值域逐项对表）。**100% 理解判据=矩阵无未处理 U 级**：
  每项要么实证升级 E，要么列待确认清单给用户出路（禁止自挑相近字段代理实现后当
  PASS）；I 级汇报中显式声明推断依据。矩阵随交付汇报留存，条目与生成区证据注释
  一一对应。详见知识库 router「U-Gate」节与各场景库首条门禁。
- **G-Gate（交付前强制）**：项目存在 golden 基准（golden_gt/golden2=已交付代码
  同数据产物）时，交付汇报必须先完成双跑逐文件 QC（xlsx 逐 sheet 哈希 + rds
  列序/class/label/逐单元格）：0 差异才可宣称交付；有残差先 harness 主导自修
  （换数据探索路径/重读 spec/修正成区），修不动如实列残差清单与已排除假设。
  比对器用 verify 根目录工具（compare_one.py/compare_manual.py/gt_rds_one.R/
  gt_rds_manual.R），不得用按列名比对的 datasetQC 替代值级对账。
- **D-Gate（交付前"可交付"四查，逐条给结论，不许默认）**：①根路径=交付运行时的
  项目根（搬机器/换路径须改默认值或声明用 DSH_R_PROJECT_ROOT 覆盖）；②单文件
  自包含（无 source()/无 .dsh 探针脚本依赖；依赖仅基础包，服务器无 python/无网络
  安装）；③[REPLACE]/待确认清单逐条给当前状态（已实证/待用户确认）；④产物命名·
  落盘目录·行数/flag 计数与 spec 契约一致，QC 报告与残差清单随交付。详见知识库
  router「D-Gate」节。

## r_manual 车道（2026-09-07；2026-09-19 起模板零业务逻辑）

DVP 已固化、目录按固定契约投递（`<项目根>/<项目名>/Project_Data/01_Raw_sas/Manual Listing/<数据日期>/`）的
项目，交付物是一份可独立 `Rscript` 运行的单文件 R 程序，不走上面四步，改调
`enterprise_listing_run_r(project, studyKey, dataDate, oldDate?, password?, render?)`：

- project（项目目录名）/ studyKey（方案号）/ dataDate 由用户提供，不得推断。
- **模板零业务逻辑（与 r_pk 同型，2026-09-19 落地）**：模板 `r-templates/manual_listing.R.tmpl`
  只含契约层（读数缓存/密码推导/ALS/解码/PT+WHODrug 装载/展开原语/输出样式/运行摘要，
  与已交付程序同源——manual-listing-r skill 骨架）；业务逻辑一律由 harness AI 识别
  spec 后写入三个 DSH-BUSINESS-ZONE 生成区（B1 context=受试者上下文与项目参照表/
  B2 listings=DVP 逐行 outlisting 装配/B3 titles=LISTING_TITLES 显示词表），未生成即
  运行 fail-fast 并给出生成契约出路；生成后 render=false 执行。首次调用渲染骨架 →
  AI 逐区生成 → render=false 重跑。
- 首次调用按模板渲染程序到
  `SAS_Program/SAS_program/Manual Listing/<studyKey>_Manual_Listing.R`；回执只含
  listing/行/flag/sheet 计数、产物文件名、R 告警。
- DVP 列职责：Visits Applied To × Related Fields 定范围；Condition 定行（Output if / flag=duplicated）；
  Column Heading 定列（Raw data + 【表单】上下文列 + 派生列 + 匹配病史/AE/CM/PR 拆行）。
  **按列白名单读 DVP（2026-09-10 用户铁律）**：只读上述需求列 + Data Source/Form Name 定位列；
  其余列（Report Description / Discrepancy Text / Unique ID / Add-Delete-Update / DB Comments /
  UAT result / Initial Date / DM Comments）与 spec 需求无关——**不识别、不读取、不转述**，
  用户贴出的无关截图同样整图不读（限制死）。
  Content 页 Form Name 显示**中文表名**（与 B1 同款，含同名（sheet 名）去重后缀；词表 =
  ALS 官方词汇，见下方"表单名称列口径"与"场景知识库"）。
- 访视规则（HXN6005 2026-09-09 踩坑固化，详见模板头注释 V1–V4）：Visits 非 ALL 必须落 `vis_scope`；
  Form Name/Visits 可能限定多个表单（各自访视范围）；计划外访视=VISITOID 99 + 关键词 oid 兜底；
  按访视名派生日期一律关键词包含匹配（覆盖 Part A/B 与 Part C 等多套同概念 OID），禁写死 OID；
  vis_scope/smp_at/dose_at 零命中会 note() 进回执——收到零命中告警必须先核对访视关键词再交付。
- 实验室检查 listing 口径（HXN6005 2026-09-09 DM 口头变更 + KXZY 成熟项目佐证，详见模板头注释 L1–L3）：
  实验室检查/实验室检查1 的多项目模块 = 解码长表原样输出，不拆编号、不加匹配列、打包编号留原单元格；
  spec 的"CS 时匹配拆行"条款对该类表已被取代。妊娠等单项目表与其他表单仍按 spec CS 匹配；
  新项目口径不同时以 DM 书面确认为准并在行注释标日期。
- 表单名称列口径（HXN6005 2026-09-10 DM 要求）：listing 有访视列（VISIT）时，表单名称列（TNAME）
  保留并紧跟访视列后（多表单合并 sheet 靠它区分行属哪个表单）；无访视列的表（如 SUBJECT 参与者信息）
  不加——没有的就没有，不乱加。日期列按原始 SAS 数据集显示（纯日期 YYYY-MM-DD 不带时间后缀）。
  **表单名称/Content Form Name/B1 一律 ALS 官方词汇，零自造（2026-09-10 晚定案）**：
  实验室检查类 = ALS 访视表"访视内显示名称"（模块名：血常规/血生化/凝血功能/尿常规/
  尿沉渣分析/血清FSH检测/HBV-DNA/HCV-RNA；LB_07 未做记录也是模块级）；其余表单 =
  ALS"表名"原样（**含 生命体征1/12导联心电图1 等编号表名——官方名，勿改写**）；
  合并 sheet 各官方名 + 连接；同名标题（MH×3/AE×3/PR1×2/SV×2）自动追加（sheet 名）
  后缀去重（客观代码，勿自造"（处理要点）"类描述词）。模板内 `LISTING_TITLES`+
  `LAB_TN` 提供，替换在 als_arrange 之后的显示层（TNAME 原值是 ALS 识别键）。
- 调整需求：直接编辑该 R 文件（`## rowN | Manual_*` 节），`render=false` 重跑；
  换数据日期同样 `render=false`。`render=true` 用模板覆盖重置。
- 宿主 `src/r-runner.ts`；运行时参数经 `DSH_R_*` 环境变量传给 R；部署配置 `rListing`。

## r_pk 车道（2026-09-10，PK Mapping）

PK/PD Mapping Spec（双盲 BE 项目）场景：交付物是单文件 R 程序，把 PK 浓度数据
（02_Raw_csv/PK Mapping/<数据日期>/，**只读不改**）与 EDC sas（01_Raw_sas/PK
Mapping/<数据日期>/，Rave 形态导出）按 受试者×周期×采样时点 合并成 spec 行序
23 变量映射数据集 + 3 张 QC sheet。调 `enterprise_listing_run_pk(project, studyKey,
dataDate, form?, studyCode?, blindMode?, password?, render?)`：
- **研究形态（form，两型分模板）**：`be`（默认）=双盲 BE（传输件 Period/Sampling
  Time(h) 列）；`sad-mad`=SAD/MAD I 期（传输件 Matrix/Day Nominal/Hour Nominal 列，
  模板 pk_mapping_sadmad.R.tmpl；studyCode 必填=完整方案号，ANALYTE 经 [REPLACE]/
  DSH_R_PK_ANALYTE 提供，交付=血浆单表 CSF_OUTPUT 开关）。形态由 spec 与投递件表头
  实证决定，签名不命中向用户澄清，禁止猜。
- **模板零业务逻辑（2026-09-17 用户定案）**：两 PK 模板只含 harness 契约层
  （cfg 覆盖/读数发现/守卫红线/落盘三件套/运行摘要/通用工具），业务逻辑一律由
  harness AI 识别 spec 后写入 DSH-BUSINESS-ZONE 生成区再 render=false 执行；
  未生成即运行 fail-fast 并给出生成契约出路。

- **双盲**：`blindMode=blinded`（默认）SUBJID 掩码（S001…，映射不落盘）+ SEQ/TRT/
  SEX/AGE/HEIGHT/WEIGHT/BMI 七列不出，QC 同步掩码整本可外发；`unblinded` 需在程序
  配置段填随机化 schedule（RAND_SCHED_FILE，[REPLACE P6]）。
- **前置条件**（模板头 C1–C5，数统编码口径）：EC 给药=ECYN 肯定；RT 给药时刻=
  ECSTDAT 日期+ECDSTTIM（ECSTDAT 自带时间为录入时间戳、绝不采用；ECDSTTIM 异常时
  给药时刻置 NA 进 QC）；VS2 人体测量=筛选期+VSPERF 肯定（无筛选期行的受试者 NA
  不拿治疗期值充数）；PC 采样=PCDAT 非空（不做启发式过滤防误杀）；**COHORT 分组
  是载荷字段**：fasted→PC1TPT(27点)/fed→PC3TPT(29点)/PC2 全保留，归类精确表+关键词
  兜底。QC 含 COHORT 无法归类/无随机化记录/FAST 双向矛盾（两组给药前均禁食≥10h）/
  PK 重复行/Analyte≠SLFS；VISIT=文件夹名原样（含 "(Period n)" 后缀）。
- **值域查证准则**：分组/编码类字段的归类规则必须先去 rawdata 查实际值域再定死
  （去重值+频数/格式命中数聚合层面，受试者行值不出域）；本项目实证：REGIME_NAME=
  Fasted(44)/Fed(44)/空(98 未随机化)；raw 列=显示文本而 _STD=数字码（方向与常见
  Rave 相反）；时点标签 27+29 个全入 TPT_HOURS_OVERRIDE。
- **成熟项目惯例**（模板头 X1–X3）：原始 PK excel/EDC zip 只读不改，产物只落
  Output；RT 为负按 0 截断 + QC 留痕；时点标签→小时优先 TPT_HOURS_OVERRIDE
  显式映射表（真实标签实证后填写），文本解析兜底。
- **读数适配**：Rave 形态（Subject 内部名 ↔ SUBJID 筛选号经 SUBJ 表归一、_STD
  列解码、FolderName→周期映射表）；PK 表头空格/大小写不敏感（必需列缺即 stop）。
- 程序/交付：`SAS_Program/SAS_program/PK Mapping/<studyKey>_PK_Mapping.R`（spec
  也放这里）→ `Output/04_Out/PK Mapping/<studyKey>_PK Mapping_<dataDate>[(blinded)]
  .xlsx/.RDS`。需求分析/待确认清单/回归记录见
  `docs/enterprise/LISTING_PK_MAPPING_DESIGN.md`。spec 的 Cover Page 类 sheet 不读。

## 数据角色

- rawdata：SAS/XPT/CSV，是 `datasets` 中的处理对象。
- spec/ALS：字段和业务规则，不是数据源。
- 标准范例：只定义工作簿结构和样式，不是数据源。

## 数据边界（2026-08-28 现行口径，ADR-0010）

数据安全开关由宿主设置页控制，默认开启；模型请求不能伪造。开启时红线只有两类，按项目路径与数据源头判定，不按字段名，无内容模式扫描：

- **dataset**：数据集（sas7bdat/xpt/csv，含加密归档解出）的原始行值不出域 → inspect 回执只含元数据（列名/行数/dtype/nullCount/uniqueCount），行样本默认根本不构建。
- **aux-excel**：`doc/` 外 spec 需求辅助 Excel 的业务单元格值不出域 → 回执只含结构、统计与 ALS 语义（mappings/codelists/designSheets），rows 默认根本不构建。ALS 设计 sheet 三层识别：已知 EDC 表头适配器（`discovery._DESIGN_SHEET_SIGNATURES`，Rave/太美/ODM-DED）→ 名字无关的结构推断（`design_inference`：值贴合数据集列名/数据集名，且无受试者主键列、无日期列、行数不超变量总数量级）→ 学习型注册表（`edc_profiles`，新 EDC 首次推断成功即登记表头形态与列角色，只存结构不存单元格值，此后无数据集也能识别）。设计 sheet 的单元格是方案结构，不入保护值索引；受试者主键值（按结构识别）永不豁免。

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
- 发布结果始终是一个 `<项目标识>_{SCENARIO}_LISTINGS.xlsx`（项目标识 =
  项目目录名，跟随申办方 `<方案号>_<文档类型>` 命名规范）。
- 可选：`attrs["_skip_default_template"] = True` 跳过审核列注入；
  `attrs["_layout"] = {header_rows, header_columns, anchor_cell, freeze_panes,
  back_link, column_widths}` 接管业务页排版（非法即发布失败）。

## 百奥知（BioKnow/Boent）EDC 数据模式（manual/medical 场景通用）

SAS 导出带 `SID/RECORDID/SUBTRID/CSN/VISITOID` 键列、FORMATS 格式目录时按本节处理（r_manual 车道模板已内置，medical 场景 run_code 生成 pandas 逻辑时同样适用）：

- **判定类字段（临床意义/检查结果是否 CS）必须按列的 format.sas 绑定识别**，不能按列名/标签猜：典型绑定 `$VSCLSIG1A/$CTCLSIG/$PERES`，值域 1正常/2异常无/3异常有临床意义(/4未查)。实测 ADB 的 ADBORES 标签是"检查结果"却绑判定格式。
- **编号字段是打包单元格**：`编号,名称,日期；编号,名称,日期`（全角；分隔，也有纯编号 `1；2` 形态）。CRC 多选病史/AE/用药记录关联时即此形态。
- **CS 匹配链路**（spec"当检查结果为CS时匹配对应的病史或AE…拆分一行仅显示一条"）：
  判定列=CS 的行 → 病史编号/不良事件编号各自按；拆分 → **两条独立链路**（病史→MH 表、
  AE→AE 表，键=受试者+序号 CSN）→ 从目标表取**当前值**的名称/开始/结束 → 一条链接一行，
  匹配编号**只显示纯序号，不带 MH#/AE#/CM#/PR# 前缀**（2026-09-10 DM 变更，推翻早期
  前缀口径；跨源区分靠 名称/来源 列，前缀仅可作内部判重唯一键不进显示面）；
  查无记录→编号照显、名称日期留空；非 CS 行不拆。
  分槽位形态（生命体征 VSCLSIG1-4 + MHNO1-4/AENO1-4）按槽位逐一判定拆分。
- **Raw data 红线**：spec 的 Raw data 列原样输出（含打包原文），永不改写/裁段/置空；
  拆分只作用于程序抓取的匹配列。原文 vs 匹配对照是 DM 发现编号录错/失活的依据。
- ALS（数据库定义 xlsx）：列名/列集合/列序均以 eCRF（表|变量|变量名|编号）为准，
  内嵌表字段按"内嵌设计"归并父表；详见 r-templates/manual_listing.R.tmpl 头注释。

## 百奥知 Manual Listing 场景知识库（端到端复用，2026-09-10 全项目收官沉淀）

示例项目 83 listing 全流程实战（八轮审计 + 显示层多轮纠偏，双侧回归全绿）+ 同系统成熟
项目佐证的总沉淀。同系统新项目按此走，可避开全部已知坑。**权威词汇源 = ALS 数据库定义
的 访视表（表名|表|访视内显示名称）/eCRF界面（表|表名称，含 SUBJECT）/Casebook 非公共
访视（表×访视矩阵，编号表名=同表单挂不同访视的实证）。**

### 实现口径终案表（每条均用户/DM 拍板，勿走回头路）

| 口径 | 终案 |
|---|---|
| 处理顺序 | Visits Applied To → Related Fields → Condition → Column Heading；Report/Discrepancy 禁读禁用 |
| Raw data 原文列 | 永不改写/裁段/置空（含打包原文）；拆分只作用程序匹配列 |
| 匹配编号 | 只显纯序号（无 MH#/AE#/CM#/PR# 前缀）；前缀仅作内部判重键 |
| CS 匹配 | 六步链路；取目标表当前值非快照；查无记录编号照显名称空；非 CS 行不拆 |
| 实验室检查 | 长表直出不拆分（L1-L3，模板头注释）；表单名称细分到访视内显示名称；LB_07 未做记录也模块级 |
| 表单名称列 | 有访视列才加、紧跟其后；无访视列不加 |
| 显示词表 | Content/B1/表单名称 = ALS 官方零自造；合并 sheet 各名 + 连接；同名自动（sheet 名）后缀去重 |
| Condition=NA 实验室行 | 不带 是否进行检查 过滤（直出含"否"记录） |
| ALS 三样 | 列集合/显示名/列序按 eCRF；内嵌归并；TNAME 原值是 als_arrange 识别键，替换在其后 |
| 值解码 | 按列 format.sas 绑定全局解码（decode_by_sasfmt）；VISITNAME 不预解码 |
| 日期显示 | 纯日期 %Y-%m-%d；真日期时间保留；00:00:00 分辨后缀 vs 真值 |
| flag | 仅 Condition 明确要求处；不注入空 Flag1 |
| 输出样式 | Content 七列 + A1 居中 + 中文 Form Name；业务页 go back/B1=Content 同款/表头 #EDF2F9 行高60/审核四列/空表占位 |

### 端到端流程（10 步）

定位输入（DVP/数据 zip/数据日期）→ 白名单读 DVP 六列并逐行映射（映射表先给用户确认）→
读 ALS（eCRF/内嵌设计/访视表/eCRF界面/Casebook）→ 探测 SAS 元数据（标签/列/format 绑定/
FORMATS 全量）→ 渲染 `manual_listing.R.tmpl` 逐行核查节 → 跑通（listing 数=DVP 行数、flag
抽查）→ 按终案表自查显示层 → spec Unique ID 回写（listing 代码进 'Unique ID (provided by
DBD)' 列，最小 XML 手术副本交付，原 spec 不覆写；listing 增删/改名/换序才重跑）→ 有旧版
做新旧比对（Rcompare 或行级 flag+列级变更集，Modified 只着变更格）→ 交付+回执。

### 回归方法论（改任何一处必做）

- 双侧 diff 验收：改动前后输出逐格比，差异必须恰好等于预期面；行列零意外变化。
- 三级自洽审计：B1 == Content Form Name == sheet 内表单名称列（官方词表对账）。
- tmpl 回归：`DSH_R_*` 环境变量在 scratch root 直跑 .tmpl（RData 缓存 + OUTPUT_PREFIX
  区分前后产物）+ `pnpm test`（listing 包单测 40 项）。
- 工具坑：openpyxl read_only 按声明维度截断 openxlsx 业务页行（假报零差异，须非
  read_only）；openxlsx 产物带悬空 drawing rel（严格解析器需剥离）；R 命名向量
  `x[[缺失名]]` 越界（先 `%in% names()`）。

### 配套资产

`r-templates/manual_listing.R.tmpl` 内置公共段（密码推导/sas7bcat 挂载/解码/ALS 段/
expand_ref/cmp 样式输出/`LISTING_TITLES`+`LAB_TN` 显示层）；成熟先例与更细粒度经验在
用户级 manual-listing-r skill（场景知识库 baiaozhi-scenario-kb.md 及 references/、
cmp_export.R 比对函数、spec_writeback.py 回写工具）。

## 场景规则

- manual / medical：固定 `Content` 结构、RT01 业务 Sheet 样式（2 行表头：第 1 行标题/返回链接，第 2 行 Label，第 3 行起数据；不再单独展示变量名 oid），自动补齐比较审核列。
- report：固定 `Cover Page`，业务页采用 DM Status Report 范例的单层表头、行高与列宽，不补比较审核列，不展示变量名 oid。封面值可由首个 DataFrame 的 `attrs["report_metadata"]` 提供。
- rbqm：业务结构按需求生成，不强制比较审核列，但套用 RT01 视觉样式。

完整机械契约见 `docs/enterprise/LISTING_MULTI_SHEET_SPEC.md`。
