# 架构与开发文档导航

企业级开发规范：[DSH 插件开发规范 v1.0](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)——**当前系统及所有后续开发必须遵守**，不设存量豁免，不为错误实现保留兼容层；不符合项须修正或重做并通过对应检查。规范唯一维护于该正文。

## 社区工作台调研（2026-11-19）

[DSH 社区工作台插件调研](DSH-COMMUNITY-WORKBENCH-RESEARCH-2026-11-19.md)：基于 npm / GitHub 与 11,979 条插件目录快照，梳理社区工作台的五类形态，提取 10 个可借鉴架构模式（版本化模块契约、共享宿主、同屏同事实同权限、控制室、完成≠验收、台账修订、唤醒租约、内联 GenUI、市场探测、版本能力矩阵），并列出不建议照搬的做法与三步落地顺序。**结论来自作者 README 自述，未逐行核源；采纳前须核对 DSH 上游公开契约。**

## 原生 WebUI 与企业工作台统一实施（2026-11-12）

[详细开发实施任务书](NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md)：保留原生实时会话能力，统一企业工作体验，支持员工独立环境与集中部署，并预备对接既有身份权限系统。包含 T00–T11 任务依赖、文件责任、目标接口、迁移步骤、NW01–NW24 验收与接续开发指令；**当前是开发方案，不是功能已实现或部署通过**。

实施进度与证据：[STATUS](native-workbench/STATUS.md)（按任务状态）、[基线证据](native-workbench/evidence/BASELINE.md)、[上游能力矩阵](native-workbench/CONTRACT-MATRIX.md)、[本轮实现记录](native-workbench/IMPLEMENTATION-2026-11-12.md)。路线决策见 [ADR-0003](adr/ADR-0003-NATIVE-WEBUI-WORKBENCH.md)。

T07/T09 成果与体验：[本轮实现记录](native-workbench/IMPLEMENTATION-2026-11-12-CONTINUED.md)、[证据与截图](native-workbench/evidence/T07-T09-REPORTS-UX.md)。T10 迁移：[只读盘点与退役前置](native-workbench/MIGRATION-2026-11-12.md)。T11 验收矩阵：[NW01–NW24 结果（第三棒更新）](native-workbench/ACCEPTANCE-2026-11-12-T12.md)。

第三棒（T10 整页替代 + T11 未跑项）：[实现记录](native-workbench/IMPLEMENTATION-2026-11-12-T12.md)、[集中部署逐条核对](native-workbench/HOSTED-2026-11-12.md)、[旧入口退役方案](native-workbench/RETIREMENT-PLAN-2026-11-12.md)；T05 原生提交关联与 NW05/08/09/10/17/23 证据见 `native-workbench/evidence/`。

**旧入口已停止对外服务（2026-11-12）**：控制面默认 API-only，`apps/enterprise-workbench` 目录保留、不再默认对外；历史验收记录保留，回退用显式 `--app`（见 [退役执行记录](native-workbench/RETIREMENT-EXECUTION-2026-11-12.md)）。

企业外壳重建：[实现记录](native-workbench/IMPLEMENTATION-2026-11-12-SHELL.md)、[旧页视觉基线](native-workbench/evidence/OLD-WORKBENCH-VISUAL-BASELINE.md)、[原生插件装配与边界](native-workbench/evidence/NATIVE-ASSEMBLY.md)；A 方案截图见 `native-workbench/evidence/t12-a-shell-*`。

工作台 UI 概念稿对齐（2026-11-13）：[实现与验证记录](native-workbench/UI-REFRESH-2026-11-13.md)——按已评审概念稿重做视觉系统、首页信息架构与工作控制台外框（线程仍为原生会话），浏览器回归 28/28＋问答专项 10/10＋规模检索 18/18、主题对比度 128/128、包测试 55/55；截图见 `native-workbench/evidence/UI-REFRESH-2026-11-13-*`。

## 2026-11-11 整改现状（代码优先）

[整改记录](REMEDIATION-2026-11-11.md)记录本轮已修复与实测：PDF ObjStm/页数完整性、DVP 真分页、
知识 claims 激活语义、公共包抽离（platform-workbook / platform-knowledge / platform-runtime）、
两插件独立装配与全量测试、平台控制面（应用登记/持久运行/模型目录与 Run 快照/完成事实 fail-closed/
模型级授权/成果封存与下载/可恢复事件流/原生问答收件箱）、正式前端 `apps/enterprise-workbench`。
最新一轮全仓门禁 12/12 检查通过：Listing 70/70、DVP 68/68、platform-control 64/64、
platform-runtime 7/7、platform-identity 7/7、正式工作台 10/10，聚合器自检 19/19、原型 27/27、
规范检查通过；web profile 配置组合含四个平台/插件包。
这些是代码与单元测试事实，**不是** DSH 宿主集成、企业身份/数据接口、真实模型执行或临床业务验收。

[整改记录](REMEDIATION-2026-11-11.md)中的“补充方案剩余工作矩阵”按 DSH01–DSH10 逐项列出
PARTIAL/NOT_RUN/BLOCKED 及所缺证据；仍未完成项包括：企业身份授权与 IT 数据入口、原生问答/审批
持久通道、成果封存/下载与 SSE、真实模型目录探测、Worker 进程监督/崩溃接管、真实项目端到端验收、
统一 CI 全量通道。工程边界见[开发规范](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)。

**2026-11-11 继续推进**：[平台控制面首批实现](PLATFORM-CONTROL-IMPLEMENTATION.md)已登记应用发布、持久运行/
事件/审计并按 DSH bundle 安装；Worker 执行器按 [ADR-0002](adr/ADR-0002-WORKER-EXECUTOR.md) 使用
DSH profile/SDK，默认未配置，配置后可通过 SDK client 执行并登记产物。进程监督与调度仍未完成。

## 多插件企业平台方案（2026-11-10）

[EMERALD 多插件架构设计](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md)已按七项评审修订为设计 0.2，面向几十至上百插件。Listing 员工业务类型仅 Manual、Medical、PK、Report；各合同均尚未实现/运行验收。

- [企业身份与数据入口契约](ENTERPRISE-IDENTITY-AND-DATA-CONTRACT.md)：Principal 派生、项目数据授权、撤权语义与 I01–I05 验收；`packages/platform-identity` 已实现解析规则（7 项测试），真实 SSO/项目 API 仍待 IT 对接。
- 代码托管：外层工作区已建立 Git 基线；`.github/workflows/verify.yml` 守卫通道随 push/PR 执行规范检查，完整构建/测试通道需托管后手动验证。

- [应用发布与执行合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)：AppRegistration/AppExecutor、确定性能力映射、不可变运行基线和 home 隔离。
- [工作与运行生命周期合同](PLATFORM-RUN-LIFECYCLE-CONTRACT.md)：取消竞争、追加消息来源、完成屏障和同 Run 恢复/新 Run 重试。
- [平台运行手册](PLATFORM-OPERATIONS-RUNBOOK.md)：Outbox 派发、启动租约与 UNKNOWN 处置、发布审批、模型健康、指标/日志、审计哈希链导出、备份校验恢复与知识验证回执的操作口径（2026-11-17 实现）。
- [平台故障排查 Runbook](PLATFORM-FAULT-RUNBOOK.md)：按症状的故障处置——运行停滞、模型/审批/配额拒绝（429）、库损坏恢复、交付包状态、不可比较差异、Windows 已知边界、升级迁移核对清单与明确门控缺口（2026-11-18，E3-5）。
- [控制面备份恢复演练记录](BACKUP-DRILL-2026-11-18.md)：2026-11-18 实机演练（备份→校验→恢复→逐表复核），含内容保真回归测试与诚实边界声明（E3-2）。
- [跨进程知识验证合同](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md)：中心状态、固定验证执行器与回执条件激活。
- [企业级知识库体系设计](DSH-ENTERPRISE-KNOWLEDGE-SYSTEM.md)：每纳管插件一个知识智能体、分层权威、运行接线、验证激活与降级（2026-11-20 设计稿）。
- [知识库开发与验收计划](DSH-ENTERPRISE-KNOWLEDGE-DELIVERY-PLAN.md)：M0–M4 里程碑、12 项工单与 A01–A16 验收矩阵；验收证据与状态分列。
- [插件知识智能体合同](KNOWLEDGE-AGENT-CONTRACT.md)：manifest v2、可信范围、固定快照与证据、事件投影、一次性回执与覆盖门禁（2026-11-20 已实现工程合同）。
- [知识库规模评估](KNOWLEDGE-SCALE-ASSESSMENT.md)：2026-11-16 实测——检索在 20 000 条下约 1.9 s、2/4 插件零沉淀、`claims`/`coverage` 缺口使 listing 全量与 DVP 5 条方法结构性不可 ACTIVE；含 P0–P2 整改顺序。
- [国际化企业级知识库架构](ENTERPRISE-KNOWLEDGE-ARCHITECTURE.md)：六层分层（语料/对象/索引检索/验证激活/租户授权/消费面）、对象模型与 `knowledge/manifest.json` 每插件沉淀合同、检索管线与延迟预算、租户与区域分区、多语言面（非分库）、Run 快照绑定、Phase 1–3 演进与 KA01–KA16 验收编号。**P0 + KA01–KA16 工程项已落地并过全仓门禁（2026-11-17，verify-all 18/18）**：存储 v3+FTS5 trigram（20k 条选择性查询 2 ms）、四插件沉淀合同+检查器规则、participants/viz 接入、种子窄声明激活、docs 57 份建 813 分片（幂等导入）、Run 创建绑定只读知识快照摘要。KA07–KA16 工程项已落地；真实生产跨进程执行器身份、ClaimEvidence 结构化扩展与生产部署演练仍为目标。
- [架构评审与修订对照](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE-REVIEW.md)：保留七项原评审，区分设计修订与运行验证。
- [SDK 最小真实接入验证](SDK-MINIMAL-INTEGRATION-VERIFICATION.md)：2026-11-11 锁定 0.2.2-rc.1 实测全绿（接入/事件/恢复/关闭），附未覆盖边界清单；不构成合同验收。
- [SDK 集成交付级验收](SDK-INTEGRATION-ACCEPTANCE.md)：2026-11-11 12 用例验收套件，11/11 真实模型通过（工具执行/多轮/提问应答与取消/并发隔离/恢复拒绝/截断/排空/审批通道），崩溃注入用例待执行；产出问答链路缺位、事件级粒度、写柄租约等基线事实。

以下保留 2026-11-09 架构导航与当时状态；当前源码/验证以各插件开发记录及新方案的现状核对为准。

更新：2026-11-09。当前阶段：**架构文档已交付，平台知识服务首批代码已编写待验证，整体迁移未完成**。本机单操作者免登录，复用DSH自主能力，首个业务插件为DM Listing。

## 现行设计（目标，不代表已实现）

1. [ADR-0001](adr/ADR-0001-DEVELOPMENT-AND-KNOWLEDGE-ARCHITECTURE.md)：用户新决策、旧条款替代与实际代码差距。
2. [平台总架构1.1](ENTERPRISE-PLATFORM-ARCHITECTURE.md)：公共项目/运行/知识服务与插件边界。
3. [Listing架构0.4](DSH-CLINICAL-ARCHITECTURE.md)：spec/ALS/SAS自主理解、R执行纠错、多工件QC和服务器单文件交付。
4. [平台项目经验知识库1.0](PLATFORM-EXPERIENCE-KNOWLEDGE.md)：按插件分类，shared/plugin/project作用域、自主捕获/验证/激活/撤回与快照。
5. [迁移与验收1.0](MIGRATION-AND-ACCEPTANCE.md)：文件级迁移、测试替换、数据保留与分阶段验收。
6. [开发交付状态](RELEASE-READINESS.md)：历史验证与当前未完成项，不是安全上线认证。
7. [上游基线](UPSTREAM-BASELINE.md)：固定源码与取得状态；不因本次文档更新改变上游代码。

## 最新明确范围

数据安全由IT源头及未来API承担；当前开发目标撤出插件自建读取/输出拦截，包括Cover名称限制、原值拒读、投影/内容审批和Hyper-V前置。API尚未接入，不宣称生产安全通过。保持格式/资源限额、错误/取消/超时、防误覆盖和真实QC等正确性要求。

平台统一管理经验库，插件贡献领域知识与验证器。Manual与Medical共用review核心，PK共同/BE/SAD-MAD分别分类；三项目历史方法不包含对新项目的默认阈值、OID或输出样式。Report不能借用三项目来源冒充成熟实证。

## 实际代码状态

旧demo/合成工程基线曾69项、类型与构建通过；后续经验文本、公共KnowledgeService首批schema/store/service、独立Cordis适配、Listing候选种子及打包接线已写，尚未编译/测试/构建。当前检索为Unicode子串、非FTS，推广/项目裁定/真实运行事件学习尚未完整接通。原安全拒读、投影/执行批准、旧UI/readiness仍在源码，归档未完成；项目级读取/开发与服务器复跑尚待实现。

最新一轮已修改知识服务相关源码和测试，但没有运行模型/R业务、删除任务数据或配置系统。验证命令均在执行前被工具服务阻止，不引用旧结果覆盖当前源码。接续见 [DEVELOPMENT](../plugins/dm-listing/DEVELOPMENT.md)。

## 历史材料

- [旧架构评审](ENTERPRISE-PLATFORM-ARCHITECTURE-REVIEW.md)：历史v0.2背景，不作当前合同。
- [旧投影设计说明](../plugins/dm-listing/PROJECTION.md)：已撤销为当前前置，代码待迁出。
- 旧目录 `deployment/local/`、插件 `src/protected/README.md` 的说明为迁移前历史，非当前开发前置；是否仍有代码见迁移清单，不据文档假称已归档。
