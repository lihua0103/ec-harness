# 场景库：pk-mapping（PK 浓度 × EDC 合并映射数据集，双盲）

车道：`enterprise_listing_run_pk`（blindMode blinded/unblinded）；目录契约（PK csv
在 02_Raw_csv、EDC sas 在 01_Raw_sas、spec/程序在 SAS_Program、产物唯一落 Output）
见车道引导（order 118）。设计记录：docs/enterprise/LISTING_PK_MAPPING_DESIGN.md。

## L1 写码前门禁（Gate）

- **GP0 需求理解自审（U-Gate，先于一切写码；2026-09-19 定案）**：产出需求理解
  矩阵（spec 逐变量：口径→数据源证据→置信级 E/I/U）+ 红队三类必查（号体系/RT
  时间戳来源/时点边界 off-by-one——2026-09-19 实案：PC 表 SD2/3/4 时点标签 48/72/96
  与 EDC 采样记录错位一格，矩阵级值域实证当场抓出修正）。无未处理 U 级（实证升级
  或列待确认清单给用户出路，禁近似代理）才写生成区；矩阵随交付汇报留存。详见
  router「U-Gate」节。交付前另须过 G-Gate（golden_gt 双跑逐文件 QC，见 router）。
- **GP1 给药时刻口径**：RT = PCDAT − **ECSTDAT 完整时间戳**直取（spec 原文口径）。
  "某字段自带时间是录入戳"这类结论必须**全行恒定差值 + 时刻分布双重实证**才可采信
  （实案：ECDSTTIM 与 ECSTDAT 恒差 +10h 系前夜空腹时刻，旧拼接口径致 RT=NT−10h、
  190 行截 0）。
- **GP2 受试者双路映射**：PK Subject 可能是筛选号（SUBJ.SUBJID）或随机号
  （RAND.RAND_ID）——SUBJID 命中优先、RAND_ID 兜底；两路皆零命中→醒目告警给排查
  出路，不静默空表。随机号另有**数值形态坑**（LIMS 导出吃前导零：01001→1001，
  2026-09-16 正式首跑 72/72 全未匹配实证）——对账键两侧 as.numeric 归一，输出的
  随机号列取 EDC 文本原样（spec $5 权威形态），未匹配行才退回 PK 原值。
- **GP3 日期解析**：dd Mon yyyy 需英文月份 LC_TIME（English→en_US.UTF-8→C 链式
  容错）；解析失败必须计数告警，不许静默 NA。
- **GP4 队列载荷**：COHORT 分组决定时点源（fasted→PC1/fed→PC3/计划外全留）——
  分组值域先查实际数据再定映射。
- **GP5 自检红线**：输出行数与 PK 投递守恒（违反直接停盘）；RT 负值**截 0 前计数**；
  匹配孤儿/StudyID/重复行进 QC 汇总。
- **GP6 揭盲**：unblinded 必须先配随机化 schedule（RAND_SCHED_FILE）。
- **GP7 首跑双名与覆盖（2026-09-16 事故回填）**：新项目首跑前先 dir Output——目录里已有他人
  `studyCode_数据日.rds` 时不得覆盖。双名共存约定：人工主编程 rds=`<studyCode>_<数据日>.rds`
  （QC 程序永不写此名），QC 独立编程 rds=车道契约名 `<studyKey>_PK Mapping_<数据日>.rds`；
  datasetQC 比对段写自动跳过式（绝对路径 file.path(out_dir,..)，缺主编程 rds 时 NOTE 出路而非报错）。
- **GP8 主编程形态即黄金基准**：列名（含是否带单位后缀）/列类型（spec Type 声明让位于主编程实际
  class）/attr label（=列名自身）/缺失值（一律 NA，禁空串——datasetQC 把 NA vs "" 记值差异）逐列
  对齐主编程交付 rds；label 必须**落盘前最后一步**对 as.data.frame 后的对象统一贴（tibble 行子集
  丢列 attr——管道/子集都会抹，中途贴必复发）；浓度等值**直取传输文件原文**（长尾巴可能是 .xls
  字面文本，readxl text 实证后再决定，勿套用其他项目 round5 惯例）。
- **GP9 datasetQC 报告逐行精读**：base/QC 列名与 class 逐行核对后再动代码，禁止凭单张截图印象改
  口径（实案：AGE base 误读 numeric 反向改错一轮）。

## L2 口径终案

- 输出模型（2026-09-10 DM 口径修正）：单表平铺（无 Content/QC 页/审核列），QC 只进
  note() 运行日志；spec 23 变量行序=列序；pre-dose RT=0；RT 负值截 0 先留痕（X2）。
- 全 23 列输出（2026-09-11 交付定案，datasetQC 双编程比对需与主编程交付集一致）：
  SEQ/TRT 走随机化 schedule（RAND_SCHED_FILE），无 schedule 空串 "" 占位（EDC RAND
  表无序列/治疗字段）；SEX/AGE/HEIGHT/WEIGHT/BMI 常输出；基础表列名改 spec Variable
  + label 属性。
- 受试者显示口径 SUBJ_MASK_MODE 项目级确认勿固化：默认 none=号原样（随机号本身
  盲态安全）；筛选号类/需掩码项目改 S001 型确定性掩码。blind_mode 仅余 Excel 文件名
  " (blinded)" 后缀用途。
- 盲态双产物形态（主编程人写交付实证，2026-09-12 蒸馏并**已固化进 tmpl**）：binded=
  外部编盲表（SUBJID→BLINDID）join 换号，剔 SEQ/TRT/SEX/AGE/HEIGHT/WEIGHT/BMI 与原
  SUBJID，STUDYID,SUBJID 打头，arrange(SUBJID,PERIOD,RT)；unbinded=全 23 列；RDS=未编盲
  全集。**输出三件套=人工形态（2026-09-12 双跑 QC 定案）：列序=spec 行序（最终装配
  显式 select 定序）、sheet 名="PK_Mapping"、write.xlsx 直出（无冻结/筛选）、文件名
  PK_Mapping_unbinded_<date>.xlsx / PK_Mapping_binded_<date>.xlsx（有编盲表时）/
  <studyKey>_PK Mapping_<date>.rds；blindMode 不再影响文件名；Concentration 最终输出
  统一 3 位精度（人工代码读取层 round5 仅浮点噪声归一，投递值 ≤3 位小数时输出同 3 位）。**
- RDS 只存单表（与 Excel 行值一致）；Concentration 字符形态（BQL 原样、数值 round 3
  后 as.character——datasetQC 对 numeric 按 17 位全精度显示，double 尾巴 round 消不掉，
  字符形态两侧比对才一致）；AGE/HEIGHT/WEIGHT/BMI 转字符；label 在类型转换后统一重打。
- **浓度精度形态分项目（勿跨项目套惯例，GP8 同源）**：BE 型=3 位精度 round；SAD/MAD 型
  正式批=6 位有效数字文本（首位非零起算、不足位补零、非科学计数；R 逐元素实现——向量版
  format() 会整列统一格式补出 7 位）。**每批对账前先重读当批 base rds 的 names/class/
  label，勿沿用上批结论。**

### SAD/MAD 形态（第二型项目定案，2026-09-16）

- 参照给药：SAD 全部=SD1 单剂；MAD Day1-2→MD1 第一剂、Day4/6 谷→同日第一剂、
  Day7-9→MD7 第一剂、CSF→MD7、未计划(999)→采样前最近一次；行级剂量/禁食与 RT 取
  同一条参照记录。NT=Day Nominal 纯映射（SAD 1-4→D1；MAD 1-6→D1、7-9→D7；CSF→D7），
  **不依赖 EDC 记录存在**；999 行 NT 由参照剂量日归属。
- pre-dose RT 截 0 双锚点（上一项目 DM 定案+本项目人工 UAT 实证），程序留 RT_NEG_ZERO
  开关；RT 数值型 2 位小数（主编程形态）。
- 编盲时间点隐藏（项目便签级需求）：血浆计划时间点队列内任一受试者未采集→该队列全员
  该时间点从交付移除并计数留痕（守恒校验在过滤前的全集上做）；CSF 一人一点与 999 豁免
  （字面执行会清空 CSF，与 spec 矛盾）；循环必须 NA 安全（logical 索引带 NA 虚增计数）。
- CSF 输出开关 CSF_OUTPUT：映射代码/规则全保留，交付=血浆单表对齐主编程（FALSE），
  CSF 数据正式投递后改 TRUE 并入单表（42 行）。
- EDC 形态（Rave）：随机号只认 DS2.DSREFID（DS1.DSREFID 是被替换者随机号，勿混）；
  采样时刻=PCDAT+PCTIM 拼装（PCDTC/ECDTC 组合列常为空）；CSF 码表显示串错位只认
  显示串解析；时点/访视日映射 case_when 显式值域（解码串实证），不写文本解析器。
- 依赖纪律：单文件只挂 readxl/dplyr/openxlsx（缺包降级，本机常无 tidyverse 整包）；
  map_*/crossing/tibble 不可用，用 vapply/expand.grid/data.frame 替代；formatC(format="fg")
  必须包 trimws（按向量最宽值补空格）；Linux 无 "English" locale——setlocale 链内静默、
  解析失败计数（GP3）。**加密传输件（.xls 口令保护）=数据准备步骤，不是 R 程序逻辑（2026-09-16
  终版定案，取代早前"程序内置自动解密"方案——该方案被用户否决：R 交付零 python，服务器无
  python）**——数据入库时用 sidecar pw.txt（多编码解析 utf-8-sig→utf-16→gbk→ascii）经
  msoffcrypto/Excel 生成官方件名+`_dec` 解密副本，程序只读解密副本；read_pk 守卫对加密原件
  给"先解密"出路而非天书报错；密码明文不出现在任何输出；不读他人工作文件（如 _zhy.xlsx 类，
  既不看也不用不比对）。
- **QC 过审后冻结纪律（2026-09-16）**：datasetQC 审核通过后交付程序不得大量改动——已验证的
  映射逻辑冻结；新增运维关切（如解密）走程序外数据准备步骤或独立工具，不塞进交付程序。

## L3 方法论：主编程人写风格（AI 写码表达层基准）

来源：本项目主编程（人工编码）最终交付 R 程序——车道 QC 独立编程与其输出哈希全等
的对端。**AI 新写/改编 PK Mapping（及同类单文件交付）R 程序时按此风格；只保留
harness 契约最小集（cfg 环境覆盖/错误回执/运行摘要）与守卫红线（行数守恒、零命中
醒目告警、编盲一对一与覆盖校验）。**脱敏全样本：`assets/mainprog-style-exemplar.R`
（项目名/作者/密码/中心名已中性化）。

### 思维链：读 spec → 落码的推导顺序
1. **输出契约先行**：spec Variable 全集=输出列全集、Label=逐列 attr、行序=列序；
   改名/定序/贴 label 收口在最终装配一步（rename→select 全列显式→attr），中间表
   一律用源列名。
2. **逐列盘数据源**：投递 PK 表自带列与 EDC 派生列分开清点；EDC 无源的列空串占位
   不硬凑（SEQ/TRT——RAND 表无序列/治疗字段），固定值列常量直给（UNIT="ng/mL"）。
3. **号体系先打通再 join**：PK 表 Subject 是哪套号先实证（随机号/筛选号），经 RAND
   表桥接受试者级归一（改出 ScreenId 键），此后一切 EDC join（DM/VS2/EC/PC）走归一号。
4. **时间口径**：RT=采样完整时间戳−给药完整时间戳（GP1；两侧字段先确认自带时刻），
   units=hours、round_half_up 3 位、负值截 0（X2）。
5. **值域先查后写**：Folder→Period、时点标签→名义小时用 case_when 显式枚举实际值域
   （与 TPT_HOURS_OVERRIDE 同思想：显式表优先、TRUE~NA 兜底、不写文本解析器）。
6. **盲态是产物形态不是列开关**：编盲段=join 编盲表→剔敏感列→BLINDID 改回 SUBJID
   →STUDYID,SUBJID 打头→arrange(SUBJID,PERIOD,RT)，binded/unbinded 双 Excel+未编盲
   全集 RDS 三件套（见 L2）。

### 骨架（六段式，中文分节横幅 `# ---- xxx ----`）
1. 库区一次性挂全家桶（含 QC/比对用包）；2. 头部元数据 Author/ProjectName/studyCode/
   environment/listingType/subjectfile/sysType 一行一变量对齐；3. 外部输入集中区
   foldername(数据日)/folder_path/als_path/pk_data_file/password——正文此后零硬编码
   路径与口令；4. `# ---- 工具函数` 三件复用件——drop_sys_varible_rave（Rave 系统变量
   清单+codelist 后缀 _STD/_RAW/_INT/_YYYY/_MM/_DD 清理）、read_sas_folder（解压→读
   全部 sas7bdat→按数据日 RData 缓存→清解压件）、alsmapping_saslabel（ALS Fields 页
   FormOID×FieldOID→PreText 给中间 rawdata 贴 label）；5. `# ---- 读取数据`；6. 主流程
   （中间表 PC_ALL/EC_ALL→join 链→派生→最终装配）→落盘三件套→datasetQC 比对段
   （注释模板形态，主编程 rds 投递到位后启用）。

### 表达层习惯（tidyverse 正文）
- join 前先 select 收窄入参：每段 join 入参只留键+需列（防列名冲撞/冗余进结果）。
- 多表单合并：select 对齐列集后 rbind；无时点列的表单打 "UN" 标记补列再合并。
- 值域映射 case_when；DOSE=paste(剂量,单位)；浓度列混合类型统一字符（BQL 原样、
  数值 round 后 as.character）。
- rename("STUDYID" = "Study ID") 带引号命名向量式；中间表名大写聚合（PC_ALL/
  EC_ALL），主表名 <源>_cohrt。
- label 只在最终表逐列 attr()（spec Label），中间表不贴（attr<- 是 copy-on-modify，
   贴完整体回写 datasets[[name]]）。
- 注释极简：分节横幅+关键口径短注，不写论证小作文（论证留交付说明，代码干净）。

### 差异清单（风格照学、依赖改造）
- 照学：RData 按数据日缓存+解压件清理；join 前 select 收窄；case_when 显式值域；
  最终一步 rename/select/attr 收口；RDS 命名带作者/日期/环境后缀。
- 改造后学：**dmy_hms/round_half_up 在人写程序内均无定义、无显式 library**——借运行
  环境里其他包顺带 attach 的函数（正因此当时 3 行 RT 边界舍入差异无法用程序源码对
  齐，实现在他环境的包里）。独立复用必须显式挂 lubridate 或自带实现（tmpl 自带去噪
  版 round_half_up 与 dt_posix 多格式解析，勿换回环境依赖）。
- 不学：setwd 自由切换+system(unzip) 裸拼密码（单项目交付可，车道/并发复用互踩——
  保持绝对路径+密码经环境变量/推导链）；库区挂而未用的包（车道按需加载并留缺包降级
  出路）。

### WebUI 实测回执（2026-09-12，进化闭环验证）
真实用户路径（WebUI→AI→enterprise_listing_run_pk）验证本层可应用性：AI 收到编盲双
产物任务后——①先 K1 实证编盲表号体系（直连/桥接两路取覆盖高者，皆零命中 stop）；
②业务段按人写风格表达（管道剔列→换号→select(STUDYID,SUBJID,everything())→
arrange(SUBJID,PERIOD,RT)）；③同时保留车道防错（norm 表头匹配/一对一校验/GP5 行数
守恒+零 NA/换号后补回 label/[REPLACE P9] 标记/render=false 复跑纪律）。实测后该段
已固化进 tmpl（P9）：缺编盲表自动跳过+NOTE 不伤主表（eval ALL PASS：manual 84/84 +
PK 1/1 哈希不变）；有编盲表原生渲染即产 binded（与 AI 手写版结果一致）。
**新增加固点：换号向量（bind_key）按行序对齐 PK_out，必须锚定同源行序
（SUBJ_E→PK_out←pk_raw 链），不得插在重排 PK_out 的改动之后——join 换号（人写
形态）无此约束，行序换号（车道形态）有。**

**终局（同日人工代码双跑定案）**：人工标准代码基准运行版（沙箱同数据原样跑，仅补
环境依赖 lubridate/round_half_up 与输入形态字面量）与车道产物三对文件（rds/binded/
unbinded xlsx）逐文件 QC——值/class/label **首轮即 100% 全等**；结构性差异（列序=
投递列序+append vs spec 行序、sheet 名 PK Mapping vs PK_Mapping、文件名 (blinded)
后缀）已在 tmpl 消除（PK_COL_ORDER 定序段+write.xlsx 直出+三件套命名），复比 0
差异；eval 基准同日切到人工产物（golden_gt）。**方法论：AI 与人工的一致性要用
"双跑逐文件 QC"闭环证真——datasetQC 按列名比对会掩盖列序/sheet 名/文件形态差异。**

### 精简度终案（V3 精简形态 tmpl，2026-09-12；体积对齐人工量级）

用户定调：数据 QC 已全过，剩余差距=代码密度（人工 8.3K/273 行，AI 旧版 62.4K/1073
行=7.5 倍）。**tmpl 已整体重写为人工风格 V3 精简形态：18.6K/345 行、注释占比 12%
（人工 2-13%）**，输出经双跑 GT 比对与 eval 三对文件零差异、回执计数不变（9726）。
- 保留层（约 +6K，人工服务器版不需要、车道必需）：harness 契约（cfg 环境覆盖/
  错误回执 handler/运行摘要 JSON）+ 守卫红线（行数守恒 stop、零命中醒目告警、
  编盲一对一+覆盖校验）+ QC 计数（eval 判据）+ SEQ/TRT schedule 段（P6）+ 表头
  归一段（投递空格形态容错）。
- 删除层（旧防御式形态，V3 已按人工写法替代）：密码候选推导链（改 cfg 单密码+
  RData 缓存免解压）、多格式日期解析器 dt_posix（改 dmy_hms 显式挂 lubridate）、
  文件夹关键词兜底/时点文本解析兜底（改 case_when 显式值域，P8 本就要求）、
  disp_of/raw-_STD 解码层（raw 直通）、C5 队列裁剪（人工=PC1∪PC2∪PC3 全源，靠
  NT 数值 join 自然过滤）、开篇长注释与论证（知识一律进本库/设计文档，程序只留
  [REPLACE] 标记与分节横幅）。
- **写码纪律（AI 生成同类程序通用）：注释占比 ≤15%；论证/教训/口径出处不进程序；
  防错只保"输出正确性红线"层，环境兜底按项目形态实证后选简式；体积对齐人工量级
  （≤2 倍），超出先自查有没有把知识库内容写进代码注释。**

## L4 关键 postmortem（已固化为 Gate）

C2 给药时刻（GP1）；dt_posix 缺英文月份分支+缺 RAND_ID 路径（GP2/GP3，模板存量
缺陷，靠"真实数据×系统链路"验证抓出——合成 e2e 的日期/编号假设会掩盖读数层缺陷）。
2026-09-16 增：首跑同名覆盖主编程 rds（GP7）；tibble 行子集丢列 label 致 datasetQC
Label mismatch 全表复发（GP8，label 家族第三坑：copy-on-modify→子集抹 attr→行子集抹
label）；浓度 round5 惯例误套致值级文本全差异（GP8，惯例先实证）；AGE base 误读反向
改错（GP9）。**QC 过审后再往交付程序塞解密逻辑（python→纯 R OLE/RC4）连续两次被
叫停回滚——教训=已过审逻辑冻结，运维关切走程序外步骤（见 L2 冻结纪律）。**

## eval 判据

`dsh-standard-verify`：PK 224 行；QC 汇总=已随机化无PK数据 86；EDC采样行无PK浓度
9632；RT为负 8。**基准（2026-09-12 起）= 人工标准代码产物（golden_gt/：主编程最终
交付版代码在同沙箱数据原样跑出的三件套）**：xlsx 1/1 sheet 哈希全等 + rds 列序/
class/label/逐单元格 celldiff=0（compare_verify.py + gt_rds_check.R）。binded 产物
经沙箱双跑比对全等（eval 沙箱无编盲表不产 binded）。
**2026-09-17 增第三车道 pk-sadmad/PSTB100**（SAD/MAD 分模板 golden 回归门）：沙箱
数据=正式批 20260916 只读拷贝；golden_gt=已验收交付产物；判据=xlsx 哈希全等 +
rds 72 行×23 列 celldiff=0；回执核对点=rows 72、flags 9（EDC已随机无PK 3+RT负 6）、
前导零归一 72 行 NOTE、CSF 空/无编盲表降级 NOTE。运行需 form='sad-mad'+
studyCode+config DSH_R_PK_ANALYTE。**两 PK 车道流程含 AI 校准步**：render 骨架→
ai_zones.R（业务生成区定稿）按区注入→render=false 执行——模板零业务逻辑架构下，
ai_zones=AI 识别 spec 生成内容的回归锚点，新项目收官时刷新本项目 ai_zones。

## L5 项目档案（新项目先读：上个项目的终点是下个项目的起点）

- **SAD/MAD 型车道回填→零业务改造（2026-09-17 两轮定稿）**：验收后实证车道三缺口
  （tmpl 仍 BE 形态 / 程序名契约 / 运行摘要契约缺失）——第一轮以"业务行原样搬家进
  tmpl"回填（sadmad 分模板+form/studyCode/config 契约），**随即被用户纠正为根本原则：
  模板不能固定写死业务逻辑，所有生成 R 代码的业务逻辑都是 harness AI 识别 spec 需求
  理解后生成的**。第二轮终态架构=**模板契约层 + DSH-BUSINESS-ZONE 业务生成区**：
  ①两 PK 模板（BE 同类改造）零业务值——契约层只留 cfg 覆盖/读数发现/通用工具
  （dt_parse/round_half_up/sig6/norm_char/drop_note）/守卫红线/落盘三件套/datasetQC 段/
  运行摘要；②生成区 BE=Z1-Z4、SAD/MAD=Z1-Z6（constants/bridge/intake/mapping/demog/
  assembly），每区带生成契约注释（从 spec 哪里读、证据要求、GP 门禁引用），未生成即
  运行 fail-fast 给出路；③runner/工具契约 form（be/sad-mad）+studyCode+config
  （DSH_R_ 环境覆盖，ANALYTE 走 DSH_R_PK_ANALYTE）；④eval=ai_zones.R AI 校准步
  （首项目已验收业务段定稿按区注入→render=false→golden 回归），三车道 ALL PASS
  （xlsx 哈希全等 + rds celldiff=0），fresh-render fail-fast 实证。
  **方法论：模板=骨架与契约的复用，业务=AI 从 spec 的每次推导；"实例→模板"回填
  的正确形态是回填"生成区契约+校准基准"，不是回填业务值。** 同类审计：manual 模板
  内嵌 HXN6005 业务（访视词/标题/行定义），有 17,993 行 golden 护航，列独立改造待办。

- **新项目首跑档案（同型新目录/新数据日 20260912，2026-09-12 WebUI 真实路径）**：
  **一遍 QC 通过**——AI 按自进化协议自动读 router→场景库→GP 门禁声明→L5 档案纪律
  （主动引用"首次真实数据须汇报 P1-P9"）→ run_pk 一次渲染执行成功（224 行，QC
  86/9632/8 与判据吻合，1.8s）→ 产物与人工基准 rds+xlsx 逐单元格 0 差异、程序
  18.5K/345 行精简形态、无编盲表自动降级说明。**进化闭环有效性实证：上一项目的
  学习（GT 基准/精简 tmpl/L5 档案）在新项目首跑即全量生效。**
- **双盲 BE·Rave（中性代称 400311，2026-09-12 收官）**：值层一遍过？——**否→是**
  （datasetQC 值级首日通过；双跑逐文件 QC 补出列序/sheet 名/文件名 3 项结构差异，
  当日消零后 rds+双 xlsx 三对 0 diff、eval 对人工基准 ALL PASS）。表达层：V3 精简
  形态后体积比 18.5K/8.3K=2.2×、注释 12%（旧版 62.4K/7.5×/35%）。RT 悬案档案：
  zhy 环境 round_half_up≈janitor 形态（无去噪），2 行半点边界浮点噪声舍错（十进制
  应进位），已定论"如实呈现勿反向对齐"；dmy_hms 来自 tidyverse≥2.0 attach 的
  lubridate。新项目写码前先查：投递表头空格形态、PK Subject 号体系、Concentration
  精度口径（3 位）、编盲表是否投递。
- **SAD/MAD·Rave 型（中性代称 P 项目，2026-09-16 首跑收官）**：standalone 交付
  （SAS_Program/SAS_program/PK Mapping/ 单文件，服务器 Rscript 直跑）。双编程对账
  三轮收敛：①xlsx 值级 35/35 零差异→②datasetQC 属性层五类（全列 label/列名 (mg)/
  类型/NA 口径/浓度原文）逐个对齐→③AGE=character、tibble 行子集丢 label、CSF 口径
  （血浆单表+CSF_OUTPUT 开关）清零。UAT 阶段 MAD/CSF 未入组属预期告警（未匹配行保留
  留空），正式批次仅换 CONFIG 文件名；CSF 待正式投递改开关并入。教训已固化 GP7-GP9。
  与上一项目两处形态差（UAT 阶段判断）：AGE character、浓度直取原文不 round。
  **正式批定案（2026-09-16 晚）**：主编程生产 rds 形态=40031 定案——列名=spec
  Variable（Study ID/Subject/COHORT/ECFASTFD/PDOSE/ECDOSE/RT/LLOQ/ULOQ/WEIGHT/HEIGHT/
  Sample Comments）、label=spec Label、Sample Comments 全空呈 numeric。浓度=6 位有效数字文本（首位非零起算，不足位补零，非科学计数；R 程序内
  sig6() 实现——向量版 format() 会整列统一格式补出 7 位，必须逐元素）。
  **教训：主编程形态会随交付阶段演进，每批对账前先重读当批 base rds 的 names/class/
  label，勿沿用上批结论（含本档案）。**
  **正式批 20260916 跑通（收官）**：C1 6 人×12 时点=72 行全匹配（前导零归一生效，输出
  随机号全 5 位）；RT 负值 6 行截 0 留痕；编盲隐藏未触发（网格 72 格全齐）；跟踪项=
  浓度 24 行 NA 待回+队列 2 三人 EDC 已采样 36 行结果待回（传输节奏非缺陷）；数据契约位
  `02_Raw_csv/PK Mapping/<date>/`，程序 CONFIG 必须跟契约位，解密副本按数据准备流程
  重建。KPI：双编程对账三轮收敛、正式批 first-pass 值层 0 差异；敏感数据红线=生产数据
  值不进对话（只出计数/值域/一致性结论）。
- **SAD/MAD 标准结构同步轮（2026-09-19 晚，冷启动第三轮）**：沙箱按规范目录完整
  布局（20260914 UAT 目录+投递 zip/RecordCounts/pw.txt+原始传输件）+ 服务全量重建
  + 新会话单提示词一轮过：xlsx 1/1 哈希全等 + rds 72×23 celldiff=0；生成 515 行
  （纯码 402）vs 交付 707（纯码 581，差额=守卫/值域留痕层）。**AI 会话内自纠 PC 表
  SD2/3/4 时点 off-by-one（48/72/96→24/48/72）**——此实案已固化进 GP0 红队必查③。
  GP8 形态缺口本轮未复发：AI 主动探针核对 golden rds 行序/形态后一次对齐（Z6 契约
  注释锚点生效）。KPI：first-pass 值层 0 差异、体积比 0.73×（精简纪律生效）。
