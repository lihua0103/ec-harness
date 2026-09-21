# DVP 数据组装模式库（每类含 R 片段，变量名以实际元数据为准）

> **口径**：每行 listing 的产出以 **Column Heading (For internal use)** 为准——
> `Raw data` = 表单全字段；显式字段清单 = 逐列输出；"匹配XXX编号/名称/日期" =
> 回连派生列；`flag` = 按 Condition 计算的标记列。**Condition / Visits Applied
> To / Form Name / Related Fields 是过滤与范围**。Report Description /
> Discrepancy Text 是 DM 自己的核查逻辑，不进程序。
>
> 下面的模式是**数据组装配方**：其中涉及"判定"的片段（P3/P5/P6/P11 的矛盾
> 判定）**仅当该行 Condition 或 ColumnHeading 明确要求 flag/筛选时才使用**，
> 否则一律输出 Raw data 或字段清单即可。

> 片段中的 `*_A` 均为经 `ACT(表, tid)` 的活动数据（带 `.inv` 失活标记），
> `CTX` 为受试者级上下文（ICF_DATE/RAND_DT/DOSE_DT/EXIT_DT/PHASE/IEYN1/AGE…）。
> `mkS`/`grp_flag`/`bad_link` 等 helper 已在 skeleton_common.R 中。

## P0 ColumnHeading + Condition → 输出的识别与实现（每行先做这一步）

**逐列推理规则**：ColumnHeading 里的每一列，先查 SAS 元数据——
- 数据集里**存在** → 原样输出（编码变量用 dec()/labels 解码后输出更易读）；
- 数据集里**不存在** → 它就是程序要加工的**派生列**，按语义归类实现：

| 派生列形态 | 识别特征 | 实现方式 |
|---|---|---|
| 回连类："匹配XXX编号/名称/开始日期/结束日期"、"PT术语" | 列名带"匹配"，或引用另一表单属性 | 按编号拆分（split_ids/first_id/ae_ids）回连 MH_REF/AE_REF/CM_REF/PR_REF，一行一条（expand_ref/expand_ae） |
| 跨表带出类："知情同意签署日期"、"给药日期"、"治疗结束日期"、"试验阶段" | 列名是另一表单的字段 | 从 CTX（ICF_DATE/DOSE_DT/DSEND_DT/PHASE…）直接带列 |
| 时点聚合类："筛选期/基线期/D1采样日期" | "某访视 + 某日期" | 按访视 group_by(SID) 取 min/max 日期后回连（见 Manual_LB_07 的 pv()） |
| 计算类："年龄_计算值"、BMI | 列名带"计算/值" | 由原始字段计算（如 (ICF_DATE-BRTHDAT)/365.25） |
| 标记类："flag" | Condition 写明规则（如 flag=duplicated） | 按 Condition 实现（grp_flag/逻辑判断），列名与取值照原文 |

**Condition 的两种用法**（与上表配合）：
- 行过滤：`Output if XXX=是`、`开始日期为UK Or 开始日期>=ICF` → `filter(...)`；
- 派生规则：`同一受试者PT术语相同时 flag=duplicated` → 派生列计算公式。

```r
# 形态1 "Raw data"：表单全字段 + 受试者状态/访视展示列
lead_cols(x)                       # 骨架已封装（含 STATUS/VISIT 前导列）
# 形态2 显式字段清单：按 DVP 列出的字段挑选/改名（中文 Label 用 attr 标签）
# 形态3 "匹配XXX"派生列：编号回连 REF 表带出名称/日期
left_join(MH_REF %>% transmute(SID, MHKEY = CSNc, MHTERM, MHSTDAT, MHENDAT),
          by = c("SID", "MHKEY1" = "MHKEY"), relationship = "many-to-many")
# 形态4 Condition 过滤："Output if 是否进行检查？=是" → filter(dec(...)=="是")
#       "开始日期为UK Or 开始日期>=ICF..." → 对应逻辑 filter / flag 列
# 形态5 Visits Applied To 指定访视：非 ALL 时按访视过滤
#       v <- VisitsAppliedTo 文本拆分（"既往或合并用药/既往或合并非药物治疗"按/拆）
#       x <- x[vapply(chr_(VISITNAME) %in% v | v == "ALL", ...)]  # 解码后访视名匹配
# 形态6 Related Fields 收窄字段范围：非 "All items" 时输出列 = 该字段范围
#       （仍保留受试者/访视/表单前导列，便于定位）
```

## P1 完成标志/未做原因 对（血常规、心电图、彩超、量表…通用）

```r
m <- dec("LBPERF", x$LBPERF) == "否" & blank(x$LBREASN)
if (any(m)) add-mkS-flag(id, x[m, ], "若否，请说明原因", "", "“若否，请说明原因”不合理，请核实。")
```
变体：量表用 `QSPERF/QSREASN`（NRS 是 `QSREAN`）；给药 `ECYN/ECREASN`。

## P2 CS 分类 + 病史/AE 链接 + 失活（PE/EG/CT/ADB/LB 通用）

```r
cs <- x[CLS(x$EGCLSIG) == "异常有临床意义", ]
# a) CS 未选分类: blank(cs$EGCSCAT) → flag
# b) 链接失效: bad_link(SID, MHNO, AENO) → flag（编号不存在或在 INVALID 中）
```
DVP 常要求按编号抓取匹配信息列：`left_join(AE_REF/MH_REF, by=c("SID","CSNc"=键))`。

## P3 结果 vs 临床意义判定矛盾（数值型检查）

```r
v <- num_(x$LBORRES); lo <- num_(x$LBORNRLO); hi <- num_(x$LBORNRHI)
OUTR <- !is.na(v) & ((!is.na(lo) & v < lo) | (!is.na(hi) & v > hi))
INR  <- !is.na(v) & !is.na(lo) & !is.na(hi) & v >= lo & v <= hi
# 超范围判正常 / 范围内判异常 / 判定缺失或未查 / 范围值缺失 / 极值(LAB_EXT_F 倍)判 NCS
```
无范围参考项（心电图间期、血压等）用 `rng_out(x, lo, hi)` + 配置段阈值。

## P4 重复记录（通用 grp_flag）

键选择按 DVP：“日期+结果”（检查类）、“日期+时间”（采集类）、“日期+评分”
（量表）、“术语+日期”（病史/手术）、“日期+全部结果”（生命体征 4 表、体格 2 表）。
跨表重复先 `bind_rows` 加来源列再 `grp_flag`。

## P5 排除标准关键词交叉（疾病史/手术史等模糊匹配）

```r
any_kw(MHTERM, names(EXCL_KW)) & IEYN1 == "是" → flag
```
EXCL_KW 值形如 `"A:10|B:8"`；命中只提示不打死，标签注明"仅提示"。

## P6 量表/检验值 入选标准3 交叉（EASI/IGA/BSA/NRS）

```r
scale_flags(df, "QSPERF","QSREASN","QSDAT", score_expr, dup_extra, incl_thr = EASI_MIN)
# flag2 = SCORE < thr & IEYN1 == "是"
```
IGA/NRS 编码值需 -1（1=0 分）。记录级量表先按 `SID,RECORDID` 取一行。

## P7 病史/AE 术语重复（无编码词典 → 规范化文本）

```r
PT_DUP  # 公共段已构建：bind_rows(AE_A, MH_A) + norm_t 术语 + DUPN
# Manual_MH_AE_01: DUPN>1 的行全量列出, flag=duplicated
# AE_01 flag3 / 术语重复在 AE 侧引用同一集合
```

## P8 编号引用一致性（多选编号拆分 + REF 回连）

```r
# 单值: first_id("2,呕吐,2026-07-02；1,恶心") -> "2"；
#       多个编号全取: ae_ids()（按；分段，每段取首数字）
# CM/PR/AE/EC 引用病史/AE：left_join(MH_REF/AE_REF, by=c("SID","XXKEY1"=键))
# 未找到/失活 → flag；日期范围矛盾（开始日期超出病史/AE 起止）→ flag
# 目的须指向本记录：grepl("病史", INDIC) & CMMHNO == 当前CSN
```

## P9 日期交叉

```r
# 早于 ICF：dt_(x) < ICF_DATE（NRS 评估、MH 病史、DM 出生日期最早）
# 退出后仍有访视：COMPYN=="否" & VISDATd > EXIT_DT
# 退出日期早于给药/治疗结束：EXIT_DT < DOSE_DT / DSEND_DT
# 手术日期不在匹配病史期内：见 PRSG_01 flag6（MHIDX 匹配 + 区间判断）
# 给药早于随机：DDTT/RDTT POSIXct 比较（缺时间回退日期）
```

## P10 采集类 + “全 logline 否”（PK/ADA/生物标志物/SRT）

```r
# 模块 PERF=是 & 所有 logline PCSTAT/SRSTAT/LBSTAT=否 → 记录级 flag（group_by(SID,RECORDID)）
# 时间点表结果为空 & 未测 → flag；采集日期时间重复 → grp_flag
```

## P11 受试者级矛盾（跨页面）

```r
# 筛选结果 vs 入排：DSREASND 含"不符合" & IEYN1=="是"（反向：成功 & =="否"）
# 生育能力 vs 年龄：女 & DMFYN=是 & AGE>=55
# PR 选是但全 logline 未填/失活：group_by(SID) any(PRYN=是) & all(blank|inv)
# AEYN vs 行：是 & (名称空|.inv)；否 & 有有效记录
```

## P12 描述完整性（"其他，请描述"类）

```r
# 勾选其他但描述空 → flag；未勾其他却有描述 → flag
# 症状多选表（SRRAT_1..9）：SYMP 拼接列 + 与 AE 名称一致性提示（mapply 词匹配）
```

## P13 尿常规阳性 → 尿沉渣/血妊娠复测 交叉

```r
# 尿常规 PRO/NIT/WBC/BLD 阳性 & 尿沉渣无结果 → flag（LB_05 flag11）
# 尿妊娠异常CS & 无有效血妊娠 → flag（preg_flags(urine=TRUE) flag6）
```

## 命名与顺序约定

- listing 名 `Manual_<主表TID>_<序号>`（RDS 对象）；sheet 名去 `Manual_` 前缀。
- 按 DVP 行号顺序注册进 outlisting（Content 页顺序=行顺序）。
- 每个 DVP 行在代码中对应一节：`## DVP rowN | Manual_XX_YY —— <表单中文名>`。
