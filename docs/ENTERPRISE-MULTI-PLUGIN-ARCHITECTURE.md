# EMERALD 企业 DSH AI 平台：多插件架构设计

日期：2026-11-10。版本：设计修订 0.2。文档类型：架构参考。状态：已按[七项架构评审](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE-REVIEW.md)补齐设计合同，尚未实施或运行验证；不是百插件性能验收、生产数据批准或企业合规证明。用户授权本轮修订文档，不等于批准生产部署或宣布接口已稳定。

## 1. 目标与明确约束

平台面向企业内部员工，预计逐步承载几十到上百个 DSH 插件。Listing、DVP 是首批应用，不是平台结构的边界。品牌沿用 EMERALD CLINICAL TRIALS。

Listing 的员工业务类型严格为 **Manual、Medical、PK、Report** 四种。内部方法、历史项目标签和技术配置不自动成为业务入口。平台分类与应用内部业务类型分开。

员工应能找到适用应用、在项目中提供资料和要求、让 AI 自主工作、在必要时回答问题，并取得有来源与检查状态的成果。不能要求员工理解插件包名、工具名、模型参数或逐步点击推进 Agent。

平台自主维护前端与业务服务，通过版本化适配器接入 DSH；不依赖上游 DOM、私有 UI 组件或客户端状态格式。不重造 Agent 循环、模型客户端或 Cordis 插件加载器。上游更新应局限在已明确的兼容范围内，但不能承诺零影响。

插件数量不等于并发执行量，也不意味着每个插件一个服务。推荐先做模块化单体控制服务与独立执行进程，用真实负载再决定扩容与服务拆分。

## 2. 当前事实与设计增量

| 范围 | 当前核实到的事实 | 不可据此声称的能力 |
|---|---|---|
| 工作台原型 | [v3 脚本](../prototypes/enterprise-workbench/app.js) 仍有静态 APPS、领域条件分支、浏览器状态与预设回复 | 正式应用注册、服务端任务、真实 DSH 执行、多人授权 |
| Listing | [package](../plugins/dm-listing/package.json) 固定 DSH 0.2.2-rc.1，有工具/技能及上游 Web client contribution；[README](../plugins/dm-listing/README.md) 记载项目资料读取与验证结果 | 所有场景均完成真实项目交付与服务器验收 |
| DVP | [package](../plugins/dm-dvp/package.json) 固定同版 DSH；无专用 client contribution；[开发说明](../plugins/dm-dvp/DEVELOPMENT.md) 记录文本读取、规则、写出及候选边界 | 任意方案一键生成、OCR、全部 EDC 原生配置、已执行 UAT |
| 知识服务 | [service](../packages/platform-knowledge/src/service.ts) 已有贡献注册、检索、候选验证与版本机制 | 企业身份授权、跨进程知识 API、向量检索、完整项目学习自动化 |
| 任务能力 | [ListingService](../plugins/dm-listing/src/service.ts) 有合成工作区及修订/执行关联 | 可直接作为跨应用企业任务服务 |
| 依赖 | DVP 直接相对引用 Listing 的工作簿实现 | 独立发布、无跨插件源码耦合 |

[平台 1.1](ENTERPRISE-PLATFORM-ARCHITECTURE.md) 和旧 ADR 保留其历史/既定范围；其中部分实现状态已落后于当前代码。本文明确提出独立平台与规模化接入的目标，不自动启动旧数据库迁移，不据此改写既有业务授权。

## 3. 五个概念，不能混用

| 概念 | 定义 | 与其他对象的关系 |
|---|---|---|
| PluginPackage | 可发布的 DSH 技术插件包，提供工具、技能、知识、连接或运行能力 | 一个包可提供多个能力，也可不提供员工入口 |
| Capability | 有版本、输入输出和依赖的能力，例如规则诊断或工作簿读取 | 应用按需组合；不是所有能力都单独展示 |
| Application | 员工可发现和使用的业务应用，拥有工作方式及成果定义 | 可组合多个插件/能力；无需与包一一对应 |
| ApplicationRelease | 某应用可部署、可审计的不可变发布版本 | 绑定配置定义、前端贡献、后端映射和兼容运行集合 |
| RuntimeBundle | 一组明确版本的 DSH、插件、依赖和 profile 装配产物 | 可供多个兼容应用复用；并非每个应用一个常驻进程 |

例如：Listing 是一个应用，内部四种业务类型；DVP 是另一个应用。工作簿读取和知识检索是公共能力，不必出现在员工首页。应用可由一个主插件加多个公共插件组成，具体映射在发布清单中声明。

不要把三种清单合为一个：企业可发现的应用目录、服务器批准安装的插件清单、单次任务实际启用的能力集合，各有不同作用和授权。

## 4. 推荐总体结构

```text
员工浏览器                         管理员 / 插件开发者
  │                                      │
  └──────── EMERALD 独立前端 ──────────────┘
                          │ 平台 API + 事件订阅
            平台控制服务（模块化单体）
  身份/授权 │ 应用目录/发布 │ 项目/资料 │ 工作/运行
  问题/授权请求 │ 工件/检查 │ 经验知识 │ 审计/运营
             │                          │
        平台数据库/工件库          Runtime 调度与适配
                                        │
                            版本化 DSH Adapter
                                        │ 进程间协议
                            DSH worker / 执行域
                           固定 DSH + 批准的 Bundle
                           业务插件 + 公共能力插件
                                        │
                           数据接口 / 执行环境 / 存储
```

浏览器只访问平台 API，不持有 DSH 管理凭据，不直接连接引擎全权限接口。平台控制服务与 worker 分进程，即使首期都在同一台机器。

模块化单体不是所有任务共用一个无隔离进程。应用目录、项目、调度可以同一服务部署；执行代码的 worker 单独管理，可按真实资料隔离要求使用专用进程、容器或 VM。进程分离不是安全沙箱，正式环境必须验证操作系统权限、文件/网络边界及运行时约束。

## 5. 各层负责什么

### 5.1 平台负责

稳定导航、搜索/收藏/最近使用、项目与资料版本、应用启用与权限、工作和运行生命周期、人工交互、工件引用、检查证据、审计、调度、运行环境版本、成本/限额与错误展示。

共性机制不得出现业务分支。应用名称、示例、配置、结果列和业务阶段均从应用贡献读取；平台数据库可以保存 appId，不能保存靠 if listing 才能解释的通用字段。控制主服务仅运行平台维护的通用模块及纯数据 AppRegistration；不得 import 应用执行包来做资料正文解析、领域计算或验证。AppExecutor 失控只影响对应执行域，不能阻塞目录与项目查询。扩展运行位置和发布映射见[应用发布与执行合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)。

### 5.2 应用/业务插件负责

领域输入角色、必要参数与默认值、业务类型、说明/示例、专业编辑/查看面板、任务上下文组装、业务工具、验证器、成果类型和业务限制。复杂领域语义由代码和受控知识处理，不塞进应用目录 JSON。

应用可以采用 AI 对话、结构化表单、表格审阅、文件预览或组合工作区。不要把所有业务强制成一个大聊天框，也不要为每个应用复制项目选择器和任务列表。

### 5.3 DSH Adapter 负责

把平台的启动、补充、停止、人工回答、观察和恢复操作映射到锁定版本的 DSH 公开接口；处理协议错误、事件对照、会话关联与版本能力协商。不包含 Listing/DVP 语义，不绕过 DSH 原有权限机制。

### 5.4 DSH 负责

Agent 自主规划、模型调用、工具/技能机制、会话原始记录、执行与原生交互。模型路由与实际密钥由受控运行环境提供，不能每个业务插件自建一套 provider 或把密钥塞进应用清单/浏览器。

## 6. 员工体验：一百插件也不增加一百个入口

### 稳定导航

AI 工作区、项目空间、应用中心、工作记录、成果文件；管理入口仅对相应角色显示。导航数量不随插件数量线性增长。

### 应用中心

- 搜索支持业务名称、用途、关键词与别名；结果说明适用任务、输入、输出和可用状态。
- 收藏、最近使用、所在项目已启用优先；其余按经业务确认的分类浏览，不先虚构几十种分类。
- 返回目录前按身份与项目过滤；浏览器隐藏按钮不是授权。
- 缺依赖、停用、试用、维护中、无权限、可使用分别展示；不能把“包已安装”视为员工可使用。
- 目录分页/检索；专业前端模块进入工作区才加载，不在首页下载全部插件代码。

### 工作区

新工作先确定项目和应用；从应用中心进入时预选应用，近期应用可快捷打开，不展示上百个横向 tab。Listing 四类由其配置贡献渲染，不硬编码到平台外壳。

项目级目录和数据批次一次设置，工作绑定其版本快照；缺必要资料才提示。员工描述目标或填写少量应用必填参数；AI 自主处理，只有真正语义冲突、必要权限或业务判断才询问。输入完整不能成为不必要的草稿生成门槛。

进行中的工作切换应用应新建工作或显式创建子任务，不能悄悄更换工具集和知识上下文。一个工作可有多次 Run，不把每次重试当新的项目。

### 跨应用

首期用“从此成果发起另一应用”显式建立输入引用、权限与来源；不自动串接任意插件。后续如需工作流，用声明的输入/输出类型、版本与授权进行编排；AI 推荐应用不是运行授权，跨项目或对外副作用不能靠推荐自动执行。

## 7. 应用接入合同

以下是拟建设的平台合同，不是 DSH 现成 manifest 或已存在 API。

### 7.1 三份定义分开

1. **ApplicationDescriptor**：可存储、可检索的纯数据，描述应用展示、业务选项、输入/输出和兼容要求。不含密钥、任意 JS、SQL 或 shell 命令。
2. **ApplicationBinding**：分为控制端的纯数据 AppRegistration 与执行端 AppExecutor。AppRegistration 引用批准的执行计划、配置和结果合同，不导入领域可执行代码；AppExecutor 在相应锁定 worker 内负责领域上下文装配、命令、解析、验证与成果发现。旧稿的模糊名称 ServerBinding 不再作为实现合同。
3. **ViewContribution**：默认声明式配置/结果视图；必要时采用受控的专业前端模块，独立版本并绑定发布摘要。

### 7.2 Descriptor 建议字段

| 分组 | 字段与含义 |
|---|---|
| 身份 | descriptorVersion、appId、releaseVersion、displayName、owner、support |
| 发现 | summary、keywords、经业务确认的 categoryIds、iconAsset、locale |
| 工作方式 | interactionMode、inputRoles、optionsSchema、outputTypes、suggestions |
| 执行 | executorContractId、所需 capabilityIds、runtimeRequirements、resourceClass；具体提供者由发布时生成的 ExecutionPlan 锁定 |
| 显示 | viewContractVersion、声明式视图或 approvedViewId |
| 边界 | documentedLimitations、resultDiscipline、审核/检查语义 |

部署记录另保存 enabled、releaseChannel、授权分配、运行 bundle 选择、区域/组织限制等。发布包自己不能声明“所有员工已获授权”。项目字段与组织凭据也不放进全局 Descriptor。

### 7.3 Listing 示例

```json
{
  "descriptorVersion": "1",
  "appId": "ec.listing",
  "releaseVersion": "1.0.0",
  "displayName": "Listing 开发",
  "owner": "DM 应用团队",
  "interactionMode": "conversation-workspace",
  "executorContractId": "ec.listing.executor.v1",
  "requiredCapabilities": ["ec.listing.develop", "platform.resources", "platform.knowledge"],
  "optionsSchema": {
    "type": "object",
    "properties": {
      "listingType": {"type": "string", "enum": ["Manual", "Medical", "PK", "Report"]}
    },
    "required": ["listingType"],
    "additionalProperties": false
  },
  "inputRoles": ["listing-spec", "als", "data-batch"],
  "outputTypes": ["program/r", "dataset-output", "verification-evidence"],
  "viewContractVersion": "1",
  "resultDiscipline": "checks-and-review-are-independent"
}
```

此示例展示边界，不代表字段名已冻结、应用版本 1.0 已发布或所有输入始终必填。业务读取要求由当前任务和真实插件确定。

DVP 的 optionsSchema 不继承 Listing 类型。其输出可声明规则草稿、诊断、用例候选和 EDC 参考，候选语义不得被通用 UI 改成“已批准”。不假定全部目标 EDC 已原生适配。

### 7.4 发布解析与执行位置

requiredCapabilities 是目录层需求，不是运行时解析结果。每个批准应用发布绑定不可变 ExecutionPlan，明确能力版本到提供者包/版本/摘要、输入输出 schema、传递依赖与配置顺序的映射。冲突、缺依赖和不兼容在发布期拒绝；启动不允许 latest、未声明 fallback 或临时安装。控制服务只加载 AppRegistration 数据，AppExecutor 和领域验证代码只在受控执行域运行。字段、基线、home 所有权与验收见[应用发布与执行合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)。

## 8. 前端扩展与信任模型

默认优先使用有限的 JSON Schema 参数、通用文件/表格/诊断/结果组件，减少每个应用重复做壳。schema 只描述配置，不发展成一套可执行低代码引擎。

复杂工作面板通过 Platform UI SDK 接入：接收授权后的项目/工作上下文、资料引用、事件投影与受控命令；不直接操作数据库、访问 DSH transport、读取其他应用状态或拿平台凭据。

同源动态 JavaScript 拥有同源能力，TS 类型和 SDK 封装不是安全隔离。因此仅对内部审查、批准代码采用同源专业模块。对第三方或不同信任等级扩展，采用独立来源/受限 iframe 与消息白名单，或不允许前端代码进入。具体隔离协议应在确有需求时实现并测试，不能因为叫“插件”就宣称沙箱安全。

已下线/卸载的 view 不能使历史工作白屏：平台保留通用记录、原始成果引用和安全降级视图；特定编辑器缺失时只读并说明原因，不用新编辑器静默解释旧版本格式。

## 9. 平台后端模块与数据归属

| 模块 | 权威对象 | 不负责 |
|---|---|---|
| Catalog / Release | 应用定义、插件版本、发布、部署/分配、兼容矩阵 | 业务规则判断 |
| Identity / Policy | 人员、组、项目成员关系、动作授权 | 用前端显隐替代服务端授权 |
| Project / Resource | 项目、资料引用、版本、批次与工作区映射 | 根据文件名推断所有读取授权 |
| Work / Run | 工作目标、输入快照、运行尝试、事件投影 | 复制 DSH 全部会话数据库 |
| Interaction | 业务澄清、工具授权、计划审阅与业务复核请求 | 把不同问题都当“审批” |
| Artifact / Verification | 工件版本、来源、摘要、检查结果及复核记录 | 从模型文字宣告 PASS |
| Knowledge | 方法、项目裁定、来源、版本、验证与应用范围 | 取代当前需求或放大为跨项目授权 |
| Runtime / Adapter | 调度、资源限额、执行域、引擎接入与恢复 | 领域分支与模型循环 |
| Audit / Operations | 操作追踪、运行指标、故障诊断、保留/恢复 | 仅凭普通日志宣称不可篡改 |

建议对象关系：

```text
Project ─ ResourceRevision
   └ Work(projectId, goal；连续工作，不等同原生会话)
        ├ WorkInputRevision(resourceRefs, options, messages)
        ├ Run(appReleaseId, executionPlanDigest, runtimeLock,
        │      knowledgeSnapshot, initialInputRevision, cancelIntent)
        │    ├ RunInputCommit ─ 提交/入队/消费事实
        │    ├ LaunchAttempt(launchId, leaseEpoch, 进程树/退出证据)
        │    ├ EngineSessionBinding / EngineEventCursor
        │    ├ InteractionRequest(launchEpoch, 输入前缀)
        │    ├ ArtifactRevision(输入来源, 不可变内容) ─ VerificationReceipt
        │    └ PlatformEventProjection
        └ WorkLink / ChildWork（后续显式跨应用）
```

平台保存业务关系和可重建的展示投影；DSH 原始会话仍由其持久机制保存。平台保留 engineSessionId/执行域/日志位置与版本引用，不把 DSH session JSON 变成平台数据库 schema。流式 token 为临时显示，最终文本与运行结局以持久事件核对；断流不代表运行结束。

知识服务已有实现，但当前 plugin/project scope 过滤不是企业身份授权。中心从已鉴权上下文派生 scope，拥有唯一知识状态写入权；业务验证器在批准的独立 ValidationExecutor 内执行，不把现有 execute 函数跨 RPC 注册或 import 到控制主进程。请求与回执绑定候选、验证器、测试集和执行计划摘要，中心核验真实来源与完整覆盖后 CAS 激活。模型自报通过不能激活。单写入者迁移、版本并存及失败处理见[跨进程知识验证合同](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md)。

## 10. 启动一次工作的完整过程

1. 员工通过应用目录选择可用应用，在项目中提出要求。平台服务端重新核验身份、项目成员关系、应用启用和动作权限。
2. 服务端读取指定 ApplicationRelease，校验参数和资料引用。资料正文不是系统指令；不足时记录缺项，不把所有材料读取改成逐文件审批。
3. 创建 Work / Run 与不可变输入修订，使用幂等键防止重复提交；发布调度请求与数据库状态使用事务 outbox，避免“任务建了但消息没发”。
4. 读取发布时已确定的 ExecutionPlan，核对批准状态、提供者/依赖摘要、有效 profile 和执行策略；运行时不选择 latest 或按安装顺序解析冲突。预检资源、知识快照和执行授权。
5. 调度者以状态/commandSeq/leaseEpoch CAS 领取启动权，监督器 spawn 前登记 launchId。启动、初始化、发送业务输入分别复核取消与授权；启动结果不明进入对账，不再启动竞争进程。恢复同 Run 沿用原 session，重试新 Run 使用新 home/root session。
6. Adapter 订阅引擎的临时流和持久事件，映射成平台合同；浏览器只消费授权后的平台事件，不拿原始管理通道。
7. 业务澄清或授权请求产生独立 InteractionRequest，绑定 Run、原生 requestId 和输入修订。员工回答经服务端复验后转交；失效、取消、超时或旧版本回答不生效。
8. 受控插件/成果适配器登记文件，平台校验项目/运行归属、路径、摘要与来源，再呈现成果。模型说“文件已完成”不等于成果已登记或检查通过。
9. 引擎回合结束、Run 结束、业务检查及人工复核分别记录。运行终止须确认资源释放；结局未知保留 UNKNOWN，不猜测成功/取消。

后续变更不重写旧证据绑定的版本；只使其不再适用于新的输入/产物。Run.initialInputRevision 不变，追加说明记录为 RunInputCommit，并区分保存、入队和消费事实。首期普通补充先排平台队列，在受控结算点有序提交；问题/授权回答走独立原生通道。终态前原子冻结接纳范围并完成输入、后代、成果封存与进程退出屏障；完整规则见[运行生命周期合同](PLATFORM-RUN-LIFECYCLE-CONTRACT.md)。

## 11. 平台与引擎的拟定合同

以下为平台语义，具体映射由适配器实现；不是对上游方法名的承诺。

### Commands / Queries

- 目录：searchApplications、describeApplication、listProjectApplications。
- 工作：createWork、appendMessage、startRun、inspectRun、requestCancel、retryRun。
- 交互：listInteractionRequests、answerInteraction，明确 interactionKind。
- 成果：listArtifacts、readAuthorizedPreview、downloadArtifact、recordReview。
- 运行适配：probe、openSession、submitInput、observe、respondInteraction、cancel、reconcile、dispose。

请求至少包含协议版本、requestId/幂等键、上下文引用和期望修订；身份由服务端会话获得，不信任客户端声称的 owner。secret 使用引用传入受控运行环境，不进事件 payload 或应用清单。

### 事件信封

```json
{
  "contractVersion": "1",
  "eventId": "platform-event-id",
  "workId": "work-id",
  "runId": "run-id",
  "sequence": 18,
  "type": "interaction.requested",
  "source": {"kind": "dsh-adapter", "engineSessionId": "engine-session-id"},
  "payload": {"interactionId": "interaction-id", "kind": "business-question"}
}
```

事件按工作/运行有稳定 cursor；重复投递幂等处理，跨引擎不要求全局单序号。原始引擎日志序号、平台业务事件序号和临时 token 不混用。断线后从平台 cursor 补读，持久来源可以对账重建；事件保留不足时返回快照加新 cursor，不把丢失假装连续。

副作用无法靠 JSON-RPC 或事件去重取得普遍的 exactly-once 保证。数据库命令可实现幂等；外部执行、发送和覆盖必须有明确的副作用键、结果回执和未知结局处置。

### 状态与人工请求

Run：QUEUED / STARTING / RUNNING / WAITING_FOR_USER / FINALIZING / CANCELLING / SUCCEEDED / FAILED / CANCELLED / UNKNOWN。同一 Work 首期最多一个非终态 Run，UNKNOWN 不可自动重试。cancelRequested 与 commandSeq 持久化，排队/启动/完成竞争使用 CAS 和监督器 launchId 对账；无 PID 不证明已取消。新 Run 新 session，同 Run 恢复先确认旧进程已退出。状态转移、追加输入、截止水位与完成屏障由[运行合同](PLATFORM-RUN-LIFECYCLE-CONTRACT.md)定义；Work 业务状态与 Run 技术终态仍分离。

InteractionKind 至少区分 business-question、tool-authorization、plan-review、business-review。用户对一个问题的“确认”不能自动扩大到其他工具授权或正式业务审核。浏览器断开/worker 退出后原生问题可能已取消，必须重新对账，不能只因平台还有待办记录就继续回答旧 requestId。

## 12. 多插件装配、隔离与性能

### 目录不等于运行上下文

目录可有 100+ 插件，单次 Run 只采用发布时已解析并批准的依赖闭包，启动时只核对而不重新选择提供者。公共能力复用，不默认注册所有应用提示词、技能与工具。工具可见性控制不是安全边界；服务端调用授权、文件与进程权限仍需独立实施。

### RuntimeBundle 与 worker

运行集合锁定到可重现的完整版本组合。按 bundle、权限/资料执行域、运行时类型和资源等级选择 worker；不要每插件常驻一个进程，也不要所有不互信工作共用一个持有全项目凭据的进程。

首期建议一个活动执行租约独占一个 worker 实例，直到完成或确认清理。本地锁定 SDK 没有 per-session close / prompt-cancel：停止只能关闭整个运行时进程，不能让多个独立活动工作共用该进程后再假装可单独取消。进程树退出须由实际执行监督器确认；关闭等待、问题取消或浏览器断开都不是运行停止。

后续只有通过残留会话、文件、环境、凭据及子进程清理测试，才允许同执行域的兼容任务复用预热 worker。持久会话可以另存后重新启动兼容 worker 恢复，不等于持有同一进程永久运行。不将 prewarm、进程池或容器认作已实现能力。

插件清单变化优先新建 bundle / 新 worker，不对在途会话热装卸。必须区分 DSH 的技术热重载能力与企业发布策略。遇到依赖冲突，以不同 bundle 运行，而不是强行把所有包升级到同一版本。

### 企业执行基线

正式执行使用经批准的 sdk 装配，不直接采用默认配置。必须关闭模型端插件管理与原生 schedule 创建/自动唤醒，安装/配置由部署身份只写、执行身份只读；工作区正常编程能力仍保留。home 按 Run 身份隔离，不按 bundle 共用可写存储；恢复不自动激活无关历史会话。基线也约束原生跨 Run goal/parked 续跑，不能以普通工具授权扩大部署权限。禁用入口、漂移检查、恢复 inventory 和测试场景详见[发布合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)。

### 并发与资源

控制服务实施每用户/项目/应用并发、公平排队、最大等待时间、执行期限、CPU/内存/磁盘与模型预算；额度按实际业务配置，不按 100 插件硬猜 100 并发。原始日志和大型数据不直接放事件总线；使用授权文件引用，截断必须标记。

应用目录基础检索先用关系数据库索引和全文检索；没有实际需求不先上向量库、独立搜索集群、消息中间件或 Kubernetes。工作量扩大再独立队列/worker 及存储，不把应用目录搜索与知识语义检索混为一件事。

## 13. 安装、发布与升级

插件/应用分开维护生命周期：

- 包：导入 → 构建/依赖检查 → 安全与许可证检查 → 工程验证 → 批准分发。
- 应用版本：草稿 → 接入测试 → 业务验证范围登记 → 发布/分配 → 停用/下线。
- 运行集合：构建锁定 → 兼容检查 → 灰度 → 默认供新 Run 使用 → 排空旧 worker。

工程通过、包可分发、应用可见、业务验收、真实数据通道批准分别记录。现有插件 release manifest 的 CANDIDATE / productionDataEnabled / acceptance 等字段原样保留，不因为平台想上线就篡改其语义。

每次 Run 绑定 app release、ExecutionPlan、AppExecutor/view 摘要、Adapter、DSH/SDK、插件包摘要、依赖锁、配置版本和知识快照。普通升级只影响新工作或显式新 Run；在途工作留在原组合，恢复须找到兼容旧运行环境。安全撤权/紧急封禁不是普通排空：立即停止新准入，撤销执行访问并请求终止；结局不明保持 UNKNOWN，不因持有旧锁继续执行。具体约束见[发布合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)。

回滚是恢复新流量路由与可用运行组合，不自动降级数据库或重写已升级会话文件。DSH 已保存的会话格式可能单向迁移；升级前做备份与恢复演练，保留旧环境和明确退出路径，不宣称 session 在任意版本间可来回读。

卸载不删工作/知识/成果；先检查在途引用、依赖应用和保留策略，执行 drain。发现问题可禁用新启动并隔离故障应用，平台其他应用仍可发现与工作。

## 14. 权限、数据与企业部署

企业共享部署必须有企业身份（按实际 IT 合同接 SSO）、项目授权、应用动作授权、资料/工件授权、引擎执行域与审计。IT 对数据源安全的责任不能替代平台自己的身份与项目归属检查；平台检查也不等同于自建临床资料分类拒读。

一个应用的有效权限是用户权限、项目授权、应用批准能力与执行域限制的交集；模型或插件提出请求不能扩大权限。工具过滤/提示词不是唯一保护，插件作为宿主代码有高信任要求，不能任意让员工安装社区包进入批准运行环境。

现行插件业务边界按插件分别遵守。Listing 现有读取授权与 DVP 的 Cover、签署信息和评审内容约束不同；本文不将某一应用的规则推广全平台，不按旧总架构文字放开 DVP 的明确边界。

远程中心服务不能直接使用员工浏览器提交的 D:/ 路径。资料进入方式需按部署明确选择受控上传、IT 数据连接器、或员工本地受控 Agent；引用统一为 resourceId/revision，由 worker-side mount/provider 解析。当前原型的路径文本不是企业共享文件接入。

主服务只接收受控资源引用；下载、预览、搜索、事件订阅也做服务端授权。分享链接不能自动泄露工作区；对外发送、正式覆盖和发布是单独授权动作。遥测不默认上传资料正文或密钥。

### 存储建议

- 本机验证阶段：SQLite/本地工件目录，单实例拥有，维护备份及迁移版本。
- 企业共享阶段：关系数据库（建议 PostgreSQL）保存平台元数据，工件用 IT 批准的对象存储或文件服务；源系统资料不无授权全量复制。
- 任务/出站消息首期可用数据库队列 + outbox；需要多节点吞吐时再替换队列实现。
- 知识沿用已有服务抽象，是否迁移其持久层按并发与部署测试决定，不直接让容器共享 SQLite 网络盘。

是否适用 GxP、电子记录/签名和相应法规，由公司 QA/合规按用途定义。此设计不声称已提供合规电子签名或不可篡改审计。

## 15. 开发者接入流程与代码边界

推荐目标组织（按模块逐步创建，不一次建空包）：

```text
apps/enterprise-web/                 独立平台前端
apps/platform-server/                BFF 与控制模块装配
packages/platform-contracts/         平台协议/DTO/schema，不引用 DSH 类型
packages/platform-core/              Catalog / Project / Work / Run 等模块
packages/platform-ui-sdk/            受控页面贡献合同
packages/harness-adapter/            唯一的 DSH SDK/协议依赖层
packages/platform-knowledge/         复用现有领域知识核心
packages/clinical-workbook/          实际抽离后供多插件使用的读取能力
plugins/dm-listing/                  Listing 插件领域能力
plugins/dm-dvp/                      DVP 插件领域能力
applications/listing/                descriptor/registration + worker executor + view
applications/dvp/                    descriptor/registration + worker executor + view
runtime-bundles/                     固定版本 profile/依赖/发布锁
```

平台 UI/DTO 包不得 import DSH 或业务插件 src。插件间不得继续用跨目录相对 import 获取别人内部实现。DVP → Listing/workbook 应在保留行为与测试后抽出实际公共包；不是全量重写插件。

当前 TaskStore/CAS 和执行回执思路可复用，但 Listing 的合成 workspace 不能直接改名企业 WorkService。保留旧数据和 API，先以适配器桥接，再做有证据的迁移。

新应用开发者的交付清单：

1. 明确用户任务、输入、成果及真实业务类型，确认既有能力可复用。
2. 提供 Descriptor、纯数据 AppRegistration 与 Worker AppExecutor，发布时生成确定的 ExecutionPlan，声明依赖、限制与执行域。
3. 优先通用工作区；确需专用 UI 才提交前端贡献与兼容合同。
4. 提供合成夹具、正反/边界验证、失败恢复、事件/成果合同测试。
5. 形成不可变包与发布摘要、兼容矩阵、许可证和依赖清单。
6. 在隔离环境验收后分配给用户/项目；上线不需修改平台核心代码。

## 16. 实施顺序与验收

### 第一步：固定平台合同与 DSH 最小接入验证

只做真实纵向验证：固定版本 DSH、SDK 子进程、一个合成任务、消息/事件、人工问题、取消、重启恢复与成果引用。记录支持与不支持的能力；失败不能由预设回复遮掩。完成应用/插件/运行集合的对象定义和最小兼容矩阵。

### 第二步：应用注册与工作持久化

替换原型 APPS 与业务分支，建立服务端应用目录、配置贡献、工作/Run、资源版本及事件投影。用 Listing 和 DVP 的真实不同输入验证机制；Listing 保留四类，DVP 无 Listing 类型字段。

### 第三步：闭环两项真实应用

提供批准的 AppExecutor，接通资料引用、领域工具、人工交互和成果回执；知识中心与验证执行器按独立请求/回执合同衔接，不把进程内函数远程化。执行结果、技术检查、业务审核分开。在真实生产数据批准前采用合成资料进行集成验收。

### 第四步：验证扩展性而不是虚构业务应用

增加一个内部测试专用 probe 插件，验证无专用 UI 的能力、依赖复用、故障和不同输出，不作为员工正式产品。用 100–200 条合成目录记录测试搜索/权限/懒加载，但不冒充实际业务插件；并发测试用真实运行集合与明确资源配置，分别报告数量、吞吐和失败恢复。

### 第五步：多人部署与治理

接入企业身份、项目授权、数据接入合同、隔离执行与审计/备份；建立发布/回滚/排空流程。只有通过相应验证才报告企业共享部署可用，不将本地原型升格为生产系统。

### 必须通过的架构验收

七项评审的具体测试分别归属[应用发布 A01–A08](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)、[运行生命周期 R01–R12](PLATFORM-RUN-LIFECYCLE-CONTRACT.md)、[知识验证 K01–K08](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md)。以下仅为总体验收，不替代这些竞争、漂移与回执测试。全部状态仍为待实施、待运行验证。

| 验收项 | 通过条件 |
|---|---|
| 新应用接入 | 不改平台核心分支；注册、搜索、启动、交互和结果可用 |
| 业务分类 | Listing 恰好四类；应用内部选项不污染平台分类 |
| 按需装配 | Run 锁定依赖闭包，不向模型暴露整个平台百插件工具 |
| 权限隔离 | 未授权的搜索/执行/工件/事件均在服务端拒绝；worker 无跨域资料残留 |
| 重复/并发 | 重复提交不重复建 Run；租约冲突不并发覆盖；副作用未知不自动重做 |
| 人工交互 | 回答绑定 Run/原生请求，取消/过期/旧修订不生效 |
| 状态真实 | 引擎结束不冒充业务验收；缺证据保持未执行/未知 |
| 升级 | 一套兼容版本升级不改企业 UI；在途保留旧锁，新流量可回切 |
| 故障 | 单应用失败不使目录/其他应用不可用；断线和进程退出可对账 |
| 存储恢复 | 平台库、工件索引和 DSH 会话备份关系可实际恢复 |

## 17. 本轮不做的事

不修改 UI 或两个业务插件，不安装社区包，不启停真实业务运行，不接真实数据，不配置 SSO 或部署容器，不迁移现有数据库，不宣称架构建议已获最终实施批准。

不先造百个应用卡片、不先建设外部插件市场、不先重写 Agent、不先开发通用低代码/工作流系统、不要求每插件一个微服务。

## 18. 固定版本 DSH 接入核对

已只读核对本项目锁定源码中的 SDK client / server / protocol / sdk-app 文档，不能拿在线 master 的新接口覆盖此结论。推荐首条接入路线为 **平台 worker 使用官方 TypeScript SDK，驱动隔离的 DSH SDK 子进程，stdio newline JSON-RPC**；不先直连上游 Web UI 私有通道，不在平台 BFF 进程内嵌整个 DSH。不自行重写 SDK，除非正式发现它无法满足明确合同。

| 项目 | 锁定源码可确认的行为 | 平台处理 |
|---|---|---|
| 启动装配 | profile、patches、dshHome 等在进程启动时选择；SDK profile 关闭 HMR，但默认开放插件管理且有 schedule 恢复路径 | 采用企业批准装配，关闭插件管理及原生自动唤醒；按 Run 隔离 home，不承诺会话级热装插件 |
| 新工作/恢复 | session handle 与首次 prompt 可激活会话；恢复通过 resumeSession / session/resume，依赖原存储和工作区 | 平台 openSession 是自己的语义，不能映射到不存在的 session/create RPC |
| 输入回执 | session/prompt 返回入队 messageId，不是一次模型响应结果 | 平台记录提交状态；定义自己拥有的活动区间和完成条件 |
| 并发/完成 | high-level run 的 finalResponse 是所观察区间最后根文本，并非每 prompt 独占的响应 | 一个活动 Run 独占会话/进程；单派发器与 RunInputCommit 留痕，完成按 FINALIZING 屏障而非最后文本判断 |
| 通知 | session.event / session.status 等；运行时广播所有会话通知，SDK 树过滤发生在客户端 | Adapter 按绑定和来源授权过滤，不把客户端 filter 当租户隔离 |
| 流式显示 | 本 SDK 协议的通知集合未提供可直接承诺的每 token 流 | 首期保证已提交文本、工具和状态事件可见；逐 token 必须另验公开机制，不造假流式 |
| 人工问题 | user-question/ask 与 cancellation；onUserQuestion 回答，晚到回答可失效 | 对应平台业务问题/计划审阅，与工具授权分开 |
| 工具授权 | approval/request 可选启用；一次允许/拒绝/取消 | 处理器须在运行前就绪；失联和缺答案不能默认允许 |
| 停止 | 没有 per-session close 或 prompt-cancel，关闭整个 harness/进程停止运行时 | 独占活动 worker；CANCELLING 直到监督器确认退出，失败保持 UNKNOWN |
| 超时 | 停止本地等待或 observer 失败不回滚执行 | 查运行结局，禁止自动重复启动有副作用任务 |
| 恢复 | session/resume 不补发历史，外部 shell/browser 进程不恢复 | 独立读取原始持久日志重建投影；进程/外部副作用另对账 |
| 资料 |原生 SDK 内容块并非任意 PDF/XLSX 上传协议 | 平台 ResourceProvider/IT 数据连接器在 worker 侧解析引用，不把路径当已上传附件 |
| 通道与环境 | stdout 必须为协议；显式 env 会替换完整子环境 | 插件日志走 stderr；受控构造完整环境，不泄漏或意外丢失运行依赖 |

工具 restrict/guard 等为宿主插件/Agent scope 的公开机制，并非 SDK wire 上现成的“任意会话设置工具白名单”方法。平台发布的原生装配插件可在已核实扩展点上完成 scope 限制；具体接线需契约测试。插件本身是高信任宿主代码，不能靠工具筛选实现代码安全隔离。

本地依据：

- [SDK client：创建/恢复/结果语义](../upstream/deepseek-harness-git/packages/sdk/client/README.md:56)
- [SDK client：订阅与关闭](../upstream/deepseek-harness-git/packages/sdk/client/README.md:104)
- [SDK protocol：方法与广播](../upstream/deepseek-harness-git/packages/sdk/protocol/README.md:36)
- [SDK server：取消限制](../upstream/deepseek-harness-git/packages/sdk/server/README.md:209)
- [SDK profile：装配及重启限制](../upstream/deepseek-harness-git/packages/bundle/sdk-app/README.md:65)

## 19. 设计修订与剩余验证

修订 0.2 将评审的七项缺口落实到三份目标合同：应用发布（执行位置、确定映射、不可变基线与原生唤醒）、运行生命周期（取消竞争、追加输入、恢复与完成）、跨进程知识验证（执行与状态提交分离）。[评审报告的闭合表](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE-REVIEW.md)保留原问题并指向修订与验收编号。这里的“闭合”只指设计责任明确，不指代码已修复或测试已通过。

依据现有源码、插件 package/README/开发记录、平台知识服务，以及官方 SDK 文档索引。正式接入仍要用构建后的锁定运行时实际测试；只读核对不是运行验收。

官方参考：

- [SDK client README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)
- [SDK server](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/server)
- [Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)

待完成：真实协议契约测试、恢复/排空与进程树停止行为、专业 UI SDK 与租约/资源提供器实现。平台 API 与 manifest 字段需在最小接入验证后冻结为 v1，不能现在把概念示例当稳定发布接口。

2026-11-11 已完成最小真实接入验证（锁定 0.2.2-rc.1，sdk-minimal + 一次性 overlay，真实模型）：子进程 initialize、prompt 入队与最终响应、durable events/status、隔离 home 持久化、跨进程精确恢复、干净关闭全部实测通过；同时证实 sdk-minimal 只内置 deepseek-official adapter，provider 组合必须显式进入运行基线。事实与未覆盖边界见 [SDK-MINIMAL-INTEGRATION-VERIFICATION](SDK-MINIMAL-INTEGRATION-VERIFICATION.md)；该验证不构成本节及三份合同的任何验收项。

同日交付级验收套件（[SDK-INTEGRATION-ACCEPTANCE](SDK-INTEGRATION-ACCEPTANCE.md)）11/11 通过，覆盖工具执行、多轮、原生提问应答/取消、并发会话隔离、恢复拒绝（`already owned by an active write handle`，即引擎原生写柄租约，可直接支撑 §10 的 fencing epoch）、截断语义（`max-tokens` 且响应为空）与低层订阅排空；并证实 sdk-minimal 缺问答链路（tool-ask-user + user-questions 须成对入基线）、事件面无逐 token 粒度、danger-full-access 基线不触发审批。崩溃注入用例待执行；这些事实已列入发布/生命周期合同的基线增补项，但合同验收仍未执行。
