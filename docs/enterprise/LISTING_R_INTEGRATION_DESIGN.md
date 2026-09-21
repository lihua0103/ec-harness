# Manual Listing R 车道接入设计（ADR 提案 / 新会话交接文档）

- 状态：已实施（2026-09-07，见 ADR-0003 决策 7、CHANGELOG）。M1/M2 完成；M4 由 HXN6005 真实数据全链路验证覆盖（换项目只换用户输入，无代码改动）；M3 compare_data 依赖公司内部函数与旧版数据，按需接入 `[REPLACE R10]` 段
- 实施偏差：项目名不经 ui-settings，由用户在对话中提供并作为普通工具参数进入模型
  上下文（用户 2026-09-07 决定）；运行时参数经 `DSH_R_*` 环境变量覆盖渲染值；
  新增 `studyKey` 必填参数；Windows 子进程环境需保留 `PROCESSOR_ARCHITECTURE`
- 日期：2026-09-07
- 关联：ADR-0003（listing 插件）、ADR-0005/0020（输出模板）、`LISTING_MULTI_SHEET_SPEC.md`
- 已验证实现：`D:\project\company\epro\Project\HXN6005\manual_listing\programs\HXN6005_Manual_Listing.R`
  （HXN6005-A1-201 真实 UAT 数据完整跑通：83 条 DVP → 83 个 listing + Content，12,711 行 / 5,895 flag）

## 1. 背景与目标

HXN6005-A1-201 项目用一次会话完成了从数据探测、DVP 需求逐条映射、到产出
**可直接在服务器跑通的单文件 R 程序**（TAISHAN-304 风格）的全过程，并在真实
UAT 数据上验证。业务结论：这类"DVP 已固化、目录格式固定"的项目，交付物就是
一份 R 程序文件，而不是 AI 每次 live 生成的 pandas 代码。

目标：把这条已验证的 R 车道接入 `@dsh-enterprise/listing` 插件，满足：

1. **交付物 = 可直接线上跑的 R 代码**（单文件、`Rscript` 可执行）。
2. **项目名称由用户输入，不进入 AI**：项目目录固定格式
   `/mnt/project/<项目名>/...`，只有 `<项目名>` 会变。宿主负责把用户输入的
   项目名渲染进 R 模板占位符；AI 的提示词、代码、回执中均不出现项目名字符串。
3. 输出样式/规格沿用 `LISTING_MULTI_SHEET_SPEC.md`（manual 场景）与本次
   会话确认的用户偏好（默认网格线显示、go back 返回链接、去 `Manual_` 前缀
   的页名、空表占位行）。
4. 保留现有 pandas 车道（inspect → run_code → publish）不动；R 车道是并列
   的第三条执行路径。

## 2. 本次会话流程记录（探测 → 最终 R 代码）

### 2.1 输入

| 文件 | 内容 |
|---|---|
| `HXN6005-A1-201_数据核查计划_V1.0_20260819_internal use.xlsx` | `Manual Review` sheet = 83 行 DVP 需求（Report Description / Discrepancy Text / Condition / Column Heading） |
| `HXN6005-A1-201_UAT_SAS7BDAT_20260902_135656.zip` | 74 个 sas7bdat（70 业务 + formats + invalid + subject + nt），无密码 |

### 2.2 数据探测（元数据优先）

- 解压 → `haven::read_sas` 全量导出元数据（`00_meta_dump.R` →
  `meta/metadata.txt`、`formats.csv`）：数据集标签、变量名/标签/示例值。
- 关键发现（Boent eClinical 导出通用结构）：
  - 每表带 `STUDYCODE/SITEID/SID/SUBJID/VISITOID/VISITNAME/SVNUM/TNAME/TID/
    RECORDID/SUBTRID/CSN/CRFSTS/审计列`；
  - **编码值需要 formats 目录解码**：`FORMATS` 数据集（FMTNAME/START/LABEL），
    `dec(格式名, 值)`；`VISITNAME` 是 6 位乱码码值，靠同名 format 还原真实
    访视名；`YN`=IEYN 编码（1是2否3不适用）、`CLS`=VSCLSIG1A（1正常 2异常NCS
    3异常CS 4未查）；
  - `SUBJID` 三种形态（S01019 / 01011 / CN001011）→ `dig5()` 取后 5 位数字
    作为跨表受试者键；
  - `INVALID` 失活数据集（TID+RECORDID+SUBTRID 键）用于"已失活"判定
    （`ACT()` 给每表加 `.inv`）。

### 2.3 需求映射

**需求口径（2026-09-07 DM 确认，最关键的一条）**：

- **Column Heading (For internal use) = 编程需求本体**：该行 listing 要输出
  的字段。`Raw data` = 表单全字段原样；显式字段清单 = 逐列输出；"匹配XXX
  编号/名称/开始日期/结束日期" = 回连病史/AE 等参照表的派生列；`flag` = 按
  Condition 计算的标记列。
- **Condition / Visits Applied To / Form Name / Related Fields = 辅助需求**：
  输出过滤（如 `Output if 是否进行检查？=是`）、关联字段。**Visits Applied
  To 可能指定访视**——非 `ALL` 时按指定访视过滤记录（与解码后访视名匹配）；
  **Related Fields 可能收窄字段范围**——非 `All items` 时输出列以该范围为准。
- **Report Description / Discrepancy Text Message = DM 自己的核查逻辑，不用
  管**：不据此设计自动判定规则，不作为输出列或文案来源（Condition 明确要求
  的 flag 列除外，如 row9 `flag=duplicated`）。

83 行逐条 → 主数据集 + Column Heading 输出清单 + Condition 过滤 + 回连列。
多表行拆为"主 listing + 交叉/重复独立 listing"（如 row23 → `EG_EGT_01`）。
纯人工判定项按惯例以全量数据 + 相关字段供 DM 审阅。HXN6005 已交付程序中的
flag 列是超集实现（含按 Discrepancy 文本生成的判定），保留可用；后续项目按
上述口径以"输出字段组装"为主、flag 仅在 Condition 要求处实现。

### 2.4 程序范式

按用户提供的 TAISHAN-304 模板风格固化：单文件、`rm(list=ls())` 起手、
公共段只写一次（读数缓存 / formats 解码 / 失活 / 受试者状态 / CTX 上下文 /
参照表 / 通用 helper），每个 DVP 行一节 `## DVP rowN | Manual_<表>_<序号>`，
flag 列（"Y"/""）+ `attr(label)` 中文标签，收集进 `outlisting`，尾部
`saveRDS` + xlsx 落盘（compare_data 新旧比对位置留 [REPLACE R10] 占位）。

### 2.5 踩坑与修复清单（接入后同样适用，勿重复踩）

| 类别 | 问题 | 处置 |
|---|---|---|
| locale | 中文列名/多字节正则/`dir.exists` 在坏 locale 下报错 | 列名 ASCII 化；`any_kw()`/`sep_norm()` 用 fixed 匹配；路径探测 tryCatch |
| dplyr | 管道外求值取不到列 | `grp_flag()`/`scale_flags()` 参数用 `rlang::enquo` |
| openxlsx | 颜色必须带 `#`；`underline` 参数不存在；`writeFormula` 自动补 `=` | `textDecoration="underline"`；公式串不带等号 |
| 数据形态 | PE1 结果列是 `PE1RES`；SRT2/3 无 `SRERYDIA/SRSTAT/SRREASN`；fresh `ACT()` 无派生列 | 列存在守卫；日期内联 `dt_()` 解析 |
| zip | R 内置 `unzip()` 无 password 参数；内置解压引擎不建子目录；数据目录权限 | 系统 `unzip -P -o`（服务器）+ 预建子目录兜底；目录约定见 §3 |
| 环境 | 服务器无 tidyverse 元包；`LC_CTYPE=C.UTF-8` 破坏 R | `requireNamespace` 回退；批处理/交互差异 |
| 需求核对 | 逐条通读后发现 6 处缺口（eGFR listing、妊娠复测交叉、手术日期 vs 病史、EC 中断 AE 措施一致性、给药-随机精确到时间、PR 全 logline 未填 + pt_name/ICF 列） | 全部补齐并回归 |

### 2.6 输出规格（已实现并逐项验证）

`Content` 首页（Comparison Summary 标题、固定 7 列、跳转链接、定宽
16.71/50.71/18.71/9.71/8.71/12.71/8.71）+ 业务页（A1 `go back` 返回链接、
B1:F1 合并页名、Label 表头 TNR13 加粗 `#EDF2F9` 行高 60、数据 TNR13 细边框、
冻结 A3、筛选、RT01 审核五列、空表"无数据记录"占位行）。**用户偏好：网格线
保持 Excel 默认显示（覆盖规范的隐藏网格线，代码留注释可切回）。** 页名去
`Manual_` 前缀；RDS 对象名保留 `Manual_*`（兼容 compare_data）。

### 2.7 验证结论

83/83 需求全覆盖；规则命中抽查合理（如 EC 药物编号缺失 150、血常规范围值
缺失 61、IE 不符合未选编号 28——与 UAT 数据故意埋的问题吻合）。

## 3. 目录契约（固定格式，只有项目名可变）

```
/mnt/project/<项目名>/                          ← 用户输入项目名后由宿主拼接
├── Project_Data/01_Raw_sas/Manual Listing/
│   └── <数据日期>/                             ← foldername
│       ├── *_UAT_SAS7BDAT_*.zip               ← 数据 zip（+ 可选同名 .txt 密码）
│       └── sas_data_<数据日期>.RData          ← 读数缓存（R 程序生成/复用）
├── SAS_Program/SAS_program/Manual Listing/
│   └── <PROJECT>_Manual_Listing.R             ← 渲染后的 R 程序（交付物）
└── Output/04_Out/Manual listing/
    ├── HXN6005-A1-201_Manual Listing_<数据日期>.xlsx/.RDS   ← 交付结果
    └── (vs<旧日期>).xlsx                       ← 新旧比对（可选）
```

R 程序内部已硬编码此契约；跨项目只变三个占位符（见 §5）。

## 4. 插件现状与扩展点

- TS 宿主 `src/index.ts`：`ctx.tools.register` 注册 5 个工具
  （`enterprise_listing_inspect / read_metadata / read_document / run_code /
  publish`），`listing.systemPrompt.section({ name:'tool:enterprise-listing',
  order:116 })` 注入引导；`SCENARIOS` 枚举（manual/medical/report/rbqm）。
- Python worker：NDJSON 串行会话；`excel/`（build_workbook / layout /
  style_atoms / templates）固化交付结构；`publish` 是唯一交付口。
- ADR-0003 决策 6：AI 负责业务内容，Writer 固化交付结构。

## 5. 集成设计：R 车道（scenario = `r_manual`）

### 5.1 原则

R 程序**自成交付物**：读数、83 条核查、样式化 xlsx 全部由 R 完成。插件不把
它塞进 pandas 车道，而是新增一条"模板渲染 + 执行 + 聚合回执"的车道；
AI 的角色从"写代码"退为"核对需求差异、维护模板"。

### 5.2 模板资产与占位符

把已验证的 `HXN6005_Manual_Listing.R` 泛化为插件模板资产
`packages/enterprise/listing/r-templates/manual_listing.R.tmpl`，顶部集中
占位符（其余逻辑零改动）：

```r
## {{PROJECT_NAME}}        # /mnt/project/<项目名>（用户输入，宿主渲染）
## {{DATA_DATE}}           # 数据投递日期（用户输入）
## {{OLD_DATE}}            # 旧版日期（比对用，可空）
## {{ZIP_PASSWORD}}        # zip 密码（可空）
## {{STUDY_KEY}}           # 项目关键字（目录自动匹配用，如 HXN6005-A1-201）
## {{OUTPUT_FILENAME}}     # 交付文件名前缀
```

阈值/关键词（AGE/ECG/VS/eGFR/EASI…、EXCL_KW、REQ_VISITS）集中在文件头
`[REPLACE]` 配置段，跨项目由 AI 按 DVP diff 调整——**调整的是模板，不含项目名**。

### 5.3 新工具：`enterprise_listing_run_r`

| 项 | 内容 |
|---|---|
| 参数 | `dataDate`（必填，用户输入）、`project`（宿主注入，**不在 AI 可见 schema/回执中回显**）、`oldDate?`、`password?` |
| 宿主动作 | ① 校验 `/mnt/project/<project>` 存在且含 R 模板目录；② 渲染模板 → 写 `SAS_Program/.../<PROJECT>_Manual_Listing.R`；③ `Rscript` 执行（TS 宿主超时控制，同 run_code 语义）；④ 读取 R 写出的 `summary.json`（listing 数/行数/flag 数/输出文件）返回聚合信封 |
| 回执 | 只含聚合计数、产物文件名、告警清单；**不含** project 名、数据值、路径明文（复用 hostDataInterception 脱敏通道，project 字段恒定脱敏） |
| 前置 | 部署机需 Rscript ≥ 4.2 + haven/dplyr/tidyr/purrr/stringr/openxlsx（缺则回 `R_NOT_FOUND`，同 PYTHON_NOT_FOUND 模式） |

模板需配套小改造（M1）：末尾追加 `summary.json` 输出（listing 名/行数/
flag 数，信息已在 outlisting 里，~15 行）。

### 5.4 流程编排与提示引导

- 系统提示新增 section（order 117）：`r_manual` 场景下不再引导
  `run_code → publish`，改为：确认 DVP 与模板一致性（必要时 AI 修改模板中
  [REPLACE] 配置段/增删核查节）→ 调 `enterprise_listing_run_r` → 读聚合
  回执向用户汇报。**全程不生成含项目名的文本**。
- 需求映射知识：本次会话的"83 行 → 表单/规则"映射表随模板以注释形式内嵌
  （`## DVP rowN` 即映射），AI 维护模板时以此为 diff 基线。

### 5.5 与现有车道的关系

| 车道 | 适用 | 产物 |
|---|---|---|
| pandas（现状） | DVP 未固化、需 AI 现场推导的 listing | writer 样式化 xlsx |
| `r_manual`（新增） | 有固化 DVP + 模板的 项目，交付物=可跑 R 文件 | `<PROJECT>_Manual_Listing.R` + R 直接产出的 styled xlsx/RDS |
| compare | 新旧数据日比对 | TAISHAN `compare_data`（RDS 已按其格式 saveRDS，[REPLACE R10] 接入）或插件 trackChanges |

### 5.6 安全与边界

沿用 ADR-0003（受信内网、不限制 AI）与 ADR-0007/0009 数据口径；R 车道
新增的出域面只有"聚合回执"，恒定脱敏 `project` 字段即可满足"项目名不进 AI"。
模板与渲染产物存放于项目工作区，受工作区访问控制保护。

## 6. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 模板泛化：占位符化 + summary.json + 交付头注释 | HXN6005 渲染后本地跑 = 与已验证输出 diff=0 |
| M2 | `r_manual` 场景 + `enterprise_listing_run_r` 工具 + 提示 section | 用 HXN6005 目录在插件内跑通全链路 |
| M3 | compare_data 接入（新旧 xlsx 比对）+ 聚合回执单测 | 两期数据日期跑出 (vs) 文件 |
| M4 | 第二个真实项目试跑（只换用户输入的项目名/日期） | 不改模板逻辑即可跑通 |

## 7. 新会话交接指令（可直接粘贴）

> 在 ec-harness 仓库中，按 `docs/enterprise/LISTING_R_INTEGRATION_DESIGN.md`
> 实施 listing 插件的 `r_manual` 车道：参考 `ADR-0003` 与
> `packages/enterprise/listing/src/index.ts`（工具注册/系统提示）、
> `python/worker.py`、`python/excel/`；R 模板源文件为
> `D:\project\company\epro\Project\HXN6005\manual_listing\programs\HXN6005_Manual_Listing_V2.R`
> （已在真实数据完整验证，口径=Column Heading 输出组装，见 §2.3），按设计文档
> §5.2 做占位符化与 summary.json 改造，§5.3 新增 `enterprise_listing_run_r`
> 工具，§9 是全部已修复 bug 清单（不得回退），项目名由宿主渲染、不进入 AI
> 回执。目录契约见设计文档 §3。

## 8. 附录：本次会话产物清单

| 文件 | 说明 |
|---|---|
| `HXN6005/manual_listing/programs/HXN6005_Manual_Listing_V2.R` | **交付/模板源（最新，按 DM 确认口径）**，1064 行，真实数据跑通 83 listing |
| `HXN6005/manual_listing/programs/HXN6005_Manual_Listing.R` | V1 参照版（含 DM 自查逻辑 flag，已被 V2 口径取代） |
| `HXN6005/manual_listing/programs/00_meta_dump.R` | 元数据导出工具（新项目探测用） |
| `HXN6005/manual_listing/meta/metadata.txt` / `formats.csv` | 数据集/变量/编码参考 |
| `~/.agents/skills/manual-listing-r/` | **skill 包**：SKILL.md（需求口径+工作流）、assets/skeleton_common.R + skeleton_output.R（已含全部修复的骨架）、references/（模式库/踩坑/输出规格/密码规则） |
| `HXN6005/manual_listing/output/` | 验证产物（84 sheet xlsx + RDS） |
| `HXN6005/manual_listing/meta/_assemble_v2.py` | V2 装配脚本（骨架渲染 + 核查节拼接的参考实现） |

## 9. V2 开发期 Bug 修复记录（新会话必读，防止回归）

以下问题在 V2 开发/服务器试跑中全部出现并已修复；**修复位置标注了所在文件**，
接入插件或改模板时不得回退：

| # | 症状 | 根因 | 修复 | 位置 |
|---|---|---|---|---|
| 1 | `no package called 'tidyverse'` | 部署机无元包 | requireNamespace 探测，缺失回退 dplyr/tidyr/purrr/stringr | skeleton 头部 |
| 2 | 服务器报 `Manual Listing/data 不存在` | 模板占位符被渲染成本机调试值 "data" | `{{DATA_DATE}}` 必须渲染真实日期文件夹（如 20260907）；Windows 覆写块只在本机生效 | 配置段 |
| 3 | 中文项目目录找不到/`dir.exists` 抛错 | locale 编码 + 全名可能不符 | `dir_ok/dirs_of` tryCatch + 按 `HXN6005-A1-201` 关键字在 /mnt/project 下自动匹配 root | 配置段 |
| 4 | `unused argument (password=...)` | R 内置 unzip 无 password 参数 | 系统 `unzip -P`（Unix）；无密码走内置 unzip | `zip_extract` |
| 5 | `cannot create ./sas7bdat` / Permission denied | 内置解压引擎不建子目录 + 数据目录只读 | 系统 unzip 失败后按 zip 条目预建子目录再兜底；解压/缓存放 zip 同目录（需可写） | `zip_extract`/`read_sas_folder` |
| 6 | `.RData` 缓存写失败 | 缓存曾放只读目录 | 缓存固定在 zip 所在日期目录 | `read_sas_folder` |
| 7 | 中文列名 invalid token / 多字节正则 invalid | 坏 locale | 列名 ASCII 化；`any_kw/sep_norm` 用 fixed=TRUE | helpers + `Manual_MH_AE_01` |
| 8 | `object 'SID' not found`（无调用栈） | `grp_flag/scale_flags` 参数在管道外求值 | `rlang::enquo` 捕获，mutate 掩码内求值 | `grp_flag/scale_flags` |
| 9 | RStudio "R Session Ended" | error handler 里无条件 quit | `if (!interactive()) quit(...)` | 文件头 |
| 10 | `object 'PE1RES'/'DS2_A'/'LB_SPAN'/'yn'/'add_status'` not found | fresh ACT 无派生列；骨架曾缺 helper | `dt_()` 内联；helper 补入骨架（expand_ref/expand_ae/qs_agg/finish_fields/yn 别名/DS2_A/LB_SPAN） | skeleton_common + 各节 |
| 11 | SRT2/3 无 `SRERYDIA/SRSTAT/SRREASN` 列报错 | 时间点表与症状表结构不同 | 列存在守卫（is.null 分支） | `sr_flags/srt_sym` |
| 12 | `character string is not in a standard unambiguous format` | POSIXct 无 format 且含 NA 拼接串 | 显式 format + NA 行置 NA_character_ | `EC_01` flag7 |
| 13 | xlsx 超链接显示 `==HYPERLINK` | writeFormula 自动补 = | 公式串不带等号 | `write_listing_sheet` |
| 14 | openxlsx 颜色/underline/列宽偏差 | 4.2.x 行为 | 颜色带 #；textDecoration=underline；列宽-0.7109375 | `STY`/Content |
| 15 | 空 listing 整页无表格线 | 0 行无数据样式 | “无数据记录”占位行（带边框） | `write_listing_sheet` |
| 16 | 表格外全白被质疑 | 规范要求隐藏网格线 | 恢复 Excel 默认网格线（用户偏好，注释可切回） | 各 addWorksheet |
| 17 | Flag1 空列被注入 | RT01 审核列无条件补齐 | 移除 Flag1 注入；flag 列仅按各 DVP 行 Condition 生成 | `append_audit_cols` |
| 18 | `.inv/PERF/CSNc/MHSTd...` 内部列泄漏进交付 xlsx | lead_cols 全保留 | `write_listing_sheet` 统一 drop_internal（RDS 保留供比对） | 输出段 |
| 19 | LBPG/LBPGU 妊娠结果解码是假设 | FORMATS 数据集缺 LBCLSIG 格式 | **已用 formats.sas7bcat（haven catalog_file）确证：1=正常 2=异常NCS 3=异常CS 4=未查**，skeleton 读数挂载 catalog | `read_sas_folder` + 标签 |
| 20 | 需求口径 | Report Description/Discrepancy=DM 自查逻辑不进程序；Column Heading=输出需求本体；Condition=过滤+派生规则；Visits/Related Fields=范围 | V2 全部按此实现；skill P0 推理表固化 | skill + V2 全部核查节 |

## 10. 新会话开发任务清单（照做即可）

1. 读本文档 §5 + §9；R 模板源 = `HXN6005/manual_listing/programs/HXN6005_Manual_Listing_V2.R`
   （内含 `{{PROJECT_DIR}}/{{STUDY_KEY}}/{{DATA_DATE}}/{{OLD_DATE}}/{{OUTPUT_STEM}}`
   同款占位符与已验证核查节）；skill 骨架
   `~/.agents/skills/manual-listing-r/assets/` 与其同步（expand_ref/expand_ae/
   qs_agg/finish_fields/密码推导/catalog 挂载均已就位）。
2. M1 残留：模板末尾追加 `summary.json`（83 个 listing 的名称/行数/flag 数，
   供 `enterprise_listing_run_r` 回执聚合，~15 行 R）。
3. M2：`packages/enterprise/listing/src/index.ts` 新增
   `enterprise_listing_run_r` 工具（§5.3 表格：宿主渲染→Rscript→聚合回执，
   project 恒定脱敏）；SCENARIOS 增加 `r_manual`；systemPrompt 增加 order 117
   section（r_manual 场景不走 run_code/publish）。
4. M3：尾部 [REPLACE R10] 注释处接 TAISHAN `compare_data`（RDS 格式已兼容）。
5. 验收：HXN6005 渲染产物在插件内跑通，输出 xlsx 与
   `HXN6005/manual_listing/output/` 的已验证文件一致。
