# Listing 开发接续记录

## 2026-11-11 整改（v0.2.0）

- **公共能力抽离**：Workbook读取迁至`packages/platform-workbook`（Listing `src/workbook.ts` 仅做兼容再导出）；
  知识服务Cordis适配迁至`packages/platform-knowledge/src/cordis.ts`并由该包独立bundle装载。Listing patch只装自身，
  DVP patch只装自身；profile先装`@ec-clinical/platform-knowledge`，两者可单独或同时装配。
- **知识验证语义**：候选新增`claims`，验证器新增`coverage`。固定用例通过只写`TOOL_REGRESSION_ONLY`回执；
  全部claims被覆盖且通过才ACTIVE（`CONTENT_CLAIMS`）。Listing intake种子未声明claims，因此保持CANDIDATE；
  测试用窄候选验证了激活与部分覆盖两条路径。无claims/部分覆盖/失败均写事件，不伪报“已验证”。
- **候选包**：Listing候选包不再内嵌platform-knowledge入口；源码清单改纳入platform-workbook。旧`lib/platform-knowledge.js`与`lib/review.js`已清理。
- **验证**：`scripts/verify.mjs` 65/65通过、tsc通过、host/client bundle构建通过；候选包构建/校验/放行测试通过。
  DSH Web（3080）干净启动，插件页显示 platform-knowledge、Listing、DVP 三包安装并启用；未发送模型业务请求，
  未做浏览器业务流程或临床验收。

> 以下为历史记录；其中“已验证/已安装”仅指当时范围，不能覆盖本次整改后的重新验证需求。旧安全门禁已按架构决定撤出。

## 最新实施状态（2026-11-10）
>
> 当前事实：旧69项/类型/构建结果是已验证基线；当前公共KnowledgeService首批schema/store/service、Cordis适配、候选种子与测试已编写但未经编译/运行。旧安全拦截已按架构决定撤出（2026-11-10：workbook 名称拦截、client 过时提示词与 demo 金丝雀均已移除）；真实项目SAS开发链和服务器单文件R复跑尚未实现。
>
> 下一步先按[迁移与验收](../../docs/MIGRATION-AND-ACCEPTANCE.md)撤出旧门禁和冲突提示，再实现[平台经验库](../../docs/PLATFORM-EXPERIENCE-KNOWLEDGE.md)，然后接项目资料/R交付与自主学习。平台总架构和插件职责详见[文档导航](../../docs/README.md)。不要把后面的历史阶段“已验证”升级为当前新增能力通过，也不要把目标文档当作代码已经迁移。
>
> 文档核对：已通过文件枚举和内容搜索核对新版本、引用目标及旧条款失效标记；自动链接检查命令与独立审阅代理均被应用判定服务在执行前阻止，没有独立结果，不写成自动检查通过。未来代码迁移须补候选包内文档链接，仓库README的相对架构链接不能直接视为独立ZIP内有效链接。
>
> 下方为截至69项基线的历史过程记录；其Cover拒读、原值扣留、强制审批、Hyper-V前置、仅合成输入等旧合同不再是当前要求，仅记录当时源码行为和验证范围。

## 加密数据包、冷启动与学习闭环（2026-11-10 已实现并定向验证）

用户指示：sas数据集可能以加密/压缩zip包交付，须把此前确立的密码推导规则引入插件；本轮全程不读取真实临床数据（合成sas7bdat fixture；spec/ALS需求sheet按既有授权可读）。

- **archive.ts 加密zip读取通道**：候选密码推导顺序对齐已交付HXN6005 R程序——显式密码→项目目录名分词组合→zip同目录sidecar txt行→zip文件名分词→项目txt/Excel文档名stem→无密码。传统ZipCrypto进程内解密：12字节加密头探测（末字节=crc>>>24，data-descriptor置位时为DOS时间高位）淘汰错候选，解密后须剥去12字节头再inflateRaw（本轮最深debug发现），CRC-32全量校验；密码不进日志或模型上下文。AES/强加密（flag 0x40或extraField 0x9901）回退本机7-Zip，argv密码可见性为已记录例外。yauzl在中央目录解析期拒绝遍历名，zip error事件按消息映射为ARCHIVE_ENTRY_UNSAFE/ARCHIVE_OPEN_FAILED。yauzl 3.4.0 bundled类型滞后，运行时decodeFileData:false+{start,end}经`as any`启用。
- **大sheet边界**：需求sheet实测5.8-7.2MB，单条目上限32MB/总量64MB；解析层500000单元格上限、返回层100000单元格在窗口过滤后判定，超限整体读取显式拒绝。
- **冷启动闭环验证**：读HXN6005真实spec需求sheet（DM_02人口统计学19列，含`若 “否”，请提供原因`弯引号原词）→AI自主理解IR→自主编写R→纯合成数据（USUBJID S001-S003）执行→独立Node QC比对需求原词列头/FLAG域/记录ID唯一性。QC真实抓出直引号与弯引号偏差驱动修正后PASS——标签保真原则经实战验证。
- **学习闭环接线**：新knowledge-validators.ts注册`dm-listing.intake-suite`（6用例：正/反/边界复现archive纯函数splitTokens/tokenCandidates/passwordCandidates，含fixture文件系统）；index.ts新工具dm_listing_knowledge_capture（强控字段，激活必要证据必填）/validate/events；store.ts新recentEvents、service.ts新events方法（可见性先行校验、分页校验、总计数）。种子方法经套件复现通过转ACTIVE并写回执；套件未覆盖候选保持CANDIDATE（KNOWLEDGE_VALIDATOR_TARGET_MISMATCH）；模型JSON只能选择运行哪个已注册验证器，不能供给测试。
- **测试**：archive.test.ts 9项（7z构造ZipCrypto/AES256/fflate明文/遍历，haven合成sas7bdat）；knowledge-loop.test.ts 6项。插件定向测试57/57通过，tsc --noEmit通过。

## 数据安全/放行政策表述更新（2026-11-10，含放行机制落地）

- README/DEVELOPMENT同步现状：数据安全由IT源头/API承担，插件无按名/sheet/数据类别的拦截，Cover可按任务读取；API未接入不宣称已实现。
- distribution放行政策：操作者2026-11-10授权"AI自主理解确认后可自行放行"，放行时记录provenance「操作者授权下的AI自主确认 2026-11-10」。
- **放行机制已落地**：release-lib.mjs新增approveCandidate（须integrity VERIFIED+blockers空+provenance非空；state保持CANDIDATE、productionDataEnabled保持false；buildDigest不绑放行字段，放行后复验VERIFIED）；release.mjs新增approve模式（固定写入provenance，输出<name>.approved.zip，拒绝重复放行）；candidate.test.ts新增放行回归（空provenance拒绝/放行字段断言/复验通过/重复放行拒绝）。构建脚本默认仍产NOT_APPROVED候选，放行是显式后置步骤。
- **今日工件**：候选 `.runtime/candidates/dm-listing-20261110-v2.zip`（buildDigest 39a17d93…）→ 已放行 `.runtime/candidates/dm-listing-20261110-v2.approved.zip`（sha256 e07c112f…，integrity VERIFIED，blockers空，approver=操作者授权下的AI自主确认 2026-11-10）。首轮候选dm-listing-20261110(.approved)因放行代码晚于其构建加入sourceInventory而由v2取代，均保留未删除。
- **DSH安装验收（同日）**：宿主以今日构建干净重启（3080端口，旧实例PID 13156停止），`/` 返回401认证网关激活即装配完成；lib/index.js导入验证name=ec-clinical-dm-listing、apply=function；插件经 `.runtime/dsh-home/profiles/web/node_modules/@ec-clinical/dsh-dm-listing` 符号链接加载当前源码构建产物。浏览器流程验证由操作者完成。
- 全量验证（放行机制并入后重跑）：**64/64测试通过、tsc --noEmit通过、host/client bundle构建通过**。
- 浏览器验证由操作者完成；真实目录验证使用既有三项目目录（只读）；不切换系统Node/R配置。

## 高强度评审修复（2026-11-10 已落地并全量验证）

用户指示"全部修复"本轮10项评审发现（5×P1、5×P2）。逐项结果：

- 架构P1 正式UI过时流程：client/index.ts 标签与插入提示词改为真实项目工作流优先（overview → read_sheet → describe_dataset，目录未知先询问），Cover可读、合成示例仅演示；workbook.ts 移除 readSheet/readRegion 的 COVER_READ_DENIED 名称拦截与demo金丝雀 NEVER_READ 措辞；inspect/read_requirements 工具描述同步更正。数据安全表述改为"IT源头/API承担，插件不做拦截；API未接入不宣称已实现"。
- correctnessP1 medical主题（实证为误报）：真实种子检索 medical → dm-listing.review.methods 命中；新增回归测试锁定全部 METHOD_TOPICS 经工具同一映射至少命中1条种子。
- correctnessP1 R诊断扣留：ExecutionReceipt 新增 diagnostics{logFile,logBytes,tail≤4000}；RDS检查器stderr（≤800字符）进入失败详情；runner.test.ts 合同同步翻转（失败时诊断必须随回执返回，完整日志留在本地且≤256KiB）。
- correctnessP1 种子更新崩溃：platform-knowledge 新增 knowledge_seed_states 溯源表；同内容幂等、新包版本→新修订、动态人工修订→SEED_CONFLICT_DYNAMIC_REVISION 冲突记录不再抛错；插件 apply() try/catch 降级并在 dm_listing_status 报告 seedState。
- correctnessP1 恢复解锁活进程：runner 落盘 run-<runId>/process.json，恢复先 processAlive（Windows tasklist / 其他平台 kill(pid,0)）取证；PID仍活动直接 RECOVERY_TARGET_STILL_ACTIVE 拒绝；PID无记录回退操作者逐项确认（已知残余：RUNNING提交与process.json落盘间的小窗口由人工对话兜底）。
- correctnessP2 datasets：Node端 normalizeTable 归一化 auto_unbox 标量；R端 flatten 收集命名/嵌套/位置列表的全部 data.frame（RData顶层data.frame保留原变量名），非frame叶记 skipped 警告。新测试捕获并修复真实R错误：顶层表达式的 <<- 会绕过全局绑定命中base锁定函数 warnings，现统一经闭包 add_warning 追加。
- correctnessP2 scan超限：>256MB 清单文件显式列出并标 sha256Skipped=INVENTORY_SIZE_LIMIT（介于摘要与清单上限之间的标 DIGEST_SIZE_LIMIT），不再静默漏报。
- build-reproducibilityP2 许可正文：新增 licenses/（@nodable+entities@3.1.0.txt 逐字节副本 + README 溯源）；bundledNotices 安装包缺失时回退版本化正文，新增 licenseSource 字段与 LICENSE_TEXT_CONFLICT 冲突阻断；licenses/ 纳入 sourceInventory 复现性摘要。安装/回退/冲突三条路径均实测（回退测试须将LICENSE移出包目录——LICENSE.bak 仍匹配许可文件名正则）。
- test-coverageP2 持久化空壳：tests/persistence.test.ts 重写为真实回归（TaskStore CAS/owner隔离/重启持久；ListingService 重启恢复需求与程序绑定、owner隔离、篡改 main-*.R 后 PROGRAM_ARTIFACT_CHANGED 且批准回调不执行）；新增 tests/datasets.test.ts（单列CSV columns=['A']、RDS命名/位置列表、skipped警告）。

验证：scripts/verify.mjs 47/47通过、tsc --noEmit 通过、host/client bundle 构建通过；候选包实测 PRESENT/回退/冲突三态且 distribution 保持 NOT_APPROVED。

## 许可正文补齐（2026-11-10 已解决）

- 从上游仓库 github.com/nodable/val-parsers 取回 MIT 许可正文（1064字节），放入已安装包 node_modules/.pnpm/@nodable+entities@3.1.0/.../LICENSE。
- 重新构建候选包：integrity: VERIFIED，distributionBlockers 为空数组，所有bundledPackages licenseTextStatus=PRESENT。
- distribution 仍为 NOT_APPROVED 是正确终态：release-lib.mjs 的设计是 blockers 清空后仍需人工批准才升级，不自动宣称可分发。

## 真实项目工作流接通（已实现并验证）

- 新增 workflow.ts：overviewProject（扫描目录并列出所有workbook sheet 名，含Cover，不读cell内容）→ readWorkflowSheet（完整sheet读取）→ describeWorkflowDataset（本机R数据检查）。
- index.ts 注册 dm_listing_overview、dm_listing_read_sheet 新工具，修掉 describe_dataset 重复注册和 Cordis 不支持的 optional schema 字段。
- tests/workflow.test.ts 3 项回归全部通过。

## 2026-11-10 验证结论

- 修复 R warnings 标量化崩溃（jsonlite auto_unbox 单条warning序列化为标量，Node端归一化）。
- 按用户方向撤出投影/审批/受保护执行等旧门禁代码及其测试（9个src模块+8个测试文件）。
- 三项目spec逐列职责、行逻辑、输出合同经验作为知识种子保留并接入平台KnowledgeService。
- 全量验证42/42通过、类型检查通过、host/client bundle构建通过。
- 候选包121KB实际构建，integrity: VERIFIED；@nodable/entities缺许可正文仍为唯一发行阻断。
- DSH web宿主已实际启动并加载插件（HTTP 303正常）。

更新：2026-11-09。现有 DSH 框架、插件入口和四场景路由已经完成；继续开发时从本文件和源码接续，不重新搭框架，不要求用户重述目标。

## 平台经验库首批实施（已编写，未验证）

- 新增外层packages/platform-knowledge/package.json和src/{schema,store,service}.ts：通用shared/plugin/project结构、正文摘要/CAS、SQLite持久修订/事件、scope先过滤后的Unicode子串检索（不假称FTS）、幂等种子导入、不可覆盖快照、冲突/撤回、安装代码提供的实际正反/边界验证后激活。
- 验证器需注册knowledgeIds，错误目标拒绝；候选在异步验证期间被修订/撤回或验证器卸载则不激活。新版候选不遮蔽旧ACTIVE，内容变化不能沿用旧验证。无项目业务裁定激活/跨作用域推广的完整操作入口，未接真实run/QC事件，不称自主学习已完整实现。
- 新增src/platform-knowledge.ts独立Cordis服务适配，导出platform-knowledge子入口并在cordis.patch.yml先装配；Listing通过clinicalKnowledge注入，不拥有公共服务生命周期。平台工具search/get/capture/validate/status可用性待集成测试证明；当前scope由调用参数显式指定，尚无完整Project/Run上下文绑定，不能宣称全自动上下文。
- 新增src/knowledge-seeds.ts五类候选：review(Manual/Medical共用)、intake、pk-common、BE、SAD/MAD。种子历史来源不自动ACTIVE；当前文本仍作迁移正文真源，尚未拆成JSON/Markdown种子manifest，也未安装Listing业务验证器。
- build.mjs/package.json/cordis.patch.yml和release-lib.mjs已加入公共入口构建/导出/源码摘要/打包；tests/candidate.test.ts新增包内公共入口加载检查，未执行，lib仍不是本批验证构建。
- tests/platform-knowledge.test.ts新增4项多案例回归；tests/integration.test.ts新增临时DSH_HOME、平台先装配、卸载Listing后公共工具和种子仍存在断言。现有其他测试尚未重跑。
- 本轮所有Bash（包括node --version）被应用判定服务在执行前阻止，无类型/测试/构建实际结果。优先恢复执行后运行Node24.9.0 scripts/verify.mjs修复失败；不换工具通道或擅自改权限绕过。
- 旧service/workbook/readiness/client仍有demo/拒读/审批，归档尚未成功。其余既定项目目录/SAS/单文件服务器R流程未实施，不能称新架构整体完成。现有任务库未打开或迁移。

## 当前续开发：ALS整sheet读取澄清（历史基线）

用户已明确批准：确认属于ALS设计/需求材料的sheet允许AI完整读取，固定六列/类型/平面结构适配不能作为读取权限。本轮不再重复询问原则，不重建框架，不涉及Obsidian目录。

- workbook.ts新增readAlsSheet：完整已存储单元格、坐标、类型、设计码表、隐藏行列/隐藏sheet、合并范围；公式仅表达式/属性，无缓存、跨表/外链读取或执行。Cover及指向Cover别名仍在内容解码前拒绝，资源限额失败不截断。嵌入/相关部件不解码并明确提示。
- projection.ts新增独立als-sheet选择与reviewed-als-sheet-v1投影；confirmAlsSheet绑定整sheet角色，旧区域模式/版本保留不升级。读取和内容发布继续复用源摘要/归属/CAS/撤销/取消；不按未知标题/类型拒绝全文。
- operator-review.ts ALS分支不再要求region/header；完整分页正文，适配结果经als-assistance.ts作为ADAPTED或NEEDS_INTERPRETATION辅助，失败不阻断原文发布。als.ts严格平面校验只用于辅助，不用于读取授权。scripts/review.ts同步演示提示，knowledge.ts明确新规则。
- 更新operator-review/projection旧断言，新增tests/als-sheet.test.ts覆盖未知布局/类型/301行码表尾部、隐藏合并、公式不缓存、不展开其他sheet/Cover、旧区域兼容、归属/源变化/撤销/并发/取消，另覆盖10001单元格不继承区域限制。
- 续开发静态检查修复：已知Auxiliary data原始表及指向它的别名在ALS读取和区域/整表审批前拒绝；登记清单不列为eligible/alsEligible。仅规范化精确匹配当前已知角色，不把名称含data或设计码表一概禁用。
- 辅助提取非ListingError异常也转换为ALS_ASSISTANCE_UNAVAILABLE提示，不再使已确认正文发布失败；更新union选择类型的测试窄化，并去除重复追加的辅助表测试。新增原始表/别名前置拒绝回归已通过。
- 最新验证已实际执行：Node24.9.0 TypeScript检查通过，ALS/投影/审核针对性22项全部通过；完整scripts/verify.mjs为69项通过、0失败、0跳过，host/client构建成功。此前命令阻断是历史状态，不能再当本轮未运行结论；浏览器preview_list仍在执行前被应用判定服务阻断，浏览器复验单独保持未验证。无真实数据读取、模型业务请求或系统配置变更。

## 本轮完成

- `src/service.ts`：已确认需求的重复读取不再提交版本，避免把运行中的执行结算挤成陈旧版本；保存程序/需求和交付在运行期间仍被拒绝。
- `dm_listing_inspect` / `dm_listing_list_tasks` 返回持久执行摘要：runId、状态、结果、QC、current。程序或需求变化后旧执行不是当前证据，不回传原始日志。
- 交付只读取一次程序快照，核对程序/输入/回执绑定与输出摘要，重新运行独立 QC；错误退出、假 PASS、旧检查器和篡改证据均拒绝。ZIP 含程序、内置合成输入、需求、manifest、运行时、可用回执/输出和 checksums，不含 Cover 或本地执行日志。
- `src/runner.ts`：探测和实际执行使用规范化绝对运行时路径；探测超时标记已结算；检查器版本不再硬编码。
- `src/checker.ts`：数值比较同时拒绝非有限期望值，避免 NaN 使比较失效；版本升级为 `synthetic-csv-v2`。旧 PASS 回执需重新执行。
- 增加运行中重读、审批时改程序、证据篡改/假 PASS、非有限期望值回归。已有五种场景 R 验收、拒绝执行、错误/超时/取消/超限、任务隔离和 ZIP 校验仍通过。
- `scripts/verify.mjs`：所有阶段复用同一个 Node 可执行文件；Node 版本不足立即失败，不安装依赖，不修改系统 PATH。
- 同步 README、知识工作流、准入文档；生成 `lib/index.js` / `lib/client.js` 及关联构建文件。

## 已实际验证

在插件目录运行：

```bash
"D:/package/Nvm/nvm/v24.9.0/node.exe" scripts/verify.mjs
```

最新结果：host/client TypeScript 通过；69 tests / 69 pass / 0 fail / 0 skipped；host/client bundle 构建通过。本轮新增并覆盖原始辅助表/别名拒绝、整sheet ALS读取及非阻断辅助异常；针对性ALS/投影/审核测试为22项。完整验证测试文件并发限制2；取消回归使用R就绪标记而非固定延时。

R：`D:/package/R-4.5.0/bin/x64/Rterm.exe`，home `D:/package/R-4.5.0`。Medical、Manual、Report、PK BE、PK SAD/MAD 均实际执行手写验收 fixture。不是模型生成程序的冷启动验收。Node 的 SQLite experimental 警告仍存在。

系统默认 Node 是 22.20.0，不够本项目要求；**不切换全局版本**，使用上述 Node 24.9.0 绝对路径。工作台执行另需操作者设置 `DSH_LISTING_R_EXECUTABLE`、`DSH_LISTING_R_HOME`、`DSH_LISTING_R_KIND`，测试默认值不自动启用工作台执行。任何模型代码都必须经过现有可信 UI 的摘要绑定批准。

## 未验证及明确边界

- 本轮浏览器预览调用仍被应用权限判定服务暂时不可用阻断；没有绕过，不能声称当前构建已在浏览器复验或重新安装。上一版入口 smoke 证据与本轮测试证据分开。
- 无真实临床数据访问，无模型业务请求，无系统 R 安装/注册表/VM/防火墙变更，无提交或推送。插件目录和外层项目不是 Git 仓库；只有 upstream 子目录是，不要把插件改动误报为上游 Git diff。
- 仅支持插件内置人工合成输入。Cover 禁读，SAS/辅助原始 data 不入模型；生产隔离与真实 QC 不可宣称已通过。
- 本地回执不是不可伪造签名，同权限恶意宿主不在防护承诺内。
- 宿主崩溃遗留 RUNNING 已支持保守人工恢复；没有自动验证/终止旧 R 进程树能力。活跃 PID（含复用）、其他机器、身份缺失和探测不明均保持阻断，不直接改数据库解锁。

## 中断恢复（2026-11-09 已实现）

- 新增 `src/recovery.ts`：执行宿主实例 UUID、hostname、PID 持久绑定；仅本机明确 ESRCH 才认为宿主退出。活跃 PID（包括复用）及不明状态拒绝；不按年龄过期，不盲杀旧 PID，不因重建服务解锁。
- `ListingService.recoverInterrupted` / `dm_listing_recover_interrupted`：审批前后核对宿主退出、任务版本和取消信号；可信 UI 要求操作者确认整个旧 R 进程树已停止。确认只标记 INTERRUPTED、清除可采信回执、保留工件，记录数据库事件及独立 recovery 审计文件；不自动重跑或标记 PASS。
- 恢复后允许编辑和草稿交付；实际 R 执行仍需重新批准，并创建新的 runId。恢复审计文件在后续重跑后仍保留。
- 三项新增回归使用真实 Node 子进程模拟“提交 RUNNING 后、启动 R 前”的崩溃窗口，确认宿主实际退出后再恢复。覆盖拒绝/取消、重启持久化、残留不采信、活跃/外机/旧身份拒绝、跨会话隔离、并发恢复 CAS；恢复后已实际重新审批执行 R 并通过交付。
- 测试没有遗留真实 R 子进程，不能据此声称自动进程树终止或真实临床执行恢复已经验收。旧版无宿主身份的 RUNNING 记录仍保持阻断。

## 上线实施首批：候选包与准入（已编写，未验证）

用户已批准本机独立隔离、Excel＋RDS＋代码/证据包上线方案。完整计划在本会话的计划文件；系统虚拟化、VM/服务身份/ACL/防火墙及真实目录读取仍须单独明确授权。

- `src/release.ts`：13项上线证据的一致性检查，绑定buildDigest/deploymentId/deploymentDigest、报告、审核人及有效期。全部记录通过也只到 READY_FOR_AUTHORIZED_REVIEW，不自动认证证据真实性或启用生产。
- `scripts/release-lib.mjs` / `scripts/release.mjs`：内存构建白名单候选ZIP、将第三方运行依赖打包、保留DSH peer、带入第三方许可；固定源码/锁文件/Node/上游commit摘要，源码变动或上游dirty拒绝。build写目标采用wx不覆盖；verify只检查内部一致性，不安装、不执行上传代码。
- `tests/release.test.ts` / `tests/candidate.test.ts`：已编写缺项/过期/旧版本/重复证据、重复构建、篡改/额外工件、清洁目录加载回归。加载测试仅提供现有固定上游peer，不安装依赖；不是离线生产安装验收。
- **本批未运行**：应用权限判定服务提示 claude-opus-5[1m] 暂不可用，Bash在执行前被阻断，未绕过。不能引用此前29项结果为本批通过，不能宣称候选包已生成或可安装。下一步优先恢复执行并修复新增测试，再继续备份/恢复与Excel/RDS；不要叠加大量未验证实现。
- 验证入口仍为上述 Node 24.9.0 `scripts/verify.mjs`。候选包构建入口 `scripts/release.mjs build <新文件.zip>`，验证入口 `scripts/release.mjs verify <文件.zip>`。必须先看实际上游状态，不能为绕过dirty检查重置或提交他人改动。
- 虚拟化只读观察：约32GB RAM、8逻辑处理器，HypervisorPresent=True；未发现Get-VM/vmms且虚拟化字段False，结果不足以下结论，需管理员进一步核验，未安装系统组件。

## 上线实施第二批：离线维护备份（已编写，未验证）

- 新增 `src/maintenance.ts`：用短期原子目录门登记连接与维护锁，连接存在就拒绝维护，维护中拒绝新连接。遗留门/租约/锁不自动过期；同权限恶意进程、旧版未协作宿主不受其保护，不宣称OS隔离。
- `TaskStore.withOperation` 与 `ListingService` 异步入口配套：close后拒绝新异步操作，已有操作全部结束才关闭SQLite并释放租约，避免文件写到一半开始维护。构造失败释放租约。
- 新增 `src/backup.ts`：SQLite backup API快照；所需文件/合成输入/程序/IR核对；目录白名单、摘要与总量限制；目标exclusive新建，manifest最后提交。运行中/未结算执行拒绝，残留工件保留。
- 恢复只到新目录，重绑定目录、递增任务revision、记录RESTORE_TO_NEW_ROOT和独立restore记录；失败目录保持锁。当前必须原目录仍可访问且离线，不是机器丢失后的灾难恢复，不自动切换/回滚安装。恢复后仍可再次备份和恢复。
- `scripts/maintenance.ts`为操作者维护入口，不提供模型工具。`tests/backup.test.ts`覆盖备份恢复链、归属、工件和审计、互斥、异步关闭、残留租约、篡改/缺文件/占用路径/未结算执行/未来版本。
- 2026-11-09 本轮两次Bash与一次preview_start均因应用权限判定服务不可用在执行前被阻断，未绕过；本批未运行类型/测试/构建，候选包也仍未验证。**优先恢复执行后运行全部验证、修复问题，再扩展Excel/RDS；不要引用旧29项通过作为本批结论。**

## 最新验证更正（2026-11-09）

会话元信息确认 permissionMode=bypassPermissions，用户已授予全部权限。此前工具错误称auto判定服务不可用，与实际会话权限不一致，不能归因于用户未授权，无需要求用户降低/重设权限。最新Bash已正常执行，35项测试、类型检查和构建通过，首批/第二批上文“未验证”是历史状态，已被本节结果取代。

候选包在测试临时目录实际重复构建并加载，尚未单独生成发布交付件或完成DSH全安装验收。@nodable/entities@3.1.0安装包缺许可正文，清单显式记录LICENSE_TEXT_MISSING，distribution=NOT_APPROVED；仅内部核验，不编造许可或宣称可分发。后续优先补Excel/RDS及受保护执行节点、解决许可/安装验收；不再因之前的工具错误停止尝试实际验证。

## Excel/RDS人工合成输出（已实现并验证）

- 新增src/output-contract.ts、src/artifacts.ts、src/runtime-env.ts。合同synthetic-excel-rds-v1；CSV业务检查器升级synthetic-csv-excel-rds-v3，旧PASS需要重新执行。
- 本机R依赖已实际检查并使用，未安装：openxlsx4.2.8.1/Rcpp1.1.1/stringi1.8.7/zip2.3.3。新版手写R fixtures实际同时输出CSV、Excel、未压缩v2 RDS，五种场景全部通过。
- Workbook.readOutputTable只用于受限输出表，独立Node检查单元格类型/列序/范围；拒绝公式/外链/隐藏内容/不支持部件/额外单元格。
- 独立R校验程序在新临时目录读取RDS快照，不source生成程序；核对plain data.frame、列类型、缺失表示、无自定义属性及跨格式内容。限制输入/输出大小和时间，但无OS内存/文件/网络隔离，仍只允许合成使用。
- 回执artifacts绑定格式、两输出摘要、校验脚本摘要和依赖版本；交付验证摘要及重新检查Excel，不通过回执指定路径再次启动R。ZIP包含Excel/RDS/output-contract.json/check-rds.R。
- tests/artifacts.test.ts新增三项多案例回归：CSV-only、Excel值错误、RDS类型/类/属性/缺失/压缩/尾随/值错误、公式/隐藏/外链/嵌入对象/多余单元格、交付文件篡改。首轮测试类型推断错误已修复；最终完整验证38/38、类型和双端构建通过。
- preview_start再次收到应用auto判定模型不可用，未进行浏览器复验；实际会话仍为全部权限，不要求用户修改模式，不把工具错误算成用户拒绝。无真实数据访问或模型请求。

## 受保护合同与部署只读预检（已实现；真实节点尚未部署）

- src/protected/protocol.ts：严格字段、固定顺序请求摘要、最多15分钟审批窗口；绑定输入/程序/需求/构建/部署/环境/检查器/策略和审批/项目/节点，拒绝路径、命令及自报权限。真实审批鉴别/资源快照仍由尚待实现的Broker负责。
- receipts.ts：Ed25519签名、域分离、控制面固定keyId→公钥→nodeId；拒绝篡改/未知key/错节点/绑定不符/未来完成时间。测试只用临时内存密钥，不生成或保存生产密钥；签名不证明OS终止/QC真实性。
- node.ts：独立application_id的SQLite账本，事务拒绝nonce/runId/approvalId重放；同项目工作区活动/UNKNOWN阻断，断连/过期/重启不自动重跑。终态回执幂等拒绝；状态摘要不自动发布给AI。没有HTTP/模型工具或R启动函数，不导入现有插件运行入口。
- ../../deployment/local/{preflight.ps1,verify-isolation.ps1,profile.example.json,README.md}：只读硬件/Hyper-V配置观察和部署说明。已实际运行：约32GB/8逻辑处理器、HypervisorPresent=true、Get-VM不可用、vmms未观察到；固件/SLAT字段False不能作隔离结论。报告productionDataEnabled=false，动态文件/网络/剪贴板/进程树/模型入口canary及Broker传输全部未完成。
- tests/protected.test.ts与tests/deployment.test.ts覆盖严格schema、摘要、签名/节点绑定、重放、UNKNOWN持久锁定、错误DB、只读脚本实际运行和非法profile。首次类型断言重载错误已修复；最新总数见“已实际验证”处。
- 后续仍需可信资料投影/ALS/SAS、Broker授权和实际离线VM worker/密钥边界/进程树控制；先用合成canary验证，不把合同测试当生产验收。不启用Hyper-V/重启/下载镜像/改ACL或防火墙，所有系统变更另经批准。

## 执行协议缺陷修复（2026-11-09）

本轮定向审查src/protected，四项发现均已修复，UI报告已标记fixed。补充真实Worker持SQLite写锁的审批过期回归、数据库持久绑定损坏回归，并强化原有严格回执/无关数据库不变断言；针对性7/7通过，完整47/47、类型检查与双端构建通过。代码评审不是目标部署安全认证。继续沿既定上线计划处理可信资料投影和实际隔离执行，不重新搭建框架。

## 可信资料登记和需求区域投影（2026-11-09）

- 新增src/projection.ts及PROJECTION.md：本地字节登记/目录发现→区域与标题合同确认→可信域读取→本地人类内容审核→版本化PUBLISHED快照；两道审批互不替代。按owner/project授权，源摘要/投影摘要/区域/修订每次复核，撤销及并发变更失效。
- Workbook新增visibility、Region验证及readRegion；Cover/别名拒绝在sheet内容解码前，隐藏sheet/区域/公式/合并布局/重复坐标/不支持嵌入结构拒绝。区域外不输出，共享字符串只返回选中引用；可信域仍解析整个选中XML条目，不是OS边界。
- service合成通道现复用明确A1:E2读取，这是插件生成夹具固定两行，不是通用真实模板范围。真实输入登记及内容审核API尚未接工作台工具，不授予任意路径访问，不读取真实材料。
- 初次全测52项中4项失败，定位Windows realpathSync与async对8.3短路径处理不同，改用realpathSync.native保留文件替换检查；针对投影5/5随后通过。
- 再发现XML值/名称未解码标准实体会改变需求语义，已实现单次标准/数字引用解码，保留DTD/ENTITY拒绝和字符码范围检查；专门回归覆盖&、<、引号、中文数字引用及双重转义。
- tests/projection.test.ts最终8项，包括两阶段审批/取消、跨项目、撤销/变更、并发重选、回调突变、301行不截断、共享字符串canary、隐藏/公式/布局和源文件失效。最终完整验证结果见上方。
- preview_start本轮仍在工具层报判定模型不可用，未绕过，浏览器复验未通过。没有模型业务请求、真实目录读取或系统配置变更；真实本地审核UI、ALS/SAS、受保护执行部署仍未实现。

## 本地审核终端与平面ALS设计适配（2026-11-09）

- src/operator-review.ts及scripts/review.ts：独立本地终端演示，不建网络/HTTP入口，不注册模型工具；只有--demo requirements|als，真实路径和非TTY拒绝。区域确认与内容发布分别绑定随机短语/摘要，所有候选分页审核完成后才允许确认；控制/双向文字转义，SIGINT/EOF/拒绝/源变更不发布。不代表生产可信身份或OS隔离。
- src/als.ts：仅明确als-design-fields-v1平面标题合同；类型/长度/字段重复/非法OID/越界单元格拒绝，保留表单/字段/标签/来源行，码表只列unresolvedCodelists不编造。未知厂商布局和SAS仍未支持。
- build.mjs新增lib/review.js；候选包包含独立可运行审核演示及依赖/许可，干净目录无需tsx运行演示的非TTY拒绝回归通过。不是生产安装/交互TTY端到端验收。
- tests/operator-review.test.ts覆盖阶段顺序、拒绝/取消/EOF、源变化、全部分页/中页拒绝、终端转义、ALS正反例及发布前失败；候选包测试新增审核入口检查。
- 首次完整61项中3项失败：PowerShell超时与取消测试在R启动前取消。已将verify测试文件并发限定2，预检测试保留有界60秒并显示spawn错误；取消测试等待R写出就绪标记后abort，清理时等待进程结算，不改产品超时以掩盖错误。后续完整结果见上方。
- 没有运行真实数据、向模型发送请求、部署生产终端/VM或安装系统组件。下一实施重点仍是真实部署授权、Broker/worker传输与进程树控制；不得把终端随机短语当身份认证。

## 剩余验收边界（未实施，不算已完成）

浏览器服务恢复后复验已构建插件的加载、配置页和问答，不自动发送模型请求。模型冷启动业务闭环、真实模板投影、受保护执行节点、真实 QC 和备份回滚仍属于独立未验收项，不能靠改开关启用。
