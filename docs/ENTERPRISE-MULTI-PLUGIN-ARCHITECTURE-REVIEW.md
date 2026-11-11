# EMERALD 多插件平台架构评审

日期：2026-11-10。本报告保留设计修订 0.2 之前的静态评审发现；原评审未修改方案或代码。随后已按用户要求修订架构，最新设计状态见下表，原问题不删除或改写为“运行已通过”。此处故障均是方案前提分析，不代表已发生生产事故。

## 设计修订闭合表（0.2）

| 原问题 | 设计修订位置 | 必须验收 | 当前结论 |
|---|---|---|---|
| 1 插件管理破坏运行锁 | [发布合同 §3](PLATFORM-APPLICATION-RELEASE-CONTRACT.md) | A03、A04 | 设计已明确，未实现/运行验证 |
| 2 ServerBinding 执行归属 | [发布合同 §1](PLATFORM-APPLICATION-RELEASE-CONTRACT.md) | A06 | 纯数据注册/Worker 执行已分离，未实现 |
| 3 知识验证跨进程 | [知识合同 §2–4](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md) | K01–K08 | 请求/执行/条件激活已明确，未实现 |
| 4 能力提供者解析 | [发布合同 §2](PLATFORM-APPLICATION-RELEASE-CONTRACT.md) | A01、A02 | 发布期确定映射，未实现 |
| 5 原生定时唤醒 | [发布合同 §3–4](PLATFORM-APPLICATION-RELEASE-CONTRACT.md) | A05 | 禁用创建与自动激活/home 归属已明确，待SDK装配验证 |
| 6 取消与启动竞争 | [运行合同 §3–4](PLATFORM-RUN-LIFECYCLE-CONTRACT.md) | R02–R05、R12 | 持久意图、准入CAS、launchId监督已定义，未实现 |
| 7 追加输入与完成边界 | [运行合同 §1–2、§5–6](PLATFORM-RUN-LIFECYCLE-CONTRACT.md) | R01、R06–R11 | 来源流水、完成屏障、会话归属已定义，待协议验证 |

本轮没有改 UI、DSH profile、业务插件或数据库。下面的评审结论与行号指原评审时的文本，不能据历史行号推断当前行内容；以条款名称及闭合表为准。


## 原评审结论（修订前）

建议保留独立平台、应用/能力/插件分离、按需装配、受控执行与版本化接入方向；当前方案不能直接冻结为实施合同。主要缺口集中在代码执行归属、运行集合不可变的实际约束、跨进程知识验证，以及能力到包的确定性解析。

“几十至上百个插件”首先要求注册、发现、确定性装配和治理，不要求每个插件常驻一个进程或立刻拆微服务。平台第一期应避免把所有规划模块一次做全；先闭合经过评审的最小纵向合同。

严重程度：**P1** 为首个正式集成前必须明确的决策或约束；**P2** 为发布接入协议前应补齐的合同。并非以缺少未来代码本身作为缺陷。

## 1. P1：锁定运行集合，但默认 SDK 仍提供运行期插件管理

**位置：**[§12 按需装配与运行集合](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:271)、[§13 版本锁](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:299)、[§18 SDK 接入](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:404)。

**具体前提与影响：**按方案直接使用官方 sdk profile，平台为常规工具提供授权回答器；该 profile 默认启用 plugin_manager。模型请求安装、升级、停用或修改插件，如果被泛化授权通道放行，会改写持久 profile。当前进程可能暂不变，但下次重启/恢复会读取已变化的组合；Run 的 runtimeLock 不再能证明实际运行代码。仅禁用 HMR 无法阻止这种变化。

**证据：**[sdk-app patch](../upstream/deepseek-harness-git/packages/bundle/sdk-app/cordis.patch.yml:23) 禁用 HMR，却启用 tool-plugin-manager；[管理器 README](../upstream/deepseek-harness-git/packages/boot/plugin-manager/README.md:31) 明确配置变更持久化、重启生效及宿主代码信任范围。此问题存在被工具授权放行的前提，不是默认必然静默安装。

**建议修订：**企业执行 profile 必须明确关闭模型可调用的插件管理入口；安装/升级仅由发布流程完成。运行时包、配置与依赖来源受部署写权限约束，session/缓存目录分离。启动时核对已批准的装配摘要，漂移拒绝接单；SDK profile 的完整工具清单纳入准入测试。不能只隐藏界面或依赖员工每次拒绝。

**验收：**普通运行不存在可用的插件管理工具；修改安装配置会被启动核对发现；新 Run 恢复不能加载未批准包。

## 2. P1：ServerBinding 执行在哪里尚未定义，可能把业务代码带进控制主服务

**位置：**[§7.1 ServerBinding](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:125)、[§5.1 平台边界](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:74)、[§15 applications 目录](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:341)。

**具体前提与影响：**方案把“上下文装配、领域命令、验证器、成果发现”放进已安装服务端 Binding，却未指定运行进程。如果平台 server import 每个 Binding 执行业务解析/验证，损坏文件引发的大内存、阻塞、异常或额外依赖就绕开了 worker 隔离。新增上百个应用还会把发布与进程依赖重新耦合回控制服务。

**建议修订：**把接入分为控制端的静态 AppRegistration 与执行端 AppExecutor。控制端只做经过 schema 校验的数据登记、授权、路由和通用状态；领域代码、资料正文处理、验证器和成果发现放在相应锁定 worker 中。平台接收类型化结果，仍独立核验资源归属和工件摘要。确有必须在控制端运行的内部扩展，另建受限清单与资源/故障策略，不允许默认为任意包 import。

**验收：**测试应用的执行端发生异常/阻塞，只使对应 Run 失败，不影响应用目录、项目查询或其他 worker；接入常规应用不增加平台主服务的领域运行依赖。

## 3. P1：集中知识服务与现有进程内验证器注册不兼容

**位置：**[§9 集中知识服务](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:212)、[§15 复用现有知识核心](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:337)。

**具体前提与影响：**现有插件在 apply 中向 clinicalKnowledge 注册带 execute 函数的验证器。新设计把知识数据库放到中心服务、业务插件放到独占 worker：函数不能按 JSON-RPC 原样远程注册；插件运行在旧版本，中心若加载新版本验证器，还可能用错误代码证明旧运行的方法。直接把全部验证器加载进中心进程，又重现第 2 项的故障耦合；为每 worker 复制知识库则产生学习分裂。

**证据：**[DVP 注册](../plugins/dm-dvp/src/index.ts:62)、[可执行验证器](../plugins/dm-dvp/src/knowledge-validators.ts:21)、[KnowledgeService.registerValidator](../packages/platform-knowledge/src/service.ts:20) 及 [validate](../packages/platform-knowledge/src/service.ts:105) 都是进程内代码调用。

**建议修订：**中心拥有知识版本、状态、验证派发与条件提交；领域验证在固定版本验证执行器运行。请求绑定 candidate digest、validator artifact digest/version、case digest、运行集合与授权上下文。中心只接受已登记执行器的实际回执，并核验候选修订未变后激活，不接受模型提交 passed=true。种子导入/分类贡献保留为纯数据注册；现有单机服务可继续使用，跨进程需新的适配实现和测试，而不是函数直接搬运。

**验收：**并存两个应用版本时使用各自锁定验证器；未知执行器/旧候选回执不得激活；相同验证幂等、失败保持候选，项目裁定不自动跨项目。

## 4. P2：Capability 只有名称，缺少可确定解析的提供者及兼容合同

**位置：**[§3 Capability](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:35)、[§7 描述字段](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:135)、[§10 依赖解析](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:219)。

**具体前提与影响：**两个插件都提供同名能力，或公共读取能力升级后输出 schema 不兼容，当前 requiredCapabilities 的字符串不能决定选哪个 provider、哪个版本、其传递依赖是什么。到了装配时才用安装顺序/最新版本解决，会使相同应用发布在不同服务器运行不同代码，甚至误用输出结构。

**建议修订：**v1 不先造通用动态包求解器。每个批准 ApplicationRelease 绑定一份离线解析好的 ExecutionPlan：capabilityId/version → provider package/version/digest、协议/输入输出 schemaVersion、依赖闭包、配置贡献及所用 RuntimeBundle。目录显示的宽泛要求可以保留，但实际启动只接受已验证的确定映射。缺失、冲突、循环或不兼容在发布预检失败；无隐式 latest、无未声明 fallback。

**验收：**给定同一发布摘要，在两台干净环境得到相同能力映射；冲突和缺依赖在发布期报具体错误，不到员工提交后才发现。

## 5. P1：原生定时唤醒可能绕过平台的运行准入

**位置：**[§10 启动/恢复](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:220)、[§12 独占 worker](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:277)、[§18 profile 接入](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:408)。

**具体前提与影响：**默认 sdk profile 提供 schedule 工具；如果复用 home 中保存了原生提醒，启动 worker 并成功初始化后，到期提醒可自行恢复会话，不等平台显式 startRun/resumeSession。按 bundle 共用 home 时，可能激活不属于当前租约的历史工作；即使独占当前会话，也会出现未绑定平台运行授权的新输入。过滤通知不能阻止已经启动的工具执行。

**证据：**[SDK server](../upstream/deepseek-harness-git/packages/sdk/server/README.md:34) 明确初始化后自动恢复到期提醒；[sdk-app](../upstream/deepseek-harness-git/packages/bundle/sdk-app/README.md:51) 包含 schedule 工具。

**建议修订：**首期关闭原生 schedule 创建和自动恢复入口，运行 home 明确绑定工作身份与允许恢复会话集合。以后真需要定时能力时，由平台调度先取得授权和 Run 租约，再激活引擎，不能两套调度各自启动。恢复历史 home 前清点/隔离旧提醒，不只是隐藏新建工具。

**验收：**带到期提醒的历史存储不能在无平台租约时执行；home 内其他会话不得随初始化自动工作。

## 6. P1：排队/启动中的取消与 dispatch 没有竞争协议

**位置：**[§10 outbox 与租约](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:218)、[状态表](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:263)。

**具体前提与影响：**启动请求已在 outbox，员工在消费者收到前取消；或取消发生在子进程已创建而 session binding 尚未写入的 STARTING 窗口。取消方查不到 PID，迟到消费者仍可启动；只写 CANCELLED 或只终止已知 PID，会造成取消后启动或孤儿进程。文档已有 fencing token，但未定义它如何撤销尚未消费的启动权。

**建议修订：**持久保存 cancelRequested 与命令序号；dispatch、spawn、接管和恢复均用期望状态、租约/fencing token 做准入 CAS。监督器在 spawn 前登记 launchId，负责对账/清理尚未绑定的进程。取消不能因暂时无 PID 就成功；明确取消与 dispatch/start/finish 的转移与获胜规则。

**验收：**覆盖取消早于 dispatch、spawn 中取消、完成与取消竞争、监督器崩溃后接管；任何分支不能重复执行或遗留无主进程。

## 7. P2：持续沟通缺少实际输入来源链，Run 与 Session 的结束边界尚未选定

**位置：**[对象关系](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:198)、[追加说明](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:226)、[SDK 观察区间](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md:411)。

**具体前提与影响：**Run 只绑定一个 inputRevision，但允许运行中补充 V2 要求。模型消费 V2 后生成结果，若仍只绑定 V1，来源遗漏；把 Run 指针改成 V2，又会使 V2 到达前的文件/人工问题错误归属新要求。同时 high-level run 返回根 idle 不等于受管后代已完成；过早释放 worker 会截断产物，继续保留又可能在 Run 终态后执行旧队列。

**证据：**[SDK client](../upstream/deepseek-harness-git/packages/sdk/client/README.md:98) 明确观察区间可能重叠；[session/wait](../upstream/deepseek-harness-git/packages/sdk/server/README.md:78) 等待受管后代，但 parked inbox 不阻塞返回。它们都不是“每个用户消息各自产生一个独占结果”的保证。

**建议修订：**保留 Run.initialInputRevision，另建不可变 RunInputCommit 流，绑定平台提交、修订、原生 messageId、入队/消费/未知事实和引擎事件前缀；不能从 enqueue 回执推断已消费。工件与人工请求关联明确的适用输入前缀；无法确认时标注未知。首期允许持续沟通，但活动运行追加先作为排队输入；不能同时启动多个高层 run 去争同一会话。

明确采用：恢复同一次 Run 保留原 session；新 Run 默认新 session，由平台装配已批准的工作上下文。若以后要跨 Run 复用持久 session，单独定义旧队列/goal/权限/工具上下文继承政策。终结需输入结算、受管后代、成果登记与清理屏障，不以根 idle 或最后文本单独判定成功；未完成 parked 输入必须显式保留为未执行、丢弃或转下一次工作，不能静默跨界。

**验收：**运行中补充但未消费、消费后产物、后代晚结束、Run 完成后补充、同 Run 崩溃恢复及新 Run 重试均能说明来源和状态，不错误报完成。

## 推荐保留的决策

- 平台前端、业务 DTO 与 DSH 类型分离，不重新实现 Agent。
- 应用目录不等于所有模型上下文，插件不等于员工应用。
- Listing 仅四类；应用内部选项不成为全平台分类。
- 复杂业务可以有专业工作面板，不强制统一成聊天框。
- 平台记录事实，不从模型最后一条文本推断业务成功。
- 首期小而完整的控制服务 + 受控 worker，不先为每插件拆微服务。

## 尚需明确，但本轮不扩大为实现任务

- 组织共享部署的数据进入方式：本机路径不能直接成为服务器资源，选择应依据 IT 数据合同与实际使用环境。
- 在途任务的撤权策略：正常版本升级可排空，安全/人员撤权需另行明确立即中止、凭据失效和已落地资料处置，不能一律继续跑旧锁。
- 自然语言帮助选择应用可以先只推荐并让员工确认，不要求员工掌握所有插件名称；不能用自动识别扩大执行授权。
- 专业视图的同源代码只接纳批准内部模块；跨信任隔离不列为首期必做的大平台工程。

## 原评审边界

原评审没有修改原架构、前端、插件或运行配置，也没有执行插件测试、安装依赖或真实 DSH 任务。后续修订仅更新架构与合同文档，执行了文档引用/示例静态检查；两阶段均不构成运行验收。设计修订后的状态以顶部闭合表为准。
