# 百奥知（BioKnow / Boent eClinical）EDC 系统经验

来源：HXN6005-A1-201 全流程实战（2026-09，83 listing 三轮审计收口）+
KXZY-GB08-201 成熟程序反推（DVP2.0 迭代、Rcompare 比对流程）。两个项目同系统，
用户确认。新项目拿到 SAS 导出先按本文逐项核对，能少走一轮探测。

## 1. 系统识别特征

- 导出 sas7bdat + sas7bcat（FORMATS 表：FMTNAME/START/LABEL）。
- 每表带 `SID/SUBJID/VISITOID/VISITNAME/TNAME/TID/RECORDID/SUBTRID/CSN` +
  审计列 `CRFSTS/CRFVER/CUSERN/CROLE/CTIME/MUSERN/MROLE/MTIME`。
- VISITNAME/SVNUM 存的是**编码 OID**（如 `781156`、`420444_106_2`），不是中文名，
  靠 FORMATS 的 `$VISITNAME`/`$SVNUM` 解码。
- KXZY 程序里叫 `drop_sys_varible_baiaozhi()` 的系统列清单可直接复用。

## 2. 表结构：主表 + 记录 + 子表（长表导出）

- `SUBJECT`（dslabel=参与者信息）：SITEID/SUBJID/SUBNUM 筛选序号/STATUS/
  USUBJID/DSGROUP 队列。**含全部筛选者（含筛选失败），行数远多于业务表**
  （HXN6005：338 vs DM 120）。无 RECORDID/VISITOID，不经 ACT/lead_cols，
  STATUS 解码后 relocate 标识列即可。"参与者筛选号/受试者信息"类 listing 用
  SUBJECT，**不要拿 DM 人口统计学代理**（KXZY 的 LISTING_SUBJECT_01 先例）。
- 一个 CRF 页 = 一个 `RECORDID`；可重复块每条一个 `SUBTRID`+`CSN`。
  **检查项目子表在导出时已"列转行"**：一个检查项目一行（LBTEST/LBORRES/
  上下限/单位/判定/编号全在行上）。
- `SUBJID` 形态：`S` + 5 位流水（前 2 位中心号），也有 01011/CN001011 变体，
  键匹配用 `dig5()` 归一。
- 失活：`INVALID` 数据集，键 = `TID|RECORDID|SUBTRID`；`ACT()` 加 `.inv` 标记。

## 3. 判定类字段识别：必须看 format.sas 绑定，不能看列名/标签

**这是本系统最大的坑**。同一套 1/2/3(/4) 临床意义编码会绑在不同名字的列上：

| 列名 | 标签 | format.sas 绑定 |
|---|---|---|
| VSCLSIG1-4 | 体温/脉搏/…临床意义判定 | $VSCLSIG1A |
| LBCLSIG | 临床意义判定 | （同域） |
| ADBORES | **检查结果** | **$PERES**（HXN6005 ADB，靠绑定才找到） |
| LBPG/LBPGU 的 LBCLSIG1 | **检查结果** | **$CTCLSIG**（不是 VSCLSIG1A） |
| PERES/PE1RES | 检查结果 | $PERES |

公共值域：`$VSCLSIG1A/$CTCLSIG/$PERES` = 1正常 / 2异常无临床意义 /
3异常有临床意义（VS/LB 系多 4=未查）。步骤：haven 读入后逐列看
`attr(col,'format.sas')` → FORMATS 查该格式 → 再定 CS 判定列。只看标签
"临床意义判定"会漏字段（ADB），只看列名会绑错格式（LBPG）。

## 4. 常用格式域速查（两个项目实测）

- `$IEYN`：1是/2否/3不适用——**各表 PERF/YN 列共用**（LBPERF/PEPERF/EGPERF/
  VSPERF/SRPERF/AEYN…），过滤"=是"统一走它。
- `$LBCAT`/`$LBCAT1A`：实验室模块名（LBH=血常规/LBC=血生化/LBCG=凝血功能/
  LBU=尿常规/LBUS=尿沉渣分析/LBFSH=血清FSH/LBHD=HBV-DNA/LBHR=HCV-RNA）。
- `$DSPHASE`：试验阶段（Part A/B/C）。
- `$STATUS`：受试者状态。
- `$VISITNAME`：访视 OID → 中文访视名（"Part A/B-筛选期（D-28~D-2）"等）。

## 5. 访视体系

- 每个项目访视 OID **不同**，必须对照该项目 SV 表实证后再用（HXN6005：
  1=Part A/B筛选期 2=基线期 3=Part C筛选期 4=Part A治疗期D1 18=Part B/C治疗期D1
  99=计划外）；EDC 配置一变 OID 就变，代码处标 `[CONFIRM]`。
- 计划外访视：`VISITOID=99`，访视名带实例后缀（`计划外访视_02_2026-01-01`），
  过滤用 OID 等值比访视名匹配稳（KXZY 用 `str_starts(VISITNAME_OID, "794392")`）。
- 访视过滤两种写法：解码后 VISITNAME 精确匹配（`vis_scope`），或保留原始
  OID 列过滤、输出前删（KXZY 的 `VISITNAME_OID` 模式）。筛选逻辑必须在
  解码覆盖原始列**之前**留 OID 副本。

## 6. 多选/打包数据形态

- **编号打包单元格**：`编号,名称,日期；编号,名称,日期`（全角；分隔，逗号混用
  全/半角），出现在 MHNO/AENO/CMNO/PRNO/SRAENO/ECAENO/PRMHNO/CMMHNO 等。
  解析：按 ；/; 分段 → 每段取开头数字（`ae_ids`/`split_ids`）。
- **勾选框横排 0/1 列组**：`LBCSC_1/2/3`（异常分类_病史/AE/研究疾病）、
  `AEACN_2/_3/_99`（措施）、`VSCLSIG1-4`+`MHNO1-4/AENO1-4`（生命体征一行
  4 个测量项各有独立判定/编号列组——匹配要按槽位展开，单列 expand_ref 会恒空）。
  通常另有一个合并文本列（LBCSCAT/AEACN）。
- **日期**：部分日期 UK 形态（`2025-01-UK`）按字符串含 UK 判定；`YYYY-MM`
  7 位补 -01；CTIME/MTIME 是 epoch 秒数值（NLDATM）。

## 7. CS 匹配类需求（"当检查结果为CS时匹配对应的病史或AE"）解读与实现链路

spec 句式（HXN6005 row18/19/21/22/24-27/29/30/40/41/82 同款）：
> 当检查结果为CS时，匹配对应的病史或AE信息，病史编号和不良事件编号若有多选，
> 则进行拆分，一行仅显示一条AE或者病史，通过AE或病史编号抓取相关病史/AE的
> 编号/名称/开始日期/结束日期信息。

**需求解读（两个要素分立，勿混）**：
- Column Heading 的 `Raw data` = 表单字段**原样**输出——打包编号原文列（含
  `编号,名称,日期；…` 整包）不改写、不裁段、不置空（DM 核对的基准=录入原貌）；
- Condition 的"拆分、一行仅显示一条"作用于**程序抓取的匹配列**（匹配编号/名称/
  开始/结束一行一条）。原文列 vs 匹配列的对照正是 DM 要的：编号录错/指向失活
  记录时匹配名称为空，异常一眼暴露。

**实现链路（六步，2026-09-09 原始 sas7bdat 端到端实测）**：
1. 判定列=CS（异常有临床意义）：判定字段按 format.sas 绑定找（§3：
   $VSCLSIG1A/$CTCLSIG/$PERES 的 3），不按列名/标签猜；
2. 该行 病史编号/不良事件编号 是打包单元格（两种形态见 §6）；
3. 按 `；`/`;` 分段，每段取开头编号（ae_ids 语义）；
4. **两条独立链路**：病史编号→MH 表、AE 编号→AE 表，键=受试者(SID)+序号(CSN)；
5. 从**目标表取当前值**的 名称/开始/结束——不是打包串里的快照（目标表更新后
   快照会过期；实测 AE 表的结束日期 2026-07-07 只在表里、快照只有开始日期）；
6. 输出：一条链接一行；匹配编号**只显示纯序号，不带 `MH#`/`AE#`/`CM#`/`PR#`
   前缀**（2026-09-10 DM 变更，推翻早期"前缀区分来源"口径；跨源区分靠 名称列
   或 MH_AE 合并表的 来源 列；带前缀的键只可作内部判重唯一键，如 row9 的 NO
   列参与 n_distinct、显示列另出纯序号）；查无记录→编号照显、
   名称日期留空；非 CS 行不拆、匹配列全空。
- 分槽位形态（生命体征）：一行 4 个测量项各有 独立判定列组（VSCLSIG1-4）+
  独立编号列组（MHNO1-4/AENO1-4），按槽位逐一判定与拆分（expand_ref_vs 模式；
   只认 MHNO/AENO 单列会匹配恒空）。可选增强：加"异常项"列标注行属哪个测量项
  （spec 未写，须 DM 拍板才加）。

**红线**：Raw data 原文列永不改写；spec 没写的显示口径不擅自加。
另：编号拆分类同链路推广到 CM/PR（row10/57/58-62/74/75/77），目标表换成
CM/PR 表；匹配编号同样只出纯序号（同步骤 6 口径，不带 CM#/PR# 前缀）。

## 8. DM 的 listing 口径偏好（KXZY 成熟形态 + HXN6005 口头变更）

- **实验室检查类：解码长表原样输出**——不拆编号、不加匹配列，打包单元格
  原样留格（HXN6005 2026-09-09 DM 口头变更；KXZY 的 LISTING_LB1_02 同款，
  其全程序无任何匹配展开）。跨表交叉核查用 EDC 自带的 `*_ptnamecn` 编码列。
  已同步固化进 dsh 插件 `r-templates/manual_listing.R.tmpl`（头注释 L1–L3 +
  lab listing 直出），边界：妊娠等单项目表与其他表单仍按 spec CS 匹配。
- 只做 DVP 四列（Visits Applied To × Related Fields 范围 + Condition 行 +
  Column Heading 列），**不加 spec 外过滤**（哪怕看起来更"干净"——
  blank(term) 过滤被 DM 数据打脸过两次）。
- 重复核查 = 原样长表 + flag 列（分组键如 模块+采样日期+检查项目，
  **日期缺失置空 flag**；同记录多 logline 不算重复，用 n_distinct(RECORDID)）。
- 空白 logline（AETERM 全空的行）按 Condition=NA 全量输出，不预过滤。
- listing 名与 keyDataPointR 配置表的 form_name 对齐；改名/删除必须同步配置，
  否则 Rcompare 比对误报"新增+丢失"。
- 新旧版本比对：`Rcompare::compare_data(compare_New_file, compare_Old_file,
  config_table, previous_output, mark_lost_tracking=F, mark_duplicate=F)`，
  新旧快照各存一份 RDS。

## 9. ALS（数据库定义 xlsx）处理配方（2026-09-09 HXN6005 落地，对齐 KXZY alsmapping_saslabel）

- 文件自动发现：项目根 / `SAS_Program/SAS_program/Manual Listing/`（服务器放程序同目录），
  文件名含"数据库定义"或"ALS"；找不到不阻塞（沿用 SAS 标签）。
- **eCRF sheet（表|变量|变量名）**贴 attr label 定输出显示列名；**内嵌表归并**：
  eCRF 里可重复块字段挂在 内嵌表OID（AE_1/LB_1…）下，SAS 平铺进父数据集，按
  **"内嵌设计"sheet（表|内嵌表）**归并键——勿按前缀猜（实测 LBBT1_1 属 LBBT2）。
  不归并时覆盖率极低（AE 仅 1/48，归并后 23/48）。
- 系统/审计列裁剪在**写盘层**（RDS/比对保留全列）：STUDYCODE/INVNAM/SID/TID/SVNUM/
  VISITOID/VISITNAME/CRFSTS/CRFVER/CUSERN/CROLE/CTIME/MUSERN/MROLE/MTIME（对齐 KXZY
  drop_sys_varible_baiaozhi 清单）；**唯一值序号/键列（TNAME/RECORDID/SUBTRID/CSN）
  按用户需求保留**；访视显示用解码 VISIT 列，原始 OID 码列一并裁。
- 坑：① `dir_ok` 是单值谓词（isTRUE），向量直传恒 FALSE，须 `vapply(dirs, dir_ok, logical(1))`；
  ② ALS 块位置在 blank()/chr_() 定义之前，块内须自写 nb()/as.character；
  ③ `df[[cc]] <- format(df[[cc]], ...)` 转日期列会丢 attr label——先存后还原（模板曾因此
  表头回退列名 LBDAT，V2 靠 SRC_LABELS 兜底才没暴露）。
- **列集合与列序都按 ALS（2026-09-09 用户纠偏"要真实读取 ALS"）**：eCRF 的 `编号` 列即表单字段顺序
  （记录级字段后跟内嵌表字段；VS 按体温→脉搏→呼吸→血压分组）。`als_arrange()` 统一重排：
  ① ALS 已定义的键（SUBJECT 的 SITEID/SUBJID/STATUS）按 ALS 原位走、**不要前置**（否则
  中心编号被提走、与相邻的中心名称拆开，用户点名不合理）；仅 ALS 未定义的导出键
  （SITEID/SUBJID/STATUS/VISIT）才前置，② RECORDID 次之，③ SUBTRID/CSN 插到首个内嵌
  字段前，④ 派生/匹配/flag 列原序尾接，⑤ SAS 源列不在 ALS 且非键的（TNAME 表名称、
  勾选框组件子列 VSCSC_1/LBCSC_1-3/AEACN_1-99/ADBCS_1-3）不进交付面。TNAME 同时是
  form 识别键（值=ALS 表名 → name2oid）。SUBJECT 无 RECORDID/VISITOID/SUBTRID，VS 无
  子表（四测量为固定列），均按实际存在处理。
- 坑补充：④ Excel 正打开 ALS 时目录里出现 `~$` 锁文件且排在真文件前，被当 ALS 读失败→
  发现时须 `!grepl("^~\\$", basename(f))` 排除；⑤ INVNAM（研究者）在 SUBJECT 是 ALS
  表单字段、在普通表单是系统列——写盘层裁剪清单不放它，普通表单靠 als_arrange 按 ALS 裁。
- 已固化三处：HXN6005 V2 程序、dsh `r-templates/manual_listing.R.tmpl`（DSH_R_ALS_PATH
  可覆盖）、skill `assets/skeleton_common.R`（同款块）。
- **坑⑥（2026-09-10 LBO_01 收口）：父表无自有字段时 eCRF 没有该表名行**——"其他检查"
  的 11 个字段全挂内嵌表 LBO_1（eCRF 表名只有"其他检查明细"），`name2oid`（表名→OID）
  按数据集 TNAME（"其他检查"）查不到 → als_arrange **静默跳过**，系统列（TNAME/INVNAM）
  与勾选框组件子列（LBCSC_1-3 裸 0/1）漏进交付面。修法：用"内嵌设计"sheet 的
  表名|表 列补充 name2oid（权威 ALS 数据，非猜测），并 cat/note 打印补充项；
  写盘层日期列与 POSIXct 分流（纯日期 %Y-%m-%d 对齐 SAS 显示）。

## 10. 稳妥核对清单（新项目第一次跑）

1. 读入后 dump 元数据：每数据集标签 + 列名/标签/format.sas 绑定 + 示例值
   （`00_meta_dump.R` 模式），FORMATS 全量导 CSV。
2. 判定列按 §3 查绑定，别按标签猜。
3. 访视 OID 对照 SV 实证（§5），代码标 [CONFIRM]。
4. 打包编号列抽 3-5 个真实值验证解析器（§6）。
5. SUBJECT 与各业务表行数对账（筛选失败者只在 SUBJECT）。
6. UAT 数据会有乱填值（编号填 dg/1111、AA..串）——匹配不上就原文带出留空，
   那是 DM 要看的录入异常，不要程序层"洗掉"。
7. **值解码必须按列自身 format.sas 绑定全局做**（`decode_by_sasfmt`，骨架
   skeleton_common 已内置）：只解码显式 `dec()` 涉及的列会让 Raw data 直出列
   残留 1/2 裸码；名称启发式（同名/YN 后缀）会漏"绑定格式名与列名不同规律"的
   列。两个雷：**VISITNAME 不能预解码**（vlab 的"未命中回退 访视NN"会把已解码
   中文误判为未命中）；勾选框子列（AEACN_1/2/3/99）与 VISITOID/键列无格式绑定，
   不受全局解码影响（HXN6005 实测）。
8. **日期/时间列写盘显示口径（2026-09-10 DM 定案）**：纯日期列 format
   `%Y-%m-%d`（对齐原始 SAS 数据集显示，不带 00:00:00 后缀）；真日期时间/
   POSIXct 列保留 `%Y-%m-%d %H:%M:%S`；hms 时间列 HH:MM:SS。输出里出现
   "00:00:00" 要先分辨是后缀还是真值（整点采样时间 07:00:00、零点时间
   00:00:00 是录入事实，不是显示缺陷）。
9. **表单名称列口径（2026-09-10 DM 要求）**：listing 有访视列（VISIT）时，
   TNAME（表单名称）保留并紧跟访视列后（als_arrange 不再当导出工件裁掉；
   多表单合并 sheet——重复核查类堆叠——靠它区分行属哪个表单）；
   **无访视列的表（如 SUBJECT 参与者信息）不加——"没有的就没有，不要乱加"**
   （用户原话）。头标签统一"表单名称"（lead_cols/finish_fields 无 ALS 时也设）。
   **同日补口径（晚定案）：表单名称/Content Form Name/B1 一律用 ALS 官方词汇，零自造**——
   权威源 = ALS 数据库定义的 **访视表**（表名 + **访视内显示名称** 两列）与
   **eCRF界面**（表名称，含 SUBJECT=参与者信息）：①实验室检查类（LB/LB1）显示
   **访视内显示名称**（=模块名：血常规/血生化/凝血功能/尿常规/尿沉渣分析/血清FSH检测/
   HBV-DNA/HCV-RNA，LB_06/LB_07 行级取值、单模块用常量，LB_07 的未做记录也是模块级
   ——每受试者每模块一条）；②其余表单 = 表名**原样**，含编号表名（生命体征1/2/3、
   12导联心电图1、注射部位反应1/2/3、PK样本采集1/2/3、生物标志物样本采集1——
   它们是数据库定义的官方名=同一表单挂不同访视，**勿自行改写成"基础名（访视范围）"之类**）；
   ③多表单合并 sheet = 各官方名 `+` 连接；④同名标题（MH×3/AE×3/PR1×2/SV×2）由输出段
   自动追加（sheet 名）后缀去重——代码客观可溯、与 spec Unique ID 互查，**不要自造
   "（处理要点）/（Raw data）"类描述词**（用户 2026-09-10 明确否决自造标签）。
   **TNAME 原表名（实验室检查/实验室检查1）是 als_arrange 的 ALS 识别键，模块替换必须
   放在 als_arrange 之后的显示层**（提前替换会让 name2oid 查不到而静默跳过重排+列裁剪）。
   另：row37 类 Condition=NA 的实验室 Raw data 行**不带 是否进行检查 过滤**
   （V2 终审 47 行；带 LBPERF 过滤会丢"否"的记录）。
10. **拿到 EDC 比对导出 xlsx（Content + 每表单一 sheet + `__cmp_` 尾列）**：
   按专门模板 `references/baiaozhi-export-template.md` 识别与套用（三行表头/
   系统固定列/新旧比对与着色规格），公共函数直接 source `assets/cmp_export.R`。

## 11. EDC 比对导出 Excel 模板（2026-09-10 沉淀）

EDC 侧另有 xlsx 导出形态（manual/medical 两场景共用）：`Content` 汇总页 +
一个表单一个 sheet（sheet 名=表单 OID）+ 三行表头（Go back 链接/表单中文名 →
OID 变量名 → 中文显示名，第 4 行起数据）+ 尾部比对四列
`__cmp_FLAG__/__cmp_UpdateDetail__/__cmp_RCcomment__/__cmp_Idate__`。
比对着色：New 整行 `#CCCCFF`、Modified 仅变更单元格 `#33FFFF`、Old 不着色。
结构与公共函数（`cmp_diff()`/`cmp_export_sheet()`/`cmp_export_content()`，已合成
数据验证）见 `references/baiaozhi-export-template.md` 与 `assets/cmp_export.R`。
**显示口径勿混**：导出第 3 行显示名只作 EDC 自身核对参考，listing 交付的
列集合/显示名/列序仍按 ALS（§9）。
