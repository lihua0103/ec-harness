# DSH 社区工作台插件调研（2026-11-19）

> 调研对象：DeepSeek Harness（DSH）社区里已经实现"工作台 UI"的插件及其架构模式。
> 目的：找出对本项目（企业临床平台，几十到上百个 DSH 业务插件）可借鉴的机制，并明确哪些不该照搬。
>
> **证据边界**：本文对社区插件的描述来自作者 README / 文档自述与目录元数据，**没有逐行核对源码**，也没有安装运行；凡涉及"实现如此"的判断，采纳前必须按 [DSH 插件开发规范](DSH-PLUGIN-DEVELOPMENT-STANDARD.md) 核对目标 DSH 上游公开契约。目录星数噪声很大（存在明显虚高），不作为质量依据；社区目录本身也声明"收录 ≠ 安全审计"。

## 1. 调研方法

- npm registry 搜索：`dsh-plugin`、`deepseek+harness`、`keywords:dsh`。
- GitHub 仓库搜索：`dsh plugin workbench`、`dsh-workbench`、`awesome-dsh-plugin`（按更新排序）。
- 全量目录快照：`dsh-plugin-catalog@2026.1119.23991`（**11,979 条**，含分类、能力声明、安装命令、描述）。
- 抽取 12 个代表性仓库的 README 精读（缓存于 `.runtime/dsh-community-research-2/`，未纳入仓库）。

数量口径：目录里名称或描述命中"工作台 / 侧栏 / 面板"的 262–444 条，多数是蹭词或单一面板；逐一核到**真正的工作台壳或整页工作台实现约 20 余个**，架构上可归为五类。`ui` 分类有 2,402 条，说明"UI 增强"已是社区最大赛道之一。

## 2. 生态地图：五类工作台

### A. 薄外壳 + 模块注册（与我们的"平台 + 多插件"最接近）

| 实现 | 机制 |
|---|---|
| [`philomelcc/dsh-workbench`](https://github.com/philomelcc/dsh-workbench) | 顶部加"系统栏 + 模块栏"两层导航：系统栏**镜像**原生侧栏项（系统级插件零改动），模块栏承载注册为"模块"的整页应用。外壳只负责布局、标签行和少量 UI 原语；模块自己管数据、自己画页面，互不 import，只通过运行时服务通信。契约 `apiVersion: 1`，`wb.registerView({id,title,component,order})` 可选注册，没装外壳时插件仍走原生侧栏。 |
| [`omdsh-dev/DSH-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) | 原生右侧栏变成完整工作台（文件、终端、Git、子代理），对外暴露 `ctx.betterSidebar` 五个扩展点：`registerTab / registerFileViewer / registerFileIcon / registerFileAction / registerTabAction`。**内置 6 个 Tab 与 5 个查看器使用同一套 API**；生态已有 30+ Tab 插件。 |
| [`novaeth/dsh-workbench`](https://github.com/novaeth/dsh-workbench) | "取 / 汇 / 通"：模块按需安装、跨平台数据汇入一张看板、读取靠浏览器会话、写入走看板动作或 agent 工具且留痕。看板由用户定义，五个动作：安装 / 启用 / 排序 / 配置 / 创建（缺的视角让 agent 现场建）。三条原则：**同屏、同事实、同权限**。产品判断：**轻交互留在看板，复杂操作交给 agent**。 |

### B. 共享宿主 + 业务包（与我们 platform-control + 多业务插件同构）

| 实现 | 机制 |
|---|---|
| [`ityyq777/dsh-workbench`](https://github.com/ityyq777/dsh-workbench) | 一个共享宿主包（本地 SQLite、业务域注册、HTTP/SSE、统一的 `Workbench` agent 工具、账号同步、按模块导出/导入、卡片首页）+ 11 个独立业务包。每个业务包 `dependencies` 声明宿主版本，装任一业务包会自动带入宿主；所有包共用一个宿主与一份数据；`minShell` 声明宿主版本下限；卸载只删代码不删数据；**agent 工具与 UI 共享同一份本地权威库**。 |

### C. 整页工作台应用（垂直场景）

- [`xuanqing-95/dsh-personal-workbench`](https://github.com/xuanqing-95/dsh-personal-workbench)：首页三块——"需要你处理"、"AI 助手任务进展"、"项目进展"，加今日计划与用量；可"编辑布局"调卡片。
- [`Dely0/dsh-personal-workbench`](https://github.com/Dely0/dsh-personal-workbench)：日历 + 层级任务 + AI 澄清/拆解/执行/复盘；**AI 申请完成 → 用户验收**闭环，进度是显式值，AI 不能靠进度把任务标完成（ADR 0003/0004）；每日计划由 AI 排序提案、**确认后才生效**（ADR 0007）；有 ADR 与版本验收链（构建 → 装盘 → 隔离实例 → 浏览器套件 → 证据包）。
- [`Aisland-SJL/dsh-worktable`](https://github.com/Aisland-SJL/dsh-worktable)：可停靠的分栏工作区（拖拽分隔、窗格标签、布局预设）+ **控制室**（默认项目，卡片网格显示 working / needs you / run ended，事件驱动镜像宿主会话快照、**不调用模型**）+ 项目↔会话绑定 + "窗口任务"（agent 写 `widget-result.json`，产物自动挂载进窗口）。
- [`tingfeng347/dsh-vscode-workbench`](https://github.com/tingfeng347/dsh-vscode-workbench)、[`ZhaoBody/dsh-terminal-workbench`](https://github.com/ZhaoBody/dsh-terminal-workbench)：VS Code 式 IDE 壳（Monaco、全文搜索、Git、终端、浏览器）；三栏 + 自绘 xterm。
- [`etony668/dsh-task-board`](https://github.com/etony668/dsh-task-board)：会话视图里的 `Chat → Trajectory → Task Board` 标签页，画布式可拖拽任务面板，任务是父子树并带**任务边界（目标/范围/非范围/验收）**；模型工具 `board_* / task_*`。

### D. 通道 / 渲染型（不占面板，长在对话里）

- [`omdsh-dev/dsh-genui`](https://github.com/omdsh-dev/dsh-genui)：助手回复里的 `dsh-ui` 代码围栏 → 白名单 schema → 渲染 React 组件（图表、表格、表单、测验、3D）；交互元素带 `action` 载荷**回传模型**，连续拖动做尾沿去抖；可导出独立 `.html` 与 `.genui.json`。
- `deep-view`、`@changfenhuang/dsh-genui`、`dsh-agent-compare`（2–4 个回答/文件/页面并排对比）、`dsh-univer-office`（内联表格/文档预览）同属这一类。

### E. 目录 / 市场层

- [`dataelement/awesome-dsh-workbench`](https://github.com/dataelement/awesome-dsh-workbench)：DSH Desktop 工作台市场。条目是一份 YAML（名称、分类、描述、截图、可选 tarball），目录按 **npm → 明确声明的 GitHub Release → 源码** 选择安装来源并**固定实际版本与校验信息**；每日探测；**PR 合并不等于上线**，发布失败保留上次成功目录；投稿要求实测环境、截图证据、权限与费用披露。
- `awesome-dsh-plugin` + `dsh-plugin-catalog`：全量插件目录与格式 1 索引，供市场客户端消费。

## 3. 值得借鉴的架构模式（按对本项目的价值排序）

### P1 版本化模块契约 + 可选注册 —— 最高价值

**机制**：外壳提供一个小而稳的运行时服务（`ctx.get('workbench')`），带 `apiVersion`；业务插件通过 `registerView` 之类的调用声明自己的整页/面板；没注册的插件不受影响，没有对应能力就不渲染。内置视图与第三方走同一套 API（better-sidebar 明确如此），因此 API 会被生态持续压测。

**对我们的意义**：本平台是"几十到上百个业务插件"，而当前 `application.json` 只是**描述符**（appId、listingTypes、capabilityId、knowledgePluginId），工作台视图是固定的六个（works / sessions / projects / apps / pending / settings）。每加一个业务面就要改 `platform-workbench` 核心，规模一上来必然失控。

**建议**：先定 `WORKBENCH-MODULE-CONTRACT`（apiVersion、注册点、可选性、外壳瘦身规则），再把现有内置视图迁到同一 API 上自用（dogfood），最后才开放给业务插件。注册点建议最小集：整页视图、右栏运行面板、待处理卡片、待处理动作。

**边界**：中心永远是原生会话（既有定调），模块契约只覆盖左右栏与整页业务视图，不提供"替换会话"的注册点。

### P2 共享宿主 + 业务包依赖 —— 我们已在做，缺声明与装卸语义

**机制**：ityyq777 用 `dependencies` + `minShell` 表达业务包对宿主的版本需求，装一个业务包自动带入宿主；数据一份、导出按模块、导入只合并不删除。

**对我们的意义**：`platform-control` 事实上就是共享宿主。缺的是：manifest 里显式声明宿主版本下限、单包装配时自动带入宿主、以及"按应用导出/导入（只合并不删除、格式版本不兼容则拒绝）"的产物契约。

**建议**：在 `application.json` 增加 `requires: { platform-control: "^x" }`、`minHost` 字段；导出/导入语义写入 [平台应用发布契约](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)。

### P3 同屏 / 同事实 / 同权限 —— 把定调写成可检查的规则

**机制**：novaeth 的三条原则，加上"轻交互留看板、复杂操作交 agent"。写操作只有两个入口：看板动作和 agent 工具，都留痕。

**对我们的意义**：与"工作页中心即原生 Chat、运行记录只在右侧栏"完全同向。可以直接借它的措辞作为评审口径：任何新界面先问三件事——是否同屏可见、agent 读的是不是同一份权威数据、写入是否只有留痕的两个入口。

**建议**：写入 `ENTERPRISE-WORKBENCH-UX-SOLUTION.md` 或模块契约的验收条款；"轻交互 / 复杂操作"的分界给出示例（排序、启停、筛选=轻交互；批量重跑、改数据=agent 工具）。

### P4 控制室与"待你处理"队列 —— 借状态词汇与诚实性

**机制**：worktable 控制室只镜像宿主会话快照（working / needs you / run ended），**事件驱动、不调用模型**，并明确"run ended 不代表成功"；未绑定会话的项目显示为 idle。xuanqing 的首页把"需要你处理"放第一块。

**对我们的意义**：我们有 pending 视图与三指针卡（记忆：2026-11-18 E1 指针/换批重跑）。可借的是：状态词表统一、**运行结束 ≠ 成功**（与"诚实身份面板"一致）、事件驱动快照而非轮询模型、以及把"需要你处理"与"运行结束"分成两个队列。

### P5 完成 ≠ 验收 —— 把验收做成独立状态

**机制**：Dely0 的"AI 申请完成 → 用户验收"，进度是显式值、AI 不能靠进度置完成；task-engine 的 `accept_item` 把逐项审核与完成分开，原生任务板的 `completed` 只表示"成员交回结果"，`verify` / 独立审核 / `accept_item` 仍由 Lead 执行。

**对我们的意义**：我们的 run 有完成事实与审批，但"业务验收"容易和"执行成功"混为一谈。建议在运行台账里显式区分 `succeeded → claimed_complete → accepted`，验收记录必须带证据指针（产物 digest / 检查输出），agent 不能自行置 `accepted`。

### P6 台账修订 / 备份 / 原子写 —— 低成本的可靠性模式

**机制**：task-board 每次变更先把上一版快照进 `backups/`（保留 10 份），主文件 + 全局镜像双写，读取按"项目文件 → 最新备份 → 全局镜像 → 空板"回退，所有写原子化，项目目录只读时降级为全局镜像；ityyq 的导出/导入是"只合并不删除"。

**对我们的意义**：可直接套到每批运行的台账与批次身份（SC-03 冻结批次身份）上：修订号 + 备份保留 + 原子写 + 明确回退顺序。这条不需要动 UI，收益是故障恢复与审计可解释。

### P7 唤醒 / 租约 / 至少一次 —— 作为对照检查清单

**机制**：sentinel 用插件自有 sidecar 日志折叠出订阅，`$DSH_HOME` 上**一个租约文件保证单一值班进程**（第二个进程被动、TTL 内接管），投递**至少一次**并用 `delivered` 水位线在崩溃后重投；`timeout_seconds` 是"计划超时"——到点没触发会**唤醒 agent** 并说明最后探测状态，与静默过期的 `expires_in_seconds` 明确区分；每次唤醒都是带 `source.kind` 的用户可见消息。

**对我们的意义**：`platform-control` 已有 outbox / 租约 / 调度。这条不当作新功能，而是**对照检查**：(a) 单值班进程与接管是否明确；(b) 投递水位线与崩溃重投；(c) "超时唤醒"与"静默过期"是否分开；(d) 每次触发是否有用户可见、可追溯到 source 的事件。

### P8 Inline GenUI —— 业务插件"不出面板也能出交互"的通道

**机制**：回复里的结构化围栏 → 白名单组件 → 本地即时交互 → 带 action 载荷回传模型。

**对我们的意义**：与"业务插件不自己做 UI 面板"的既有决策互补：Listing 结果表、抽样确认表单、DVP 轮次摘要，都可以在中心原生会话里内联呈现，而不用新增页签。前提是三个约束必须成立：组件白名单与转义、动作只能映射到 `platform-control` 的已有工具（可留痕）、以及临床内容外显边界仍按既有合同执行（Cover 禁读等长期边界不变）。

**建议**：作为候选通道评估，不先落地；评估项包括审计、可复现（导出静态件）与失败降级。

### P9 市场与登记治理 —— 借"探测 + 固定 + 校验"

**机制**：市场条目只存元数据；安装来源按 npm → Release → 源码的优先级探测，**发布时固定实际版本与校验值**；合并 ≠ 上线，发布失败保留上次成功；投稿要求实测环境、安装来源、截图证据、权限与费用说明。

**对我们的意义**：与"平台应用发布契约"同构可借：业务插件登记表只存指针与证据，装配时固定版本 + digest，未探测成功不得标"可安装"。

### P10 兼容性矩阵与能力门禁

**机制**：Dely0 按宿主版本列能力矩阵（如 `sessions.retain()` 在旧宿主回落到 `sessions.binding()`）；genui 用 `check:host-api` 对不同宿主版本各跑一条门禁；task-engine 对旧宿主固定插件版本。Dely0 还记录了一条原则：**能力不满足时"明确不启动"**，而不是半残运行。

**对我们的意义**：我们的 [上游基线](UPSTREAM-BASELINE.md) 与 `verify-all` 已覆盖一部分。可补的是"按宿主版本的能力矩阵"这一表达方式，以及"不满足即明确不启动"的启动策略。

## 4. 不建议照搬

| 模式 | 原因 |
|---|---|
| 完整 IDE 壳（Monaco / 终端 / 浏览器 / Git 全套） | 与临床业务面无关；维护面巨大，且会与原生会话、原生侧栏争夺主列 |
| 会话卡片画布（多会话摊在自由画布、流水线互喂） | 与"中心永远是原生会话、运行记录只在右栏"的定调直接冲突 |
| 依赖 `ctx.betterSidebar` 等第三方私有服务 | 是社区插件之间的契约，不是 DSH 上游公开契约；我们做的是平台级外壳，不应把第三方插件写成硬依赖。只借 API 形状（版本化注册 + 内置与第三方同 API） |
| 自绘 xterm / 三栏终端 | 场景狭窄，与原生能力重复 |
| 用目录星数或收录状态当质量/安全证据 | 目录自身声明"收录 ≠ 审计"，星数存在明显虚高 |

## 5. 建议的三步落地（按风险从低到高）

1. **写模块契约，不写代码**：新增 `WORKBENCH-MODULE-CONTRACT`（apiVersion、四个注册点、可选注册、外壳瘦身、中心不可替换），并把六个内置视图迁到同一注册点作为自用验证。这一步不改上游、不改业务插件，风险最低。
2. **验收状态显式化**：运行台账增加 `claimed_complete` 与 `accepted`，验收记录带证据指针；UI 上"已交付"只认 `accepted`。涉及 `platform-control` 与工作台各一处，可独立测试。
3. **可靠性对照检查**：以 P6/P7 为清单审计现有台账与调度（修订/备份/原子写/水位线/超时唤醒/单值班租约），只补缺口，不重写。

两项观察项：P8（内联 GenUI 通道）与 P9（登记探测流水线）先出评估结论，再决定是否立项。

## 6. 参考清单

- 外壳 / 模块注册：philomelcc/dsh-workbench、omdsh-dev/DSH-better-sidebar、novaeth/dsh-workbench
- 共享宿主：ityyq777/dsh-workbench
- 整页工作台：xuanqing-95、Dely0、Aisland-SJL/dsh-worktable、tingfeng347/dsh-vscode-workbench、ZhaoBody/dsh-terminal-workbench、etony668/dsh-task-board
- 渲染通道：omdsh-dev/dsh-genui、deep-view、dsh-agent-compare、dsh-univer-office
- 目录 / 市场：dataelement/awesome-dsh-workbench、awesome-dsh-plugin、dsh-plugin-catalog
- 对照参考：fuhefei/dsh-sentinel（唤醒/租约）、godv61/dsh-task-engine（阶段/证据/验收）、nanmicoder/dsh-agent-teams（团队/任务依赖）