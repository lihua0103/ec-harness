# 场景库：manual（数据核查计划 Manual Listing，单文件 R 程序）

车道：`enterprise_listing_run_r`；目录契约/参数/回执语义见车道引导（systemPrompt
order 117）。本文件 = L1 门禁 + L2 口径摘要（**master**）。深库同在本库目录、经
`enterprise_listing_kb(scenario="manual", topic=…)` 拉取：scenario-kb（口径终案
16 条+编码接入方法论）/ edc-baiaozhi（EDC 系统数据模式）/ export-template /
dvp-patterns（派生列 12+ 类模式）/ pitfalls（坑库+预防索引）/ output-spec /
password-rule。ZCode 个人 skill（manual-listing-r）为镜像，同步方向：本库 → skill。

## L1 写码前门禁（Gate，未过不得渲染/编辑程序）

- **G-1 需求理解自审（U-Gate，先于 G0；2026-09-19 定案）**：DVP 白名单六列逐行
  产出需求理解矩阵（`口径判定→数据源证据→置信级 E/I/U`）+ 红队三类必查（①号体系：
  筛选号/随机号/掩码两侧键实证 ②时间戳来源：录入戳 vs 业务时刻 ③边界 off-by-one：
  访视/窗口/时点枚举值域逐项对表）。**需求态考古先行**：spec 存在评审列（DM Comments
  [已处理]/R1 回复版类）时，真实交付态以评审定案列为准（83→77 listing 实案：7 删/
  2 合并等 12 条决策都在评审列里，按字面行数实现会多出 7 个 listing）；表头权威=
  DVP Column Heading 逐页对照（无全局去问号规则）。无未处理 U 级（实证升级或列待
  确认清单给用户出路，禁近似代理）才写生成区；矩阵随交付汇报留存。详见 router
  「U-Gate」节；交付前另须过 G-Gate（golden2 双跑逐文件 QC）。
- **G0 通用**：写进代码的任何业务关键词（访视/页名/表名/编码值/格式名）必须先对
  实际数据**去重值域**核对；零命中即停禁止当"没数据"继续。0 行表防塌型（ifelse
  空向量→logical→join 崩）。单文件交付；中性代称。
- **G1 医学编码**（DVP 出现 PT术语/pt_name/编码类派生列）：探测 编码|coding 文件
  （随数据包投递）→ 表头按"含 Subject 单元格"定位 → **页名键对 DataPageName 实际
  值域核对**（勿从 spec 抄词；编码文件与 EDC 用词可能一字之差）→ 两段键匹配
  （记录级 受试者|页名|记录号 → 词典级 规范化术语）→ 未命中**置空不回退**+计数进
  回执。HTML 数字实体先解码再建键。
- **G2 重复标记**（Condition 含 flag/duplicated）：判重显示列只显纯序号（前缀仅
  内部键）；编码类重复=命中才入表、flag 仅已编码记录；不注入空 flag 列。
- **G3 访视过滤**：kw 对 vlab 解码后实际访视值域核对；合并表单访视名是"X/Y"完整
  组合串（写半截零命中）。
- **G4 打包数据**（`编号,名称,日期；` 全角串）：按 ；/; 拆分取开头编号；匹配列只
  显纯序号；勾选框 0/1 列组按槽位逐列。
- **G5 判定字段**：解码依据=**列自身 format.sas 绑定**（逐列查 attr），禁止按
  列名/标签猜。
- **G6 CS 匹配**：匹配值取目标表**当前值**非打包快照；非 CS 行不拆；查无记录编号
  照显名称空。
- **G7 派生列**（Column Heading 列不在 SAS 数据集）：逐列识别来源（回连/聚合/跨表
  /计算/解码），一列不丢；来源拿不准→映射表问用户，不代理。
- **G8/G9 比对与回写**：新旧比对用资产函数（cmp_diff/compare_data）；spec 回写用
  spec_writeback.py（最小 XML 手术，副本交付）。

## L2 口径终案摘要（完整 16 条见镜像 scenario-kb 终案表）

Raw data 原文列永不改写；显示词表=ALS 官方零自造；值解码按 format.sas 全局；
DVP N 行=N listing 漏一即败；日期显示三形态；输出对齐 EDC 导出模板（Content 七列
/审核四列/go back）。

## 模板零业务生成区契约（2026-09-19 落地，与 r_pk 同型）

模板 `r-templates/manual_listing.R.tmpl` = 契约层（读数缓存/密码推导/ALS/解码/
PT+WHODrug 装载/展开原语/输出样式/运行摘要，与已交付程序同源——skill 骨架）+
三个 DSH-BUSINESS-ZONE 生成区，业务逻辑一律由 AI 识别 spec 生成后 render=false 执行：

- **B1 context**：A_* 活动表（按本项目 EDC 表集实证增删）、CTX 跨表上下文列表
  （列集=DVP Column Heading 的【表单】上下文列，逐列实证聚合规则；给药访视关键词
  按方案实证禁写死 OID）、add_ctx/CTX_DROP、AE_REF/MH_REF/PT_DUP。无上下文列的
  项目生成仅 SID 的最小 CTX。
- **B2 listings**：DVP Manual Review 每一需求行一节装配 `outlisting$<数据集>_<序号>`
  （不加 Manual_ 前缀），漏行=失败；四列口径=Visits×Fields 定范围 → Condition 定行
  → Column Heading 定列（Raw data 原样红线）。
- **B3 titles**：LISTING_TITLES（sheet 名→Content/B1 中文表名，ALS 官方词汇零自造）
  与显示层修正（与 .als_applied 标记协同防二次重排甩尾）。

## RDS 工件形态惯例（2026-09-19 冷启动实证沉淀，compare_data 依赖）

RDS 是新旧比对工件，列名形态必须与交付版惯例一致（xlsx 全等 ≠ RDS 全等）：

1. outlisting 键名带 Manual_ 前缀（"参与者信息"类无前缀者如 SUBJECT_01 除外）；sheet 显示层自动去前缀。
2. transmute 型字段清单 listing（fields 收窄类）的 RDS 列名=中文显示名，与 xlsx 表头同词（不是 SAS 变量名+label）。
3. CTX 上下文列在 listing 内重命名为中文（试验阶段/给药日期PartA_D1/治疗结束日期/知情同意签署日期…）。
4. .d 派生日期列（LBDATEd/VISDATd/DSENDATd…）与 CRFVER/CRFSTS 保留在 RDS（写盘层才裁）。**反向教训（2026-09-20 实证）：.d 列是 RDS 工件的一部分——pipe 化重构最易丢这些"xlsx 不可见列"；bind_rows 异源合并时，无派生列的来源分支行=填充 NA，勿给来源分支物化该列。**
5. 缺失表示**逐格按构造路径**：join 产生=NA，显式 dts()/if_else 产生=""。**同列内 NA 与 "" 可按行混合（join-miss 行=NA、命中但解析空行=""），列级整列 NA↔"" 归一补丁必然打反其中一路（实测 DS_01 修 20 格反 20 格、PE_02 反 12 格）——唯一修法=撤补丁、回构造段逐路径复刻。CTX 层禁加"收尾整层 NA→''"兜底，缺失语义由 join 源自带。**
6. 长会话修形纪律：xlsx 全等状态先快照，一次只改一列形态并双验证（xlsx+RDS），禁整块重写——实测两轮回归都是整块重写把已修列冲掉、甚至破坏 ALS 词汇管线（全 sheet 表头退化成 SAS 裸标签）。
7. **RDS 自检必须结构+值双全**（2026-09-20 定案入 G-Gate）：值层用 NA 敏感 xor 口径（`xor(is.na(x),is.na(y)) | (!is.na(x)&!is.na(y)&x!=y)`，规范化 NA=="" 会假零）；结构层逐对象核对 names（含列序）/class/label——gt 系工具对 names 不等者跳过值层比对，"celldiff=0 但 FAIL"即结构残差，两者同零才是终局。

## eval 判据（2026-09-19 起，对齐交付终版 77 listing）

`dsh-standard-verify`：manual **77 listing/78 sheets/17,993 行/437 flag**；golden2 =
已交付 V2 终版（2026-09-11 23:16，77 listing）同沙箱重跑产物（与真实交付产物 78/78
逐格全等已验证）；校准回归 = 渲染骨架 + 注入 `_calibration/HXN6005_ai_zones.R`
（V2 业务段原样）+ render=false → **78/78 sheet 哈希全等**。改造前旧基准（83 listing/
84 sheets/17,941 行/164 flag）已存档为 golden2 内 *_83listing_era.bak。

**活体冷启动档案（2026-09-19/20，全自主闭环首证）**：清空生成产物+新会话单提示词
冷启动，全流程自主完成（需求态考古→U-Gate 矩阵→三生成区→运行→G-Gate 对账）。收敛
轨迹：xlsx 14,949→11,942→6,829→5,443→173→210→**0**（78/78 全等）；rds 612→322→311→
151→**0**（值层+结构层）。关键实证：①R1 自收敛有效（被外部中止前已收敛 20%）；
②评审反馈只给根因方向/残差模式，修法 AI 自定（harness 主导）；③长会话退化实锤——
6 轮后 AI 反复"宣告完成+语义豁免"（把 NA 语义差解释成"解码值域差异"拒修），换新鲜
收尾会话接手（洁净上下文+GT 路径+残差清单）10 轮外科收敛零回归；④收尾会话产出 8 条
构造差异蒸馏提案（bind_rows 填充 NA 源维度/事后归一反混合路径/CTX ""-化反模式/
受试者资格口径/.d 列属 RDS 工件/join 碰撞后缀即契约/无锚 listing 构造序=交付序/
rename 保 label），方法论已并入本库惯例节。
