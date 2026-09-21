# 百奥知 EDC Manual Listing 场景知识库（端到端实战沉淀）

来源：示例项目全流程实战（2026-09-07 ~ 2026-09-10，83 listing 八轮审计 + 显示层多轮纠偏全部收口，
双侧回归全绿）+ 同 EDC 系统成熟项目 KXZY-GB08 参考程序反推。**下一个同系统（百奥知/Boent
eClinical 导出）项目做 manual/medical listing，从本文进入，按 §9 流程走，可避开全部已知坑。**
细节按需查各专文（§4 资产地图），本文是索引+终案速查。

## 1. 需求理解（spec = 数据核查计划 Manual Review sheet）

- **按列白名单读**（铁律）：只读 `Condition / Column Heading / Visits Applied To /
  Related Fields / Data Source / Form Name` 六列；其余列（Report Description、
  Discrepancy Text Message、Unique ID、Add/Delete/Update、DB Comments、UAT result、
  Initial Date、DM Comments）**不识别、不读取、不转述**；无关截图整图不读。
- **处理顺序**：Visits Applied To（访视过滤）→ Related Fields（字段收窄）→ Condition
  （行筛选/flag 规则）→ Column Heading（输出列需求）。Report/Discrepancy 是 DM 人工
  核查，绝不进程序。
- **N 行 = N listing，漏一行即失败**；Column Heading 里 SAS 没有的列 = 必须实现的派生列
  （回连/跨表带出/时点聚合/计算/标记 五类），一列不能丢。
- Condition=NA 且 Heading 写 Raw data → 全字段原样直出（行不筛）；"<>无"类条件空值按无。

## 2. 数据理解（SAS 导出侧）

- 识别特征：sas7bdat+sas7bcat，系统列 SID/SUBJID/VISITOID/VISITNAME/TNAME/RECORDID/
  SUBTRID/CSN + 审计列；VISITNAME/SVNUM 存 OID 编码（FORMATS 解码）。
- **判定类字段必须看列的 format.sas 绑定**（$VSCLSIG1A/$CTCLSIG/$PERES，3=异常有临床
  意义），不能按列名/标签猜（ADBORES、LBPG.LBCLSIG1 两个实案）。
- SUBJECT 含全部筛选者（含失败），不要拿 DM 代理；SUBJID 变体用 dig5() 归一。
- 打包编号单元格（`编号,名称,日期；…`，全角；）、勾选框 0/1 列组（VS 分槽位）、
  UK 部分日期（含 UK 字符串判定）、epoch 秒时间列。

### 医学编码结果（PT 术语）接入方法论（每项目按流程走，勿抄上个项目的字段值）

1. **投递契约**：编码文件随数据包进数据日期文件夹，文件名含 `编码|coding`；
   MedDRA sheet 第 1-2 行是版本横幅、**表头在其下一行**（Subject/RecordPosition/
   DataPageName/TERM/llt_code/pt_code/pt_name/…）；另有 WHODrug sheet（用药编码，
   列名体系不同：Drug/Product_Name/Preferred_Name/ATC…，需要时仿此扩展）。
2. **装载**：发现顺序=显式配置→数据日期文件夹（递归）→项目根；表头行按"含
   Subject 单元格"定位（勿写死行号）；导出中文可能是 HTML 数字实体（&#26082;），
   必须先解码再建键（规范化会破坏实体串）。
3. **页名键核对（每项目必做，勿从 DVP/spec 文本抄页名）**：pt_of 的页名取编码文件
   DataPageName 的**实际去重值域**逐个核对——同一业务表单两边用词可能不同
   （实案：编码文件"既往及**伴随**非药物治疗" vs EDC 访视"既往或**合并**非药物治疗"，
   一字之差记录级键全空，只剩词典级兜底）。
4. **匹配**：两段键——记录级（受试者小写|页名|记录号去 .0 后缀）→词典级
   （规范化术语；MedDRA 同词同 PT）。
5. **行为口径**：未命中 PT **置空、不回退原值**（避免混淆已编码/未编码），未命中
   计数进 note；重复类 listing（Condition=PT术语相同 flag=duplicated）= **编码命中
   才入表**，flag 仅对已编码记录生效。
6. **EDC 侧对应行的访视过滤同理**：kw 必须对 vlab 解码后的**实际访视名整串**——
   合并表单（一张表覆盖两个业务域）的访视名是"X/Y"完整组合串，写半截→零命中→
   空表（空表还会触发 helper 塌型坑，见 pitfalls）。

## 3. 实现口径终案表（核心速查——每条都是用户/DM 拍板过的，勿走回头路）

| # | 口径 | 终案 | 关键依据/实案 |
|---|---|---|---|
| 1 | Raw data 原文列 | 永不改写/裁段/置空（含打包原文） | DM 核对基准=录入原貌 |
| 2 | 编号拆分 | 只作用程序抓取的匹配列；匹配编号**只显纯序号**（MH#2→2），前缀（MH#/AE#/CM#/PR#）退出显示面 | 2026-09-10 DM 变更；前缀仅可作内部判重键（row9 NO） |
| 3 | CS 匹配 | 六步链路（§7 专文）；从目标表取**当前值**非打包快照；查无记录编号照显名称空；非 CS 行不拆 | 实测 AE 结束日期只在表里 |
| 4 | 实验室检查 | 解码长表**直出**不拆分不加匹配列（L1-L3）；表单名称细分到**访视内显示名称**（模块名）；LB_06/LB_07 行级取值，LB_07 未做记录也是模块级 | 2026-09-09/10 DM 定案 |
| 5 | 表单名称列 | 有访视列（VISIT）才加，紧跟访视后，表头"表单名称"；无访视列不加 | "没有的就没有，不要乱加" |
| 6 | 显示词表 | Content Form Name/B1/表单名称列 = **ALS 官方词汇零自造**：实验室类=访视表"访视内显示名称"，其余="表名"原样（**含生命体征1 等编号表名勿改写**）；合并 sheet 各官方名 `+` 连接；同名（MH×3/AE×3/PR1×2/SV×2）自动追加（sheet 名）后缀去重，与 spec Unique ID 互查 | 三轮纠偏定案：否决纯代码、否决自造"（访视范围）/（处理要点）" |
| 7 | 编号重名表单 | = 同一表单挂不同访视（Casebook 矩阵实证），显示官方名即可，访视区分靠 VISIT 列 | 用户确认参考模板命名方式 |
| 8 | Condition=NA 实验室行 | 不带 是否进行检查 过滤（LB1_01 47 行；过滤丢"否"记录） | V2 终审 |
| 9 | ALS 三样 | 列集合/显示名/列序全按 ALS eCRF（编号=DM 查看顺序）；内嵌表按"内嵌设计"归并；name2oid 需内嵌设计补充；**TNAME 原值是 als_arrange 识别键，模块替换必须在其后** | 静默跳过实案 ×2 |
| 10 | 值解码 | 按列自身 format.sas 绑定**全局**解码（decode_by_sasfmt）；VISITNAME 不预解码 | 裸码残留实案 |
| 11 | 日期显示 | 纯日期 %Y-%m-%d、真日期时间保留、hms HH:MM:SS；00:00:00 分辨后缀 vs 真值 | DM 定案 |
| 12 | flag | 仅 Condition 明确要求处存在（duplicated）；不注入空 Flag1 | 用户否决空列 |
| 13 | 输出样式 | Content 七列+A1 居中+中文 Form Name；业务页 go back/B1=Content 同款标题/表头 #EDF2F9 行高60/冻结/审核四列/空表占位 | 对齐 EDC 导出模板 |
| 14 | spec 回写 | listing 完成后 Unique ID (DBD) 列回写 listing 代码（XML 手术，副本交付）；listing 增删/改名/换序或 spec 换版才需重跑 | 2026-09-10 落地 |
| 15 | 新旧比对 | cmp_diff 行级 flag+列级变更集（Modified 只着变更格）；或 Rcompare::compare_data | EDC 模板逆向确证 |
| 16 | 医学编码结果（PT 术语） | 按 §2 编码方法论接入：自动发现→表头行定位→**页名值域核对**→两段键匹配（记录级→词典级）→未命中置空不回退+计数；重复类=编码命中才入表、flag 仅已编码记录生效 | 2026-09-11 V2↔车道模板移植互证 84/84；"伴随≠合并"页名实案 |

## 4. 公共资产地图（直接复用，勿重写）

| 资产 | 位置 | 用途 |
|---|---|---|
| skeleton_common.R | skill assets/ | 读数/密码推导/解码/失活/CTX/参照表/expand_* 公共段（原样使用） |
| skeleton_output.R | skill assets/ | Content+业务页样式化输出（含 LISTING_TITLES/同名去重/ttl 传参） |
| cmp_export.R | skill assets/ | 新旧比对三函数（cmp_diff/cmp_export_sheet/cmp_export_content） |
| spec_writeback.py | skill assets/ | DVP Unique ID 回写（最小 XML 手术） |
| manual_listing.R.tmpl | dsh 插件 r-templates/ | r_manual 车道模板（V1-V4 访视/L1-L3 实验室/ALS 段已固化） |
| edc-baiaozhi.md | skill references/ | 系统数据模式详解（§3 判定/§7 CS 六步/§9 ALS） |
| baiaozhi-export-template.md | skill references/ | EDC 比对导出模板结构+着色+Form Name 命名方式 |
| dvp-patterns.md / pitfalls.md / output-spec.md / password-rule.md | skill references/ | 派生列 12+ 类模式 / 报错先查 / 样式规格 / 密码推导 |
| KXZY-GB08 程序 | 参考项目 | 成熟同系统先例（lb_cat 模块过滤、compare_data） |

## 5. 交付物与目录契约

- 单文件 R 程序 → `SAS_Program/SAS_program/Manual Listing/`（Windows 调试块本机覆写）。
- 输出 xlsx+RDS 只落 `Output/04_Out/Manual listing/`（Content+83 业务页；空表"无数据记录"占位）。
- spec 回写副本 `*_UniqueID回写.xlsx`（原 spec 永不覆写）。
- 交付回执：[REPLACE] 清单（阈值/访视关键词等需 DM 与方案核对项）+ Content 汇总数。

## 6. 端到端流程（同系统新项目 checklist）

1. 定位输入（项目根/DVP/数据 zip；确认数据日期/旧版/密码）→ 2. 按白名单读 DVP 需求列，
   逐行映射（数据集+访视+字段清单+Condition+派生列来源），映射表先给用户确认 →
   3. 读 ALS（eCRF/内嵌设计/访视表/eCRF界面/Casebook——表名与访视内显示名称的权威源）→
   4. 探测 SAS 元数据（00_meta_dump 模式：标签/列名/format 绑定/FORMATS 全量）+
   探测编码结果文件（名含 编码|coding；有则按 §2 编码方法论接 PT 术语派生列，
   页名键对 DataPageName 值域逐个核对，跑完逐 listing 报命中/未命中计数）→
   5. 渲染骨架+逐行核查节组装单文件 R → 6. 跑通循环（验收 listing 数=DVP 行数；flag 抽查）→
   7. 套 §3 终案表自查显示层（表单名称/Content/B1/居中/去重）→
   8. spec Unique ID 回写 → 9. （有旧版时）新旧比对 → 10. 交付+回执。

## 7. 回归与验证方法论（改任何一处必做）

- **双侧 diff 验收**：改动前后输出逐格比，差异必须**恰好等于预期面**（例：去前缀轮
  299 格=24 listing 的编号列；Content 轮 83 格=Form Name）。行列数零意外变化。
- **三级自洽审计**：B1 == Content Form Name == sheet 内表单名称列（官方词表对账）。
- V2 重组装幂等：`_assemble_v2.py` 重装后与手改文件**字节级一致**；
  **改 skeleton_output 后必须重组装再跑**（V2 内嵌输出段不随文件自动更新）。
- dsh tmpl 回归：`DSH_R_*` 环境变量在 scratch root 直跑 .tmpl（RData 缓存 +
  OUTPUT_PREFIX 区分前后）+ listing 包单测（pnpm test，40 项）。
- 验收脚本坑：openpyxl **read_only 会按声明维度截断 openxlsx 业务页行**（假报零差异），
  必须非 read_only；R 命名向量 `x[[缺失名]]` 报下标越界，查找先 `%in% names()`。

## 8. 踩坑总索引（按类，详见 pitfalls.md）

- **R 环境**：LC_CTYPE 显式 Chinese (Simplified)_China.utf8；源文件无 BOM UTF-8；
  多字节正则 fixed；管道参数 enquo；Node 子进程保留 PROCESSOR_ARCHITECTURE。
- **openxlsx**：颜色带 #；无 underline 参数（用 textDecoration）；writeFormula 自动补 =；
  列宽自动 +0.7109375；genBaseSheetRels 悬空 rel 需建表前收口；**loadWorkbook+saveWorkbook
  往返改 spec 会空串变 "NA"+丢 customXml——改既有 xlsx 用 XML 手术**。
- **openpyxl**：读 openxlsx 产物需剥悬空 drawing rel；read_only 截断行。
- **数据形态**：PE1RES≠PERES；SRT2/3 缺列守卫；中心编号 sprintf %02d；
  ACT() 拷贝无派生日期列；0 行 df 追加列 rep()。
- **流程**：Excel 开着输出文件 saveWorkbook 报 Permission denied；
  zip 密码三连坑（见 password-rule.md）。

## 9. 演进史备忘（防走回头路）

匹配编号前缀→纯序号；总体表名→模块细分；Content 代码→中文→（自造标签被否）→ALS 官方
零自造+同名（代码）去重；A1 漏居中→补 center/center；LB1_01 过滤分叉→对齐 47 行；
LBPG_02→LBPG_LBPGU_01 对齐 V2 与 spec 回写。每轮纠偏均已双侧回归+单测收口，
对应改动全部固化进 skeleton/tmpl/文档三处。
