# 企业业务工作台：社区调研与架构建议

日期：2026-11-10。类型：方案参考。状态：只读调研后的建议，未实施、未安装社区插件、未进行运行验收。本文不替代现有业务规则，不修改数据读取边界。

## 1. 结论

社区存在 UI 管理、开发者工作台和生成式交互 UI 插件，但本次检索与核对未找到能直接承担本项目“业务入口、输入识别、任务持久化、人工裁定、业务审核和交付证据”的现成企业工作台。

建议新增独立的企业工作台插件：员工从业务任务开始，Harness 作为后台 Agent 引擎；保留原生会话作为辅助与专家入口。使用官方 UI 插槽和 Cordis 服务，不修改 Agent 循环，不以 DOM 改写构建正式业务入口，不复制模型客户端。

先交付本机可用的员工体验，再按真实多人需求增加企业身份、服务端授权与隔离运行。企业级首先是职责、合同、可恢复性和证据完整，不等于先上微服务。

## 2. 调研范围与证据等级

- 本地：静态读取两插件代码/说明、现有架构文档、锁定上游源码的公开 UI 扩展说明。未读取真实临床 PDF、工作簿单元格、Cover 或受试者信息。
- 在线：搜索定位社区项目，再通过 GitHub API 核实仓库身份、README 与许可证元数据。没有执行下载代码、安装依赖或验证插件运行效果。
- 上游：本项目锁定版本线为 DSH 0.2.2-rc.1；公开 API 仍未稳定。社区的兼容声明不是本项目兼容验收。
- 既有架构文档明确部分内容为目标设计，不能用其推断当前实现。旧文档的知识服务等状态也不能替代现版本代码。

## 3. 社区 UI 插件筛选

| 候选 | 核实到的能力 | 本项目用途 | 不应承担的责任 |
|---|---|---|---|
| [Han-1413141/dsh-ui-hub](https://github.com/Han-1413141/dsh-ui-hub) | 枚举插槽/浮动控件；显隐、移动、改尺寸、布局备份；localStorage 持久化；README 声明通过 DOM 标记及 CSS important 工作 | 开发期整理界面、个人布局试验 | 业务导航、服务端权限、业务任务状态、统一企业配置 |
| [loadingvx/deepseek-harness-workbench-plugin](https://github.com/loadingvx/deepseek-harness-workbench-plugin) | 编辑器、PTY 终端、文件树、Git、使用量、Agent 控制面；README 声明 DSH ≥0.1.5，并对接官方右侧栏 | 开发者/技术支持工作区的候选；可参考停靠交互 | 普通员工默认入口、企业身份或任务审核系统 |
| [omdsh-dev/dsh-genui](https://github.com/omdsh-dev/dsh-genui) | 聊天内白名单 JSON 组件、表单、表格、动作回传、会话 dock；npm 为 @changfenhuang/dsh-genui | 可选的结果展示、非关键澄清卡；先完成依赖、动作、渲染和网络审查 | 正式审批、权威状态、服务端授权、确定性业务操作入口 |
| [lhuans/dsh-genui](https://github.com/lhuans/dsh-genui) | 独立同名项目，仓库说明为交互图表/表单/小应用；搜索结果标识 Vue/OpenTiny 路线 | 保留为替代候选，不与上一项目混装 | 不能仅按同名推断 API、依赖或安全特征相同 |
| [lee259/dsh-workbench](https://github.com/lee259/dsh-workbench)、[Dpf555/dsh-workbench](https://github.com/Dpf555/dsh-workbench) | 两个不同仓库，前者描述为右侧文件工作区，后者描述为 Explorer + Monaco 三栏编辑器 | 参考文件与结果预览 | 不因名称为 workbench 就视为业务平台 |

GitHub 元数据显示以上仓库未归档，许可证标记为 MIT；这不等于完成许可证文件、依赖许可证或供应链审计。目录如 [HackSing/dsh-plugins](https://github.com/HackSing/dsh-plugins)、[dshplugin-app/deepseek-harness-plugins](https://github.com/dshplugin-app/deepseek-harness-plugins) 只用于发现，不作为安装来源或官方背书。

### 取舍

UI Hub 解决“控件放在哪里”，不解决“员工该做什么”。用 CSS 隐藏按钮不是权限控制，浏览器布局也不是企业配置源。

开发者 Workbench 解决“如何编辑代码和调试”，而员工的问题是“如何提供资料、启动任务、处理待办和取得可信结果”。把终端与 Git 全部摆上来可能增加学习负担。插件声明的命令黑名单也不应被当作执行隔离。

GenUI 解决“对话中的交互更丰富”。其 README 的白名单、无 eval 等为作者声明，本次未审计实现；即使渲染安全，也不保证动作权限和业务语义正确。正式业务表单和审批按钮必须由版本化代码定义，不能每轮让模型临时生成。

## 4. 现有两个插件的产品缺口

### DM Listing

[客户端入口](../plugins/dm-listing/src/client/index.ts:25) 注册了配置说明和 conversation.input.activity 按钮。[插入任务动作](../plugins/dm-listing/src/client/index.ts:40) 调用 inputActions.insertText：它是提示词辅助，不是服务端任务创建。

员工仍需理解项目目录、技能、下一次发送消息、资料选择、运行条件和交付含义。现有项目发现、资料读取、知识检索、草稿、执行回执等应复用，但合成执行路径不能包装成已完成真实项目端到端验收。

### DM DVP

[package.json](../plugins/dm-dvp/package.json:6) 未声明 Web client contribution；[README](../plugins/dm-dvp/README.md:8) 描述的是技能与工具能力。缺少普通员工可识别的业务首页和任务页面。

现有方案文本读取、工作簿 IR、规则诊断、测试用例候选和草稿写出可以保留。但“具备这些工具”不等于任意方案 PDF 到完整、已审核 DVP 的全自动业务链路已被验证。扫描件 NEEDS_OCR、未解析逻辑和 EDC 参考输出必须显示真实能力限制。

DVP 的 Cover、Approval 和评审内容边界与 Listing 当前实现不同。统一工作台按插件显式声明并遵守现行规则，不把它们合并为一个推测出的全局规则；本次不改变任何读取授权。

### 共同缺口

- 缺少统一、无需知道插件名的业务入口。
- 缺少任务创建、资料归属、在途状态、待办和结果的同一条路径。
- 缺少业务语言错误恢复，例如“缺少 R 环境，由管理员配置”而不是让员工调环境变量。
- 候选、执行成功、技术验证、业务审核、生产批准容易被一个“完成”混淆。
- 两插件的领域逻辑应保留独立；工作簿读取等跨插件源码依赖可在有实际共同消费者时抽成公共包。

## 5. 推荐员工体验

### 导航

默认展示“工作首页 / 项目 / 我的任务 / 待我处理 / 交付物 / 使用帮助”。插件安装、模型密钥、终端、完整日志和运行时设置属于管理员或专家入口；隐藏界面不代替后端授权。

首页用业务名称而不是包名：

- “生成 Listing 程序”：说明所需资料、适用场景、交付内容和当前限制。
- “编制 DVP 草稿”：说明输入方案/模板、生成候选、需要人工审核。
- “继续未完成任务”：恢复服务端任务，不只是恢复聊天记录。
- “体验示例”：仅使用合成资料，与真实项目路径显式区分。

### 一条统一任务路径

选择业务 → 选择/建立项目 → 选择资料 → 确认识别结果 → 创建任务 → 处理必要澄清 → 查看结果和检查证据 → 导出版本化交付包。

表单只收集必要信息。唯一资料候选自动识别；多个版本、关键字段歧义或真实业务冲突才询问。不要把 Agent 自主理解变成几十个强制人工配置步骤。

任务详情分为“资料 / 处理进度 / 待我处理 / 结果与检查 / 操作记录”；聊天作为辅助区域，用于解释、补充和修正，而不是任务唯一载体。

点击“开始”必须返回持久 taskId，并显示“已创建/排队/运行/需补充”等事实；仅返回提示词不算开始。重新打开、刷新或重启后，仍能找到任务和产物。若当前能力只能创建草稿或执行合成验证，按钮与结果必须按这个范围命名。

## 6. 分层方案

```text
员工业务工作台插件                       专家/管理员入口
首页、项目、任务、待办、结果               原生会话、调试、配置
                  │                         │
           企业应用服务 / 类型化命令与查询
业务能力注册 │ Project │ Task/Run │ Decision │ Artifact/Evidence
                  │
          领域能力适配：DM Listing / DM DVP
                  │
       现有领域服务 + Harness Agent / 工具 / 会话
                  │
       资料读取、知识服务、R 等实际运行能力
```

UI 不直接依赖工具名称、拼 rulesJson 或跨插件导入内部组件。工作台不写 if listing 分支；业务插件提供场景、输入定义、能力限制、阶段解释、结果视图及验证器。

UI 和模型工具调用同一领域服务，防止“按钮一套业务逻辑、聊天另一套”。已知确定性动作直接调用服务；语义理解、规划、编码和诊断通过 Harness 执行，不重新实现 Agent 循环。

### 官方扩展点足够先做插件路线

- 全局业务页面：官方 [ui-layout](../upstream/deepseek-harness-git/packages/client/ui-layout/README.md:36) 提供 main keyed slot 和 ctx.layout.selectPanel。
- 左侧入口：[ui-sidebar](../upstream/deepseek-harness-git/packages/client/ui-sidebar/src/client/index.ts:57) 从 sidebar.panellist 聚合导航。
- 结果、规则或文件辅助页：[ui-sidebar-right](../upstream/deepseek-harness-git/packages/client/ui-sidebar-right/README.md:80) 提供标签类型注册、body 插槽和打开控制。
- 对话业务卡：[官方扩展 cookbook](../upstream/deepseek-harness-git/docs/cookbook/extension-cookbook.md:35) 指向 ConversationNodeDefinition 与 keyed renderer。

因此不必一开始 fork 上游界面。先验证企业全局面板和导航能覆盖需求；若默认首页选择或企业外观配置缺少公开扩展点，再增加极薄且单独测试的适配，不通过 DOM 选择器掩盖缺口。不声称已有通用默认首页配置。

### 建议包职责

- plugins/enterprise-workbench：首页、业务导航、通用任务/待办/结果视图。
- packages/platform-core：按真实需求增加能力注册、项目/任务/运行/决定/工件机制，不预先造大量空包。
- packages/harness-adapter：仅在版本适配确有复杂度时独立；隔离上游 API 变化。
- plugins/dm-listing、plugins/dm-dvp：保留领域语义、工具与技能，增加业务 capability 适配。
- packages/platform-knowledge：复用当前公共知识能力，不另建第二套。
- profiles/enterprise：装配固定版本的宿主和批准插件，员工不自行配依赖。

## 7. 最小服务合同与状态

以下为拟设计的业务语义，不是已存在 API。

| 对象 | 责任 |
|---|---|
| BusinessCapability | 稳定 capabilityId、版本、输入角色、限制、输出类型、阶段与检查定义 |
| Project / ResourceRevision | 明确项目归属、资料角色、版本和摘要；不从 cwd 隐式猜测 |
| Task | 员工的业务目标、负责人、当前输入与生命周期 |
| Run | 一次尝试：版本快照、Harness session 关联、实际执行和恢复证据 |
| DecisionRequest | 问题类型、选项、影响对象/版本、回答及适用范围 |
| ArtifactRevision / Evidence | 文件版本、摘要、来源 Run、检查结果和审核记录 |

命令至少覆盖 createTask、startRun、answerDecision、cancelRun、retryRun、exportArtifacts；查询覆盖任务、运行、待办、结果和证据。命名仅为方案示例，不承诺现有 SDK 提供这些方法。

创建/启动携带幂等键；更改和回答绑定 expectedRevision；重试产生新 Run；输入变化使相关结果或决定失效。事件流支持断线后按序号重放，不能仅靠浏览器保存任务状态。UI 偏好可在 localStorage，业务状态必须持久化。

### 两条状态轴，不是一个绿色完成

运行轴：CREATED / QUEUED / RUNNING / WAITING_FOR_USER / SUCCEEDED / FAILED / CANCELLED / UNKNOWN。

交付轴：草稿候选 / 技术检查通过 / 业务审核中 / 已审核 / 已被新版本替代；具体审批层级按公司实际流程确定，不伪造电子签名能力。

运行成功不代表规则正确，也不代表业务批准。DVP 的 RENDER_REFERENCE_ONLY 独立保留；Listing 的代码包完成和目标服务器实际复跑分别记录。取消请求发出不等于进程已经停止；退出未知显示 UNKNOWN，不自动重放可能产生副作用的步骤。

Task/Run 保存业务生命周期；Harness session 保存模型交互和工具事实。二者用稳定 ID 关联，通过适配器读取/归并证据，不另建一份完整聊天历史，也不从模型总结或聊天文本猜测完成状态。

### 人工问题分流

- 业务澄清：由实际业务冲突触发，员工回答后继续。
- 缺环境/依赖：形成管理员可处理问题，员工不必理解 Node/R 配置。
- 覆盖正式产物、对外发送：独立、明确授权。
- 业务审核：绑定产物版本及证据，不能把普通聊天“好的”当作正式批准。

## 8. 部署演进

### A. 先让其他员工能使用

企业装配包/受管配置 + 每位员工独立本地运行环境；统一入口、运行时检查、合成教学示例、中文错误、诊断包和固定升级版本。首页业务面板默认可达；不要求员工安装插件、找技能或配置模型密钥。

此阶段仍是单操作者模式，不宣称已实现中心化协作、企业 RBAC 或不可抵赖审计。如何分发凭据由 IT 确定，不把共用密钥放入浏览器或安装包。是否纳入本地凭据管理需按真实部署方案实现。

### B. 确认中心化多人需求后

浏览器 → 企业 SSO/OIDC 与 BFF → 项目/任务授权 → 作业调度 → 隔离 Harness worker → 受控工件存储和数据库。

员工不能直接访问 worker 的全权限管理 API；BFF 每次按人员、项目、操作与工件校验权限，下载/事件流同样鉴权，不能只验证登录。worker 使用最小化服务凭据和明确的工作目录、资源及网络策略。

隔离单位按项目资料边界、操作者和风险实际确定。原则上不让不互信用户共享可执行任意代码的同一无隔离宿主进程；容器、VM 或专用 worker 的选型需验证实际执行权限与沙箱能力。已有模块化服务可先保持单体，长作业从 worker 独立部署，无需立即拆成微服务。

官方 Web Connection 已提供浏览器会话认证及 Host/Origin 检查，见 [web-server 说明](../upstream/deepseek-harness-git/docs/subsystems/web-server.md:102)；不能把它等同于企业 SSO、项目 ACL 和多用户执行隔离。反向代理只加登录也不能完成这些职责。

### C. 涉及受监管正式使用时

建立用途限定、风险评估、版本受控、回归验证、变更控制、备份/恢复、保留策略和审计要求。若涉及电子记录/签名，由 QA/合规判定适用性及验证范围；本方案不宣称已符合 GxP、21 CFR Part 11 或其他法规。

现有 IT 数据安全 API 仍须按真实合同接入；UI 改造不代表真实数据生产通道已获批准。

## 9. 社区插件准入和升级

- 只在隔离测试 profile 中试装，使用合成数据；本次尚未安装。
- 固定仓库身份、版本/提交及依赖锁；审查安装脚本、网络请求、文件/进程权限、动态代码和导出内容。
- 用白名单和企业装配控制插件分发，不让员工从市场任意装入同一受信运行环境。
- 核验宿主版本与真实加载 API；预稳定接口下“≥某旧版本”不足以覆盖当前 RC。
- 回归验证企业导航、模态框/权限提示、任务恢复、结果显示及卸载恢复；不覆盖或遮挡授权对话框。
- 维护 SBOM、许可证清单、回滚路径和可重现构建证据。社区 README 的测试结果仅作线索。

## 10. 实施顺序与验收

| 阶段 | 交付 | 核心验收 |
|---|---|---|
| 体验验证 | 业务首页、两条任务路径、状态和结果示意，使用合成资料 | 未参与开发的员工无需知道技能名即可找到功能，知道输入、下一步和输出 |
| 最小闭环 | capability 注册、持久 Task/Run、两插件适配、待办/结果、实际能力预检 | 点击即返回 taskId；刷新/重启可恢复；不重复创建；真实故障可解释且可恢复 |
| 可靠交付 | 资料/产物版本、证据、过期检查、取消/重试、依赖包装 | 同一项目不误覆盖；输入更新使旧结果显式失效；候选不显示正式通过 |
| 多人部署 | 身份、项目授权、调度与 worker 隔离、审计和运维 | 跨项目访问拒绝；并发不串资料；下载/流鉴权；重启与备份恢复实际测试 |

建议邀请约 5 名未参与开发的内部员工，在不口头指导的条件下完成：找到正确业务、选择合成资料、发起任务、回答澄清、获取结果、理解“候选未审核”。记录完成率、误操作、求助次数和耗时；将目标设为产品验收指标，而不是用截图代替可用性验收。

先用一条真实能力范围内的垂直切片打通，再接第二插件检验平台是否通用。不要先造一个能展示很多卡片、却仍要求员工回到聊天框输入工具名的空壳。

## 11. 与既有架构的关系

延续 [企业平台 1.1](ENTERPRISE-PLATFORM-ARCHITECTURE.md) 的模块化单体、复用 Harness、自主理解和最小公共服务原则。该文档的首期本机/单操作者范围不因本建议自动扩大。

本次补充的重点是业务可发现性、任务交互和员工认知路径，不是重新规划全部知识服务或强制增加资料读取审批。多人部署、SSO、隔离和生产数据批准作为独立演进条件，不能被一个 UI 插件冒充。

## 12. 外部来源

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方扩展 cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)
- [官方 UI layout](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/README.md)
- [官方右侧栏扩展](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar-right/README.md)
- [UI Hub](https://github.com/Han-1413141/dsh-ui-hub)
- [Workbench](https://github.com/loadingvx/deepseek-harness-workbench-plugin)
- [GenUI：omdsh-dev](https://github.com/omdsh-dev/dsh-genui)
- [GenUI：lhuans](https://github.com/lhuans/dsh-genui)
- [lee259 工作区](https://github.com/lee259/dsh-workbench)
- [Dpf555 工作区](https://github.com/Dpf555/dsh-workbench)
