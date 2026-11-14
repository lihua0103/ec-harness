# 企业工作台与 DeepSeek Harness 二次开发整改补充方案

日期：2026-11-11。版本：1.0。状态：设计补充，待实施与验证；不是接口已完成、生产批准或全球部署声明。

关联主方案：[企业级 DSH 平台与两插件整改实施方案](ENTERPRISE-REMEDIATION-PLAN-2026-11-11.md)，尤其 WP4、WP5、WP7、WP8 与 U07–U14。本文件专门澄清产品定位、工作台体验与 DSH 接入边界；如主方案的概括性表述与本文件的明确合同冲突，以本文件为工作台/模型集成的后续设计基准，再由维护者合并更新主方案。现阶段不得据此推定实现状态已变化。

## 1. 产品定位：Harness 原生智能体平台的企业化二次开发

EMERALD 是基于 DeepSeek Harness（以下简称 DSH）二次开发的国际化企业智能体平台。DSH 是核心 Agent 运行底座，不是可随意替换的后台模型 API；平台围绕 DSH 构建面向员工的业务工作台、应用目录、模型选择、项目上下文、运行恢复、治理和成果体验。

平台必须继续使用 DSH 锁定版本所提供的 profile、SDK、Agent 循环、Session、工具/Skill、子智能体和 LLM Adapter 机制。**不另写 Agent loop，不在平台控制服务中实现第二套模型客户端，不通过手工改 prompt 冒充模型切换，不以浏览器直接调用供应方 API 替代 DSH。** 平台工作台是员工的一站式入口；不要求普通用户安装插件、配置密钥或了解 provider/model ID。

> **2026-11-12 路线修订**：原"DSH 原生界面/会话仅保留为专家诊断或辅助入口"的定位已由 [ADR-0003](adr/ADR-0003-NATIVE-WEBUI-WORKBENCH.md) 取代。原生 WebUI 现在是正式交互底座，企业导航/上下文/成果经原生 slots 与平台能力进入；企业身份、安全与业务边界不变。实施以 [原生 WebUI 与企业工作台实施任务书](NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md) 与 `docs/native-workbench/` 为准。

国际化智能体平台是产品方向，不代表当前已经支持所有地区、语言、供应方或监管制度。部署区域、数据驻留、跨境传输、语言清单与供应商批准需由产品、IT、业务和合规分别确认。

## 2. 设计先导：本项目专属视觉与布局

本段是设计系统与可测试原型的方向，不是未评审品牌终稿。延续已确认的 EMERALD 品牌，不把全局 AI 平台伪装成临床业务软件，也不使用默认 SaaS 卡片墙。

### 2.1 紧凑设计 Token

| 角色 | 建议值 | 用途 |
|---|---|---|
| 深海青 `#004B61` | 品牌与持久导航 | 品牌锚点、导航选中态、主要结构 |
| 翡翠 `#008A72` | 关键行动 | 新建工作、发送/运行、明确可执行的主要 CTA |
| 雾白 `#F5F8F7` | 工作底色 | 长时阅读画布与表格周边留白 |
| 石墨 `#182522` | 正文 | 高对比长文本与标题，不以纯黑大面积铺底 |
| 琥珀 `#A65B12` | 注意/等待 | 等待用户、预算提示、需要查看的状态；不代替错误红 |
| 状态红 `#B42318` | 错误/危险操作 | 真实失败、撤销前确认、不可恢复风险 |

正式色值、暗色主题和状态颜色需用对比度工具验证后纳入 token；颜色不能是唯一状态信息。字体使用系统可用的国际 sans 字体栈，优先保证中英混排、长名称、数字和代码易读；不得依赖未许可或不可用的远端字体。标题采用左对齐、句式大小写与清晰字级；正文限长行，代码/模型 ID 使用易辨读的等宽字形但不把整个界面做成开发终端。

### 2.2 两种布局候选及建议

**建议主路线：工作画布优先。** 入口先问“你要完成什么工作？”，用户可用自然语言描述目标；当前项目/资料与运行成果在可收合的上下文栏中，工作主区保留连续的 Agent 会话、进度、引用和待办。应用/Agent 与模型控制器在开始前、且在执行期间可见；组织策略不允许的项目或模型由服务端真实拒绝。

```text
┌ EMERALD ─ 工作区 ─ 智能体 ─ 项目 ─ 我的工作 ─ 成果 ───────────────┐
│ 新建工作：描述目标……       [选择智能体] [DeepSeek · 模型选择]     │
├───────────────────────────────────────────────┬────────────────┤
│                                               │ 项目 / 资料     │
│          Agent 对话与协作工作画布              │ 当前任务       │
│          进度、来源、问题与响应                 │ 产物 / 检查     │
│                                               │ 可收合          │
│ [写消息或补充要求……                    发送]   │                │
└───────────────────────────────────────────────┴────────────────┘
```

**替代路线：任务入口优先。** 首页采用工作列表/收件箱，进入某项后展开相同的三栏工作区。适合管理多个待办和长任务；缺点是新用户从空白开始时较难发现平台能力，因而只作为有大量存量工作的返回首页候选，不作为全局主画布默认。

两种布局都采用左对齐与稳定导航，不用居中 hero、统计 KPI 行、装饰渐变、所有内容等尺寸圆角卡片或全 caps 标签。一个主画布承担注意力；项目上下文可收起，窄视口切成抽屉/标签而不是缩成三栏。要让员工能用自然语言启动，又能在需要时检查 DSH 正在做什么。

### 2.3 设计原则

- 显著但克制的模型选择器是工作入口的一部分，不是设置页面深处的工程字段。
- 视觉系统围绕“人和智能体在同一项工作中协作”展开：工作目标、Agent 当前状态、资料来源与成果版本形成连贯层级。
- 一个主要动作对应一个明确结果，如“开始工作”“发送补充”“停止运行”“下载成果”；按钮名称和完成反馈保持一致。
- 状态用文字、图标与结构表达；UNKNOWN、失败、等待、已交付和已审核不可只靠颜色或一个“完成”勾号区分。
- 空状态给真实的下一步；错误明确指出影响对象、可恢复动作与是否需要管理员协助；不说“抱歉”或只展示内部异常栈。
- 动效仅反馈用户操作或状态变化；尊重 reduced-motion。键盘可见焦点、语义标签、屏幕阅读器可读名称和触摸目标是基线。
- 本地化从组件和数据模型起步：不拼接硬编码文案，日期/数字/时区使用 locale 格式化，布局支持扩展文本；RTL 是否纳入首批由产品确认后作为正式验收范围。

## 3. 内置模型目录与选择体验

### 3.1 员工体验

1. 每位用户可在工作台查看**平台已接入并对其组织/项目可用**的模型，无需自行提供 API Key。供应方接入、凭据、区域策略和模型启停属于管理员/部署配置。
2. 在开始一个新 Run 前，用户可沿用个人偏好或从平台目录选模型。选择器显示可理解名称、供应方、适用能力、经核实的输入模态/上下文/输出限制、可用状态及信息来源标记；未验证数据写“未知”或“未验证”，不编造性能排行、价格或 benchmark。
3. 用户可在应用默认建议与平台允许的目录项之间主动选择；建议说明依据且可更改。设置页的“默认模型”只控制偏好，不取代新 Run 选择；工作区清楚显示本次 Run 将使用的模型。
4. 创建 Run 时锁定完整模型路由快照。对同一 Run 不允许 UI 切换而暗中改变已发出的模型请求；后续 Run 可选择新模型。失败、配额/凭据失效或路由撤销时明确说明，不无提示 fallback；若由 DSH/adapter 的显式重试策略重试同一请求，保留相同逻辑 route 并记录各次尝试，不改写为另一个模型。
5. 模型目录分组/筛选只帮助发现，不暴露密钥，也不让用户输入任意 provider、URL、endpoint 或模型路由。对不可用项可按产品研究选择隐藏或显示禁用原因；被策略禁止的模型 ID 不得通过 API 枚举。

### 3.2 平台服务职责和配置对象

平台拥有经部署审定的 `ModelCatalog`、服务端 `ModelAvailability`、用户 `ModelPreference`、Run `ModelConfigSnapshot`。目录数据来源为锁定 RuntimeBundle/profile 中实际装配的 DSH adapter/模型目录及平台审核过的元数据；服务端按身份、组织、项目、区域与部署策略过滤，而不是信任前端目录。供应方声明的元数据、DSH adapter 报告的数据与平台验证结论分别标记。

用户选择映射到平台签发的 opaque `modelSelectionId`/可验证的目录项，并在服务端解析为 DSH 允许的 provider、model 和 adapter 支持的可选参数（如 reasoning effort）；客户端直接提交 provider/model 字符串不得成为路由授权。Run 快照至少记录 provider route、model ID、adapter/profile/runtime 版本、允许的调用参数策略、模型能力元数据版本及非秘密 credential reference/version、区域/策略版本和目录快照摘要。凭据仅经受控 secretRef 在 Worker 内注入；密钥本体不得进入浏览器、提示词、普通 Run 投影、审计正文或日志。

平台目录/API 的缓存须能处理 adapter 发布的模型目录更新；Run 创建时重新服务端校验 availability，防止前端 stale cache 绕过撤权。目录 metadata 缺失并不授权猜测其支持图片/工具/上下文。模型配置与 DSH profile 的版本组合属于 RuntimeBundle 发布事实，不能在任务执行中动态安装插件或从网络下载任意 provider。

## 4. 基于锁定 DSH 的实现接入设计

### 4.1 上游可用能力（锁定基线）

本项目锁定 DSH `0.2.2-rc.1`，upstream commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`；API 仍属预稳定。实施时仍需按源码和 profile 的实际版本做契约测试。

| DSH 能力 | 已核对的上游契约 | 平台映射/约束 |
|---|---|---|
| 运行底座 | `@deepseek-ai/dsh-sdk-client` 通过 SDK profile 启动完整 Harness runtime；profile 组合必须包含 SDK 应用/JSON-RPC server | 由独立受控 Worker 启动，不由浏览器启动/控制 Harness 全权限接口 |
| Provider/model 启动选择 | `DeepSeekHarness` 选项有 `profile`、`provider`、`model`、可选 `reasoningEffort`、`maxTokens`；启动握手检验精确 route | 平台 Run 解析并传入批准配置；不能认为只有默认 DeepSeek 模型，也不能把任意字符串直接透传 |
| Provider 与模型目录 | DSH `ctx.llm.listProviders()`、`listModels(provider)`、`resolveModelInfo(provider, model)`；adapter 可通过 `registerAdapter()` 注册 route，并实现模型发现 | 目录由部署/平台 adapter 组合支撑；平台过滤、审计、用户友好解释仍需实现。没有 adapter/model discovery 证据的项不展示为可选 |
| Session 模型变更 | Runtime Agent 可记录选择并作用于后续步骤；Host 有 `session.selectModel`，且会后台保存默认选择；SDK stdio 没有模型列表/热切换 RPC，`/model` 不是该 SDK 命令 | 首期采用 Run 级固定路由，以新 Run 应用新选择。Host API 不是 SDK API，不得直接复用其修改默认值的副作用作为企业用户偏好实现 |
| 运行与观察 | SDK 支持 Session、输入、持久事件通知、`resumeSession(id)` 与 `close()`；`session(id)` 不是持久恢复。恢复时当前 initialize 路由会覆盖恢复会话的模型选择，不恢复 shell/browser 等外部进程 | 恢复必须重用原 Run 模型快照，先验证原执行退出与接管条件。事件级更新不等于逐 token 流；未实现实时 token 通道时展示真实活动/消息，不用打字动画伪造流式推理 |
| 人工交互 | SDK 支持 `onUserQuestion` 问题回调；`approvalRequests` 与 `client.onRequest()` 是单独的工具/系统审批通道 | 业务澄清、DSH 原生批准、平台业务审核分开映射；不得把“回答问题”当成权限批准，也不得将模型选择变成授权 |
| 取消/关闭 | 锁定 SDK 的 `run()` 没有 `signal` 参数，也没有 prompt-cancel / per-session-close RPC；`close()` 关闭所属 runtime，超时/停止本地等待不等于终止执行 | 平台取消/超时必须主动触发并等待关闭及 supervisor 结算；不能给本地包装器加 `signal` 后宣称 SDK 已处理取消，退出证据不足记 UNKNOWN |

契约出处：`upstream/deepseek-harness-git/packages/sdk/client/README.zh.md`、`packages/sdk/client/src/types.ts`、`packages/sdk/client/src/api.ts`、`packages/llm/llm/README.md`、对应锁定源码 commit。完整调用参数、SDK 子进程所有权和 profile 装配限制以锁定源码/类型及本项目 [ADR-0002](adr/ADR-0002-WORKER-EXECUTOR.md) 为准。不得以在线最新 master 页面替代这条基线。

### 4.2 平台 → Worker → DSH 数据流

```text
工作台：用户选择智能体 + 平台目录 modelSelectionId + 项目/目标
    │ HTTPS/BFF：可信 Principal、项目授权、幂等键、expectedRevision
平台控制面：解析 modelSelectionId → 验证目录/区域/凭据/发布策略
    │ 原子保存 Work/InputRevision + Run + ModelConfigSnapshot + Outbox
Worker Supervisor：CAS/epoch/取消复核 → 启动隔离工作区与批准 profile
    │ SDK Initialize(provider, model, approved options, cwd)
DSH Worker：Agent loop、Session、工具/Skill、adapter、后代协作
    │ DSH notifications / session events / controlled question & approval
平台适配器：事件映射、持久水位、取消与进程结算、产物登记
    │ 授权事件流 / 可恢复工作台投影
工作台：显示模型、阶段、待办、引用、错误、成果及验证状态
```

Work/Run API 是业务事实来源；DSH Session 是会话、Agent 活动与 Harness 事实来源。用稳定 `runId`、`launchId`、`sessionId` 与 fencing epoch 关联，不把完整聊天记录复制为第二权威账本，也不从模型最终回答推断输入已消费、取消已结算、产物已封存或业务正确。刷新、断线和换设备后，客户端按平台持久事件水位重新拉取状态。

运行开始前冻结 `ExecutionPlan`、Profile/RuntimeBundle 与模型快照。除授权撤销、明确取消等平台控制外，worker 不从浏览器接收新的任意模型配置；补充输入按平台版本化 Run/InputRevision 合同投递，并验证 DSH 真实接收/消费事实。控制面不 import 领域插件代码；运行时按批准发布计划在 DSH profile 中装配工具和 Skill。新供应方接入通过可审查、锁版、部署管理的 DSH adapter/plugin 完成，而不是在应用插件或控制面里绕过 LLM registry。

### 4.3 缺失接口的落地方式与代码归属

以下名称是拟建平台 API/模块，不是已有 SDK endpoint；不因写进方案就视为已实现。

| 归属 | 实施内容 | 依赖/边界 |
|---|---|---|
| `apps/enterprise-workbench/`（拟建） | WorkCanvas、ModelPicker、AgentCatalog、ContextPanel、InteractionInbox、ArtifactViewer 与 locale/design tokens | 只消费平台鉴权 API，不读 SDK 进程、宿主 DOM 或私有状态 |
| `packages/platform-control` | 模型目录/可用性查询、个人偏好、Run 快照、版本化 Work/输入/回答/事件投影 | 复用身份合同；控制面只处理元数据，不为拿模型目录加载业务插件 |
| 部署侧目录探测/发布校验模块（拟建） | 在同版本受控 DSH composition 内调用 `ctx.llm` 公共服务，产出带 RuntimeBundle/profile/adapter 摘要的非秘密目录快照 | 使用 SDK 不提供的运行时目录能力时，新增平台拥有的 Host 插件/受控服务桥接；不能虚构 `sdk.listModels()`。无请求模型生成的目录探测也可能访问供应方端点，须走批准网络与凭据策略 |
| `packages/platform-control/src/worker.ts` 及 adapter | 使用公开 SDK 类型接入 initialize、通知、问答/审批、close/resume；接收模型快照而不是全局可变默认值 | 现有文件另有维护者，接口冻结后由同一负责人串行集成；先解决 WP4/WP5 完成与取消事实 |
| profile 装配/发布脚本 | 精确锁定 runtime、adapter、能力与配置闭包，验证摘要、凭据最小继承和 Run 工作区/home 所有权 | 本地 `link:` 脚手架不是独立发布制品；不得修改生产 profile 来演示功能 |

首期模型目录采用**部署产出可验证目录快照 + 控制面策略过滤 + Worker 启动精确路由校验**，而非把一个控制 Host 的目录当作所有 Worker 的能力。动态目录刷新是同一模块的受控刷新，必须重新绑定 runtime/profile 摘要。缺少跨进程桥接或快照验证时明确 BLOCKED，不改成浏览器直连 Host 全权限 API。

拟建 API 至少覆盖模型目录查询、默认偏好保存、带 modelSelectionId 的 Run 创建、Run/会话投影查询、事件重放、输入补充、交互回答和取消。写入使用幂等键/expectedRevision，服务端重复鉴权；具体 URL 和 schema 在 S0 合同冻结，不在这里伪造已经上线的路由。

**多轮连续性：** Work 是员工看到的一项连续工作，不让用户为每次 Run 手工搬运上下文。已完成 Run 后的继续/改用模型，在新 Run 中引用前序输入、明确的上下文修订和已封存成果，展示来源及新尝试标记；不能直接让新 Run 共享旧未知进程或可写 Session。崩溃接管的 `resumeSession` 与普通新 Run/重试分开，保留原 home/session 映射、模型快照和 epoch。业务审核与原成果不因继续对话而漂移。

**子智能体与辅助调用：** 选择器默认指主 Agent 模型，不暗示压缩、标题生成或子智能体必然都使用相同模型。RuntimeBundle 声明继承规则/可用子路由和辅助模型配置；保留 DSH 自主委派能力，执行域约束其只能使用获准路由并记录实际使用、用量和归属。没有支持子路由的公开合同与测试时，不开放该跨模型能力，也不在领域插件中另造路由器。真实费用未知时不显示 0；费用估算标明币种、价格版本与估算性质。

## 5. 计划内容需要具体改写的承诺

1. **优先级调整：模型选择不是后期锦上添花。** S0 产品定义必须冻结用户流程、模型路由语义及可用模型发布机制；S1 原型包含可交互模型控制器与不同模型能力/可用状态；S2 必须打通 ModelCatalog、Run 快照和实际 DSH adapter route；S3 纵向切片须实测“选择模型→真实 DSH Run→同模型历史/恢复→切换后续 Run”。未完成 S2/S3 不能宣称“用户可以使用平台内置模型选择”，即便原型能点击模型项。
2. **正式工作台以一项工作为核心，不继续把 v4 导航/表单/草稿布局当正式设计基准。** v4 只是有价值的纯函数和迁移语义来源；正式 IA、任务画布、应用发现、模型选择及状态展示需重设计并经目标员工评审。应用中心负责发现数十至数百应用；工作画布负责当前 Agent 协作；管理配置、开发诊断和普通员工业务入口分层。
3. **以 DSH 为实质性产品能力而非架构脚注。** 每个应用通过 RuntimeBundle/Profile 声明所需 DSH capabilities 和版本；平台负责目录、任务与治理，DSH 负责 Agent loop 与插件运行，adapter 负责协议映射。禁止建设与 DSH 平行的工具调度/模型请求/会话事实系统。
4. **国际化是可验收体验，不等于无限承诺。** 首批 locale 清单与目标部署地区在 S0 登记；先完成语言资源外置、长文本布局、时区/数字/日期格式、键盘/读屏与选定浏览器测试。RTL、法律区隔与跨境路由在产品/合规确认后纳入范围，不得默示为已支持。
5. **设计系统由验证产出，不先宣称最终品牌 UI。** 依本附录 Token 做至少一轮可交互原型，对实际“发现智能体—选择模型—描述目标—处理问题—查看结果”旅程做非开发用户观察。保留一个可解释的差异化元素（工作画布与模型选择控制器组合），删除不服务任务的装饰和堆叠卡片；调研后再冻结颜色/字体/断点和组件。

## 6. 补充验收编号

在主方案 U07–U14 之外，增加 DSH 接入验收 DSH01–DSH10；必须在冻结 DSH/profile/模型目录版本后测试。凡依赖真实模型计费或外发资料的检查，只使用合成数据并另行取得运行授权；不以真实临床资料作默认验收输入。

| ID | 可复现验收事实 |
|---|---|
| DSH01 | 启动时 Run 快照中的 provider/model/options 与 DSH SDK 握手及实际 adapter route 一致，且运行详情/审计可查；不能只断言配置对象正确 |
| DSH02 | 已启用的每个 provider route 来自该 Run 的批准 RuntimeBundle/profile；缺 adapter、未知 route、禁用 provider 均明确失败，不触发动态安装或网络配置注入 |
| DSH03 | 平台 ModelCatalog 展示项和 DSH `listProviders/listModels/resolveModelInfo` 与部署策略对应；无目录或未验证元数据不会伪装可选/已验证 |
| DSH04 | 用户 A 无权使用的模型，经 UI 和绕过 UI 的 API 请求均被服务端拒绝；模型 ID 猜测不能枚举组织不可见目录；拒绝事件不泄露密钥/凭据 |
| DSH05 | Run A 以模型 A 运行期间选模型 B；A 的当前执行、恢复、证据与成果仍绑定 A；后续显式新 Run 才绑定 B |
| DSH06 | 模型 A 被停用、凭据过期或 provider 限额时，UI 准确显示失败/未知事实和可做动作；不存在静默跨 provider/model fallback。用户显式选择 B 重试时生成可追溯的新 Run 或经批准的重试事实 |
| DSH07 | SDK 原生用户问题、DSH 工具审批和平台业务审核通过各自通道呈现；回答绑定 request/session/launch epoch，断线后可恢复，旧请求不能晚答提交 |
| DSH08 | 流式通知丢失/客户端刷新后，服务端按持久水位补齐状态；Run 终态由实际输入结算、子会话/进程、产物登记与 supervisor 事实产生，不依据 `finalResponse` 猜成功 |
| DSH09 | Worker 被取消、close 报错或崩溃时，不遗留可写会话/产物；退出证据不足记 UNKNOWN，不自动复用 Run 或制造新会话冒充恢复 |
| DSH10 | 新增第二个合成 DSH provider adapter 和第三个 probe 应用后，不改工作台业务分支、Run 通用表结构或 Agent loop；profile/发布清单与平台目录按配置发现并应用策略 |

UX 验收 U07–U14 需再覆盖真实可交互原型及服务端合同。原型模型选择只证明信息架构/理解能力，不证明 DSH route。企业试点至少由预先选定的非开发员工代表完成端到端旅程，登记发现成功率、模型选择理解、从目标到开始用时、运行状态识别、错误恢复、成果/检查状态理解、求助率；阈值在测试前由产品负责人冻结，不能事后改成“看起来可用”。测试至少涵盖当前确认的首批 locale、窄屏、键盘、读屏标签及 reduced-motion。设计评审、浏览器 UI 回归、真实 DSH adapter 集成、企业授权和业务验收分别记录。

## 7. 交付状态与不声明事项

本文是待实施设计补充。读取时工作台原型 README 明确其“不连接模型、不执行工具、不读取文件内容”；其他会话正在更新原型及控制面代码，不能将该观察或旧现状文档当作最终交付状态。仓库已存在 `platform-identity` 包，不能继续据旧文档断言没有任何身份实现；企业真实身份/数据集成验收仍需独立证据。一次历史成功模型 Worker E2E 不代表上表 DSH01–DSH10、用户选模型闭环、真实业务、企业安全或高可用已通过。

落地时需要更新主方案对应 WP8、模型目录及优先级/验收表，并同步当前状态矩阵；更新前本补充作为设计解释文件保留。没有执行的检查标为 `NOT_RUN`，没有外部身份/运行条件的标为 `BLOCKED`，严禁把“计划支持”“配置里可填”或“原型可点选”汇报为可用平台功能。
