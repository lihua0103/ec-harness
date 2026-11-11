# 架构与开发文档导航

企业级开发规范：[DSH 插件开发规范 v1.0](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)——**当前系统及所有后续开发必须遵守**，不设存量豁免，不为错误实现保留兼容层；不符合项须修正或重做并通过对应检查。规范唯一维护于该正文。

## 2026-11-11 整改现状（代码优先）

[整改记录](REMEDIATION-2026-11-11.md)记录本轮已修复与实测：PDF ObjStm/页数完整性、DVP 真分页、
知识 claims 激活语义、公共包抽离（platform-workbook / platform-knowledge / platform-runtime）、
两插件独立装配与全量测试。Listing 70/70、DVP 68/68 测试通过；平台运行包 7/7、控制面 17/17 通过。
这些是代码与单元测试事实，**不是** DSH 宿主集成、企业身份/数据接口、工作台原型或临床业务验收。

仍未完成：企业身份授权与 IT 数据入口、Worker 执行器与进程监督、成果登记/调度、工作台真实执行、
真实项目端到端验收、统一 Git/CI。工程边界见[开发规范](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)。

**2026-11-11 继续推进**：[平台控制面首批实现](PLATFORM-CONTROL-IMPLEMENTATION.md)已登记应用发布、持久运行/
事件/审计并按 DSH bundle 安装；Worker 执行器按 [ADR-0002](adr/ADR-0002-WORKER-EXECUTOR.md) 使用
DSH profile/SDK，默认未配置，配置后可通过 SDK client 执行并登记产物。进程监督与调度仍未完成。

## 多插件企业平台方案（2026-11-10）

[EMERALD 多插件架构设计](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md)已按七项评审修订为设计 0.2，面向几十至上百插件。Listing 员工业务类型仅 Manual、Medical、PK、Report；各合同均尚未实现/运行验收。

- [企业身份与数据入口契约](ENTERPRISE-IDENTITY-AND-DATA-CONTRACT.md)：Principal 派生、项目数据授权、撤权语义与 I01–I05 验收；`packages/platform-identity` 已实现解析规则（7 项测试），真实 SSO/项目 API 仍待 IT 对接。
- 代码托管：外层工作区已建立 Git 基线；`.github/workflows/verify.yml` 守卫通道随 push/PR 执行规范检查，完整构建/测试通道需托管后手动验证。

- [应用发布与执行合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)：AppRegistration/AppExecutor、确定性能力映射、不可变运行基线和 home 隔离。
- [工作与运行生命周期合同](PLATFORM-RUN-LIFECYCLE-CONTRACT.md)：取消竞争、追加消息来源、完成屏障和同 Run 恢复/新 Run 重试。
- [跨进程知识验证合同](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md)：中心状态、固定验证执行器与回执条件激活。
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
