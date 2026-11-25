# 企业 DSH 智能体平台开发计划

**日期及版本** 2026-11-21 · v1.1 · 方案待实施。v1.1 修订员工工作台的左栏装配和验收。详见[员工工作台单侧栏架构](WORKBENCH-SINGLE-SIDEBAR-ARCHITECTURE.md)。

**目标** 在现有 DSH 原生工作台和多插件架构上，完成运行制品核验、知识租户边界、启动恢复、员工交互和工程门禁整改，为限定范围的企业试点建立可复验的放行证据。

**实施基线** 2026-11-21 审查基于 `b86705a` 及当时的未提交工作树。宿主为 DeepSeek Harness `0.2.2-rc.1`，提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。Node `24.9.0` 已用于审查抽检。实施开始时重新记录实际工作树和制品，由待验收快照生成当轮证据。[上游基线](UPSTREAM-BASELINE.md) · [DSH 开发规范](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)

## 1. 架构与交付边界

- `platform-runtime` 维护执行计划及其版本化摘要。`platform-control` 维护发布批准、Work、Run、调度、交付和复核事实。Worker 在所属执行域加载 DSH 及业务插件并消费冻结输入。`platform-knowledge` 负责范围判定和知识证据。`platform-workbench` 通过 DSH 公开扩展点装配员工界面。[应用发布合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md) · [运行生命周期合同](PLATFORM-RUN-LIFECYCLE-CONTRACT.md) · [工作台架构](ENTERPRISE-WORKBENCH-PLUGIN-ARCHITECTURE.md)
- 一个 Work 的中心是其绑定的 DSH 原生会话，运行、输入、成果和复核在右栏。一次 Session 只有一个写入所有者。新应用从发布描述获取入口、表单和成果展示。Listing 的员工入口保留 Manual、Medical、PK、Report，DVP 使用独立字段。[原生工作台 ADR](adr/ADR-0003-NATIVE-WEBUI-WORKBENCH.md) · [工作台架构 R3/R4](ENTERPRISE-WORKBENCH-PLUGIN-ARCHITECTURE.md#r3--从表单到冻结输入platform-workbench--platform-control--worker)
- IT/API 和执行环境提供可信身份、授权及隔离。业务插件保留 Harness 自主规划、获得授权的普通读取和 R 开发能力。领域专属数据约束继续使用对应合同。审查、回归和试点默认使用合成或获准公开资料。[DSH 开发规范 §§6–8](DSH-PLUGIN-DEVELOPMENT-STANDARD.md) · [企业身份与数据入口合同](ENTERPRISE-IDENTITY-AND-DATA-CONTRACT.md)
- 发布候选应能在干净检出中构建、安装和验证。企业试点在获准目标环境验收，业务 QC 独立绑定当前输入、Run 和具体交付物。当前工作树中的历史和本地记录用于确定要补的证据。[开发规范 §§10–13](DSH-PLUGIN-DEVELOPMENT-STANDARD.md) · [企业试点验收清单](ENTERPRISE-AGENT-PILOT-ACCEPTANCE.md)

## 2. 顺序、依赖和责任人

表中为负责角色。开工时在实际工单登记负责人、可编辑路径和基线。共享文件只有一个写入负责人。控制面启动、制品路由和知识快照都可能触及 `cordis.ts` 或 `service.ts`，这些改动按表中顺序落入同一检出。

| 顺序 | 工作包 | 优先级 | 负责角色及依赖 | 可交付结果 |
| --- | --- | --- | --- | --- |
| 0 | 冻结工程基线 | 前置 | 平台维护者和发布工程 | 源码、宿主、环境及差异清单，重跑命令和基线结果 |
| 1 | 运行制品与发布路由 | P0 | 平台运行和发布工程，依赖基线 | 实际制品核验、双版本装配、回退与阻断证据 |
| 2 | 知识租户范围 | P0 | 知识与身份维护者，依赖范围合同，控制面接线接续工作包 1 | 查询、直读、冻结和重放共用范围规则 |
| 3 | 会话导航与恢复 | P1 | 工作台维护者，依赖锁定宿主 | 快速切换与断线恢复的浏览器证据 |
| 4 | 启动恢复和调度装配 | P1 | 平台控制维护者，接续工作包 1–2 的控制面变更 | CLI 与 Cordis 的一致恢复行为 |
| 5 | 工程门禁和干净安装 | P1 | 发布工程，基线修复可先做，候选制品门禁依赖工作包 1 | PR 检查、锁定宿主装配、可复跑的候选报告 |
| 6 | 员工单侧栏、国际化和无障碍 | 员工版发布门槛 | 工作台及发布维护者，接续工作包 3 | 首屏、刷新及窄屏只有一套企业导航，中英核心任务与纯键盘操作通过 |
| 7 | 目标环境试点与规模验收 | 放行门槛 | IT、平台、发布、业务 QC，依赖相应用例的实现和环境 | 绑定同一候选制品的试点报告与明确放行范围 |

工作包 1、2 决定是否有资格接入企业数据。受控的本地合成验证可在相应模块稳定后开始。真实 SSO、区域策略和执行域准备可由 IT 提前进行。已有工作台或知识库计划仍维护各自功能合同，本计划给出此次整改的工作范围和出口。[W1–W6 方案](ENTERPRISE-WORKBENCH-PLUGIN-ARCHITECTURE.md) · [知识交付计划](DSH-ENTERPRISE-KNOWLEDGE-DELIVERY-PLAN.md)

## 3. 实施工作包

### 0. 冻结工程基线

1. 记录 `git rev-parse HEAD`、`git status --short`、上游 commit 和工作树状态、Node、pnpm、R、OS 和执行器入口。核对改动及未跟踪文件归属，特别是聚合器使用的 `verify-applications.mjs` 和 `verify-knowledge-golden.mjs`。将需要保留的本地变更由负责人纳入候选快照。
2. 在同一源码状态下记录开发规范检查、受影响包、`verify-all` 和最小宿主装配的实际结果。Windows 上如 npm 子进程无法解析 Node，记录所用 Node 绝对路径或纠正继承的 `PATH` 后重跑，保留首次失败和最终结果。
3. 准备隔离测试库、专用 profile、两套可区分的合成制品、双组织双区域知识和工作台会话夹具。记录制品及夹具摘要、测试数据归属、证据目录和现行环境限制。

**完成条件** 有可重跑的输入和命令，有版本归属的历史证据及当前失败清单，写入范围已登记。[聚合验证](../scripts/verify-all.cjs) · [试点验收登记](ENTERPRISE-AGENT-PILOT-ACCEPTANCE.md#1-验收前登记)

### 1. 运行制品与发布路由

部署生成器目前以版本、profile 名和 Bundle 名单形成运行摘要，Worker 入口比较配置和计划中的声明值。服务层拥有按摘要登记执行器的接口，本地部署装配只读入一套 Worker 配置。[部署生成器](../scripts/workbench-deployment.cjs) · [部署读取](../packages/platform-control/src/deployment.ts) · [服务路由](../packages/platform-control/src/service.ts) · [Worker](../packages/platform-control/src/worker.ts) · [子进程 Worker](../packages/platform-control/src/child-worker.ts)

| 任务 | 实施要求 |
| --- | --- |
| 发布清单 | 从同一装配入口生成版本化、可确定性计算摘要的清单。绑定引擎和 Adapter、实际安装包及依赖闭包、能力和协议、有效 profile/patch 顺序和配置、平台架构要求。将摘要绑定进发布计划，批准仍关联 `releaseDigest`。固定序列化、文件路径规范和符号链接处理，秘密使用引用。 |
| 装配验证 | 在获准制品目录中校验真实安装内容和有效配置。启动预检覆盖必需能力、版本和批准状态。进程及子进程入口使用同一核验规则，把匹配结果连到 Run 和启动尝试。部署身份管理制品，执行身份使用只读内容，会话与输出使用各自工作目录。 |
| 双版本路由 | 正式部署装入多套按摘要登记的执行器和适用模型路由。按已冻结 Run 的摘要选定执行器。缺失、不可用和摘要不匹配时记录明确原因并停止派发。默认发布切换通过版本比较保护，撤权仍走独立路径。 |
| 历史与回退 | 保留既有发布的原始摘要、Run 和工件关联。按原格式查验历史记录。需要继续执行的版本应具备可匹配、已批准的原制品，否则按合同阻断。新制品需生成并批准新发布。回退前核对目标批准及实际可用性，回退只切换新 Work 的默认路由。 |

**拟改范围** `platform-runtime/src/plan.ts`，`platform-control/src/{release-manifest,registry,deployment,config,worker,child-worker,service}.ts`，实际启动入口及发布脚本。按需要评估现有计划格式能否表达制品清单，涉及公共合同或持久化时同步版本、迁移说明和 ADR。复用已有注册与派发路径。[应用发布合同 §§2–5](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)

**验收** 同一只读安装内容在不同部署位置可重验。合成夹具中的插件、依赖或有效配置发生变更时，启动在消费业务输入前明确拒绝。通过正常部署入口装配两套可区分制品，确认旧 Run 与新 Run 各自使用准确制品并留下启动证据。覆盖缺制品、过期默认发布提交、回退后历史可读和撤权版无法设为默认。扩展现有 `worker`、`child-worker` 和 W6 试验，再执行目标环境 `REL-01`、`RUN-01`。[W6 扩展试验](../packages/platform-control/tests/w6-extension-drill.test.ts) · [试点验收](ENTERPRISE-AGENT-PILOT-ACCEPTANCE.md)

### 2. 知识租户范围

当前缺省组织或区域时，检索与只读快照可能省略对应条件。按 ID 读取和固定快照重放则有逐条的范围判断。控制面当前给快照传入插件及项目。[查询存储](../packages/platform-knowledge/src/store.ts) · [逐条可见性](../packages/platform-knowledge/src/service.ts) · [只读快照](../packages/platform-knowledge/src/snapshot-readonly.ts) · [控制面接线](../packages/platform-control/src/cordis.ts)

1. 先冻结范围规则，说明显式全局共享、组织范围、区域范围、项目范围及旧无归属数据的含义。企业身份和项目授权提供组织、区域和项目。缺少企业范围时返回可诊断的不可用状态。业务侧请求只可收窄组织、区域和项目。单机模式使用显式的本地范围。
2. 统一列表、FTS、短词降级、精确读取和只读冻结的范围语义。SQL 在分页计数、排序、去重前过滤，按 ID 读取和固定快照按同一规则验证。搜索结果、总数和返回引用均来自同一个授权范围。
3. 控制面创建 Run 时绑定可信范围、知识摘录所用的固定修订引用及摘要。重放核对固定内容和当前可见性，撤回或撤权后以排除原因入证。对旧库做有范围的清点和备份。已知归属由负责人按批准映射迁移，归属未决的记录保留供受控处理，历史快照摘要保留。企业试点从已批准归属的库生成新快照。

**拟改范围** `platform-knowledge/src/{scope,identity-scope,store,service,snapshot-readonly}.ts`，`platform-identity` 的授权适配与 `platform-control` 的 Run 快照接口和启动接线。测试扩展 `scope`、`tenant-i18n`、`projection-query`、`snapshot-readonly`。[知识库架构](ENTERPRISE-KNOWLEDGE-ARCHITECTURE.md) · [知识验证合同](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md)

**验收** 在双组织、双区域、同名项目的合成库中，覆盖有效上下文、缺失上下文、明确共享、旧无归属记录、撤权及撤回。比较普通列表、FTS、短词、直读、冻结、重放中的正文和引用可见性。线上范围随可信身份与授权一致变化，已创建 Run 的历史证据仍可追溯。[试点 ID-01/ID-02/RUN-01](ENTERPRISE-AGENT-PILOT-ACCEPTANCE.md#2-p0--试点放行门槛)

### 3. 会话导航与恢复

1. 在 `WorkbenchPage.tsx` 及实际宿主绑定处统一工作、详情、历史会话和浏览器前进后退的导航生效规则。以锁定宿主公开 `beginNavigation()` 为基础覆盖宿主级切换，平台页内切换统一使用同一导航意图。异步返回后只允许当前意图提交页面、会话引用、订阅和焦点。过期导航只释放其拥有的引用。
2. 给恢复路径传递结构化结果。临时网络或宿主不可用保留坐标、显示可诊断状态并允许重试。明确不可恢复时移除坐标。按服务端可见性策略显示不可访问提示并清理旧正文。对仍获准的工作记录保留只读详情入口。
3. 在右栏独立切换 Run、回答 Worker 待答和查看成果。用同一 Session ID、会话输入状态和提交记录观察右栏操作前后行为。引用、订阅、轮询与定时器按所有权在换页或卸载时释放。

**验收** 在真实锁定宿主中使用可控延迟，覆盖 A→B 反序返回、A→列表、浏览器前进后退、加载中卸载、冷启动、刷新中断网后恢复、撤权及工作归档。最终界面只显示最新目标，临时错误恢复后仍使用原 Session，既有对话流继续且提交未重复。留浏览器证据、Session ID 和脱敏提交关联。[工作打开和恢复](../packages/platform-workbench/src/client/WorkbenchPage.tsx) · [上游布局合同](../upstream/deepseek-harness-git/packages/client/ui-layout/README.md) · [工作台 R4](ENTERPRISE-WORKBENCH-PLUGIN-ARCHITECTURE.md#4-主链路状态与隔离)

### 4. 启动恢复和调度装配

- 从 `api-cli.ts` 和 `cordis.ts` 提取共用的初始化和关闭逻辑。按当前合同处理 `reconcileOnStartup`、`scheduler.enabled`、Worker 模式和退出证据。启动时的接线顺序应确保意外退出记录完成对账后才开启新派发。保留原 CLI、Cordis 配置入口的调用方式并用入口级测试验证。[API 启动](../packages/platform-control/src/api-cli.ts) · [Cordis 启动](../packages/platform-control/src/cordis.ts)
- 在隔离持久库覆盖正常结束、租约过期、控制面中断、发送后未确认和重启期间重复触发。验证 launch、退出证据、Run、outbox 状态一致。未能确认的结局保留 `UNKNOWN` 或对应合同状态。重复对账保持幂等。[运行合同](PLATFORM-RUN-LIFECYCLE-CONTRACT.md) · [故障手册](PLATFORM-FAULT-RUNBOOK.md)
- 两入口在相同配置与相同夹具下的派发、对账语义一致。调度禁用时零启动。涉及环境级进程监督和恢复的实测放入 `RUN-02`，恢复后核对 Run、交付索引、授权和工件摘要。[试点 RUN-02](ENTERPRISE-AGENT-PILOT-ACCEPTANCE.md#2-p0--试点放行门槛)

### 5. 工程门禁和干净安装

| 任务 | 实施与验收 |
| --- | --- |
| 检查器覆盖 | 检查公共包、业务插件和发布脚本的依赖边界。PR 使用源码解析识别可确定的静态导入、再导出及动态字面导入，识别包公开入口。宿主装配后按实际注册工具对账知识 manifest、主题及种子。补齐配置型 Bundle 门禁，用上游公开规则验证有序 patch 列表和各文件路径。若平台明确收窄上游能力，按规范版本记录适用范围和理由。 |
| PR 检查 | 先确保必须文件与依赖锁从干净 checkout 可获得。对受影响包及共享包消费者执行相关 `verify`，并在涉及 DSH 入口、配置、Client 协议的变更上做锁定宿主装配检查。Windows 复验日常 CLI 工作流，Linux 复验参考 CI。两端的运行时、R 和测试夹具按实际支持组合登记。 |
| 候选制品检查 | 在冻结快照执行根 `verify-all`。按包类型验证打包、干净安装或导入、真实加载和卸载。知识发布范围执行 `--release` 门禁。记录制品摘要、依赖锁、宿主版本、执行命令、适用性、结果和诊断。禁止用上一次构建结果代证当前候选。 |
| 合并与分发 | 将需强制的检查配置为合并要求，经实际 runner 执行后留报告。分发使用已核验的候选制品，按现有发布合同保留批准来源和对应摘要。 |

**拟改范围** `scripts/check-development-standard.mjs`、`scripts/verify-all.cjs` 及其自测、应用与知识验证脚本和 `.github/workflows/verify.yml`。编写检查器之前对照上游实际模块解析、插件管理与配置装配合同。[开发规范](DSH-PLUGIN-DEVELOPMENT-STANDARD.md) · [上游 Bundle 合同](../upstream/deepseek-harness-git/docs/user/develop/basic/publish.md) · [当前 CI](../.github/workflows/verify.yml)

### 6. 工作台宿主兼容、国际化和无障碍

- **员工单侧栏。** 使用 DSH 插件 `platform-workbench` 注册公开的 `sidebar` 插槽。验证优先级选出企业导航，并在隔离环境复验可选的员工 Web profile 叠加层。`main:emerald-platform` 负责页面内容、原生会话和右侧工作上下文。员工侧只有企业导航及其响应式抽屉，首屏和刷新均符合此条件。通过运行时装配与浏览器证据核对 Workspace、Session、原生交互和既有深链接。明确区分员工入口和运维装配。[单侧栏方案与验收](WORKBENCH-SINGLE-SIDEBAR-ARCHITECTURE.md)
- **会话 Views。** 核对锁定版公开 header 与 View 动作装配。优先复用上游提供的能力。对嵌入模式需要平台拥有的部分实现方向键、可见焦点、选中状态和 View 与面板关联，按公开合同处理额外 View 与动作。验证 Chat、Trajectory、合成 View、扩展动作、窗口变窄和会话保持。[当前嵌入视图](../packages/platform-workbench/src/client/WorkbenchPage.tsx) · [上游会话合同](../upstream/deepseek-harness-git/packages/client/ui-conversation/README.md)
- **语言和时区。** 将历史、创建、运行、错误、空态、复核及无障碍名称统一到 locale。应用描述按发布提供本地化名称、帮助、资料角色和成果标签。运行与审计时间保留可核对的原始时间，按员工选择呈现时区，日期值按业务含义显示。用中英完整任务、键盘与移焦、临界日期和缺翻译回退测试验收。[语言实现](../packages/platform-workbench/src/client/i18n.ts) · [规范 §5.3](DSH-PLUGIN-DEVELOPMENT-STANDARD.md#53-client-与安装配置)

### 7. 目标环境试点与规模验收

1. IT 接入真实身份、项目授权、资源入口和撤权信号。平台从可信上下文授权目录、搜索、Session、Run、答复、下载及复核，执行域以相应身份提供已获准的目录、网络和模型能力。按拟放行区域核对实际端点、处理及留存位置、授权及运营责任。登记撤权时限和恢复目标后执行 `ID-01`、`ID-02`、`ISO-01` 和 `RUN-02`。[企业身份合同](ENTERPRISE-IDENTITY-AND-DATA-CONTRACT.md) · [试点验收](ENTERPRISE-AGENT-PILOT-ACCEPTANCE.md)
2. 用同一候选制品，在原生工作台跑一个跨过目录、Work、Session、右栏 Run、Worker、封存成果及复核的完整路径。分别执行 DVP 和 Listing 的独立 QC，鉴别工作完成、运行成功、候选工件与业务批准。扩大 Listing 场景、地区、模型或数据范围时，按新增范围重验适用项。[试点 UX-01 与 QC-01–03](ENTERPRISE-AGENT-PILOT-ACCEPTANCE.md#2-p0--试点放行门槛)
3. 接入一个不同类型的合成应用，经声明完成登记、加载、运行、显示和卸载，并检查工作台源码无新增应用特判。用至少 100 项混合目录核对搜索、授权过滤、分页和按需加载，再按实际预计并发测队列等待、执行耗时、失败重试和恢复。与部署方在运行前约定负载和阈值，报告 P50/P95、错误率、硬件与模型条件。[工作台 R1–R6](ENTERPRISE-WORKBENCH-PLUGIN-ARCHITECTURE.md#6-评审验收标准) · [试点 EXT-01/OPS-01](ENTERPRISE-AGENT-PILOT-ACCEPTANCE.md#3-p1--扩规模前验收)

## 4. 验收证据与切换

| 阶段 | 必须交付的证据 | 通过后可推进 |
| --- | --- | --- |
| 工程验证 | 规范、受影响包、回归和完整根门禁记录，有对应源码快照及未覆盖项 | 使用冻结制品进入候选验证 |
| 候选验证 | 干净安装、真实 DSH 装配、UI 与 API 关键路径、双制品切换和回退、历史对照 | 在约定目标环境进行试点验收 |
| 企业试点 | 所有适用的试点 P0 用例通过，记录获准的组织、项目、数据、地区、模型、应用版本和业务场景 | 按记录范围开放员工入口 |
| 扩规模 | 规模、地区和应用增量在相关工况下达到预定阈值，补全目标证据 | 评估扩大试点范围 |

每条证据记录用例、执行人、时间、源码及制品摘要、环境、夹具、命令或操作、实际结果及证据位置。用 `PASS` / `FAIL` / `BLOCKED` / `NOT_RUN` / `N/A` 保存结论，`N/A` 引用适用性依据。适用 P0 缺证据时关闭对应放行范围。业务 QC 单独指向 Run、输入版及具体工件摘要。[试点放行记录](ENTERPRISE-AGENT-PILOT-ACCEPTANCE.md#4-放行记录每轮填写)

切换前在隔离副本演练备份与恢复，抽查发布摘要、Work、Session 关联、运行、复核及封存工件。切换按获准制品登记执行器后更新默认发布。保留已接纳 Run 的原装配和旧制品至排空。普通回退核对目标仍获准可用并切回默认指向。撤权或停止结局未知时按运行合同处理，历史内容及审计证据继续按其所有权和保留规则维护。[发布升级与撤权](PLATFORM-APPLICATION-RELEASE-CONTRACT.md#5-发布升级与撤权) · [运维手册](PLATFORM-OPERATIONS-RUNBOOK.md)

## 5. 初始看板

| 项目 | 目前证据 | 本计划出口 |
| --- | --- | --- |
| 规范与聚合器 | 前轮规范检查与自测通过，聚合器自测 19/19；发现 21 个根检查入口 | 干净检出完整执行 `node scripts/verify-all.cjs`，附 PR 和候选报告 |
| 制品与版本 | 前轮 2 项 W6 合成登记与回退用例通过 | 实际制品预检、双制品与缺制品验证通过 |
| 工作台 | 前轮直接通过当前 Node 执行测试 112/112 | 锁定宿主下通过会话竞态、断线恢复、纯键盘、双语、多插件验收 |
| 企业环境 | 企业身份、隔离、区域与业务验收按目标环境记录 | 试点清单全部适用 P0 通过，形成范围明确的验收决定 |

首个实施工单应完成工作包 0 的快照冻结，并提交工作包 1 的版本化运行制品清单及 Worker 核验。以两个可在隔离环境安装的合成制品完成首次端到端检查，交付物包含制品、部署描述、Run 绑定及拒绝证据。
