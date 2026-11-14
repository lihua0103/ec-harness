# 原生 WebUI 企业工作台 — 总状态表

依据：`docs/NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md` 第 8 节交接模板。
单一事实源：本文件。不在多处复制互相冲突的状态。

## 总览

| 任务 | 状态 | 依赖 | 负责人/文件范围 | 证据 |
|---|---|---|---|---|
| T00 接手基线与写入所有权 | DONE | — | 单一接续会话；全仓库只读 + `docs/native-workbench/evidence/BASELINE.md` | BASELINE.md |
| T01 上游能力矩阵与 ADR | DONE | T00 | 只读上游 + `docs/native-workbench/CONTRACT-MATRIX.md`、新 ADR | CONTRACT-MATRIX.md、ADR-0003 |
| T02 最小原生 Host/Client 集成 | DONE | T01 | `packages/platform-workbench/**` | 真实 Loader+浏览器：品牌 slot、零错误、刷新不重复、两轮同 Session（`evidence/T02-NATIVE-LOADER.md`）；**启用→禁用→启用往返无 slot/样式/品牌残留**（`evidence/nw23-disabled.json`、`nw23-enabled.json`） |
| T03 企业对象与持久存储 | PARTIAL | T01 | `platform-control`（store/service/works/projects + 新增 session-bindings） | session-bindings.test（6 项） |
| T04 身份与执行域访问适配 | PARTIAL | T01,T03 | `platform-control`（新增 identity-access） + `platform-identity`（复用） | identity-access.test（5 项）；真实 SSO 未接（NW11 BLOCKED） |
| T05 交互提交与执行记录集成 | DONE | T02,T03,T04 | 集成包 Host/Client + `platform-control`（submissions） | submissions.test（6）、binding-http.test（4）；**原生 composer 提交经持久事件窗关联为 CONSUMED Submission，绑定前历史不回填**（`evidence/t05-submission-correlation.json`，13/13） |
| T06 企业导航与工作上下文 | DONE | T02–T05 | 集成包 Client（sidebar.panellist + main keyed 整页） | **企业外壳主导，单页嵌入形态（2026-11-13 修订）**：单一 `main` 页 `emerald-platform`，页内导航（项目空间/应用中心/我的工作/待处理/平台设置）+ 主内容 + 右栏上下文/成果；启动默认选中并收起原生侧栏；打开工作**不再切页**——原生会话以 embedded 变体嵌入页内（单页形态，见 T13 修订），「返回工作台」页间切换动作退役；装配与边界见 `evidence/NATIVE-ASSEMBLY.md`，浏览器实证见 `evidence/EMBEDDED-SESSION-EXPLICIT-SCOPE-E2E.png`。原生 `sidebar`/`conversation` 键由上游拥有；平台页激活时**完全隐藏原生侧栏**（可逆布局模式，进入会话恢复），切换/恢复 8/8（`RETIREMENT-SHELL-TRANSITION.json`） |
| T07 成果与输入批次 | DONE | T03,T05,T06 | 控制面成果/输入 + 集成包 Client 成果视图 | 成果/输入批次/执行输入视图、分页、封存下载、空状态；`evidence/T07-T09-REPORTS-UX.md`、`t07-t09-browser.json`；业务审核绑定与候选文件区分未实现（不计入本项） |
| T08 本地与集中部署装配 | PARTIAL | T02,T04,T05 | `scripts/native-workbench-deploy.cjs`、`native-workbench-start.cjs` | 本地真实启动 + 种子 API 全链路；hosted 描述符/单控制进程已验，**集中运行形态 BLOCKED**（`HOSTED-2026-11-12.md`） |
| T09 UX 与可访问性 | DONE | T06,T07,T08 | 集成包 Client 视觉系统与交互 | 22/22 浏览器检查 + 本轮新增表单/问答沿用同一作用域与焦点；`evidence/t07-t09-browser.json`。**2026-11-13 概念稿对齐**：视觉系统/首页信息架构/工作控制台外框重做（线程仍原生），真实宿主回归 28/28＋问答专项 10/10＋规模检索 18/18、浅暗两主题 128/128 文本配对 ≥4.5:1、包测试 55/55、`verify-all` 13/13；见 `UI-REFRESH-2026-11-13.md` 与 `evidence/UI-REFRESH-2026-11-13-*`。locale 资源仍未接入（规范 §5.3 未完成项） |
| T10 历史迁移与正式入口切换 | PARTIAL | T03–T09 | 迁移脚本 + `apps/enterprise-workbench` 替换/退役 | 企业外壳覆盖旧入口主流程；**三项缺口已补齐并验证**；退役**阶段 0–3 已完成**：备份 51 文件（`.runtime/nw-retirement/backup-20261112T171025`）、旧入口只读预演 7 Works/0 Runs、dry-run 7 Works 全部 verified-session（digest `a50557a5…`）、入口切换为 API-only（旧 URL 404，回退 `--app` 实测 200）；**阶段 4 删除/归档未执行，需用户再次确认** |
| T11 全链路验证 | PARTIAL | T00–T10 | §6 NW01–NW24 + `scripts/verify-all.cjs` | 16 PASS / 3 NOT_RUN / 5 BLOCKED（`ACCEPTANCE-2026-11-12-T12.md`） |
| T13 嵌入式会话宿主探针 | DONE | — | 只读上游 + `docs/native-workbench/EMBEDDING-PROBE-2026-11-13.md` + `packages/platform-workbench/**` | 方向修订实证并**落地为正式实现**：外部 keyed `main` 页宿主 `conversation.content` embedded 变体。**探针配方已修正**：探针所用的 `retain(source:'mainView')` 依赖主视图选举，在完整应用中失效——`ui-session` 的 `publishMain` 选举是粘性的，`ui-workspace` 启动即以 `mainView` 持有开机主会话且永不释放，第二次 `mainView` retain 不会改选（正式实现曾因此短暂绑错会话）。正式配方改为上游右栏 Sidebar 的显式作用域模式：插件自持 `SessionReference`（`source:'platformWorkbench'`，`SessionReferenceSourceMap` 模块扩充声明）+ `<SessionProvider session={reference}>`，作用域绑定到该引用、不与主视图竞争。浏览器 E2E 实证：嵌入会话渲染绑定 Session、真实发送流入绑定会话、控制面 Submission 状态 CONSUMED（`b23cf010…`）、0 控制台错误（`evidence/EMBEDDED-SESSION-EXPLICIT-SCOPE-E2E.png`）；包门禁 tsc/build/45 测试全绿，`verify-all` 13/13 |

状态语义：NOT_STARTED / IN_PROGRESS / DONE / BLOCKED（附阻塞说明，不写成已完成）。

## 当前环境与已知约束

- 仓库 HEAD：`53fd85efd79c81784a0dff7ef86f4ae5e4b97c37`（main）
- 上游锁定：`0.2.2-rc.1` @ `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`
- Node：本轮在 **24.9.0**（合规）下执行；下列门禁为该环境实测。
  - 2026-11-12 第三棒：platform-control **107/107**、platform-workbench **45/45**、`verify-all` **13/13**；
    开发规范检查 PASSED。
- 未提交：本轮新增/修改未提交；T00 起不覆盖、不回写旧快照。
- 无生产 profile 修改；浏览器验证使用 `.runtime/nw-web-home` 隔离 profile。
- **从 upstream checkout 目录启动 `dsh web` 会在上游工作区生成未跟踪 `web/` profile 工作区**，使 dm-listing 发布溯源检查（`UPSTREAM_WORKTREE_DIRTY`）失败。启动后须删除该生成物；verify-all 才能通过（2026-11-13 实测）。

## 写入所有权边界

- 单一接续会话负责本任务链全部改造；未发现其他会话持有文件写锁。
- 禁止并发编辑：manifest、pnpm-lock.yaml、总导航、同一测试夹具。

## 最近一次交接

- 时间：2026-11-14（Listing 四场景入口 + 活动运行护栏 + 员工验收环境）
- **Listing 场景入口**：发起运行卡新增「Listing 场景」选择，选项取自已发布应用的 `descriptor.listingTypes`（Manual / Medical / PK / Report），随 `input.applicationOptions.listingType` 交给 Worker；信封由纯函数 `forms.runInput` 生成并有单测。
- **同一工作活动运行护栏**：工作已有 QUEUED/STARTING/RUNNING 运行时「发起运行」禁用并说明；服务端另有**按工作区目录**的限制 `WORKSPACE_ACTIVE_RUN_EXISTS`（同一目录只允许一个活动运行），跨工作的并发仍由服务端拒绝并原样显示 code。
- **员工验收环境**：`.runtime/setup-employee-e2e.cjs` 先备份真实库（`.runtime/platform-live/backup-*`），再用 `.runtime/employee-e2e` 独立 store 与 `.runtime/nw-employee-home` 干净 home 起平台（控制面 3097、原生工作台 3095，复用真实 worker 与发布）。公开项目「公开肾脏试验数据」含 EMPA-KIDNEY 与 DAPA-CKD 两个空间（`.runtime/renal-trial-docs`）。
- **员工模拟**：按员工视角新建 1 个 DVP 工作与 4 个 Listing 场景工作，全部自动登记本机执行域、绑定原生会话；DVP 工作完成 3 轮原生对话且流式（250ms 采样 13 个不同长度）。Listing 四个场景的真实运行结果：**Medical / PK / Report / DVP 均 SUCCEEDED**，各自的产物已封存并登记（Medical 3 项、PK 3 项、Report 1 项、DVP 3 项）。listing 的 Manual 首次运行 **FAILED**，原因 `WORKER_MANIFEST_INVALID:artifact name`——模型在 `platform-result.json` 里把中文标题写进了 `name`（登记名/下载路径只接受 `[A-Za-z0-9][A-Za-z0-9._/-]{0,255}`）；产物文件已写在本次产物目录但未登记。已在 `workerPrompt` 明写 name 契约（只允许安全字符、通常等于文件名、标题写 summary），platform-control **110/110**；Manual 以新运行 `7a3ed92d…` 复跑 **SUCCEEDED**（~15 分钟），登记 3 项封存产物：`EMPA-KIDNEY_Manual_Listing_README.md`、`EMPA-KIDNEY_Manual_Listing_Spec_v0.2-draft.xlsx`、`EMPA-KIDNEY_Manual_Listing_skeleton_v0.2.R`。至此 DVP 与 Listing 四个场景全部成功登记。
- 门禁：platform-workbench **59/59**、platform-control **110/110**；`verify-all` **13/13**。未提交、未推送。
- 时间：2026-11-14（工作台内新建并绑定原生会话）
- **绑定入口落地**：工作详情新增「原生会话」卡——未绑定时「新建原生会话并绑定」，已绑定时可「重新绑定新的原生会话」（服务端把旧 primary 降为 reopened）。会话通过 `ctx.sessions.create` 在工作的真实目录创建，目录先经原生 `workspaces.create` 登记（Host 幂等），因此嵌入会话打开即为可输入态而不是「选择工作区」。无执行域时先登记本机执行域（local）。执行域选择与绑定载荷在 `work-context.ts` 的 `selectBindingDomain`/`bindingDraft` 里为纯函数，缺工作空间或 release digest 直接拒绝。
  - 门禁：platform-workbench tsc/build/**58/58**；`verify-all` **13/13**；开发规范检查 PASSED。
  - 真实宿主浏览器实证（Edge headless，1440×900，隔离 home `.runtime/nw-platform-web` + 真实控制面 3096）：未绑定工作点开后进入详情并显示绑定卡 → 点击后 `GET /api/domains`、`POST /api/works/:id/bindings` **201**、嵌入会话挂载（`data-ec-embedded-session` 命中）、composer 可用、0 控制台错误；重新绑定路径同样通过（旧关联 demoted）。真实对话两轮：回复按原生流式呈现（200ms 采样 13 个不同文本长度）、显示 70 tok/s 与用量。
  - 副作用（真实库）：登记了 1 个本机执行域；CKD 工作绑定 `session-cf1d487d…`（工作目录 nhanes-ckd），EMPA-KIDNEY 工作绑定 `session-3f79ab63…`（empa-kidney）；CKD 早期测试会话 `session-e6ca8f74…` 保留为 reopened。未提交、未推送。
- 时间：2026-11-13（单页嵌入形态落地，接手方向修订）
- **单页嵌入重写完成（2026-11-13，用户批准「是，开始重写」）**：WorkbenchPage 重写为单页嵌入形态——企业工作台保持唯一 keyed `main` 页（`emerald-platform`），原生会话能力经 `renderSlot('workbench.session')` + `conversation.content` `variant:'embedded'` **嵌入页内**；`selectPanel(null)` 两页切换与「返回工作台」头部动作退役。关键实现事实：
  - **探针配方修正（必读）**：`EMBEDDING-PROBE-2026-11-13.md` 的 `retain(source:'mainView')` 配方在完整应用中**不成立**——`ui-session` `publishMain` 选举粘性（`ui-session/src/client/index.ts:460-475`），`ui-workspace` 启动 `restoreSelection` 即以 `mainView` 持有开机主会话且长期持有，第二个 `mainView` retain 永不改选；浏览器曾实证嵌入视图因此短暂解析到错误会话（绑定 `session-297c5d3b` vs 显示 `session-153073e9`）。正式实现采用上游 `ui-sidebar-right` 的显式作用域模式：插件自持 `SessionReference`（`source:'platformWorkbench'`，经 `SessionReferenceSourceMap` 模块扩充声明）+ `<SessionProvider session={reference}>` 包裹 slot 渲染，作用域绑定到该引用本身，不触碰主视图选举。
  - 生命周期：`retainSession/releaseSession` 由 `index.ts` 持有并注入；页面离开会话视图时 React 卸载先于 `releaseSession()` 清理执行（渲染器不会读到已释放引用）；插件卸载经 ctx.effect 兜底释放。
  - 浏览器 E2E（修复后复验）：打开工作 → 嵌入视图渲染绑定 Session（seed 历史可见）；经嵌入 composer 真实发送 → 流式回复写入绑定会话；控制面 Submission `b23cf010-c89c-4842-b036-124e8054c172` 状态 CONSUMED、会话正确（`session-297c5d3b…`）；工作列表/详情/会话三条导航路径往返正常；0 控制台错误。证据：`evidence/EMBEDDED-SESSION-EXPLICIT-SCOPE-E2E.png`。
  - 门禁：platform-workbench tsc/build/45 测试全绿；`verify-all` **13/13**。注意事项：从 upstream checkout 目录启动 `dsh web` 会在上游工作区生成未跟踪 `web/` profile 工作区，导致 dm-listing 发布溯源检查 `UPSTREAM_WORKTREE_DIRTY` 失败；本轮已删除该生成物恢复干净（已记入下文环境约束）。
- 时间：2026-11-13（方向修订 + 嵌入式探针）
- **方向修订（2026-11-13，用户定调）**：一个工作台不能有两套页面风格、更不能是独立两页；接入方式改为**将原生 chat 会话能力以 `variant:'embedded'` 嵌入自研工作台整页**，取代 2026-11-12 确认的 A 方案两页切换。T13 探针已实证可行（外部 keyed `main` 页宿主 embedded 工厂、当前主会话经根 ScopeProvider + `retain(source:'mainView')` 自动解析、无主 Header、无会话落地态不崩；上游 vitest 2/2）；配方与机制见 `EMBEDDING-PROBE-2026-11-13.md`。~~下一步：按配方重写 WorkbenchPage 为单页嵌入形态~~（已完成，见上）。
- 时间：2026-11-12（第三棒 + 外壳重建）
- **最终形态已确认（2026-11-12）**：A 方案——单一插件 keyed `main` 整页（页内企业导航+内容+右栏）、默认首屏并收起原生侧栏、打开工作切原生 `conversation`、会话头部「返回工作台」；装配/边界见 `evidence/NATIVE-ASSEMBLY.md`。
- 完成：
  - T10 原生整页覆盖旧入口主流程：新建工作/草稿/发起运行/问答回复/模型选择；浏览器 19/19 PASS。
  - T05 原生 composer 提交 → 企业 Submission 关联（持久事件窗 + `rpcId`，非 DOM 拦截）；13/13 PASS。
  - T02/NW23 启用→禁用→启用往返（无 slot/样式/品牌残留）。
  - T11：NW05、NW08（重启 + 并发写）、NW09、NW10、NW17（平台语义）、NW23 转 PASS；NW15 维持 NOT_RUN（单模型）；NW18 NOT_RUN（无真实 DVP）；NW22 NOT_RUN（dry-run + 摘要守卫）。
  - T08 hosted 逐条核对：描述符/单控制进程已验，运行形态 BLOCKED（`HOSTED-2026-11-12.md`）。
  - 企业外壳重建（A 方案）：单一插件整页 + 页内企业导航 + 右栏上下文/成果；默认首屏并收起原生侧栏；打开工作切原生会话，会话头部「返回工作台」；装配证据 `evidence/NATIVE-ASSEMBLY.md`，浏览器 17/17（`t12-a-shell-browser.json`）。三项能力缺口已补齐，另有首版 21/21 证据（`t12-shell-browser.json`）。
  - 契约修订：`resource` 路由只读、写入口必须 `handler`；Session id 含 `session-` 前缀；`sidebar`/`sidebar.workspaces` 为 single slot，插件不能整体替换左侧栏（`CONTRACT-MATRIX.md` §3）。
  证据：`IMPLEMENTATION-2026-11-12-T12.md`、`ACCEPTANCE-2026-11-12-T12.md`、`evidence/t10-ui-smoke.json`、`t05-submission-correlation.json`、`nw05-browser.json`、`nw08-*.json`、`nw09-submission-faults.json`、`nw10-browser.json`、`nw17-nw18-evidence.json`、`nw22-dryrun-*.json`、`nw23-*.json`。
- 下一任务：按 `RETIREMENT-PLAN-2026-11-12.md` 先处理三项能力缺口（原生页新建项目、运行取消/重试/对账、工作归档），
  再走备份→预演→逐 Work 迁移→只读并存→清理；每一步的破坏性操作需用户明确确认。
  NW15 需第二条真实路由模型；NW18 需真实 DVP 修订；NW11–NW14/NW20 需真实身份/撤权/集中域。
- 退役执行（2026-11-12）：阶段 0 备份、阶段 1 旧入口只读预演、阶段 2 dry-run（7 Works / 7 verified Session / 0 只读 / 0 未知，摘要 `a50557a5…`）、阶段 3 入口切换（API-only，旧 URL 404；回退 `--app` 实测 200）已完成；阶段 4 删除/归档未执行。证据：`RETIREMENT-EXECUTION-2026-11-12.md`、`RETIREMENT-DRYRUN-1/2.json`、`RETIREMENT-PRE-SWITCH-OLD-ENTRY.png`、`RETIREMENT-POST-SWITCH-NATIVE.png`。
- 是否提交/推送：默认否（用户未请求）。
