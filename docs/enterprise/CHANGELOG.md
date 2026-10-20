# 更新日志

## [2026-10-20 真实项目实测] RT01 真链路验证：修掉三类真实误拦，红线完好

在 `CGB3002-RT01`（66 个 SAS 数据集 + DMP 需求 + 加密归档 + 上一版交付物）
上跑真实 AI 会话（WebUI→AI→企业工具→本地 Python→交付），两轮共约 90 分钟、
108 次工具调用。**这是方案 §12.3 要求的真实用户路径验收，T13 部分完成。**

### 实测发现的误拦（全部已修，均用合成数据固化为回归）

1. **稀疏列码表值**（`AEREL` 69 行仅 4 个非空、2 个唯一值）：`_is_vocabulary_column`
   用**非空值个数**做基数分母与证据门槛，稀疏列因此被判"样本不足"→ 落进
   fail-closed 数据保护 → 码表值（RELATED 类）进索引 → 模型把需求摘要写盘
   再读回被整体拦。修复：分母与证据门槛改用**整列行数**。
2. **小表 EDC 元数据常量列**（15/19 行表的 `DataPageName`/`Folder` 等）：
   行数 < 20 未达词表门槛，整列同值的导出元数据被当数据保护。修复：
   `_is_constant_column` 对已确认的 EDC 元数据列名（DataPageName/Folder/
   FolderName/InstanceName/environmentName/SiteGroup/project）不受行数限制。
3. **列名/值长相扩大豁免面**：`_is_identifier_column` 初版含 `STUDYID`，
   把方案号 `PSTUDYID`（整项目常量）误判为个体标识、灌回索引，导致
   GQ1005-301 类方案号被拦。修复：标识词只收受试者/患者级
   （USUBJID/SUBJID/PATIENT/DOB 等），方案号与中心号不在其列。

### 红线校验（每次改动后都重跑，全部通过）

- 237 个高基数列**全部仍受保护**；受试者号抽样 19/19 在索引中。
- 单行/极少行唯一值**不**因"常量"豁免（`SUBJID=["1007"]` 仍保护）。
- 标识类列名即便整列同值也不豁免。
- 模型把数据行导出到 `.dsh/work/*.json` 再 `read` 回读 → **被正确拦截**
  （实测 `mr_rows.ndjson`/`build5_pretty.json`/`focus_dump.json` 确含保护值）。
  这不是误拦，是红线在阻止"写盘洗白"。

### 结果

- 第二轮真实会话：54 次工具结果、4 次拦截（**全部为含真实行值的自建中间
  文件，属正确拦截**）、4 次业务代码错误（IndexError/SyntaxError，模型自行
  修错成功——修错闭环已工作）、0 次基础设施故障。
- 交付物 `RT01_MANUAL_LISTINGS.xlsx` 生成 51 张表，与基线 52 张共享 51 张；
  差 1 张 `LISTING_NVI_01`（源表仅 3 行），属需求理解范围，非安全拦截导致。
- 回归：pytest 240 全绿（新增 `test_real_project_false_positives.py` 6 例，
  误拦与红线断言成对）、tool-audit 25、listing vitest 58、typecheck、架构检查全通过。

### 同时修掉我自己引入的两个业务上限（用户指出）

- `decode_runner_outputs` 曾加 **50 张表上限**，真实 Manual Listing 需 51 张，
  模型被迫反复试探 50/51/52 边界。已删除帧数与单帧行数上限，只保留总单元格
  资源兜底（50M，防 OOM）。**工作表数量由需求决定，护栏不设业务上限。**
- `controlled_analysis` 的 `MAX_REQUEST_ITEMS=64` 会挡住 RT01 的 66 个数据集，
  已提到 2000（纯滥用兜底）。
- 两个上限的移除各有专项回归（`test_sheet_count_is_not_capped` 等）。

### 尚未收口（如实记录）

- T05（语义分页/稳定文档 ID）、T08（R 车道暂存发布）、T09（请求门禁/会话继承）、
  T10（成组收紧宽豁免）仍未实施；三项宽豁免（shell 结果、enterprise 前缀、
  未绑定项目）仍在，**红线未严格成立**。
- 上一版交付物（项目根 xlsx）仍按辅助业务数据处理并受保护：模型读它会被拦，
  这是正确行为；若需要模型做新旧对比，应走 `enterprise_listing_analyze` 的
  compare_artifacts，而不是放开读取。
- 交付完整性（`LISTING_NVI_01` 差异）需按 DVP 逐表核对，属需求理解验收，
  本轮未做。

## [2026-10-20 第二轮] 数据安全 P1 部分：受控分析落地 + 快照绑定 + runner 输出严格校验（T06/T07/T04/T11/T12 轻量面）

- **受控分析（T06，方案 §6）**：新增 `controlled_analysis.py`（独立于任意
  代码 runner 的可信模块）+ `enterprise_listing_analyze` 工具（工具总数
  8→9）。首批操作：schema / key_check / join_check / rule_check /
  compare_artifacts / run_status——输入句柄只能是已登记数据集名或最近一次
  成功 run_code 的产物名（模型不能传文件路径/表达式/SQL，声明式算子白名单
  拒绝 eval 兜底）；宿主本地计算、只返回有限非负整数计数，不含行值/键值/
  样例。join_check 冻结 nullPolicy（默认 never_match）与期望基数、冲突键
  计数；compare 键不唯一显式失败，绝不按位置配对（修复实现中被测试抓出的
  行号交集错误——正确语义是键值交集）。
- **runner 输出严格校验（T07 残项，§7.3）**：decode_runner_outputs 把子进程
  JSON 当不可信输入——重复列名显式拒绝（此前静默改形，按列取统计会炸）、
  帧数/单帧行数/总单元格上限、attrs 键白名单（模型可伪造任意 attrs，未登记
  键不得进入下游投影）。
- **快照绑定与发布防护（T04/T11 轻量面，§5.2/§7.4）**：会话快照 ID
  （_ensure_session 与 inspect 全量路径生成）写入 run_code/publish/analyze
  回执；publish 校验产物所属快照，旧快照产物返回 SNAPSHOT_STALE 不得隐式
  发布。**快照语义定案**：inspect 全量入会话 = 不可变快照，run_code 只消费
  会话内存，磁盘文件事后变化不作废当前快照（保住"免二次读取"既有契约与
  回归）；数据更新经重 inspect 换新快照。conftest 补齐全部会话全局
  （含两个指纹与快照字段）的保存/恢复。
- **T12 轻量面**：系统提示工作流接入 analyze（第 4 步：需要结论优先
  analyze，只在确需个体值时 run_code）。
- **测试**：新增 `test_controlled_analysis.py`（11 用例：计数口径/基数冲突/
  空值策略双语义/算子拒绝/句柄守卫/键唯一性）、`test_snapshot_binding.py`
  （快照绑定/发布防护/decoder 严格合同）；TS 端 analyze 工具注册与参数
  透传测试。
- **验证**：tool-audit 25/25、listing 58/58、pytest 白名单 97/97、全仓
  typecheck、check-architecture 通过（`node scripts/safety-tests.mjs` 一键）。
- **边界如实声明**：T05/T08/T09/T10/T11 完整/T13 未实施——T10（成组收紧
  shell/enterprise 前缀/输出目录宽豁免）按方案依赖图必须等 T05–T09 全部
  就绪，**严禁提前单独收紧**；三项宽豁免仍在，红线未严格成立。T13 真实
  路径验收需授权环境，NOT RUN。

## [2026-10-20] 数据安全 P0 落地：误拦修复 + 扫描故障分类 + 诊断贯通（T00–T03）

按 `DATA_SAFETY_EXECUTION_REDESIGN_PLAN.md` 完成第一阶段。剩余边界
（shell/enterprise 前缀宽豁免仍在、红线未严格成立）见文末风险声明，
P1/T04 起继续。

- **公共出口合同**：tool-audit 新增无副作用子路径
  `@dsh-enterprise/tool-audit/egress`——固定错误码（PROTECTED_CONTENT_WITHHELD /
  SCAN_WARMING / SCAN_TIMEOUT / SCAN_FAILED / SCAN_UNAVAILABLE）、路径型
  参数键表、发现型工具集、交付目录形态常量；listing 经 workspace 依赖消费，
  判定原语不再各处各写。
- **误拦修复（pre-execute）**：路径型参数（file_path/path 等）按完整引用
  原子判定——含空格/中文的 doc 需求不再被空白切词切碎误拦，拒绝引用保留
  完整路径；glob/ls/stat 等发现型工具只做发现合同，不因模式串含
  .xlsx/.csv/.zip 拒绝。执行命令显式引用数据集仍拒绝（保护面不回退）。
- **绕过面关闭（post-execute）**：移除"参数或结果文本任意位置出现
  Output/04_Out 即整体放行"的文本豁免，改只认路径型参数命中交付目录；
  additionalContexts 两侧拼接面全部扫描（此前 `??` 单侧取值漏扫原结果上下文）。
- **故障分类回执**：扫描未就绪/预热超时/请求超时/扫描失败不再与真实命中
  共用"检测到受保护数据"文案——基础设施故障明示 errorCode、说明"不是检测
  到数据"并给出恢复动作；只有真实命中保留扣留口径。模型不再把初始化状态
  当泄露陷入重试循环。
- **诊断贯通（Python→TS→模型）**：`failure()` 补转 environmentHint 与
  failures 失败清单（此前在 Error 重建时丢弃，模型盲猜环境与失败输入）。
- **code_runner 编译/执行分离**：编译期 SyntaxError 带 stage=compile 与
  行号（数据未进执行，安全）；运行期异常类名过显式内置白名单（自定义类名
  归并 ExecutionError——exec 环境无 `__name__` 时 `__module__` 判定不可靠，
  实测踩坑）；运行期 raise 的 SyntaxError 文本不再借编译期口径回流；
  outputsDefined 成为成功/异常双路径的如实观察值。
- **scan_init 数据面指纹核对**：同项目换数据（指纹变化）必须整会话重置并
  全量重建保护值索引——此前同 project 直接短路 ready，扫描进程拿旧项目数据
  的哈希当当前项目用（首轮 init 清空会话数据集后短路复用会"重建"出空索引，
  双向风险：真实命中漏判 + 旧值误判）。
- **测试与工具**：新增 `test_code_runner_stages.py`（9 用例）、
  `test_scan_init_refresh.py`（3 用例）；conftest 补全两个指纹字段的
  会话状态恢复；`tests/safety/cases.json` 建立 S01–S30 场景→测试映射
  （P0 面 covered/partial，其余标 notRun 不假通过）；新增
  `scripts/safety-tests.mjs` 一键合成回归（vitest + pytest 白名单，
  Windows 经 cmd.exe 中转 .cmd）。
- **验证**：tool-audit 25/25、listing 57/57（含真实 Python worker 的
  risk-regression/data-guard）、pytest 白名单 52/52、全仓 typecheck 通过、
  check-architecture 通过。
- **风险声明（P0 不是安全收官）**：shell 执行工具结果整体放行、
  `enterprise_` 前缀放行、未绑定项目不拦——三项宽豁免仍在（方案 §1.2
  已登记），红线未严格成立；P1（T04–T10）补齐可信分析/快照/请求门禁后
  成组替换。

## [2026-09-22] demo-video 插件按首个交付项目 skill 增量升级：S0 调研 + 逐帧亮度锚点 + 验收门加密

- **S0 调研落地**（工具 6→7）：新增 `enterprise_demo_survey` + 随包
  `scripts/menu-tree-probe.mjs`——递归展开侧边栏产出菜单树（定覆盖清单）+ 可见菜单
  标签中文计数（语言门禁：含中文的页面录制时只高亮不打开）。只读零写入，与录制共用
  会话互斥；中文数据处置优先级（造英文演示数据须批准+先确认删除入口/换数据源/标注例外）入 KB。
- **S2 锚点算法整体换为逐帧 signalstats**（blackdetect/场景分值弃用）：三个实测失效
  场景（VFR 帧稀疏拉长 black_end、闪光帧被虚拟光标压住像素、黑条落深色侧边栏 luma
  临界）。新口径：闪光=全帧 YAVG<40 最长连续段（≥0.15s）掐头=黑出+0.1s；黑条=顶边
  条带 YMIN<20 帧簇（0.03–0.35s，间隔 ≤0.2s 归并；limited-range 纯黑 Y=16、full-range
  是 0，阈值取 20 兼容两种编码）按时刻窗口排除闪光；序列解析按 key 过滤。**亮度剖面门**同路产出：闪光后 5s 桶均值 <60 连续 ≥2 桶=弹层遮罩累积，
  S2 即拦截重录不带病进 S3。
- **S1 弹层卫生三件套进 walk 模板**：closeOverlay 三段式（Escape blur → Cancel/X →
  before-close 确认框点主按钮 → 可见 .el-overlay 数归零；**只点关闭确认主按钮，删除/
  发布等破坏性词消息框走取消**——数据红线脚本化）+ purgeStrayPoppers（幽灵下拉）+
  assertClean（段前卫生门）；scrollSteps 长页逐屏滚动 + 预热全页滚（懒渲染）；
  登录被拒（账号被占）不循环重试；record 回执新增 recoverCount/warnings。
- **S4 验收门加密**：字幕实证门（源视频同一帧带/不带字幕 YAVG 差 ≥0.4；探针必须
  `-copyts`，否则 -ss 归零时间戳后字幕滤镜永远命不中事件——本轮实测新坑）；尾留白不足
  自动 tpad 克隆末帧补齐（fps=25 必须在链头，tpad 对 VFR webm 不生效）。
- **语言体检助手 `cjk()` 进模板**（可见性过滤中文计数，只回计数不回流内容）；
  知识库 pitfalls 18 → 34 条（新增死按钮探测/evaluate 传参丢失/预览 --outDir/
  FINDER 大小写/首句 t 与掐头耦合/findstr 假失败等）；AGENTS/README/ADR-0011 修订同步。
- 验证：包内单测（纯核值级+装卸+schema+红线）与真实 ffmpeg 集成/E2E 全量适配新
  契约（gates 含 captionBurned、anchors 含 brightness）。

## [2026-09-21] 新增企业插件 demo-video：系统模块操作演示视频四阶段流水线

- 第五个企业插件 `@dsh-enterprise/demo-video`（row id `enterprise-demo-video`，
  ADR-0011）：把"模块全操作走查 + 英文界面 + 神经语音配音 + 动作级同步字幕"流水线
  从项目 skill 固化为随 dsh 企业层部署的插件能力。六个模型工具：
  `enterprise_demo_preflight / record / anchors / narrate / compose / kb` +
  systemPrompt section `tool:enterprise-demo`（order 126）。
- 四阶段契约：S1 录制（walk 脚本子进程，DV_* 环境变量注入，timings.json 含
  flashWall/黑条打点）→ S2 锚点（ffmpeg 场景检测掐头 + 顶边黑条两指针对齐）→
  S3 旁白（edge-tts 合成 + 44.1k wav 铺轨 + captions.srt，改文案不用重录）→
  S4 合成（libx264+烧字幕+faststart，自动版本递增）。S2/S3 核心算法以纯函数用
  TypeScript 重写并值级单测；walk 模板/虚拟光标/TTS 合成作为随包 mjs/py 资产。
- **S2 锚点新发现并修复 VFR 坑（pitfalls #12 修订）**：可变帧率 webm 里
  black_end 会被稀疏帧拉长（实测 110ms 黑条记成 0.56s/1.16s 事件），"时长>0.2s=闪光"
  口径会误删黑条——改为按场景检测闪光窗口排除 + 锚点取 black_start。
- 数据安全（沿用首例红线并落进工具契约）：只点按钮不动数据（弹窗打开→取消、无确认层
  直连写库按钮只高亮）；回执只含步骤日志/UI 标签/计数/亮度电平指标，页面帧不回流；
  录制密码经宿主凭据（credentialRef）解析仅注入子进程环境变量；录制单飞互斥。
- workDir 单目录契约（一个模块一个目录，产物全落该目录，成片版本自动递增）；
  部署参数（ffmpeg/Chromium/playwright-core/python/音色语速/超时）走 cordis.patch.yml，
  解析顺序 patch config > DV_* 环境变量 > PATH。
- 验证：包内 20 单测全绿（纯核值级+装卸+schema+红线）+ 真实 ffmpeg 集成 2 项 +
  四阶段真链路 E2E 全绿（无登录样例页→录制→锚点 8/8 命中→edge-tts 真配音 8 句→
  合成 mp4：YAVG 227.9 / max_volume -2.5dB / 尾留白 4.32s / 21.88s）；
  architecture（5 插件 7 Bundle 层）/ secrets / typecheck / profile verify（5 企业
  Bundle）全过；`pnpm start` 3080 WebUI 启动验证。lint 基线另有 7 个存量 error 在
  listing/tool-audit/scripts 的在途 WIP 文件（与本插件无关，未代改）。

## [2026-09-10 晚] r_pk 输出模型修正：PK 基础表 + 新加列 + 单表 Excel（DM 口径）

- 输出模型对齐成熟项目示例：PK 表为基础表（列/值原样），spec 处理变量 append 为新加列
  （盲态 8 列/非盲态 15 列），单 sheet 平铺 Excel；撤销 Content/QC 页/审核列，QC 只进
  note() 日志。模板与 djh.R 同步。
- 匹配零命中防护：PK Subject 与 SUBJ.SUBJID 零命中/<50% 时醒目警告 + 排查出路
  （实测 dummy 受试者号 R 样式与真实 EDC SUBJID 5 字母数字样式零交集——dummy 跑真实
  EDC 新加列必空，属数据事实）。
- djh.R 本地测试模式（对齐 manual listing）：Windows 调试覆写段（数据只读复制到
  localtest/，产物落 localtest/Output）+ library 容错加载 + 文件头 UTF-8 locale 行
  （中文文件名字面量 Windows 必需，服务器无害）。
- 验证：本地真实链路（真实 EDC 缓存 + dummy PK）跑通、结构层验证（16 列/224 行/空列
  全在预期、零命中警告触发）；模板 e2e 9 项全 PASS；listing 单测 47 项全绿。

## [2026-09-10 下午] r_pk 车道复核修订（数统 DM 逐行复核 spec）

- 五处偏差修正（模板 + 设计文档 §7）：VISIT=文件夹名原样（含 "(Period n)" 后缀，
  spec 枚举与真实 FolderName 逐字一致）；FAST 矛盾 QC 改双向（两组给药前均要求禁食
  ≥10h，"fed" 是给药前高脂餐不是不禁食）；ECDSTTIM 非 HH:MM 时给药时刻置 NA（绝不
  拿 ECSTDAT 录入时间戳冒充）；QC_Match 新增 PK 重复行；QC_Derive 新增 Analyte≠SLFS。
- P6 澄清：随机化 schedule 联表键可能按 RAND_ID。
- 合成端到端 33 项断言全 PASS；listing 单测 47 项全绿。

## [2026-09-10] listing 新增 r_pk 车道：PK Mapping 双盲映射数据集（R 程序）

- 新工具 `enterprise_listing_run_pk(project, studyKey, dataDate, blindMode?, oldDate?,
  password?, outputPrefix?, render?)` + 系统提示 section `tool:enterprise-listing-pk`
  （order 118）；工具总数 6→7。
- `src/r-runner.ts` 重构为 `RLaneSpec` 参数化：`RLaneRunner` 共用执行/回执骨架，
  `RManualRunner` 原行为零变化，新增 `RPKRunner`（PK_LANE_DIRS 双数据目录校验、
  `<studyKey>_PK_Mapping.R`、`DSH_R_BLIND_MODE` 运行时覆盖）。既有 40 项测试不动全绿。
- 模板资产 `r-templates/pk_mapping.R.tmpl`：PK 浓度数据（02_Raw_csv，只读）× EDC sas
  （01_Raw_sas，Rave 形态）按 受试者×周期×采样时点 合并成 spec 行序 23 变量数据集 +
  3 张 QC sheet（受试者一致性/PK↔EDC 匹配/派生变量）。
- 双盲：blinded（默认）SUBJID 确定性掩码 + SEQ/TRT/SEX/AGE/HEIGHT/WEIGHT/BMI 七列不出
  （QC 同步掩码整本可外发）；unblinded 需随机化 schedule 文件（RAND_SCHED_FILE）。
- 前置条件（数统编码口径，模板头 C1–C4）：ECYN 肯定才计给药；RT 给药时间=ECSTDAT+
  ECDSTTIM 拼接；VS2 筛选期+VSPERF 肯定（无筛选期行 NA 不拿治疗期值充数）；PC=PCDAT
  非空不做启发式过滤。成熟项目惯例（X1–X3）：原始 PK excel/EDC zip 只读不改；负 RT
  按 0 截断+QC 留痕；时点标签优先 TPT_HOURS_OVERRIDE 显式映射表。
- 已知坑（合成端到端实测）：`regmatches(regexpr)` 丢未命中元素导致向量错位——先 grepl
  子集再提取；`attr<-` copy-on-modify——label 必须在对象进 outlisting 前贴。
- 验证：listing 包单测 47 项全绿 + tsc 干净；合成数据端到端 25 项断言全 PASS
  （盲态 16 列/非盲态 23 列、双盲列差恰 7 受限列、QC 全类别、RT/C1/C3 派生抽查）。
  设计与待确认清单：`docs/enterprise/LISTING_PK_MAPPING_DESIGN.md`。

## [2026-09-07] listing 新增 r_manual 车道：交付可独立运行的单文件 R 程序

- 新工具 `enterprise_listing_run_r(project, studyKey, dataDate, oldDate?, password?, outputPrefix?, render?)`
  + 系统提示 section `tool:enterprise-listing-r`（order 117）。project/studyKey/dataDate 由用户在对话中提供，
  作为普通参数进入模型上下文；提示禁止推断。
- 模板资产 `packages/enterprise/listing/r-templates/manual_listing.R.tmpl`（HXN6005 已验证程序泛化：
  头部 7 个占位符 + 尾部 `summary.json` 运行摘要 + `note()` 告警收集 + `options(error)` 失败也写摘要）。
- 宿主 `src/r-runner.ts`：渲染/写入 `SAS_Program/SAS_program/Manual Listing/<studyKey>_Manual_Listing.R` →
  `Rscript` → 聚合回执；运行时参数经 `DSH_R_*` 环境变量覆盖（修改过的程序 `render=false` 换日期直接重跑，密码不落盘）。
  稳定错误码：`PROJECT_NOT_FOUND / DATA_DATE_NOT_FOUND / R_PROGRAM_NOT_FOUND / R_NOT_FOUND / R_TIMEOUT / R_EXECUTION_ERROR`。
- 部署配置 `rListing: { projectRoot, rscript, timeoutMs, templatePath }`（cordis.patch.yml），缺省项目根 `/mnt/project`，
  Rscript 亦可经 `DSH_RSCRIPT` 指定。
- 验证：本地按目录契约构造中文项目目录，仅放数据 zip（强制走解压分支），经宿主 runner 首次渲染 + 执行 →
  83 listing / 12,729 行 / 6,269 flag / 84 sheet，27 秒；`render=false` 复用路径通过；产物页名无 `Manual_` 前缀、
  Content 首页结构正确。单测 26/26（r-runner 8 + index 18）。
- 平台坑：Windows 子进程最小环境缺 `PROCESSOR_ARCHITECTURE` 时 R 以 0xC0000005 崩溃，白名单已补齐处理器变量。
- 需求口径修正（用户 2026-09-07）：DVP Manual Review 的 Report Description / Discrepancy Text 是 DM 人工核查逻辑，程序**不实现**；
  程序只按 Visits Applied To × Related Fields 定范围、Condition 定行（Output if / flag=duplicated）、Column Heading 定列
  （Raw data + 【表单】上下文列 + 派生列 + 匹配病史/AE/CM/PR 编号多选拆行）。模板 83 节按此重写（1887 → 800 行，公共原子
  `raw/vis_scope/fields/dup_flag/ctx_cols/explode_match/stack_raw`），旧阈值配置段（R2–R7/R9）随之删除；真实数据重跑
  83 listing / 17,762 行 / 84 sheet，duplicated 仅出现在 Condition 要求的 7 个 listing。已知占位：PT 术语来源编码结果未随数据包投递（[REPLACE R11]）。
- R/dplyr 坑：`mutate(.d = ...)` 之类以 `.d` 开头的列名会部分匹配泛型 `.data` 形参，表达式在数据掩码外求值报 not found；hms 时间列经 dplyr 动词丢 haven 标签，`raw()` 先转文本再回填。
- 新旧比对：首次交付无旧版，审核列统一记 New；模板 `[REPLACE R10]` 段是公司 `compare_data` 的挂接点，有旧版数据后传 oldDate 并接入即可，不属本次范围。HXN6005 即真实项目，车道已在其真实数据上完整验证。

## [2026-09-07] ALS 设计表三层识别 + 保护值索引按真实 EDC 结构收窄

### 背景（8 个真实项目核对）
- 真实交付的 ALS 至少三种形态：Medidata Rave（Forms/Fields/Folders/DataDictionaryEntries/Matrix*）、
  太美 EDC（Forms/Items/FormItem/CodeList*/DataStructure/Checks…）、ODM-DED 中文导出
  （eCRF表单/变量列表/受控术语/访视流程）。原解析只认合成格式 `Dataset Name/Variable Name/Label`，
  真实项目 ALS 映射为 0，整张设计表（表单名/字段标签/码表值/访视名）被当业务值灌入保护索引。
- 实测 GQ1005-301（78 数据集）：保护哈希 14999，12 条普通 harness 输出 3 条被误拦
  （vitest 统计行、`True False 2026` 字面量、ALS 表单名）。

### 改动（红线不变：数据集行值 + 辅助 Excel 业务单元格值不出域；本地执行面不加任何限制）
- `discovery`：已知 EDC 表头适配器（`_DESIGN_SHEET_SIGNATURES`）抽取 mappings/codelists/designSheets；
  受试者级列（Subject/USUBJID/筛选号…）一票否决；`type=als` 仅在提取到映射或码表时判定。
- `design_inference`（新）：名字无关的结构推断兜底任何新 EDC——值贴合数据集列名/数据集名为正向
  证据；某列大量落在数据集高基数行值集合、日期列、行数超变量总数量级为负向一票否决；数据集未
  加载时不推断（fail-closed）。否决集合只用于让更多表被判为业务表，从不用于放行任何值。
- `edc_profiles`（新）：学习型注册表。推断成功的设计 sheet 登记表头形态与列角色（dataset/variable/label），
  只存结构不存单元格值/项目名；此后同一 EDC 的导出在 discovery 层直接命中，无数据集也能抽映射。
  路径由宿主 `DSH_EDC_PROFILES` 下发（默认 profiles/enterprise/.edc-profiles.json）；读写失败只降级为
  "本次不学习"。
- `worker.protected_value_hashes`：**哪些值是受试者数据由列基数决定，不看值的长相**——值随行变化的
  列（受试者号、日期、检验值、自由文本、质疑内容）入索引；几十上百行只有几个值的列（码表解码、
  访视名、表单名、状态、年份、中心、方案号）是方案词表，不入索引。小表（<20 行）借用同名列跨
  数据集汇总的基数证据（EDC 同名列语义一致），汇总后仍不足才按数据保护。已披露结构值（数据集
  列名、mappings、codelists、设计 sheet 单元格、项目目录名/文件名及其分词片段）不入索引。值级过滤
  只剩：最小长度 4、JSON 字面量、孤立纯小写 ASCII 词（"text" 与英文散文无法区分）。撤掉本轮中途
  引入的全部"值长相"启发式（含数字/大小写/纯数字位数/EDC 状态词表/主键猜测/_forced_hashes）。
  bigram 只对含字母的多词值生成；时刻/日期切出的纯数字片段不拼 bigram。
- `worker.text_contains_protected_value`：普通文本额外按空白切分做整值比对，`09:15`、`2024/01/05`
  这类带内部分隔符的整值按原样精确匹配，不再依赖碎片拼接。
- `index.ts`：post-execute 命中"扫描进程未就绪"时等待预热完成（上限 120s）再扫，不再把 inspect 之后
  紧接着的普通工具调用整体封路；预热失败才 fail-closed。
- `data_guard` aux-excel 白名单补 designSheets/inferredDesignSheets/learnedEdcProfiles/codelists；rows 仍不在表。
- 系统提示与 AGENTS.md 同步 ALS 语义口径。

### 验证
- WebUI 真实会话（GLM-5.3-Flash，重启后 lib 生效）：GQ1005-301 inspect → `Get-ChildItem` 项目目录
  → 列 Project 根目录 → grep 源码 → git status → Get-Date → read_metadata，6 步零拦截；修复前同一
  会话 `Get-ChildItem` 被"受保护临床数据值"整体拦截（命中方案号 GQ1005-301 与文件名片段 V1.0）。
  ALS 映射 4399 条、78 数据集经企业车道正常披露。
- TAISHAN-304 真实项目冒烟通过：真实行值命中、普通英文诊断句放行。
- 新增 tests/test_design_inference.py（虚构中文列名新 EDC：识别、推断映射、学习、二次无数据集命中、
  受试者级导出不误判、注册表不可写不打断 inspect）、tests/test_scan_false_positives.py（列基数口径）。
- pytest 200 通过（含真实项目冒烟）；listing TS 30 通过。

## [2026-09-04] publish 交付文件名跟随申办方命名规范

- listing_publish 输出由 `{SCENARIO}_LISTINGS.xlsx` 改为
  `<项目标识>_{SCENARIO}_LISTINGS.xlsx`（项目标识 = 项目目录名），对齐申办方
  `<方案号>_<文档类型>` 交付命名（如 CGB3002-RT01_DM Status Report
  Specification_11Aug2026.xlsx）；八个真实项目同跑时交付文件不再同名混淆。
- 侧车文件（`_changes.json` / `_run_history.jsonl`）随主文件 stem 自动跟随；
  目录布局 `.clinical-listing/output/<scenario>/` 与 track_changes 同路径基线
  回读机制不变。已发布的旧名文件不迁移，升级后首跑变化统计按全量新增重建基线。
- 验证：pytest 183 通过；listing TS 30 通过（typecheck 0 错误）。

## [2026-09-03 第二批] 红线加固与智能保持并行:窄版 pre-execute 拒绝恢复 + 专用扫描 Worker

### 决策(双重标准:数据不出域 ∧ 不降低 harness 智能)
- 恢复窄版 pre-execute 路径拒绝:只在通用工具参数**正向命中**数据集/归档/doc 外辅助 Excel 文件引用时拒绝并附改道指引;内容型参数(write/edit)、enterprise_* 车道、不可解析参数、doc 与系统输出引用全部放行——关闭 R-4 窗口的"显式读取"部分,同时不给模型增加任何误伤面
- 专用扫描 Worker(listing_scan_init):与主车道计算分进程,装载项目后只保留保护值哈希并释放全部 DataFrame(71 数据集项目实测常驻降到哈希级);通用结果扫描不再被 900 秒 run_code 阻塞(实测批量误拦根因),项目绑定成功即预热
- 值扫描补相邻 token bigram 匹配:多词值("New York" 类)按单 token 匹配必然漏报,双侧对称哈希补齐
- additionalContexts 旁路面纳入 post-execute 扫描

### 治理
- check-secrets 补真实密钥形态:智谱 32hex+尾缀、无引号 YAML/ENV 凭证赋值(键允许业务前缀);自测通过且全库无误报
- CI 落地:.github/workflows/ci.yml 在 push/PR 跑全量 check:all(含 submodule)
- `pnpm run clean:data`:opt-in 数据保留清理(会话转录/项目缓存/spill/listing 临时),--dry-run 预览、--yes 确认、--projects 清项目产物
- settings API 恢复 Origin 同源校验(纵深防御);A-1/审计欠账:ulimit 外 subprocess stdin=DEVNULL 已于第一批完成

### 回归猎杀修复(第二轮审计)
- junction/符号链接项目 PROJECT_SWITCH_DENIED 误报:TS realpathSync 与 Python Path.resolve() 对齐
- inspect 失败留粘滞封路态:绑定拆分为请求前校验+成功后提交
- 孤儿 runner 的 dsh-listing-* 残留纳入 6 小时回收
- back_link 正则补 Excel 双引号转义形态(合法排版不再 publish 失败)
- doc 文本回退链补 UTF-16 BOM 显式识别(GBK 兜底会把 UTF-16 解成乱码)
- conftest 会话状态对称性补 _session_sources

### 验证
- pytest 173 通过;listing TS 30 通过;tool-audit TS 17 通过;ui-settings TS 5 通过;lint 0 错误;check-secrets/architecture 通过

## [2026-09-03] 全系统审计收口:通用车道值级扫描立档 + doc 防洗白 + 健壮性加固

### 背景与决策
- 全系统审计发现"代码、ADR-0010、系统提示词"三方口径失配:通用车道防线实际已改为 listing 宿主 post-execute 值扫描,但 ADR/提示词仍宣称 pre-execute 路径拒绝(P0)。本次如实立档(ADR-0010 修订记录 + 决策 7 重写),不改变"两类数据值红线、其余全权交给 harness"的口径
- 新增 doc 防洗白(决策 10):会话建立时登记 doc/ 文件指纹基线,项目原始输入直接信任;会话期间新增/改写的 doc 文件出域前做保护值精确匹配,命中拒绝(PROTECTED_DOCUMENT_CONTENT)
- 红线口径不变:开关开启只拦数据集行值与 doc 外辅助 Excel 单元格值;关闭零处理;默认开启

### 安全收口
- `project` 参数 host 侧锚定:必须是存在目录的绝对路径,一个 Agent 会话绑定一个项目,拒绝换绑(PROJECT_SWITCH_DENIED)
- 内部控制工具豁免改精确名单(plan/todo_write),子串匹配曾把任意同名 MCP 工具豁免出值扫描
- Worker 崩溃/协议损坏的 stderr 片段只进宿主日志,模型侧替换为稳定码 WORKER_UNAVAILABLE
- run_code runner:stdin=DEVNULL(模型代码 input() 曾可吞掉 NDJSON 协议行)+ 840s 自杀超时(防孤儿进程与 %TEMP% PHI 残留)
- code_runner 不再透传 `_source` 属性:源头标记不可由模型重贴
- back_link 公式收紧为两参数字面量形态:=HYPERLINK(WEBSERVICE(...)) 前缀穿透已封
- ZIP 解压预算(总量 + 单成员压缩比)+ 顶层归档数量上限(200);SpreadsheetML ss:Index 列上限与文件大小上限。预算实测校准:RBQM 真实归档解压 10.2GB(72 数据集),总量上限定为 64GB,爆炸特征由压缩比检查承担
- ui-settings:恢复设置页开关与 GET/POST API(写操作须 X-DSH-Settings: 1 头,V-6 口径);开关加载即审计(event: load),落盘篡改下次启动留痕
- read_spec_files 失败回执在开关开启时不再携带异常文本;doc 文本 UTF-8 失败回退 GBK(与 CSV 一致);归档发现大小写不敏感(POSIX)

### 实测补充(2026-09-03 八项目真实链路验证后)
- SyntaxError 诊断放行:编译期错误消息只含模型自己的源码行,经白名单进入 failure() 诊断(syntax 字段)——实测大代码块无行号盲修不可行
- read_metadata 新增 compact=true 目录模式(name/path/columns/rowCount):实测大项目元数据页被宿主截断迫使模型多轮补读,compact 让全目录一页读完
- 上游 spill 落地治理(ADR-0010 R-7):listing 插件启动时回收 %TEMP%/dsh-spill-* 中超过 6 小时的目录(spill 含 doc 全量业务值,上游无清理机制)

### 缺陷修复
- run_code 冷启动时数据集部分失败被静默清零:失败清单与 inspect 口径聚合,datasetFailureCount 如实上报
- _write_audit 失败现在真正记 stderr;worker 协议层异常写 stderr 而非静默吞掉
- Excel autofilter ref 越界钳制(1,048,576 行 / 16,384 列),不再产出需修复的工作簿
- check_deps 最低版本强制生效(此前声明版本从不比对)
- tool-audit 路径分类工具预修 Windows 边角:NTFS ADS、尾点/尾空格

### 文档
- ADR-0010:决策 7 重写为值级扫描口径,新增决策 10 与修订记录(残余风险 R-4 初始化窗口/R-5 匹配精度/R-6 执行自由+出域组合);README §6、listing AGENTS.md、tool-audit docblock 同步
- .gitignore 补 /artifacts/、/tmp/、/.pytest_cache/;仓库根冒烟产物已清理

### 验证
- Python listing:173 通过(新增 doc 防洗白与 back_link 回归);listing TS:30 通过;tool-audit TS:16 通过

## [2026-08-28 终版] ADR-0010:宿主开关硬数据边界与 doc 全量分片

### 决策
- 数据安全开关由宿主设置页控制:默认开启;关闭后 listing 与通用工具均不做任何形式拦截;模型请求不能伪造
- 开启时固定两类数据值红线:SAS/XPT/CSV 数据集原始行值(含归档解出)与 `doc/` 外 spec 需求辅助 Excel 业务单元格值
- `project/doc/**` 为需求理解域:所有文件经 canonical JSON 分片按顺序完整读取,未知/二进制文件 base64 完整承载,不摘要、不截断
- 开启时 `run_code` 回执不构建 stdout/stderr、动态异常文本、输出名或列名;关闭时原始载荷照常回执;listing Python 执行面保持全开
- tool-audit 改用官方 monotonic `tools.guard()`,按路径与文件系统元数据分类;开启且受保护项目内通用 shell/terminal/code/job 通道 fail-closed,关闭后零拦截
- ui-settings 恢复 `.data-security.json` 布尔开关与设置页 toggle;扩展名配置不恢复,两类拦截对象固定

### 验证
- Python listing:148 通过;listing TS:24 通过;tool-audit TS:16 通过;ui-settings TS:5 通过
- 全仓收口门禁:`CI=true corepack pnpm run check:all` 已通过(lint、typecheck、workspace/root 测试、architecture、secrets、Python dependencies、upstream、profile verify)

## [2026-08-28 第三轮] ADR-0009:出域单点——执行面全量放开

### 决策
- 用户终裁"任何一层都不限制 harness AI 的代码执行面,唯一红线=数据行值出域"
- sandbox 删除 AST 禁用表/GuardedModule/import 白名单/builtins 白名单:标准 Python 全量可用(import os/open/eval、pd read_*/to_*)
- 出域控制点不变:sanitize_receipt 投影、dataset-guard 车道护栏、回执 120 字符上限;开关仍只管出域
- 保留:V-2 Excel 公式中和、V-3 环境白名单、V-7a 捕获上限、V-8 back_link 白名单;V-1 形态入库 commit 61dc8a9 可 revert
- 风险 R-1~R-3(宿主破坏面/stdout 行值/网络出域)显式接受,登记于 ADR-0009

### 验证
- pytest 143 全绿(160→143:24 条封堵用例退役、7 条执行自由用例新增);四包 tsc 零错误
- 同批:CHANGELOG 清除 NUL 字节(grep 恢复文本检索)

## [2026-08-28 深夜二批] FP 收口:全部修复且不误伤(ADR-0008 修订)

### 防变蠢(误伤修复)
- FP-1:to_* 前缀改枚举写出器——pd.to_datetime/to_numeric/to_list/to_numpy/to_dict 放行;to_csv 等 18 写出器仍封
- FP-3:safe_import 白名单导入器——修复 numpy/pandas C 层惰性导入断路(ndarray.sum() 实战复现);模型可正常 import re/statistics 等 17 纯计算库
- FP-2:注入 rng/datetime/json
- FP-4:dataset-guard 豁免纯写出型工具(写文档提及数据集名不再误拦)

### 记录项闭合(V-4/6/7/8)
- 回执名称 120 字符上限;设置 API X-DSH-Settings 头;捕获流 1MB 上限+truncated;stat 竞态跳过;back_link =HYPERLINK 白名单
- 勘误:V-5 带空格文件名其实命中(测试钉死);通配符刻意不拦(ls *.csv 会误伤)

### 验证
- pytest 160 全绿;四包 tsc 零错误;5 攻击链全灭 + 3 合法链全通

## [2026-08-28 深夜] ADR-0008:安全漏洞扫描批修(沙箱逃逸 RCE/公式注入/环境收敛)

### V-1【P0】沙箱 AST 黑名单被下钻链绕过(实战复现 RCE)
- 复现:`pd.io.common.os.system`(任意命令)、`pd.io.common.urlopen/get_handle`、`np.lib.npyio.DataSource`(任意读)、`os.environ`(摸环境)
- 修复:GuardedModule 运行时护栏——双下划线/read_/to_/IO 名单 + **module 类型属性整体封死**;ExcelWriter/DataSource 补入双层名单
- 复验:六条攻击链全灭;DataFrame/merge/groupby/isinstance/df.sample 零损耗

### V-2【P1】交付 Excel 公式注入
- '=' 开头模型串被 openpyxl 当公式(=WEBSERVICE 打开即外联);表名引号可逃逸 HYPERLINK
- 修复:literal_cell 铺满九处写入点 + hyperlink_formula 引号双写;设计内公式由测试精确钉死

### V-3【P1】worker 继承宿主全部环境变量
- 修复:minimalSpawnEnv 白名单(win32 11 键/POSIX 5 键)+ 强制 UTF-8

### 记录在案未改(V-4~V-9)
- 元数据隐蔽信道/护栏通配符残余/设置 API 本机无鉴权/健壮性/back_link 设计内公式/子模块封死的能力折损
- 详见 SECURITY_SCAN_20260828.md;决策记录 ADR-0008

### 验证
- pytest 153 全绿(新增逃逸链回归+公式中和 9 用例);listing tsc 零错误

## [2026-08-28] ADR-0007：数据集单规则红线 + 通用车道护栏 + 系统性缺陷修复

### 数据拦截口径（ADR-0007，用户裁决"doc/ 零拦截 + 防住真实泄露"）
- doc/ 整目录零拦截：文本与 Excel 单元格值恒全量回执（截断上限只作协议护栏并显式标记 truncated）
- 红线收敛为单规则：仅数据集（sas7bdat/xpt/csv）行值不出域（元数据白名单）
- **tool-audit 复活为通用车道护栏**：tools/pre-execute 按路径引用拒绝 shell/文件工具触碰数据集文件（防 2026-08-28 实战的 pwsh 系统 Python 绕过）；enterprise_* 车道豁免；开关感知 fail-closed；拒绝理由引导回 listing 车道
- datasetExtensions 配置单源化：ui-settings → listing worker + tool-audit 护栏（修审计 B-3 死接线）；auxExcelExtensions 废除

### 缺陷修复（PLUGIN_SYSTEM_AUDIT_20260828.md B 组）
- B-1：spawn 强制 PYTHONUTF8/PYTHONIOENCODING（中文错误不再 GBK 乱码）+ 解释器候选链 DSH_PYTHON→python3/python、Windows python→py -3（P1-4 闭合）+ windowsHide
- B-2：sandbox builtins 补异常类/dir/repr/map/filter；AST 补双下划线属性封堵（堵 pd.__dict__['read_sas'] 绕过）与 numpy/Excel 文件 IO 构造器；run_code 失败回执附 environmentHint（环境自描述）
- B-4：ui-settings 路由 disposer 收集、stop() 拆除（可卸载）
- B-5：审计写失败记日志不再静默吞
- B-6：branding 兑现 ADR-0002——validateBrandingConfig（长度/尖括号/env 兜底）、HTML 转义、结构化注入行（index-inject）、/favicon.svg 与 /manifest.webmanifest 路由（原 404）；修复客户端脚本 \b 正则在模板字面量中被转义为退格符导致短名替换失效的隐藏 bug
- B-7：设置页文案改为 ADR-0007 口径
- C-5：.data-security.json/.data-audit.jsonl 入 .gitignore
- C-6：四包 tsconfig 排除测试 + vitest --exclude lib（不再 src/lib 双跑）
- C-9：report Cover 申办方文案（"康德弘翼/WuXi"）挪 cordis.patch.yml reportCoverLabels 配置，代码内只留中性默认

### 文档
- 新增 ADR-0007；ADR-0004/0005/0006 与 DATA_GUARD_PLUGIN_DESIGN/INTERCEPTION_AUDIT 加取代/修订横幅

### 验证
- pytest 143 通过（含新增 doc/ 直通、截断标记、sandbox 封堵用例）；四包 tsc -b 零错误；Windows 侧待跑 pnpm run check:all 收口

## [2026-08-27] Multi-Sheet Excel 输出 + 自动 Submodule 初始化

### 新功能

#### 1. 临床 Listing 多 Sheet 输出规范化
- ✅ 实现多 Sheet Excel 生成（所有 listings 合并到一个文件）
- ✅ 自动 Contents 目录页（包含统计信息）
- ✅ 四种场景统一样式（manual/medical/rbqm/report）
- ✅ 系统字段自动添加（Flag, Update Details, Review Comments 等）
- ✅ 版本间变化追踪
- ✅ 现有单文件合并工具
- ✅ 一键部署脚本（支持备份回滚）

**核心文件**:
- packages/enterprise/listing/python/styles/ (样式模块)
- packages/enterprise/listing/python/worker_new.py
- packages/enterprise/listing/src/index_new.ts
- packages/enterprise/listing/deploy_multi_sheet.py

**文档**:
- docs/enterprise/LISTING_MULTI_SHEET_SPEC.md
- packages/enterprise/listing/SWITCH_PC_TESTING.md
- packages/enterprise/listing/TESTING_GUIDE.md

#### 2. 启动脚本自动 Submodule 初始化
- ✅ start.bat 现在会自动检测并初始化 upstream/deepseek-harness
- ✅ 新电脑无需手动执行 'git submodule update --init'
- ✅ 修复"官方CLI不存在"错误

**改进文件**:
- scripts/start.mjs

### 使用方法

#### 新电脑快速开始（现在更简单了！）

\\\ash
# 1. 克隆仓库
git clone https://github.com/lihua0103/ec-harness.git
cd ec-harness
git checkout feat/clinical/harness

# 2. 直接启动（会自动处理一切）
start.bat
\\\

#### 测试 Multi-Sheet 功能

\\\ash
# 生成示例模板
cd packages/enterprise/listing/python
python generate_templates.py
\\\

### 提交记录

- \d919cc\ - feat: Auto-initialize git submodule in startup script
- \36fcd85\ - docs(listing): Add testing guides for multi-sheet feature
- \787ef96\ - feat(listing): Add multi-sheet Excel output with unified styling

### 统计

- **新增代码**: ~1,400 行
- **新增文档**: ~10,000 字
- **新增文件**: 18 个
- **改进文件**: 1 个 (start.mjs)

### 下一步

1. ✅ 代码已提交到 feat/clinical/harness 分支
2. ⏳ 在新电脑上测试
3. ⏳ 完整测试四种场景
4. ⏳ 性能测试
5. ⏳ 用户验收测试
6. ⏳ 合并到主分支

### 参考文档

- **快速开始**: docs/enterprise/QUICK_START_NEW_PC.md
- **完整规范**: docs/enterprise/LISTING_MULTI_SHEET_SPEC.md
- **测试指南**: packages/enterprise/listing/TESTING_GUIDE.md

---

**分支**: feat/clinical/harness  
**最新提交**: 0d919cc
