# PK Mapping R 车道接入设计（r_pk 场景，2026-09-10）

首个项目：400311（双盲、四周期交叉 BE 项目）。spec = `400311_pk Mapping Spec_v0.2_20260908.xlsx`
的 `PK (PD) Non-Compartmental Model` sheet（23 个变量，No.1–23；Cover Page 类 sheet 一律不读）。
本文是需求初始分析 + 车道设计的权威记录；模板 `r-templates/pk_mapping.R.tmpl` 是实现载体。

## 1. 需求本体：两条数据流合成一张 23 变量映射数据集

PK Mapping 不是 DM 核查 listing，而是**映射数据集生产线**：把生物分析浓度数据（PK csv）
与 EDC 临床数据（Rave 导出 sas7bdat）按 受试者×周期×采样时点 合并，产出 NCA 分析用的
23 变量数据集（spec 行序）：

| # | 变量 | 来源 | 程序逻辑 |
|---|---|---|---|
| 1 | STUDYID | 固定值 | `400311`（=studyKey）；QC 校验 PK csv 的 Study ID 列一致 |
| 2 | SUBJID | PK csv Subject | 筛选号（R0101 型）；须与 EDC `SUBJ.SUBJID` 一致（QC 校验）；**揭盲前盲化** |
| 3 | COHORT | EDC `RAND.REGIME_NAME` | 空腹组(A/B)/餐后组(C/D)；输出值形态待确认，默认原值透传 |
| 4 | FAST | EDC `EC.ECFSTYN1` | 给药前过夜禁食≥10h；解码表待确认，默认 `_STD` 列优先透传 |
| 5 | SEQ | 随机化表 | **揭盲前不传输**；揭盲后从随机化 schedule 文件按受试者并入 |
| 6 | TRT | 随机化表 | **揭盲前不传输**；揭盲后按 受试者×周期 并入 |
| 7 | PERIOD | PK csv Period | 1/2/3/4；**999=计划外访视** |
| 8 | VISIT | EDC 访视文件夹名 | D1/D6/D11/D16→Day1/6/11/16，UN→Unscheduled；文件夹→周期映射配置化 |
| 9 | ANALYTE | PK csv Analyte | 固定 SLFS（透传） |
| 10 | DOSE | EDC `EC.ECDSTXT`+`ECDOSU` | 单位解码 spec 明确：1=Tablet，2=Other→取 `ECDOSUOT`；拼接格式待确认 |
| 11 | NTPT | EDC `PC1.PC1TPT`/`PC3.PC3TPT` | 空腹组 27 时点 / 餐后组 29 时点；标签→小时数解析后与 NT 对齐 |
| 12 | NT | PK csv Sampling Time(h) | 数值；Pre-dose=0 |
| 13 | RT | 派生 | (同周期 `PCx.PCDAT` − `EC.ECSTDAT`)/3600，保留 3 位小数；计划外行基准待确认（默认最近前次给药） |
| 14 | Concentration | PK csv | 数值或 BQL，**字符型保留原样** |
| 15 | UNIT | 固定值 | ng/mL |
| 16 | LLOQ | PK csv | 透传 |
| 17 | ULOQ | PK csv | 透传 |
| 18 | SEX | EDC `DM.SEX` | 1=Male 2=Female（spec 明确）；**揭盲前不传输** |
| 19 | AGE | EDC `DM.AGE` | 数值；**揭盲前不传输** |
| 20 | HEIGHT | EDC `VS2.HEIGHT` | cm；**揭盲前不传输** |
| 21 | WEIGHT | EDC `VS2.WEIGHT` | kg；**揭盲前不传输** |
| 22 | BMI | EDC `VS2.BMI` | kg/m²；**揭盲前不传输** |
| 23 | COMMENTS | PK csv Comments | 透传（列缺省则留空） |
| 24 | （完） | | 23 个业务变量（spec No.1–23 行） |

双盲口径：**8 个受限项**（SUBJID 盲化保留 + SEQ/TRT/SEX/AGE/HEIGHT/WEIGHT/BMI 整列不出，
实删 7 列），由 `blind_mode` 开关控制：`blinded`（默认）输出 16 列 + SUBJID 以确定性掩码
替换（排序后 S001…，映射不落任何输出文件）；`unblinded` 需提供随机化 schedule 文件后
输出全量 23 列。

## 2. 数据源实证（结构级探测，未读取真实数据值）

- **EDC = Rave 形态导出**（与 HXN6005 百奥知形态不同）：系统列 `Subject/FolderName/
  DataPageName/RecordId/RecordPosition/*_STD`，**无** FORMATS 目录/sas7bcat/VISITOID。
  解码依据 = `<字段>_STD` 列（Coded Value），不走 format.sas 绑定。
- 需求表齐全：SUBJ(R0101 型 SUBJID)、RAND(REGIME_NAME)、EC(ECYN/ECFSTYN1/ECSTDAT/
  ECDSTXT/ECDOSU/ECDOSUOT)、PC1(4752 行,PC1TPT/PCSTAT/PCDAT)、PC3(5104 行,PC3TPT)、
  PC2(0 行、无 TPT 列，计划外采样页)、DM(SEX/AGE)、VS2(HEIGHT/WEIGHT/BMI)、UN。
- **PK csv 形态**（以 dummy 数据确证）：列 `Study ID / Analyte / Subject(带尾随空格) /
  Period / Sampling Time(h) / Concentration(ng/mL) / LLOQ(ng/mL) / ULOQ(ng/mL)`，
  无 Comments 列（真实数据可能有，可选）；Concentration 数值或 BQL。表头匹配必须
  去空格/大小写不敏感（dummy 的 `Concentration(ng/mL)` 与 spec 的
  `Concentration (ng/mL)` 差一个空格）。

## 3. 目录契约（固定格式，只有项目根可变；以服务器初始代码实测路径为准）

```
/mnt/project/<项目名>/
├── Project_Data/02_Raw_csv/PK Mapping/<dataDate>/   ← PK 浓度 csv/xls（只读，程序不回写）
├── Project_Data/01_Raw_sas/PK Mapping/<dataDate>/   ← EDC sas zip（+RData 缓存）
├── SAS_Program/SAS_program/PK Mapping/              ← R 程序 + PK Mapping Spec xlsx
└── Output/04_Out/PK Mapping/                        ← 交付 xlsx/.RDS（唯一输出目录）
```

注意：EDC sas 在 **01_Raw_sas**（服务器初始代码实测），与此前"02_Raw_sas"的口述不一致
已按真实代码修正；PK csv 确在 02_Raw_csv。原始 PK excel/EDC zip 只读不改（红线 X1），
产物只落 Output。

## 3.5 前置条件（数统编码口径，2026-09-10 值域查证后定稿）

spec 未明说的取数前提按临床惯例落地。**分类字段值域已从 rawdata 查证**（去重值/格式
命中数聚合层面，未取受试者行值），对应 [CONFIRM] 全部闭环：

| # | 前置条件 | 落地 | 值域实证（2026-09-10） |
|---|---|---|---|
| C1 | EC 给药记录 = ECYN 肯定 | AFFIRM 容错集（Yes/是/Y/1） | raw 全 352 行="Yes"、_STD="1" |
| C2 | RT 给药时刻 = **ECSTDAT 完整时间戳**（spec 原文 RT=<PCx.PCDAT>-<EC.ECSTDAT>） | dt_posix(ECSTDAT) 直取 | **2026-09-11 逐行对账推翻旧口径**：ECDSTTIM 与 ECSTDAT 时间恒差 +10h（352/352，前夜空腹开始相关时刻）；ECSTDAT 自带时间恒为晨间真实给药时刻（逐受试者全 08:xx/09:xx）；旧"日期+ECDSTTIM 拼接"致 RT=NT-10h（190 行截 0、正 RT 只剩 12/16/20/24 点），修正后 216/224 行 RT≈NT（中位偏差 0.000h）、仅 8 行给药前采样小负→按 0 |
| C3 | VS2 = 筛选期访视 + VSPERF 肯定 | 全局两级：有筛选期行则只取筛选期（无则 NA，不拿治疗期值充数） | VS2 全表 FolderName="Screening (Day-7~Day-2)"、VSPERF="Yes" |
| C4 | PC 采样行 = PCDAT 非空 | 不做启发式过滤防误杀 | PCPERF 全"1"、PCSTAT/PCREASND 全空，无排除面 |
| C5 | **COHORT 分组是载荷字段**——决定时点来源：fasted→PC1.PC1TPT(27点)、fed→PC3.PC3TPT(29点)、PC2 全保留 | 精确表 COHORT_GRP_EXACT + 关键词兜底（两侧 tolower + match，命名向量按名索引区分大小写）；归类不了退化全源 + note | REGIME_NAME = Fasted(44)/Fed(44)/空(98=未随机化 RANDTRIG=0) |

C5 衍生 QC（三类新增/修正）：
- COHORT 无法归类（REGIME_NAME 非 fasted/fed，原值照传 + 时点源退化全源）
- PK受试者无随机化记录（RAND 无 RANDTRIG=1 记录但有浓度行；原"已随机化无PK数据"
  必须按 RANDTRIG=1 过滤——98 个空白 REGIME_NAME 是未随机化，不能进 QC）
- COHORT 与 FAST 矛盾（**双向**：两组给药前均要求过夜禁食≥10h——"fed" 是给药前
  高脂餐不是不禁食；实测 352 行全 Yes）

值域查证的两个方向性修正：
- **raw/_STD 方向与常见 Rave 导出相反**：raw 列是显示文本（Yes/Tablet/1=剂量文本），
  _STD 是数字码（"1"）→ 解码函数 disp_of 改为 raw 优先、_STD 兜底（ECDOSU_DECODE/
  SEX_DECODE 仅在 raw 缺失/纯码数据时兜底生效）
- **时点标签全部以 Post dosing/(pre-dose) 结尾**（27+29 个去重值，如
  "0.166H（10min）Post dosing"、"within 2 hours prior to dosing (pre-dose)"），文本
  解析器不适用 → TPT_HOURS_OVERRIDE 显式映射表按实际标签全量填入（大小写不敏感查找），
  文本解析降为兜底

成熟项目惯例同步吸收（参考同类 PK Mapping 程序 + 2026-09-10 用户明确）：
X1 原始 PK excel/EDC zip 只读不改；X2 RT 为负按 0 输出、QC_Derive 留痕；
X3 时点标签→小时优先查显式映射表 TPT_HOURS_OVERRIDE（真实标签实证后填写），文本解析兜底。

## 4. 车道设计（scenario = `r_pk`）

项目实例化：本项目程序直接建在用户初始代码 `PK Mapping djh.R`（项目根目录）上——草稿
结构/路径/函数原样保留，业务逻辑段（PK 读取别名匹配/SUBJ 键归一/C1-C5/合并/双盲/QC/
输出）按本设计补齐；与 r_pk 模板同源同算法，合成数据验证 22 项断言全 PASS。
（注：djh.R 顶部草稿函数 `alsmapping_saslabel` 调用 rave 版 drop_sys 无误，另补了 ALS
文件缺失守卫；DJH 的 `foldername`/`pk_data_file`/`RAND_SCHED_FILE` 等仍为 [REPLACE] 位。）

- 模板 `r-templates/pk_mapping.R.tmpl`，占位符与 r_manual 同名同机制（`cfg()` + `DSH_R_*`
  运行时覆盖 + `{{PROJECT_ROOT}}/{{STUDY_KEY}}/{{DATA_DATE}}/{{OLD_DATE}}/
  {{ZIP_PASSWORD}}/{{OUTPUT_PREFIX}}/{{SUMMARY_PATH}}/{{BLIND_MODE}}`）。
- 宿主 `RManualRunner` 参数化为 `RLaneRunner(spec, ...)`：r_manual 保持原 API/行为零变化
  （既有测试不动），新增 `RPKRunner`（PK_LANE_DIRS + 双数据目录校验 + blindMode 参数）。
- 工具 `enterprise_listing_run_pk(project, studyKey, dataDate, blindMode?, password?,
  oldDate?, outputPrefix?, render?)`；回执与 r_manual 同构（聚合计数/产物/告警，
  不含数据行值），`lane: 'r_pk'`。
- 程序文件名 `<studyKey>_PK_Mapping.R`；交付前缀 `<studyKey>_PK Mapping`，
  盲态产物加 `(blinded)` 后缀。
- 公共处理复用（不直接照搬）：locale 容错、zip 密码推导/解压、RData 缓存、
  summary.json 回执、Content+样式化输出骨架。读数层按 Rave 重写，
  新增 PK csv 层与双盲装配。

## 5. 输出物（2026-09-10 晚 DM 口径修正：PK 基础表 + 新加列）

**输出模型对齐成熟项目示例代码**：PK 表为基础表（列名/顺序/值原样保留），spec 需要
处理的变量作为**新加列** append 到右侧；交付物 = **一张平铺 Excel 数据表**（单 sheet
"PK Mapping"，表头冻结+筛选，无 Content/QC 页/审核列）。QC 一致性检查只进运行日志
note()。

| 新加列 | spec # | 来源 |
|---|---|---|
| SUBJID | 2 | PK Subject（盲态与基础表 Subject 列同掩码 S001…） |
| COHORT / FAST | 3/4 | RAND.REGIME_NAME / EC（C1 后） |
| SEQ / TRT | 5/6 | unblinded 才加（随机化 schedule） |
| VISIT | 8 | EDC 文件夹名原样 |
| DOSE / NTPT / RT | 10/11/13 | EC 拼接 / 队列选源时点标签 / (采样−同周期给药)/3600 负值截 0 |
| UNIT | 15 | 固定 ng/mL |
| SEX/AGE/HEIGHT/WEIGHT/BMI | 18-22 | unblinded 才加（DM/VS2 筛选期） |

盲态新加 8 列、非盲态 15 列；基础表已有列（Study ID/Subject/Period/Analyte/
Sampling Time(h)/Concentration/LLOQ/ULOQ/Comments）不重复添加。文件名
`<项目>_PK Mapping_<日期>[(blinded)].xlsx`，落 `Output/04_Out/PK Mapping`。

**匹配零命中防护**：PK Subject 与 SUBJ.SUBJID 零命中（或 <50%）时打醒目警告并说明
出路——dummy PK 的受试者号（R 样式）与真实 EDC SUBJID（实测 196 个全部 5 字符全大写
字母数字、非 R+数字样式）**零交集**，属数据事实非程序缺陷：用 dummy 跑真实 EDC 时
新加列必空，真实 PK 数据（spec 要求与 SUBJID 一致）到位即恢复。

**本地测试模式（对齐 manual listing）**：djh.R 内置 Windows 调试覆写段（服务器 Linux
不生效）——数据从项目根只读复制到 `localtest/<日期>/`（RData 缓存 + PK 文件），产物落
`localtest/Output/`，跑完 localtest/ 可整体删除；library 块容错加载（缺 tidyverse 退
单包、装饰库跳过）；文件头加 UTF-8 locale 容错行（中文文件名字面量在 Windows 上必须，
服务器无害）。

## 6. 待确认清单（2026-09-10 值域查证后收敛为 7 项）

1. ~~COHORT 输出值形态~~ **已闭环**：REGIME_NAME 实测 Fasted/Fed，原值透传即 spec 措辞。
2. ~~FAST 输出格式~~ **已闭环**：raw 值域实测全 Yes（显示文本在 raw 列），透传。
3. DOSE 拼接格式：`"<剂量> <单位>"` 单空格（实测 "1 Tablet"），DM 如要其他形态再改 DOSE_SEP。
4. SUBJID 盲化编码方案：S001 型（排序确定性，默认）vs 申办方指定规则。
5. 计划外访视（PERIOD=999）的 RT 基准：最近前次给药（默认）vs 留空。
6. 随机化 schedule 文件路径与列契约（揭盲后启用 SEQ/TRT 时必须提供）。
7. VISIT 输出值：Day1/Day6/Day11/Day16/Unscheduled（默认词表，可按 DM 偏好调整）。

已闭环项的依据（2026-09-10 rawdata 值域查证，聚合层面）：REGIME_NAME=Fasted(44)/Fed(44)/
空(98 未随机化)；ECYN/ECFSTYN1/VSPERF raw 全 Yes；ECDSTTXT 全"1"+ECDOSU"Tablet"；
ECSTDAT 时间=真实晨间给药时刻（2026-09-11 修正，见第 9 节；旧"录入时间戳差 13-14h"
结论系误判）；PC1TPT/PC3TPT 27+29 个标签全入
TPT_HOURS_OVERRIDE。**注意真实 SUBJID 形态与 dummy 的 R0101 样式不同**（^R\d{4}$ 命中
0/196），SUBJID 值不读取，联表按相等匹配不受影响。

## 7. 复核修订记录（2026-09-10，以数统 DM PK Mapping 经验逐行复核 spec 后修正）

以 23 变量逐行复核 spec 与实现的偏差，发现并修正 5 处（已进模板并 e2e 实证）：

| # | 偏差 | 修正 |
|---|---|---|
| R1 | VISIT 默认词表截短了文件夹名（"Day1"/"Unscheduled"） | VISIT=文件夹名原样：spec G 列枚举（"Day1 (Period 1)"/…/"Unscheduled Visits"）与真实 FolderName 逐字一致，spec 明示 Sourced from folder name |
| R2 | FAST 矛盾 QC 曾误收窄为"仅 fasted 组" | 双向：两组给药前均要求过夜禁食≥10h（"fed" 是给药前高脂餐不是不禁食），实测 352 行全 Yes |
| R3 | ECDSTTIM 非 HH:MM 时退回 ECSTDAT 整体解析 | 危险兜底：改为给药时刻不可定 → EC_DT=NA（RT/DOSE 进 QC）。（2026-09-11 C2 推翻后 ECDSTTIM 整体退出 RT 计算，本项的 ECDSTTIM 分支已随之移除，见第 9 节） |
| R4 | 漏 QC：PK csv 同受试者×周期×时点重复行（再分析/重复投递常见） | QC_Match 新增"PK数据重复行"（重复行照留输出，DM 裁定） |
| R5 | 漏 QC：Analyte≠SLFS（spec 固定分析物） | QC_Derive 新增"Analyte非SLFS" |

另澄清 P6：随机化 schedule 的联表键可能按 RAND_ID（EDC RAND 表含 RAND_ID）而非筛选号，
揭盲后用哪个键等 schedule 到手再定（列契约 Subject+Period+Seq+Trt 长表不变）。

## 8. 回归验证（最终态 2026-09-10）

- 单测：listing 包 47 项全绿（含 r_pk 车道 6 项）；tsc 无错误。
- 端到端 v2（合成数据镜像真实值域形态：raw=显示文本/_STD=数字码、ECSTDAT 带录入
  时间戳假时间 21:30、PC1 塞 fed 受试者诱饵行(+1h)、PC 时点用真实标签、PK 重复行与
  Analyte≠SLFS 诱饵、六种受试者状态覆盖全部 QC 类别）：盲态/非盲态两跑 **33 项断言
  全 PASS**——
  - 结构：sheet 序、盲态 16 列/非盲态 23 列、双盲列差恰 7 受限列、列序=spec 行序；
  - 双盲：SUBJID 全掩码（含 PK-only 号也入掩码）、QC 同步、数据体零真实号；
  - 前置条件：C2 给药时刻=日期+ECDSTTIM（RT=0.099，假时间戳未被采用）【旧口径下的
    断言；2026-09-11 C2 推翻（第 9 节）后合成夹具需按"ECSTDAT 自带真实给药时刻"
    重建该断言，ECDSTTIM 不再参与】、C1 ECYN=No
    排除、C3 筛选期优先（170 非 999 诱饵）/未进行不取值、C5 fed 取 PC3 源（诱饵
    +1h 行被裁，RT 0.099 非 1.099）、P8 真实标签经 TPT_HOURS_OVERRIDE 解析；
  - QC 全类别：QC_Subj 六类（含双向 FAST 矛盾 fasted+fed 各 1 行）、QC_Match 三类
    （双向孤儿 + PK 重复行）、QC_Derive 五类（含负 RT 截 0、Analyte 非 SLFS）、
    VISIT=文件夹名原样含 Period 后缀。

## 9. C2 推翻重写与自检增强（2026-09-11，真实项目数据逐行对账定案）

### 9.1 C2 给药时刻口径修正（需求理解错误，非代码实现错误）

- **证据链**（真实项目 rawdata 逐行对账，受试者掩码、只输出偏差聚合）：
  ECDSTTIM 与 ECSTDAT 自带时间恒差 **+10h**（352/352 行全一致，非 13-14h、非随机
  录入延迟）；ECSTDAT 时间恒为晨间（逐受试者全 08:xx/09:xx）＝真实给药时刻；
  ECDSTTIM（18:00/19:01）＝前夜空腹开始相关时刻。旧口径"ECSTDAT 日期 + ECDSTTIM
  拼接"把给药时刻推后 10h → RT=NT-10h（179 行负值截 0、正 RT 只剩 12/16/20/24 点
  各=NT-10、中位 RT=0）。
- **修正**：`ec_dt <- dt_posix(ECSTDAT)` 完整时间戳直取（spec 原文即
  RT=<PCx.PCDAT>-<EC.ECSTDAT>）；ECDSTTIM 退出 RT 计算。修正后 216/224 行 RT≈NT
  （中位偏差 0.000h），仅 8 行给药前采样（NT=0）小负→按 0（spec "Pre-dose is
  recorded as 0"）；服务器复跑一致。
- **教训（进方法论）**："某字段自带时间是录入时间戳"这类口径必须用**全行恒定差值
  + 时刻分布双重实证**，差值口径（13-14h）未经行级验证不得写死进注释/模板。
- 已同步：`r-templates/pk_mapping.R.tmpl`（头部 C2 注释 + EC_DT 计算 + 移除
  ECDSTTIM/tim_ok 分支）；项目程序（400311 中性代称 Rave 项目 djh.R）同改并双环境
  验证。

### 9.2 自检增强（公共自检口径并入车道）

- **行数守恒红线**：写盘前 `nrow(PK_out) != nrow(pk_raw)` 直接 stop——防后续任何
  联表改动引入炸行/丢行（join 键重复是结构性错误，静默继续只会产出翻倍/错位表）。
- **QC 新增**：`PC采样时间缺失(已匹配)`（匹配成功但 PCDAT 解析为 NA 的行）。
- 既有项已覆盖自检五件套其余件：未匹配计数（PK行未匹配EDC采样）、解析失败
  （ECSTDAT 无法解析 note）、负值截 0 前计数（RT为负按0输出，用截断前 RT_raw）、
  派生列缺失（RT缺失/DOSE缺失）。
- **与版本比对的关系**：自检答"本版程序自产数据对不对"；参照版比对答"与参照版差
  在哪"。参照版与本版犯同一个错（如旧 C2）时比对照样全绿——自检是结构性错误的
  最后一道闸，二者互补不可互替。
- 回归：r_pk 车道单测 6 项 + r-runner/risk-regression 13 项全绿；第 8 节 e2e v2 的
  C2 断言基于旧口径（合成数据把 ECSTDAT 时间设为假时间戳），重建夹具后需重跑
  （真实项目数据 216/224 RT≈NT 为更强证据，暂列待办不阻塞）。

### 9.3 系统链路端到端验证与两处模板缺陷修复（2026-09-11，RPKRunner 真实路径）

以真实项目数据（400311 中性代称项目的 localtest 副本：PK dummy xls + EDC RData
缓存）驱动系统全链路（RPKRunner.render→Rscript→回执），**首跑抓到两处模板存量
缺陷**（djh.R 已修但从未同步进模板；旧 e2e 用 yyyy-mm-dd 合成日期与 SUBJID 键，
从未暴露）：

- **D1 dt_posix 缺 dd Mon yyyy 英文月份分支**：ECSTDAT "06 Jul 2026 08:00:00" 全
  352 行解析 NA（旧口径下同样解析不了，只是无告警不可见；C2 修正的解析失败 note
  让它显形）。修复=补 English→en_US.UTF-8→C 链式 LC_TIME 切换 + "%d %b %Y*" 三
  格式（与 djh.R 加固版同源，Linux "English" 无效名已容错）。
- **D2 PK Subject 映射缺随机号（RAND_ID）路径**：模板只有 SUBJID（筛选号）单路；
  本项目 PK Subject=RAND_ID（R0101 样式）→ 224 行全未匹配、EDC 新加列全空。
  修复=K1 双路（SUBJID 直接命中优先→RAND.RAND_ID 映射兜底→原值进 QC），RAND
  加载上移；QC in_edc 改为映射后键命中口径，零命中警告补两路排查出路。

修复后系统链路复跑：**与 djh.R 逐字一致**（汇总=已随机化无PK数据86/EDC采样行无
PK浓度9632/RT为负8；224 行×16 列；|RT-NT|≤0.5h=224/224；RT=0 仅 NT=0 行；Subject/
COHORT/FAST/VISIT/DOSE/NTPT/RT 关键字段 224 行逐行全等）；生成程序含 C2 修正
（ec_dt=dt_posix(ECSTDAT) 直取）与自检（PC采样时间缺失 QC + 行数守恒红线），
R parse 通过；listing 包 47 单测全绿。**方法论：车道模板改动必须走"真实数据×
RPKRunner 系统链路"验证，合成 e2e 的日期格式/编号体系假设会掩盖读数层缺陷。**

## 10. QC 双编程比对（datasetQC）与交付踩坑实录（2026-09-11，完整交付定案）

主编程（zhy）投递产出 rds，QC 方（本车道）用公司标准 datasetQC 双编程比对：
`saveRDS(最终输出表)` → `qc_compare(主rds, qc=本方rds)` → `qc_report(cmp, pdf)`，
两个 rds 与报告同在 `Output/04_Out/PK Mapping`。从满屏差异到零差异的完整对齐过程
（每一条都是报告实证后落地的口径，勿回退）：

### 10.1 rds 交付形态
- **只存 PK Mapping 对应的单表**（PK_out，与 Excel 行值一致），不存 list 多表；
- 命名照项目既有投递件规则：`{ProjectName}_PK Mapping_{数据日}.rds`（无 QC 人缩写，
  与主编程文件 `_zhy_日期` 同构）；报告名 `{ProjectName}_PK Mapping QC Report_{日期}.pdf`；
- datasetQC 是公司内部包，本机未装——本地跑只落 rds + NOTE 降级（守卫顺序
  requireNamespace → file.exists），比对与 PDF 报告在服务器生成；
- 程序尾部 setwd 用 out_dir（服务器/本地各落各的输出目录），文件名写死 + [REPLACE]。

### 10.2 列名 / label / 列集对齐（qc_compare 按名字配对的前提）
- **主编程产出列名 = spec Variable 全集 23 列**（STUDYID/SUBJID/NT/…），且每列带
  spec Label 属性。QC 方基础表列若保留 PK 投递原名（Study ID/Subject/Sampling
  Time(h)/Concentration(ng/mL)…），比对会满屏 Only in base / Only in QC；
- 对齐映射（PK_COL_RENAME，值不动）：Study ID→STUDYID、Analyte→ANALYTE、
  **Subject→SUBJID**（值=随机号；原新加 SUBJID 列并入删除）、Period→PERIOD、
  Sampling Time(h)→**NT**、Concentration(ng/mL)→Concentration、LLOQ/ULOQ 去后缀；
  Comments（可选列）→COMMENTS，投递无此列时补空列；
- **改名匹配键必须先规范化**（norm_h 去空格+小写）：真实投递表头
  `Concentration (ng/mL)` 带空格、`Subject ` 带尾随空格，dummy 是无空格形态——精确
  匹配必炸；
- **每列 attr(,label) = spec Label**（STUDYID=Study ID、SUBJID=Participant、
  NT=Sampling Time (h)、NTPT=Nominal Sampling Time Point…）——datasetQC 比 label
  属性，漏打则全列 Label mismatch。label 必须在**类型转换之后**统一重打（as.numeric
  会丢 attr）；
- **列集对齐 = 全 23 列输出**：SEX/AGE(DM)、HEIGHT/WEIGHT/BMI(VS2) 总是输出；
  SEQ/TRT 唯一数据源=随机化 schedule（**EDC RAND 表无序列/治疗字段**，实测仅
  RANDTRIG/REGIME_NAME/RAND_ID），配置 RAND_SCHED_FILE 读真值、无文件空列占位+NOTE；
  主编程若未做盲态剔除，QC 方按 spec 口径剔除会满屏 Only in base。

### 10.3 值 / 类型形态对齐（方向以 QC 报告 Base/QC class 实证，不从 spec 纸面推）
- **SUBJID/Participant 显示随机号原值**（PK Data <Subject> 即随机号 RAND_ID，本身
  盲态安全），不做 S001 掩码；匹配只走随机号路径（spec 措辞 screening number 与
  数据不符）；
- **Concentration = character + round 3 规范字符串**（`as.character(round(n,3))`，
  BQL 原样）：datasetQC 值明细对 numeric 按 **17 位全精度显示**（6.219 →
  6.2190000000000003，double 二进制表示所致，round 消不掉）——numeric 形态尾巴必然
  在，字符形态才是与主编程一致的终态；
- **AGE/HEIGHT/WEIGHT/BMI = character、Concentration 数值行 = numeric**：以 QC 报告
  的 Base class 实证为准（曾凭 spec 纸面 Type 推反方向，被下一份报告推翻）；
- **空占位用 ""（空字符串）不用 NA**：datasetQC 判 "" ≠ NA（SEQ/TRT 空列实证）。

### 10.4 RT 舍入（0.001h 半点行，最终=去噪 round_half_up）
- 差异行全部落在 **0.001h 舍入半点**（19.9775/16.0025/4.7475/8.0125h=秒差恰半），
  ±0.001 的翻转=双方舍入实现与浮点路径不同；
- zhy 口径=**round_half_up 四舍五入**（非 R 内置 round 的五成双，非截断）；
- **janitor 式实现有漏进位 bug**：8.0125 的 double=8.0124999999999993（略小），
  `×1000+0.5` 取整得 8.012（十进制四舍五入应 8.013）；
- **终版实现（去噪 half-up）**：
  ```r
  round_half_up <- function(x, digits = 0) {
    z <- round(abs(x) * 10^digits, 6)   # 去 ulp 噪声（偏差~1e-12 << 窗口 1e-6 << 半点距 0.5）
    z <- floor(z + 0.5)
    z * sign(x) / 10^digits
  }
  ```
  实测 8.0125→8.013（用户手算实证 8h45s=8.0125→8.013）、全部历史边界形态十进制正确；
- **zhy rds 部分行本身是浮点噪声下的错误舍入**（19.9975 十进制应进 19.998，zhy 浮点
  舍成 19.997）——修复后这类行会成为"QC 方十进制正确 vs 主编程浮点误差"的差异，
  QC 如实呈现即可，**勿再反向对齐浮点噪声**；
- 对账日志：半点边界行打全计算链（行号/SUBJ/PERIOD/NT/PCDAT/ECSTDAT/secs/hours 17
  位/RT），供与主编程逐项核对。

### 10.5 方法论教训（多轮翻烧饼的复盘）
1. **服务器/本地双版本场景，"报告与代码预期矛盾"优先怀疑版本没同步**（本案例多次：
   服务器脚本落后两版、zhy rds 中途换版本）——同步用整个文件覆盖，禁止手动 patch；
2. **怀疑修复没生效时，先发只读诊断命令拿实证**（class + as.numeric 差值 table +
   差异行样本），再决定改不改——一轮诊断避免了第三次盲改（并定案"值早已全等，
   差异纯属类型显示假象"）；
3. **反推对端规则要用全部已知值验证**，且先确认对端产物版本未变——base 换版本时
   旧吻合是巧合（banker 假设即栽在只验当前差异行）；
4. **代码"执行了但没效果"先重读自己刚写的段**确认操作行真实存在（改名段曾漏写
   赋值行，连查缓存/环境/编码多轮），再怀疑环境；
5. **用户手算一条边界案例是最快定案手段**（8h45s=8.0125→8.013 一条即定舍入口径）；
6. 对端（主编程）的实现细节拿不到时，差异如实呈现 + 留对账日志，**勿盲改对齐浮点
   噪声**——zhy 侧部分行本身是浮点误差值。

## 11. SAD/MAD 分模板回填（2026-09-17，P 项目验收后实例升格成生成器）

第二型研究形态（SAD/MAD I 期）此前以 standalone 交付路线完成（已验收程序
PK_Mapping_main.R，业务口径见场景库 pk-mapping L2/L5），验收后实证车道三缺口
（tmpl 仍 BE 单形态 / 程序名契约 / 运行摘要契约缺失）并全部收口：

- **新模板** `r-templates/pk_mapping_sadmad.R.tmpl`：已验收程序业务行原样搬家
  （参照剂量/RT_NEG_ZERO/编盲时间点隐藏/CSF_OUTPUT/sig6/双名 rds/分支互斥校验），
  新增仅车道契约层：cfg 运行时覆盖、DSH_R_SUMMARY_PATH 运行摘要回执、note 告警
  收集、RData 构建（zip+password）、_dec 解密副本发现式（血浆/CSF 按文件名标记，
  加密原件守卫给出路）、qa() QC 计数进 flagCount。[REPLACE SA1-SA9] 待确认清单，
  SA8 值域表（TPT_H/CSF_TPT_H/folder 映射/planned_h/编盲网格）为基线项目值域，
  新项目逐项对照 spec/ALS 解码串实证后替换。
- **runner/工具契约**：`form`（be=默认 BE / sad-mad，分模板选择；签名不命中向用户
  澄清禁止猜，BE 缺列报错补换型出路）、`studyCode`（完整方案号，STUDY_ID 预期常量
  与 GP7 双名 rds 用）、`config`（DSH_R_ 前缀键的运行时环境覆盖通道，ANALYTE 走
  DSH_R_PK_ANALYTE，不写入程序文件）。
- **eval**：dsh-standard-verify 增第三车道 pk-sadmad/PSTB100（数据只读拷贝+
  golden_gt=已验收产物）；判据 xlsx 哈希全等 + rds 72 行×23 列 names/class/label/
  celldiff=0；三车道（manual 84/84、pk/400311 1/1、pk-sadmad 1/1）ALL PASS。
- **方法论**：项目走 standalone 直交路线时，收官必须做"实例→模板"回填 + golden
  回归门，否则学习停在知识库文档层，生成器不进化（自进化协议"蒸馏入库"与
  "固化进 tmpl"是两步）。

## 12. 模板零业务逻辑改造（2026-09-17，用户定案）

用户指出 §11 回填违反根本原则：**业务逻辑不能写死进模板，所有生成 R 代码的业务
逻辑都是 harness AI 识别 spec 需求理解后生成的**。两 PK 模板当日改造为
"契约层 + 业务生成区"架构：

- **模板只含契约层**：cfg 运行时覆盖、读数发现（RData 构建/_dec 副本发现式/表头
  契约）、通用工具函数（dt_parse/round_half_up/sig6/norm_char/drop_note）、守卫红线、
  落盘三件套、datasetQC 段、运行摘要。零项目业务值。
- **业务生成区（DSH-BUSINESS-ZONE）**：BE=Z1 constants/Z2 intake/Z3 assembly/Z4 qc；
  SAD/MAD=Z1 constants/Z2 bridge/Z3 intake/Z4 mapping/Z5 demog/Z6 assembly。每区带
  生成契约注释（从 spec 哪里读、证据要求、门禁引用）；未生成即运行 fail-fast 并给出路。
- **eval AI 校准步**：`ai_zones.R`（首项目已验收程序业务段定稿）经
  `applyBusinessZones` 按区注入渲染程序，模拟 AI 识别 spec 的校准步；之后
  render=false 执行对 golden_gt 回归。契约层回归不丢，业务归 AI。
- **车道引导/AGENTS 同步**：工作流改为"render 骨架 → AI 生成业务区 → render=false
  执行"；首个真实数据汇报区待确认清单（BE P 项 / SAD-MAD SA 项）。
- **同类审计**：manual_listing.R.tmpl（1397 行）经审计同样内嵌 HXN6005 业务
  （访视词/标题/CS 拆分规则/行定义）——因有 17,993 行 golden 回归护航且业务与
  引擎交织深，列为独立改造待办，不在本轮动手术。
