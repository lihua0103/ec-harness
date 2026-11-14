# 上游能力矩阵（T01，锁定 DSH 0.2.2-rc.1 @ fcc0ad46）

证据等级：**S**=源码已核实（本地锁定文件+签名）· **A**=装配已核实（bundle/profile 行存在并经启动验证）· **B**=实际行为已验证（真实运行）。
本文件不把 S/A 冒充 B；标 B 的项必须有可复现运行证据路径。

## 1. 原生 WebUI 组成（bundle/web-app + bundle/base 行）

| 行 id | 包 | 角色 | 证据 |
|---|---|---|---|
| session-controller | `@deepseek-ai/dsh-api-session-controller` | 会话命令/历史流/实时控制/身份策略；`ctx.sessionController`/`ctx.remote.session` | S+A |
| remote-access | `@deepseek-ai/dsh-api-remote-access` | 非 owner Peer 方法级授权、列表过滤、访问快照 | S+A |
| typert-gateway | `@deepseek-ai/dsh-api-gateway` | Remote 网关 + 资源解析 | S+A |
| user-questions | `@deepseek-ai/dsh-user-questions` | 原生问答 | S+A |
| webserver / web-runtime | `@deepseek-ai/dsh-host-webserver` / `@deepseek-ai/dsh-web-app` | HTTP 宿主与 SPA 壳 | S+A |
| frontend-static | `@deepseek-ai/dsh-host-frontend-static` | 认领 webserver fallback seat，服务 dist/index.html；index 需进程 token/cookie | S+A |
| file-upload | `@deepseek-ai/dsh-client-file-upload` | 浏览器附件上传 receipt | S+A |
| ui-session | `@deepseek-ai/dsh-client-ui-session` | `useSessionAccess`/`useAccess` 标准 Hook | S |
| ui-conversation | `@deepseek-ai/dsh-client-ui-conversation` | 会话装配、input、slots、per-session binding | S |
| ui-chat | `@deepseek-ai/dsh-client-ui-chat` | Chat View + 节点渲染 | S |
| ui-approval / ui-attachment / ui-tool / ui-workspace | 同名 client 包 | 审批视图、附件、工具树、工作区导航 | S |

装配顺序见 `packages/bundle/web-app/cordis.patch.yml`（ui-session → resources → ui-sidebar → … → ui-conversation → ui-approval → ui-chat → ui-brand-official → ui-attachment → ui-tool）。

## 2. 逐能力矩阵

图例：公开入口 = 本项目可消费的 export/ctx key；级别见上；本项目映射 = 计划调用点。

### create / resume
- **公开入口**：`ClientSessions.create(opts:{workspaceId?,cwd?,sessionId?,agentPreset?}) → SessionId`；`sessions.retain(target,{source,signal})` 返回可 `release()` 的引用；`Session.open()`。冷/热会话由 Host `session.create` 复用规则决定（blank + 同目录 + 未归档 + 无其他写者才复用；否则新建）。
- **签名证据**：`packages/api/session-controller/src/client/sessions/service.ts:450-475`（S）
- **角色限制**：非 owner 需 `session/create` global 角色；owner 免检。**跨写者**由 Host 拒绝（`session/conflict`、`session/writer-held`）。
- **本项目映射**：`ensureWorkSession`（T05）先建企业意图，再调 `sessions.create`，以返回的真实 `sessionId` 为准，不把请求 id 当最终 id。

### prompt
- **公开入口**：`Session.prompt(content: PromptContentPart[], mode:'queue'|'steer', signal?, requestId?) → RemoteResult<{accepted:true}>`（S: `sessions/session.ts:257-271`）；wire `remote.session.prompt({requestId,sessionId,mode,content,clientTimeZone})`。
- **关键事实（T05 直接依赖）**：
  - `requestId` 是客户端铸造的 `SessionRequestId`（Branded），**Host 对已排队/已记录的同 requestId 重试返回原接纳、不再插入**（README:38）。→ §3.1 的 `(domainId,sessionId,requestId)` 唯一不变量有原生支撑。
  - `user-rpc` 持久消息源携带 `rpcId`；**非 owner 才写 `principal`**，无 principal 即 owner（`types.ts:400`）。→ 可信提交者来自原生 principal，不是模型参数。
  - 仅 create/fork 直接创建 Agent；prompt 可 resolve/resume 普通会话。
- **本项目映射**：correlateSubmission 不重复实现 requestId 去重，以原生接纳回执为准；企业侧只记录意图与对账。

### queue / steering
- **公开入口**：`updateQueue(itemId: MessageId, action: QueueAction)`；`QueueAction = {edit,content}|{remove}|{steer}`（S: `types.ts:144-153`）；`sessions/session/session.ts:353`；inbox/QueueDock 语义（README:62-65）。
- **本项目映射**：T05 支持运行期 queue/steer，关联执行区间；不另起队列协议。

### cancel
- **公开入口**：`Session.cancel() → RemoteResult<{accepted:true}>`（S: `session.ts:364-368`）；取消需 live state。
- **本项目映射**：`requestWorkStop` 只调用原生 cancel，不直接写企业终态；终态由原生结算 + 控制面 barrier 决定。

### follow / history / events
- **公开入口**：`SessionEventStream`（Gateway `RemoteJournalStream`，绑定 address）；`createSessionControlStream(remote, opts)`（S: `transport.ts:115`、`137`）；`loadOlder()`/`loadThrough(seq)`；append/prepend/replace/settle-assistant 增量。
- **关键事实**：Assistant live delta 走 **Client-only transient `assistant/live-chunk`**（S: README:60），**不是 SDK 新增 delta**；durable `assistant/message` 结算后替换临时行。→ T02 的"真实流式"复用此通道，不自造。
- **本项目映射**：`observeWork` 走原生 follow，不代理成 activities；企业历史只做投影，不建第二份正文库。

### model
- **公开入口**：会话级 model 选择是 Host 命令（session/model 相关），run 快照属本项目控制面（`models.ts` ModelConfigSnapshot）。原生模型列表经 `session/provider-models*` 错误码可见（S: `types.ts:187-189`）。
- **本项目映射**：模型默认值/选择沿用现有 platform-control 的"显式→偏好→默认"冻结逻辑；原生 UI 的模型座位通过 slot 读控制面目录，不另建模型协议。

### question / approval
- **公开入口**：`session/inbox` 投影携带 `'approval'|'question'|'other'` 待处理；SDK `onUserQuestion` 由控制面 `awaitQuestion` 持久化（S: 本仓 `service.ts:1109`）。
- ****非 owner 限制（BLOCKED 依据）**：`remote-access/README.md:87` 明确 **Interaction participation（答复转发 waterfall）owner-only**；非 owner 只收到策略允许的广播帧。→ 集中模式非 owner 问答/审批**当前无公开参与接缝**；T02 需给可重复失败测试 + 最小扩展设计，未闭合不得过 NW13/NW20。

### upload / file
- **公开入口**：`fileUploads` receipt（Host 服务）；prompt admission 消费 receipt（README:38）；`session.attachment` 读取；`file-upload` client 行。附件是**存储级读取**，隔离靠独立 home/执行身份，不能靠 sessionId 参数。
- **本项目映射**：T07/T08 复用原生上传/预览；封存下载走控制面授权 + SHA-256。

### fork / archive
- **公开入口**：`fork({sessionId,atSeq?,increaseTitle?,allowMigration?}) → childId`（S: `service.ts:476-510`）；fork 精确复制事件前缀，不继承 parentSession；archive 经 Workspace registry 的 `ArchivedSessionGate` 拒绝 archived 会话的 step（README:81）。
- **本项目映射**：fork/换应用/换域产生显式新关联或新工作（§3.4），不静默转移原会话。

### access（非 owner）
- **公开入口**：`RemoteAccessPolicy.registerPolicy(kind,policy)`、`invalidate(principal?)`、`decide/allows/snapshotFor/follow`；Client `useRemoteAccess/useSessionAccess/useWorkspaceAccess/whenAccess/whenResourceAccess`。
- **关键事实**：`session/list|search|control` 读 `global`、需 `global` 角色；`session/prompt|events|follow|projections|state|wait` 读 `session` 资源；列表按 `allows()` 过滤。**撤权**：业务包在每次授权/撤权/过期调用 `invalidate`，开放快照重算。
- **Exact Fetch 路由**：**不经 Gateway**，非 owner 一律 403 直到各路由声明访问规则（README:86）→ T08 附件/下载路由必须逐条授权，不能只测 WebSocket。
- **本项目映射**：T04 用 `platform-identity.InMemoryAccessDirectory` 实现 `RemoteAccessPolicy`，`invalidate` 接权限缓存失效。

## 3. slots / 打包 / 跨进程控制

- **Client 装配**：`ctx.uiConversation`（registries + binding）、`ctx.uiSession`（useConversation/useInput/inputActions 标准 props）。`UiConversation.binding(source)` 返回身份稳定的 `ConversationBinding{snapshot,openTurn,activate,target}`（S: `conversation/assembly.ts:260`）。
- **入口插槽**：root `main` key `conversation`；`conversation.hero.frame` hoc Slot；`conversation.session.header.views.actions` 列表；业务入口应经平台 slots 注册，不导入私有组件。
- **打包**：client 包有 `./client` 入口 + `./src/*`；**不打包第二份 React**（Host 依赖外置）。
- **跨进程**：原生 Client 通过 Gateway Remote 命名空间；浏览器的 SSE/fetch 传输在 `bundle/web-app` 的 web transport 行。集中模式转发原生协议，不解码成第二套聊天事件。

### 3.1 Host 路由的写能力（T10 实测发现）

- `webServer.register` 有两种命名路由（S：`packages/host/webserver/src/index.ts:48-75`）：
  - `resource` 路由**只接受 GET/HEAD**；其他方法在读取 body 之前返回 `405 Allow: GET, HEAD`（`serveResource`）。
  - `handler` 路由拥有完整 `IncomingMessage`/`ServerResponse` 生命周期，**接受任意方法**。
- 本项目第一版把企业控制面代理注册为 `resource`，结果所有 `POST/PUT` 被原生服务器以 405 拒绝；
  改为 `handler`（前缀匹配）后 `POST /platform-workbench/api/works` 实测 201。
  **这是与企业工作台写操作相关的公开契约，不是私有 hack。**
- 结论：任何需要在原生 Host 上新增写入口的插件必须使用 `handler` 路由；`resource` 只适合只读投影。
  写入口仍需自行做 Origin/方法/路径/体积校验（本仓 `src/index.ts` 已验证负例）。

### 3.2 Client Session 事件窗与提交关联（T05 实测）

- `ctx.sessions.retain(sessionId, { source })` + `binding.eventSource`（`ObservableSnapshot<SessionEventWindow>`）是公开的
  持久事件窗；`user/message` 事件数据携带 `source.kind === 'user'` 与 `rpcId`（S：`llm/llm/src/message.ts`、`session-controller/src/types.ts:400`）。
- **Session id 形态**：持久 Session id 是 `session-<uuid>`（含前缀），不是裸 uuid。按存储目录名取 id 时不得剥离前缀，
  否则 `sessions.retain` 报 `unknown session`（本轮实测）。
- **新会话可见性**：刚创建/刚选中的 Session 可能尚未进入 Client catalog；`retain` 前允许 `sessions.refresh()` +
  短重试（本仓实现 20×250ms），仍失败则如实报告 unavailable，不伪造提交记录。
- 据此，企业 Submission 的 `rpcId` 关联在**浏览器半**完成（身份即当前 principal）；Host 半不冒充用户身份。
  DOM 监听/提交拦截既非必要也不被采用。

### 3.3 侧栏 slot 的替换边界（T12 实测）

- `sidebar` 是 **single slot**，由 `ui-sidebar` 在 `apply` 中注册；`ui-slots` 对 single 的第二次注册直接抛
  `single slot "<name>" already has a registration`（S：`packages/client/ui-slots/src/index.ts:1256`）。
  → **插件不能整体替换左侧栏**，即使它声明了同名 slot。
- `sidebar.workspaces` 也是 single，由 `ui-workspace` 注册；**原生会话列无法被替换或按工作过滤**。
- 可用的公开洞：`sidebar.brand.mark/name`、`sidebar.panellist`（全局面板行）、`sidebar.panellist.actions`、
  `sidebar.settings`、`sidebar.footer.action`。
- 社区同类产品面（`ui-plugin-manager`、`ui-schedule`）的公开做法：**一个 keyed `main` 页 + 一个
  `sidebar.panellist` 入口 + 原生 `conversation` 作为另一 main 键**；页面是 main 列的整页，聊天不嵌入、
  不重画。本仓 A 方案采用同一形态：单一 `emerald-platform` 页，页内自渲染企业导航/内容/右栏；打开工作
  `selectPanel(null)` 进原生会话，`conversation.session.header.actions` 提供「返回工作台」。
  原生侧栏容器保留（可 `layout.toggleSidebar` 收起）；彻底替换侧栏不在公开能力内。证据：
  `evidence/NATIVE-ASSEMBLY.md`。

## 4. T01 结论（实施约束）

1. **可复用**（S/A）：create/prompt/queue/steer/cancel/follow/model/fork/upload/question 的公开入口均已定位，签名可引用。
2. **必须先做最小实验**（T02）：①公开 slot 能否完整截获原生提交并关联企业执行记录；②非 owner 问答/审批参与接缝（README 明示 owner-only，倾向 BLOCKED）；③跨部署原生连接路由。
3. **不得臆造**：`SessionRemote` 的 wire 方法名在 `types.ts` 只以错误码形式出现；真实方法名以 `remote.session.*` 调用点（`session.ts:271/368/179`）为准，写实现时以类型检查为准，不猜签名。
4. **本项目映射不另起第二套**：企业意图/成果/审计在控制面；会话正文、实时流、队列、取消、问答一律原生。

## 5. 未解决 / 需真实运行确认

- 非 owner 参与问答/审批：**BLOCKED 风险**（README:87），T02 产出可重复失败测试。
- 跨域（两个 ExecutionDomain）原生连接路由：需 T02/T08 实验。
- 真实公司认证协议：未提供，T04 只交付 adapter + NOT_RUN。
- 上游若需修改：制品标识为锁定基线 + 补丁摘要，不声称未改上游通过。
