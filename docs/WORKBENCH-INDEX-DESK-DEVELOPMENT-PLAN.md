# Emerald 研究工作桌 · 方案 B 开发计划

**交付目标**：在现有 `@ec-clinical/platform-workbench` 插件上，实现「选工作 → 看待处理事项与底稿 → 进入原生会话」的员工工作面。开发基线：2026-11-22 的当前工作树（含未提交改动），不是干净 HEAD。本文是施工规格，不是已上线或已验收声明。

| 视觉基准（1512 × 948，静态合成数据） | 产品解释 |
|---|---|
| [B1 工作索引与底稿 · 夜蓝](../prototypes/enterprise-workbench/visual-study/10-midnight-desk.png) | 「我的工作」首页；中栏是工作列表，右边是**选中工作的只读摘要**，不是另一个聊天入口页。 |
| [B2 会话与资料栏 · 夜蓝](../prototypes/enterprise-workbench/visual-study/11-midnight-session.png) | 同一工作台进入 Work 后的外壳。中间画面来自宿主截图，不是待复刻或重新着色的组件。 |

## 1. 边界与已有资产

**改**：企业侧栏外观、我的工作索引、工作摘要、公共顶栏、Work 控制台右栏的信息层级、响应式布局与相关测试。**不改**：原生会话内容、输入框、View 标签、流式输出、附件、问答、排队、停止、绑定/解绑、恢复坐标的既有语义、Work/Run 会话引用交换。不是重新开发项目、应用、待办、设置、历史会话五套页面；它们沿用原页面和入口，只共享新的外壳。无新服务、依赖包、数据库迁移、领域插件分支或生产 profile 变更。

| 已核对的入口 | 如何使用 |
|---|---|
| [项目规范 §2、§4–5](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)、[单侧栏架构](WORKBENCH-SINGLE-SIDEBAR-ARCHITECTURE.md)、[ADR-0003](adr/ADR-0003-NATIVE-WEBUI-WORKBENCH.md) | 目标 DSH `0.2.2-rc.1`，规范锁定提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。外壳仍是一套员工导航，不挂第二个应用。 |
| [上游 ui-layout 插槽与 owner props](../upstream/deepseek-harness-git/packages/client/ui-layout/src/client/index.ts)、[当前插件装配](../packages/platform-workbench/src/client/index.ts) | 根 `sidebar` 属宿主布局；`collapsed/width/drawer` 是输入，不是插件可随意写的几何值。保留 `shell.leading`、`main:emerald-platform`、`workbench.session` 和现有 stylesheet disposer。 |
| [SidebarNav](../packages/platform-workbench/src/client/sidebar-nav.tsx)、[route-store](../packages/platform-workbench/src/client/route-store.ts) | 全局导航、创建、折叠/抽屉、焦点归还沿用。route store 只同步导航意图和坐标，不塞工作列表、成果或会话消息进去。 |
| [WorkbenchPage.tsx](../packages/platform-workbench/src/client/WorkbenchPage.tsx) | `WorksQueue` 是列表查询/分页基线，`WorksPage` 是首页，`WorkDetail` 是现有完整详情，`WorkConsole` 是工作会话。实施时按符号定位，不依赖旧行号。 |
| [api.ts](../packages/platform-workbench/src/api.ts)、[WorkContext](../packages/platform-workbench/src/work-context.ts)、[view-state](../packages/platform-workbench/src/client/view-state.ts)、[i18n](../packages/platform-workbench/src/client/i18n.ts) | 复用当前同源代理、类型、状态投影、偏好及中英语言机制；不从其他插件 DOM、磁盘、日志或聊天文本拼数据。 |

## 2. 页面与动作：先定行为，再排像素

宽屏的区域次序是 `全局导航 | 工作索引 | 工作摘要` 或 `全局导航 | 工作索引 | 原生会话 | 工作资料`。**工作索引是「我的工作」的主从列表，不是第二套全局导航**：不重复品牌、项目树、应用入口或设置。它放在 `main` 内；导航及全局创建继续只有 `sidebar` 一个所有者。图中索引标题旁的加号在实施时挪到相邻导航轨，名称「新建工作」，仍走既有 `create` 意图。其它页面同样可新建。

| 操作 | 必须发生 | 严禁副作用 |
|---|---|---|
| 首次进「我的工作」 | 优先有效的已选项；否则在当前可见结果中选已有优先事项对应 Work，再否则选首项。空集显示空态。 | 自动调用 `openWork`、创建 Session、启动 Run。 |
| 点索引行／键盘确认 | 首页只更新 `previewWorkId` 和对应摘要。主动切换另一项才换摘要。 | 选中即绑定、下载、复核，或把 Work 状态冒充 Run 状态。 |
| 点「进入工作会话」 | ACTIVE 项调用既有 `openWork(workId)`，让已有导航守卫、绑定和错误处理接管；进行中禁止重复提交。 | 新增第二条创建/绑定路径、直接操作 SessionProvider。 |
| 已在会话中点索引 | 当前 Work 行是当前项，点击不重开。点击另一行是**显式离开当前工作、查看该项摘要**：经现有离开/导航清理回工作页，再应用目标预览；不自动进另一会话。给行可访问名称「查看…工作摘要」。 | 在旧会话上方换成新工作标题；因搜索、列表刷新或收起面板导致退出会话。 |
| 待办、运行、归档 | 首页「查看运行记录」到该 Work 的完整详情并定位已知 Run；无 Run 不显示此入口。带目标的待办沿用 `openPendingById`：ACTIVE 进对应工作/运行，ARCHIVED 进只读详情。归档摘要主动作是「查看详情」，不是「进入会话」。 | 把无 `workId/runId` 的全局事项绑定给当前工作，或恢复归档工作。 |
| 全局快捷入口 | 保留 Ctrl/⌘+K、刷新、紧凑布局、专家诊断。宽度不足收进有名称的工具菜单，不删除。全局搜索与索引搜索分别命名。 | 在工作索引复制历史会话列表，或把专家诊断默认展开。 |
| 刷新、深链、返回 | 已有 Work、Run、历史 Session、只读详情坐标优先恢复。返回「我的工作」恢复本次页面的筛选、滚动和有效预选。若需跨刷新记住首页预选，只在现有恢复完成且位于 works 首页后，读取单独的标签页级 `workId` 并重新验证可见性。 | 给现有导航坐标换格式；持久化标题、路径、正文、reference；首页默认选中抢占深链恢复。 |

**选择与异步约定**：唯一业务键 `workId`；标题及数组位置不是键。在首页，提交新筛选并成功返回后，仍可见则保留原预选，否则重选；等待、错误不算空结果。会话内，索引过滤掉活动 Work 只影响列表，不导航。页面/身份/项目切换撤销旧请求，清掉不再授权的展示；A→B→A 仍须按请求代次比较，不只比 ID。401/403 不继续显示上次成功数据，不因失败自动尝试写操作。

## 3. 显示数据契约

| 界面位置 | 来源 / 取数时机 | 缺失、失败和限制 |
|---|---|---|
| 工作索引 | `WorkbenchBootstrap.works/projects/apps`、原 `WorksQueue` 的 `selectWorkRows`、`listWorks` 与 `queryWorks`。有搜索词或指定项目走整库游标查询，保留 250 ms 防抖、取消和加载更多；按 `workId` 去重。 | 保留活动/归档/全部、项目范围、已有排序与服务端排序限制，可放在「筛选」菜单。不把首页已加载数量说成工作总量。「今天/更早」仅用于最近排序；按本地日界线分组，无有效 `updatedAt` 不编时间。 |
| 选中工作标题、项目、应用 | `WorkbenchItem`；详情需要时按该 `workId` 调 `workContext`，用授权项目名及发布的显示名。 | `WorkContext.work` 没有 goal 正文字段。无已知任务摘要就展示项目/应用，不能填入图上的临床结论。 |
| 待办与提示 | `bootstrap.todos` 过滤到目标 Work；如声称属于某 Run，还须匹配 `runId`。保持 question、review、delivery-receipt、model-approval 的既有语义。多项按明确顺序列出并提供全部入口。 | `todos` 缺失/加载失败≠零条。仅匹配的 review 才显示「待复核」；技术成功≠业务复核通过。图上的「请确认…」只在有相应事实时成立。 |
| 当前摘要的运行 | 首选同 Work 已明确定位的 Run；否则用 `workRuns(workId,{offset:0,limit:1},signal)` 的最新一条。必须验证 `run.workId`；注明「最近一次运行」，不要称为当前活动运行。 | 没有记录、加载中、失败三态分开；不得从平台全局最近一页推断此 Work 从未运行。 |
| 工作底稿 | 对选中 Run 调 `runArtifacts(runId,signal)`；显示 `name/bytes/mediaType/sealedAt` 中实际存在的信息。1 项可用大文件卡；多项用同一列表，首屏最多 5 项再展开。 | `ArtifactItem` 无摘要或缩略图接口。正式版画**通用格式封面**，不伪造工作表、页数或内容说明，不读取临床文件生成预览。无结果说「本次运行未登记文件」，普通聊天无文件是正常情况。 |
| 下载 | 只有 `sealedAt` 存在才展示可下载动作；复用 `saveArtifact(runId,name)` 与 `artifactDownloadPath`，禁用本次重复点击并就地反馈。 | 未封存只显示元数据。HTTP 失败不保存错误页，不自动重试。不要把底稿、已封存文件和正式交付包混称「已交付」。 |
| 最新活动／右栏 | 当前选中 Run 的 `runEvents`、`RunSummary` 和现有复核/问答/交付组件；只展示已记录的动作和时间。会话右栏**沿用 WorkConsole 的 selectedRun**，不是首页预览 Run。 | 不用 `runDetail.activities` 或 `finalResponse` 复制会话。没有事件显示空态；失败提供本区重试。没有选中 Run 不暗选一个去改变原生视图。 |

**请求预算**：列表每页一次查询，不按行读取 context、成果或事件。摘要按所选 Work 读取事实；Run 确定后仅查询该 Run 的成果和首屏活动，可独立失败和重试。已进入 `WorkConsole` 后使用原有数据拥有者，不再并行挂载摘要请求链。刷新复用现有动作；不新增后台轮询或全局缓存。

## 4. 组件拆分与状态归属

以下为**建议新文件**，不是现存 API；均位于 `packages/platform-workbench/src/client/`。优先抽取旧能力再切视图，不在 5000 行的 `WorkbenchPage.tsx` 里追加一套并行实现。

| 单元 | 输入 → 输出／责任 | 不负责 |
|---|---|---|
| `work-index-model.ts` | `rows + sort + locale + now + selectedId + priorityId` → 分组、选中项、日期标签；纯函数，时钟可注入。 | fetch、授权或会话。 |
| `use-work-index.ts` | 从 `WorksQueue` 提取分页、过滤、搜索与状态。返回 rows、命中 ID 映射、加载/失败、总量口径和下一页动作。 | 每行预取、独立后端。 |
| `work-index.tsx` | 受控列表；输入查询结果、筛选、当前/预览 ID，输出 `onInspect(workId)`。用真实按钮、可见焦点与空态。 | 持有 Work 或 Session 对象副本。 |
| `work-brief.tsx` | 只读摘要及分区状态，输入 `workId/api` 和父级的 `onEnter/onDetail/onPending/onDownload`；在 key 或请求代次变化时重置局部状态。 | 创建、复核决定、发消息、分析文件。 |
| `work-desk-frame.tsx` | 主区内容网格，接收 index 和 content。具名 class 控制可用宽度与面板显隐。在既有 `shell()` 稳定层装配。 | 创建或以 `previewWorkId`、宽度、主题为 key 重建中心节点。 |
| 现有 `WorkbenchPage.tsx` | 页面级持有 `previewWorkId` 和索引查询状态；保留 `sessionWork/historySession/detailWork/creating/restoring` 原有决策优先级、导航守卫及回调。`creating` 为真时展示原向导，不渲染默认摘要抢焦点。 | 让 `previewWorkId` 决定原生 Session 引用。 |
| 现有 `sidebar-nav.tsx`、`styles.ts`、`i18n.ts` | 改画导航与主题，复用既有图标/焦点/抽屉。样式量大可单建 `desk-styles.ts`，通过 `WORKBENCH_CSS` 原 style effect 装配。 | 新增根选择器、全局快捷键监听、独立应用和外部字体请求。 |

**受保护区域**：[embedded-views.tsx](../packages/platform-workbench/src/client/embedded-views.tsx)、[submission-observer.ts](../packages/platform-workbench/src/client/submission-observer.ts)、`EmbeddedSessionHost`、`WorkConsole` 的 `leaveRunView/adoptWorkReference/workEpoch`、`SessionProvider` 与 `renderSlot('workbench.session', {})` 装配、运行视图提示条。现有代码在同一组件混合布局与引用管理，只动 shell/heading/aside 的 JSX 与外壳样式。侧栏收起使用稳定 DOM 结构；不可用按宽度条件返回两棵不同的 WorkConsole 树。纯历史会话继续走 `HistoryConsole`，不套业务索引/Run 资料。

## 5. 视觉与可访问性规格

- 默认「夜蓝双栏 / 白色工作面」：导航轨 `#10172F`、索引底 `#1C2B50`、栏内分隔 `#374970`；左栏标题白色，普通工作名 `#EDF2FF`，元数据 `#B7C5E4`。活动导航用 `#30446E`，选中工作用白字钴蓝实底 `#284DC8`，配亮侧标 `#A9D6FF` 和字重。祖母绿只在品牌图形处少量使用。右侧沿用白画布、正文 `#202126`、次文 `#5E6069` 和浅资料栏 `#F8F8F9`，不将白底正文颜色继承到深索引。
- 右侧主动作继续用 `#254FE4`，下载等直接动作用蓝字，待复核 `#774C0A` / `#FFF1D9`，已完成 `#386247` / `#EBF3ED`。深栏键盘焦点使用独立亮色轮廓，区别于持久选中标记。默认稿是深浅分区，不是全局暗色主题；系统暗色需单独适配验收。不得向原生会话覆盖 token。
- 字阶：资料页标题 32–44 px，区域标题 20–24 px，工作行 15–16 px，辅助信息 12–14 px；系统中英文字体栈、时间数据等宽数字。间距 4/8/12/16/24/32/48；普通控件 6–8 px 圆角，底稿容器 12 px。大封面仅用于已登记的文件；不搞 KPI 卡、营销横幅或循环动画。
- 1512 px 参考图：导航轨约 84、索引约 310、资料栏约 255，其余给正文。**不是固定四列合同**。先量宿主给的侧栏宽度，保留原 resize/折叠；正常宽度显示带标签导航，原生折叠态显示图标轨。不改 profile 强制 84 px、不留人为造出的空列。索引在主区 240–310 px 内自适应。
- 依据**主区实际宽度**而不是浏览器整窗调整：可用宽 ≥1120 px 且中心净宽 ≥600 px 时保留索引+会话+资料；否则先将索引收成标题处「工作索引」按钮；仍不足 840 px 时资料也改为「工作资料」面板，中心占剩余全宽。手机只保留一个临时面板，不能与宿主全局抽屉叠开。首页宽度不足 800 px 采用索引→摘要单列、有明确返回，不塞左右并排小字列表。
- 用 `nav/main/aside` 语义及名称区分全局导航和工作列表。普通按钮列表不冒用复杂 tree/grid 角色。抽屉用项目已有 modal 层模式：命名、聚焦首控件、Tab 圈、Escape、关闭后焦点还给触发器。正文对比 ≥4.5:1；焦点可见；图标有可访问名称；触控目标以 44 px 为目标。长中英文名、200% 缩放、减弱动态和紧凑模式不得遮挡输入框。新增文案须提供 zh/en。

## 6. 可认领工单（按依赖实施）

估算为熟悉项目的单人净开发时间，不含等待宿主环境、UAT 或发布窗口。**同组文件只有一位写入负责人**，尤其 `WorkbenchPage.tsx/styles.ts/i18n.ts`；开始前查实时 diff、确认其它会话范围。每项完成有可检查的中间产物，不能用设计截图代替证据。

| 工单 / 前置 | 实施范围与完成条件 | 估算 |
|---|---|---|
| B0 基线 / 无 | 在隔离员工 profile 核对 slot/版本和真实可用宽度；存首页、工作会话、窄屏基线，记录分支、已存在 diff、原生会话/Run 坐标与已有失败。使用合成数据；记录两种装配（默认侧栏存在/员工 overlay）下只有一套企业导航。缺宿主则标记阻塞，不动生产。 | 0.5 天 |
| B1 索引数据 / B0 | 提取列表查询及纯投影，先不换 UI。补 `work-index-model.test.ts` 和查询边界用例。现有查询、恢复、归档、超过 bootstrap 页的工作仍能找到；过时请求不覆盖新结果。 | 1 天 |
| B2 外壳 / B0、B1 | 替换企业导航皮肤、主区网格；在 works 首页接 `WorkIndex`，其余页面保持可达。焦点与快捷键保留；主题/密度/宽度变化不卸载原生会话。提交物是可操作的插件界面，不是从 PNG 切出的背景图。 | 1 天 |
| B3 首页摘要 / B2 | 接 Work/Run/待办/成果/事件契约，完成空、加载、失败、无权、归档、元数据未封存、多成果和安全下载。将完整详情、待办及创建向导接回现有入口。测试「浏览三项、零创建/绑定/执行请求」。 | 1–1.5 天 |
| B4 工作页 / B2、B3 | 在同一外壳布局中放现有 WorkConsole，给右栏可辨的「当前运行、待处理、文件成果、运行记录」分组。原有复核、交付、问答、事件、知识依据、草稿/执行器、重试、专家详情保留入口与错误。高优先事项不藏在默认关闭的深层面板。视觉收拢不改挂载时机/请求语义。 | 1 天 |
| B5 交互与主题 / B3、B4 | 对齐中英、键盘、深浅主题、窄屏、断网、长名、恢复和撤权。更新过期的 concept-draft 样式断言以检验新职责，不能通过删除防回归断言换绿。补工作台文档和视觉证据。 | 0.5–1 天 |
| B6 实机回归 / B5 | 执行下列命令与宿主矩阵，记录通过、失败、未执行；验证会话/提交唯一性、可回退。输出证据清单和剩余风险，由负责人判定是否进入发布流程。 | 1 天 |

## 7. 验收矩阵（QA 可直接执行）

预置两个合成项目、同名不同 ID 的工作、一个归档工作、超过一页的列表、一个未绑定工作；至少一个有两次执行的 Work（不同 `runId`、不同原生执行 Session），以及一份已封存和一份仅元数据的成果。另备无权限/无待办接口/超时场景。故障注入仅在夹具或隔离环境。矩阵中的请求计数是**用户操作造成的增量**，排除已记录的宿主后台刷新。

| ID | 操作 | 通过标准与证据 |
|---|---|---|
| A01 | 首次打开、预览 A/B、搜索另一页、翻页、过滤归档、清筛选 | 选中项与摘要 ID 一致，列表无重复；只读浏览不产生 create/bind/run/submission 写请求；用网络摘要和录屏证明。 |
| A02 | 对 A 慢响应时切 B；A 的成果晚返回；B 返回 403、超时，再恢复授权 | 绝不闪现 A 的标题/成果为 B 内容；403 清掉不可访问内容，超时可就地重试；未知不报零。 |
| A03 | 在待答/待复核/已成功未复核/无 Run 的工作间切换 | 四种状态文字可区分；处理入口落到实际 Work/Run；归档只读，未绑定工作仅显式进入才运行既有绑定流程。 |
| A04 | 下载封存文件、查看未封存文件、令下载返回非 2xx | 成功件名称与合成夹具内容一致；未封存无下载；失败有提示且无伪下载文件。初次画封面不请求文件正文。 |
| A05 | 同一 Work 输入未发送草稿，展开/收起索引与右栏、切主题与宽度 | 草稿、光标可恢复，View 不重置，无额外 Session、无新增提交；输入框可见可操作。 |
| A06 | 在隔离宿主发送唯一标记，观察流式/工具/停止、附件、问答与队列 | 走原生交互，按能力逐项记录；一次发送仅有一个原生提交及预期企业关联。网络重放或失败不能记成成功。 |
| A07 | 工作会话 → Run A → Run B → 回到工作会话；刷新已定位 Run，再从历史会话打开普通 Session | 会话/轨迹标签、实际绑定与提示条正确，未出现 released reference；普通历史会话不显示 Work 资料，不写业务绑定。 |
| A08 | 无结果、超长中英文、数十种应用；从项目/应用创建、查看完整详情/待办/平台设置 | 合成名称不进入生产文案；原有入口可达，筛选/向导上下文不丢。深链到未在 bootstrap 首屏的 Work 可恢复。 |
| A09 | 1512×948、1280×800、1024×768、390×844；深浅主题、中英、键盘、200% 缩放 | 桌面与二稿对照；实际宿主宽度差异有记录。无页面横向溢出，无双主导航或遮住 composer 的常驻层；面板焦点、Escape、返回焦点正常。 |
| A10 | 禁用/重新装载测试插件，回退测试构建，再开原 Work/Run/Session | 无多余 stylesheet/监听器；旧入口和坐标可恢复；历史、成果和提交数不被删除或重建。 |

**执行入口**（仓库根目录；Node ≥24.9.0，依赖按当前工作区已锁定的配置装配）：

```bash
node --version
```

```bash
npm --prefix packages/platform-workbench run verify
```

```bash
node scripts/verify-all.cjs
```

包验证包含类型检查、构建和测试。沿用 [UX 与原生中心合同测试](../packages/platform-workbench/tests/ux-contract.test.ts)、[导航测试](../packages/platform-workbench/tests/navigation.test.ts)、[观察器测试](../packages/platform-workbench/tests/submission-observer.test.ts)，补行为/宿主验证，不能只对源码做正则。实机装配参考[原生宿主验证基线](native-workbench/evidence/NATIVE-ASSEMBLY.md)与[现有启动入口](../scripts/native-workbench-start.cjs)；先核对隔离 home、数据与端口，**不要把当前员工实例当测试环境**。宿主权限、浏览器工具、模型或执行器不可用时，记录哪个用例被阻塞，静态预览不计实机通过。

## 8. 交付、回退与开工顺序

**交付包**：插件源码及测试、上述三条命令的环境/退出码、A01–A10 矩阵、同一组夹具的前后对照图、异常流程证据。证据只保留合成内容；持久化 ID 可用同一测试别名关联，禁止上传认证信息、真实路径与临床正文。标清「代码门禁」「宿主实测」「人工视觉评审」「未验项目」四类，不写笼统的“全绿”。

**回退**：实施前记录当前可用插件构建/版本及隔离 profile 摘要。若出现中心重挂、重复提交、跨工作数据串显、撤权后旧资料可见或移动端无法输入，停止推进；在隔离 profile 切回原构建并复验 A07/A10。不要通过代码里留一套旧 UI、清空用户浏览器状态、回滚整个脏工作树或迁移数据库来回退。真实发布、登记版本、切默认发布及生产 profile 另行审批。

**接手第一步**：从 B0 开始，在当前工作树找到 `WorksQueue`、`WorksPage`、`WorkConsole`、`EmbeddedSessionHost` 四个符号并标记最后一个及会话交换区为保护区；记录现有查询、进入会话和发送一条合成消息的基线。B1 先证明抽取没有改变行为，才开始改画面。完成定义是 B1/B2 两张视觉图在真实插件内对应到正确数据与动作，并通过上表，不是看起来相似的单独网页。
