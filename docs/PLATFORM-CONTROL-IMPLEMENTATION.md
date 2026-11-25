# 平台控制面首批实现（2026-11-11）

对应设计：[应用发布合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)、[运行生命周期合同](PLATFORM-RUN-LIFECYCLE-CONTRACT.md)。
代码：`packages/platform-control`，依赖 `packages/platform-runtime`；作为独立 DSH bundle 安装。

## 已实现

### 应用发布登记（纯数据）

- `AppReleaseDraft`：descriptor（appId/version/displayName/description、可选 listingTypes/materialRoles/resultTypes）、
  requiredCapabilities、providers（插件版本/artifactDigest/协议/schema/依赖）、runtimeBundleDigest。
- 登记时用 `resolveExecutionPlan` 解析确切提供者，检测缺失、冲突、版本不符、依赖循环、同一 pluginId 多版本；
  保存 planDigest 与 releaseDigest。
- 同 appId+version 重复登记：内容相同幂等；内容不同 `APP_RELEASE_CONFLICT`；已撤销不能静默复活。
- 撤销后不能创建新运行；既有运行与历史不回写。
- 登记不 import、不执行任何应用代码。

### 持久运行

- 创建运行冻结 appVersion、releaseDigest、planDigest、输入摘要与输入正文（≤1MB）。
- 运行快照、revision、状态变更事件、actor 与审计持久化到 `$DSH_HOME/platform/control.sqlite`。
- 所有状态变更走 `RunLedger` + CAS revision；重启后从持久快照恢复。
- 取消：QUEUED 直接 CANCELLED；STARTING/RUNNING 只持久 `cancelRequested`，监督器确认进程停止后
  `cancel-settled` 才 CANCELLED。
- 完成：只有监督器可写 `barrier` / `finish` / `fail`，且完成屏障四项事实齐全；工具不暴露这些入口，
  模型不能自报成功。
- 工具返回运行投影时**不返回原始输入正文**，只返回输入摘要。

### 身份与审计

- 工具 actor 从 DSH 会话派生（`session:<id>`），工具参数不能指定 actor。
- `LocalOperatorPolicy` 仅用于本机单操作者：operator 可登记/撤销/创建/取消/读取；service 可派发/开始/
  屏障/完成/失败。企业部署必须替换为身份与项目授权服务。
- 审计记录应用登记/撤销、运行创建、每次状态变更（含 from/to/revision）。

### Worker 执行器（DSH profile/SDK）

- 选型见 [ADR-0002](adr/ADR-0002-WORKER-EXECUTOR.md)：通过 DSH SDK client 启动锁定 profile，而不是自定义
  子进程协议或控制服务内 import 业务代码。
- `DshProfileExecutor` 每次运行创建独立工作目录，传入目标/输入与产物清单契约，不规定工具调用顺序；
  Worker 可使用 profile 内全部能力自主规划。
- Worker 结果清单 `platform-result.json` 声明产物相对路径；适配器在工作目录边界内校验路径、大小并计算
  SHA-256，控制面登记产物后才满足 `artifactsRegistered`。
- 取消会 abort 并关闭 Harness，等待 `cancel-settled`；超时可配置。SDK client 未安装时明确报
  `WORKER_SDK_UNAVAILABLE`，不伪造执行。
- 当前 `worker` 配置默认关闭；配置 `profile/dshHome/workspace` 后才派发。`RunScheduler` 在 worker 配置存在时，
  按 `scheduler.intervalMs`（默认 5000）自动派发一条 QUEUED run；重叠 tick 跳过。
- `reconcileOnStartup`（默认 false）在控制进程启动时把遗留 STARTING/RUNNING 标为失败
  `HOST_RESTARTED_RECONCILIATION_REQUIRED`，不把未知状态当成功。
- `scripts/setup-worker-profile.cjs` 生成隔离 worker profile 模板（base + sdk-app + 平台知识 + 业务插件），
  禁用 plugin-manager 与原生 schedule；模型/凭据由部署 patch 提供。示例：

```bash
node scripts/setup-worker-profile.cjs --home .runtime/worker-home
```

```bash
cd .runtime/worker-home/profiles/worker && pnpm install
```

之后在 platform-control 配置中设置 `worker.profile=worker`、`worker.dshHome` 为该 home 的绝对路径、
`worker.workspace` 为绝对运行目录，并确保 `@deepseek-ai/dsh-sdk-client` 可解析。

### 模型目录与 Run 模型快照（2026-11-11 增补）

对应补充方案 §3–§4 的 S2 后端先决条件；当前是**声明式目录 + 服务端策略校验 + Run 快照**，
不是 DSH `ctx.llm` 实时发现，也未取得 DSH03 集成证据。

- `ModelCatalog`：部署注册的 metadata-only 快照（catalogId、RuntimeBundle 摘要、默认选择、模型项）。
  校验拒绝未知键/密钥类字段、重复 selectionId、非法 selectionId（不得是 provider/model 路由）、
  不存在的默认项；同一内容幂等，变更写 `MODEL_CATALOG_UPDATED` 审计。目录项包含 adapter/
  adapterVersion、enabled/unavailableReason、verification（provider-declared/platform-verified/
  unverified）、能力与允许参数；缺失能力不猜测。目录项可声明 `modelOptions` 默认运行参数
  （2026-11-14 增补；与运行级选项同规则校验，参数不允许即目录无效）：运行未传选项时整条继承，
  运行级选项按键覆盖——目录仍是路由参数的唯一权威，Worker 部署默认永不介入。
- `ModelAvailability`：`enabled` + 停用原因在服务端判定；目录快照的 `runtimeBundleDigest` 必须等于
  该应用 plan 的摘要，否则 `MODEL_CATALOG_RUNTIME_MISMATCH`。
- `ModelPreference`：按 actor 保存 `selectionId`；保存时校验目录可用性。偏好失效（目录移除/停用）时
  `modelPreference` 返回 unavailable/unknown 与原因；创建运行返回 `MODEL_PREFERENCE_UNAVAILABLE`，
  不静默改用部署默认。
- `ModelConfigSnapshot`：`platform_run_create` 解析 **显式选择 → 偏好 → 部署默认**，记录
  selectionId/provider/model/adapter/adapterVersion/catalogDigest/runtimeBundleDigest/options/
  selectionSource/selectedAt，并随 Run 持久化；工具投影不回传任何密钥。历史运行没有该字段时读为 null。
- `retry`：沿用原 Run 的选择与参数，重新校验目录；选择被移除/停用 → `MODEL_SELECTION_UNAVAILABLE`，
  同 selectionId 被改映射到另一 route → `MODEL_ROUTE_CHANGED`，不静默改变重试含义。
- Worker：dispatch 接收 Run 模型快照并传给 SDK harness（provider/model/reasoningEffort/maxTokens）；
  `worker.adapter` 与快照 adapter 不一致时报 `WORKER_MODEL_ROUTE_MISMATCH`。`worker.provider/model`
  仅作为**没有快照的历史 Run** 的部署默认路由。
- 工具新增：`platform_model_catalog_register`、`platform_model_catalog`、`platform_model_preference_set`；
  `platform_run_create` 支持 `modelSelectionId` 与 `modelOptionsJson`；`platform_workbench_snapshot`
  返回目录与偏好。策略新增 `model.read` / `model.register` / `model.preference`（operator；service 只读）。

仍属未执行：部署侧 `ctx.llm.listProviders/listModels/resolveModelInfo` 探测、真实 adapter 路由握手校验、
组织/区域维度的服务端过滤、企业身份策略与密钥引用管理；对应 DSH01–DSH04/DSH06 记为 NOT_RUN。

### Work、输入完整交付与工作台 HTTP API（2026-11-11 增补）

- **Work 持久化**：新增 `works` 表与 `WorkRepository`（projectId、appId/appVersion、title、createdBy、
  ACTIVE/ARCHIVED）。创建 Run 时可绑定 workId；同一 Work 同时最多一个 QUEUED/STARTING/RUNNING Run
  （`WORK_ACTIVE_RUN_EXISTS`）。归档后拒绝新 Run 与 retry（`WORK_ARCHIVED`），历史 Run 保持可读。
- **输入完整交付**：dispatch 不再读取固定前 100 条；`RunRepository.allInputs` 按序分页取全量，
  测试覆盖 101 条输入全部交给执行器。
- **HTTP API**（`src/http.ts`）：同源提供 `/api/workbench`、works/runs/models/events/inputs/cancel/retry/
  artifacts、`/api/works/:id/{context,binding,bindings,submissions,input-baselines}`、
  `/api/sessions/:id` 反向解析与 `/api/submissions/:id/{acknowledge,consume,unknown}`；
  每次请求由注入的 authenticator 派生 Principal，服务层仍逐项授权。运行投影剥离输入正文；
  错误映射为稳定的 HTTP 状态与 `{ok:false, code, detail}`；静态资源只允许 app 目录内白名单文件并带 CSP。
- **本地服务器**（`src/api-cli.ts`）：绑定 loopback，固定本地 operator principal；`--seed` 只注册合成
  探针应用与本地模型目录。它是评审/开发入口，不是企业身份网关。
- **正式前端**：`apps/enterprise-workbench` 消费该 API，提供工作列表、工作画布、运行尝试、模型控制器、
  事件/输入/成果上下文与排队/取消/失败/归档状态；执行器未配置时明确显示“已保存并排队，尚未执行”。
  它不含预设 AI 回复、假进度或假成果。

### 工具

`platform_app_register/list/get/revoke`、`platform_work_create/list/get/archive/runs/run_create`、
`platform_run_create/get/list/cancel/events/artifacts/attempts/retry`、
`platform_run_append_input/inputs`、`platform_model_catalog`、`platform_model_catalog_register`、
`platform_model_preference_set`、`platform_audit_events`、`platform_control_status`、`platform_workbench_snapshot`。

运行输入以 `RunInputCommit` 持久化（序号、摘要、PENDING/CONSUMED/…状态）；创建运行即写入第 1 条，
非终态可追加。Worker 派发时读取当前提交列表，但追加后的消费事实仍由后续监督器/会话事件确认，工具不能自报 CONSUMED。
`launch_attempts` 记录每次 dispatch 的 launchId/fencing token/开始结束与终态；启动对账把未结尝试标为 UNKNOWN。

### 运行合同闭合（2026-11-11 集成审查后）

- **进程退出证据**：Worker `close()` 失败时 outcome 记 `exitProven:false`，控制面写
  `WORKER_EXIT_UNPROVEN` 失败，绝不把无退出证据的运行记为 SUCCEEDED/CANCELLED（合同§5/§7）。
- **运行时绑定**：`worker.runtimeBundleDigest` 必填且必须等于 run plan 的 `runtimeBundleDigest`，
  不一致拒绝派发（`WORKER_RUNTIME_MISMATCH`），落实发布合同§2「运行时只接受批准的确定映射」。
- **公平队列**：`dispatchQueued` 改用 `WHERE state='QUEUED' ORDER BY created_at` 的专用查询，
  不再扫描「最新 100 条全状态」，避免大量终态记录饿死早期 QUEUED。
- **launch intent 先持久化**：supervisor 在 spawn 前写入 `launch_attempts(STARTING)` 并预留
  launchId/fencingToken，executor 复用；spawn 失败即标 FAILED，崩溃后可对账（合同§3）。
- **cancel 退出证据**：executor 记录每个 launch 的退出证据；`cancel()` 对「close 失败」或「本实例从未派发」
  的 launch 返回 false，使 `cancelRun` 保持 `cancelSettled:false` 的诚实未知态，不写 CANCELLED。
  证据持久化在 `launch_attempts.exit_proven`（含旧库 additive 迁移），控制进程重启后仍据此结算，
  不在内存无界累积。

配置（`cordis.patch.yml` 的 `config`）：`storePath`（相对 `DSH_HOME` 或绝对路径）、`allowedApps`
（本地操作者可见应用白名单）。未知键在装配时报 `PLATFORM_CONFIG_INVALID`。

### 完成事实与模型授权强化（2026-11-11 第六轮）

- **完成屏障事实化**：Worker outcome 缺失 `exitProven` 时按未知处理；成功路径必须显式 `cleanedUp`，
  不再由控制面补常量；`finishReason` 严格校验，缺失即失败。
- **输入消费可追溯**：派发只把实际进入 prompt 的输入提交（inbox splice 精确前缀）标为已派发，
  收到消费回执后置 CONSUMED；不再在成功 outcome 后把全部输入一律标 CONSUMED。
- **后代会话身份**：以下代 `parent/child` 身份跟踪替代数量比较，重复事件去重；零比零不再直接视为完成。
- **outcome 绑定 launch/epoch**：结果只结算匹配的 launch 与 fencing epoch，旧派发结果不能写入新状态。
- **退出与成果顺序**：执行器先关闭进程再计算成果摘要（close 幂等合并），避免在进程仍可能写入时登记产物。
- **UNKNOWN 隔离**：UNKNOWN 运行禁止追加输入；同一 Work 在 UNKNOWN 未对账前不能创建新运行，
  避免把未知副作用当作可重试。
- **模型级策略**：目录按 selection 逐项 scope 过滤（目录查询、偏好保存、创建、重试一致执行），
  猜 ID 返回与不存在一致的拒绝；模型读取/选择产生公开审计事件；策略缺失或不匹配 fail-closed。
- **排队再校验**：dispatch 领取 QUEUED 运行时重新校验模型可用性，撤销后不再派发。
- **快照参数冻结**：Worker 不再以部署默认 `maxTokens` 覆盖已冻结快照未记录的参数。
- **实测（Node 24.9.0，控制面负责人本地验证）**：platform-control 60/60 + typecheck + build、
  platform-runtime 7/7、规范检查通过；该轮未运行真实模型、未取得 adapter 网络握手证据、
  未实现原生交互持久化。

### 成果封存与授权下载（2026-11-11 第七轮）

- **控制面封存**：Worker 只报告源路径与摘要；控制面在 close 之后把字节复制到
  `$DSH_HOME/platform/artifacts/<runId>/<name>`（临时文件+rename），复制时重新计算 SHA-256
  并核对大小；不一致记 `RUN_ARTIFACT_DIGEST_MISMATCH`，运行失败，不登记任何成果。
- **交付门槛**：`artifactsRegistered` 只承认已封存副本；只有元数据没有封存不构成可交付成果，
  完成屏障不满足即 UNKNOWN。
- **下载**：`GET /api/runs/:id/artifacts/:name/download` 重新鉴权、读取时复验摘要，
  改动封存文件返回 `RUN_ARTIFACT_TAMPERED`；投影不暴露控制面封存路径。
- **回归**：源文件在运行后被改动不影响下载字节；封存副本被改动被检出；摘要不匹配运行失败且无成果；
  HTTP 下载/缺失 404/投影不含 `sealedPath`；控制面测试 60/60。
- **仍未完成**：浏览器预览（不执行文件脚本）、Evidence/ReviewRecord 分层、业务复核记录、保留策略。

### 输入批次与只读迁移盘点（2026-11-12 续跑）

- **输入批次**：`input_baselines` 按 Work 追加 revision（旧基线不重写）；`GET
  /api/works/:id/input-baselines` 倒序分页，`POST` 需 `work.input`，归档工作 `WORK_ARCHIVED`，
  service principal 拒绝。批次只记来源引用与 SHA-256 摘要，员工不在 UI 手填摘要。
- **只读迁移盘点**：`summarizeMigration`（`src/migration.ts`）以只读方式打开控制面库，
  统计 Work/Run/成果/绑定并输出稳定摘要；缺失=`MISSING`、损坏=`UNREADABLE`、浏览器记录未知= `unknown`。
- **CLI**：`scripts/native-workbench-migrate.cjs` 默认 dry-run，`--apply` 明确拒绝，
  直到原生替代入口验证完成且用户确认。
- **测试**：`work-inputs-http.test.ts`（3）、`migration.test.ts`（7）；控制面总计 105/105。

### 原生用户问题收件箱（2026-11-11 第七轮）

- Worker 通过 SDK 公开 `onUserQuestion` 回调把问题交给控制面；控制面持久化
  `run_interactions`（run/session/requestId、问题正文、状态），并以 Promise 等待答复。
- `GET /api/runs/:id/interactions` 读取收件箱；`POST /api/interactions/:id/answer` 以 CAS
  一次性提交答复；重复答复 `INTERACTION_NOT_PENDING`、运行终止后 `INTERACTION_RUN_TERMINAL`、
  未列出选项/空答复 `INTERACTION_ANSWER_INVALID`。
- 取消或运行终止时未答问题置 CANCELLED/EXPIRED，SDK 收到 `{cancelled:true}`，不会永久挂起。
- 工作台渲染待办问答（选项/多选/自定义），提交后刷新；答复正文不进入运行投影以外的地方。
- **仍是分开的通道**：DSH 工具审批（`approvalRequests`/`client.onRequest`）与平台业务审核未接入，
  不能把回答问题的通道当作权限批准。
- **实测**：platform-control 64/64；覆盖持久化、会话绑定、一次性答复、非法选项、取消后晚答拒绝、
  HTTP 列表/答复/重复 409/未知 404。

## 尚未实现

- **Worker 进程监督**：launch intent 与退出证据已持久化/校验；仍缺独立 PID/进程树终止证据、崩溃自动恢复与
  租约续期。`reconcileOnStartup` 只把遗留活动运行标为失败，不做自动恢复。
- **调度与重试**：`RunScheduler` 只做单条 QUEUED 派发，没有 outbox/退避/重试策略；同 Work 单活动 Run
  的约束尚未在服务层实现。
- **模型目录真实来源**：当前目录由部署 JSON 注册；尚未实现 DSH `ctx.llm` 目录探测/摘要发布、组织/区域
  可用性过滤、凭据 secretRef 版本绑定或提供方健康检查。`retrySnapshot` 只校验 route 未变，不证明凭据有效。
- **前端 API/UI**：本地 HTTP API 与正式前端最小切片已实现，但尚无企业身份 BFF、SSE/实时事件、
  成果下载/预览、人工交互通道与多用户并发验收；前端尚未接入真实 Worker 执行。
- **企业身份与数据接口**：仍使用本机策略与文件系统；无真实项目授权、数据 API 或租户隔离。
- **SDK 依赖**：`@deepseek-ai/dsh-sdk-client` 需由部署提供；未安装时派发明确失败。
- **统一 Git/CI**：工作区仍不是受统一管理的 Git 仓库；仅提供 `scripts/verify-all.cjs` 可复跑命令。

## 验证（2026-11-11）

- `npm run verify`：typecheck 通过；51/51 控制面测试通过；bundle 构建通过。
- 测试覆盖：应用登记幂等/冲突/撤销、计划解析失败、运行创建/派发/开始/屏障/完成、取消前后语义、
  Worker 结果产物登记、越界产物拒绝、启动对账、调度批处理、重启恢复、CAS、审计；模型目录校验/摘要稳定、
  显式选择/部署默认/偏好来源、未知/停用/非法参数拒绝、偏好失效不静默回退、目录变更不改写历史快照、
  retry route 保持与拒绝重映射、Worker 收到快照与 adapter 不匹配拒绝；Work 归属/单活动 Run/归档限制/
  重启恢复；101 条输入完整交付；HTTP API 的 bootstrap、工作与运行创建、输入/取消/重试、模型偏好、
  认证失败、畸形请求与静态资源白名单。
- `apps/enterprise-workbench`：6/6 纯状态测试通过；浏览器实测新建工作→排队运行→补充输入→请求停止→
  归档→切换模型新建尝试，控制台无错误、无失败请求。测试与浏览器数据均为合成数据，未调用模型。
- 全仓 `scripts/verify-all.cjs`：6/6 包验证命令通过。
- DSH Web（3080）装配烟测：插件页显示 platform-control 与 platform-knowledge、Listing、DVP 均启用；
  未发送模型业务请求。
- **真实模型 Worker E2E（2026-11-11）**：`scripts/platform-worker-e2e.mjs` 注册合成应用 → DSH SDK/profile
  worker → 模型写入 `out.txt` 与 `platform-result.json` → 控制面登记产物并 SUCCEEDED；产物 21 字节，
  sha256 `09d0cd32…`，首轮约 89 秒。同一脚本第二次运行超过 210 秒未终止，已按脚本超时逻辑取消；
  因此当前只记录一次成功实证，不宣称稳定吞吐。SDK 集成层另有 [11/11 验收](SDK-INTEGRATION-ACCEPTANCE.md)，
  那是引擎/SDK 验收，不等于平台 Worker 稳定性或业务验收。

本实现是控制面骨架，不是 Worker、企业身份或生产运行验收。
## 2026-11-17 可靠性与企业治理增补

本段只记录本轮实际实现与验证，不改变上文历史结论。范围：持久派发、启动租约、发布审批、模型健康、
关联与指标、审计导出、一致备份恢复、知识跨进程回执、工作台体验。未接入企业身份/租户，与既有边界一致。

### 持久派发 Outbox

- 新增 `outbox_messages`（PENDING/CLAIMED/DONE/DEAD）与 `outbox_claim` 语义：Run 创建与派发意图
  在同一事务提交（`RunRepository.create`），控制进程崩溃后重启可从队列恢复，不再出现“已创建但永远 QUEUED”。
- `PlatformControlService.dispatchOutbox`：回收过期 claim → 领取到期消息 → 派发 → 完成/退避/死信。
  退避为 15 s × 2ⁿ（上限 10 min），5 次后 DEAD；永久错误（发布撤销/未审批/工作归档/已取消）直接 DEAD。
  `RUN_REVISION_STALE`/`RUN_DISPATCH_STATE_INVALID` 视为“另一监督者已推进”，完成而不重试。
- 运行进入终态或取消时，同一事务把未结消息标为 DONE（保留原因），不会在终态后再次启动。
- `RunScheduler` 改为：续租 → 对账过期租约 → 领取并派发 outbox；重叠 tick 跳过。
- HTTP/工具：`platform_run_outbox` 读取单次运行的派发事实；`status().outbox` 输出各状态计数。

### 启动租约与对账

- `launch_attempts` 增加 `lease_owner`/`lease_expires_at`/`heartbeat_at`（增量迁移）。
- 派发前持久化 launch intent 并带租约；`renewOpenLaunchLeases` 由同一控制进程的调度器续租
  （SQLite 单写者假设；多进程部署必须替换为真实租约移交）。
- `reconcileExpiredLaunches`：租约过期只说明“无人证明存活”，运行置 `UNKNOWN`（`LAUNCH_LEASE_EXPIRED`），
  不自动重启、不重发已消费输入；`reconcileOrphans` 同时清理残留租约。
- 仍未实现：独立 PID/进程树终止证明（SDK 在同进程内运行）、多监督者租约移交、容器/VM 级隔离。

### 发布审批与模型健康

- 新增 `release_approvals`：审批绑定**精确 releaseDigest**（摘要不一致拒绝），记录审批人、证据引用、
  回滚目标与到期时间；撤销后新运行立即被拒绝。配置 `requireReleaseApproval=true` 时，创建/重试运行
  必须存在 ACTIVE、未过期、摘要一致的审批；历史运行不回写。
- 新增 `model_health`：部署探针写入 `healthy|degraded|unavailable|unknown`（unavailable 必须带原因）。
  配置 `requireModelHealth=true` 时，创建、重试和派发都会重新校验；未探测保持 unknown，绝不猜测健康。
  工作台设置页显示健康事实与探测时间。

### 关联、指标与审计导出

- `src/observability.ts`：请求级 correlation（`x-request-id`，非法值替换为新 id）、结构化 JSON 日志
  （自动脱敏 input/prompt/token 等键）、进程内 metrics（counter/gauge/histogram）。
- HTTP 全部请求记录 `platform_http_requests` 与 `platform_http_duration_ms`；`GET /api/metrics`
  返回 JSON，`?format=prometheus` 返回文本；需要 `metrics.read`。
- 审计新增 `correlation_id` 列；`GET /api/audit/export` 输出升序 NDJSON，每行带 `prevDigest`/`digest`
  哈希链，响应头 `x-audit-head` 给出可签名头摘要。删除/改行会破坏链。它是完整性辅助，不是签名。

### 一致备份与恢复

- `src/backup.ts`：`VACUUM INTO` 生成一致快照，复制封存产物并对整棵目录做摘要清单；
  `verifyBackup` 重算全部摘要；`restoreBackup` 先验证再暂存改名，失败不留半写库。
- CLI：`npm run backup -- backup --store <control.sqlite> --out <dir> [--artifacts <dir>]`
  以及 `verify` / `restore` 子命令。
- 非空目标目录拒绝覆盖。

### 知识跨进程验证回执

- `KnowledgeService.createValidationRequestFor`：从 store 读取候选与套件摘要签发请求（候选 digest、
  套件版本/digest、用例集 digest、executionEpoch）。
- `validateWithReceipt`：校验请求绑定当前候选与已安装套件、执行器在白名单、用例数量/分组/期望摘要
  逐项匹配；沿用同一 claims/coverage/evidence 激活规则。失败仍记录回执与事件，候选保持 CANDIDATE。
  验证器被替换、候选已修订或回执来自其他 epoch 时拒绝激活。

### 配置与接口新增

- 配置键：`requireReleaseApproval`、`requireModelHealth`（均为布尔，缺省 false，保持既有部署行为）。
- HTTP：`/api/metrics`、`/api/audit/export`、`/api/approvals`、
  `/api/apps/:appId/:version/approval`（GET/POST）、`.../approval/revoke`；
  `/api/models` 与工作台 bootstrap 增加 `health`；`status` 增加 `outbox`/`approvals`。
- 工具：`platform_app_approve`、`platform_app_approval`、`platform_model_health_record`、
  `platform_model_health`、`platform_run_outbox`。

### 验证（2026-11-17）

- platform-control：135/135 测试通过（新增 outbox 7、lease 4、governance 5、observability 3、backup 3），
  typecheck 与 bundle 构建通过。
- platform-knowledge：24/24 通过（新增跨进程回执 3 项），构建通过。
- platform-workbench：69/69 通过（新增 i18n 4 项与体验契约断言），bundle 构建通过。
- 全仓 `scripts/verify-all.cjs`：**18/18 验证命令通过**（2026-11-17 最终一轮，含包验证、规范检查与工具/原型检查）；
  门禁只证明实际执行的检查。
- 本轮未运行真实模型、未连接企业身份、未做多进程/OS 级进程树实测；不得据此宣称生产就绪。

## 2026-11-17 第二批：发布溯源、回滚、交付复核与知识沉淀

在上段基础上补齐的发布治理与交付事实，全部有对应测试。

### 发布溯源与回滚

- `AppReleaseDraft.provenance`（可选）：`sourceRevision`、`builder`、`builtAt`、`sbomDigest`、
  `dependenciesDigest`。只接受这些键与摘要格式；未知键拒绝（`APP_PROVENANCE_INVALID`）。
- `releaseDigest` 在声明 provenance 时把它计入身份（同样的代码不同构建方式即不同发布，需分别审批）；
  未声明 provenance 时沿用原摘要公式，旧库记录保持可读与有效。
- `rollbackRelease(appId, fromVersion, toVersion, reason)`：撤销 `fromVersion`，保持 `toVersion` 为
  ACTIVE 目标；启用审批时目标必须已批准。不猜测版本顺序、不删除历史、不改写在途运行。
  HTTP `POST /api/apps/:appId/:fromVersion/rollback`；工具 `platform_app_rollback`。

### 交付复核（三轴分离）

- 新表 `delivery_reviews`：每个运行最多一个未结 `REQUESTED`；决定 `APPROVED|REJECTED` 为终态。
- `requestReview` 只接受 `SUCCEEDED` 运行；`recordReviewDecision` 以 revision CAS 绑定，
  驳回必须写明原因；决定不可改写。复核不改变运行状态，也不等于交付批准。
- HTTP：`GET/POST /api/runs/:id/reviews`、`POST /api/reviews/:id/decision`；
  工具 `platform_run_review_request/decision/reviews`。
- 工作台工作详情新增「业务复核」卡：显示运行状态与复核状态、发起复核、通过/驳回与最近意见。

### 运行事件知识沉淀接缝

- `PlatformControlService.setKnowledgeCaptureSink`：运行进入终态时，把可信事实
  （kind、runId、workId、appId/version、projectId、inputDigest、artifactDigests、reason）交给部署注入的
  sink，每运行最多一次。sink 只能创建 CANDIDATE，不能激活；异常只写审计
  `KNOWLEDGE_CAPTURE_SINK_FAILED`，不改变运行结果。真实 KnowledgeService 绑定由部署装配。

### 待办与移动端

- 待办投影增加 `runState`；「待我处理」按项目分组并显示运行状态，未加载 Work 归入“未加载项目”，不丢失。
- 窄屏（≤720px）补充：控制台动作换行、模式开关铺满、运行记录横幅纵向排列、复核/向导按钮自适应、
  会话工具栏与搜索铺满；不改变桌面布局。
- 并发上限：`maxConcurrentRuns`（0/缺省不限）在领取前检查容量；达到上限时消息保持 PENDING、
  不消耗尝试次数，运行结算后自动继续。

### 验证（本轮追加）

- platform-control 143/143（新增 provenance/rollback/review/capture-sink/HTTP 复核 7 项、并发上限 1 项）。
- platform-workbench 70/70（新增复核 API 客户端 1 项）。
- 其余计数与全仓门禁以最终一轮 `verify-all` 为准。

## 2026-11-17 第三批：本地自安装模式的执行与自检补全

定位仍是员工本机自安装运行，因此不引入 PostgreSQL/分布式组件；补齐本地模式真正缺失的能力。

### 独立 Worker 子进程（真实进程树）

- 新增 `ChildProcessWorkerExecutor`（`src/child-worker.ts`）与 `scripts/worker-runner.mjs`：
  SDK harness 在独立 Node 子进程中运行，控制面通过 NDJSON stdio 转发通知、提问与最终结果。
- launch attempt 记录真实 `pid`、`processIdentity` 与 `processMode='child-process'`。
- 取消/超时：先发 cancel，再终止整棵进程树（Windows `taskkill /T /F`；POSIX 进程组 SIGTERM→SIGKILL），
  只有观察到真实退出事件才记 `exitProven`；超时内未退出则 `WORKER_EXIT_UNPROVEN`，不假报结算。
- 子进程提问通过平台持久收件箱回答（stdin/stdout 往返），取消时未答问题按既有语义失效。
- 配置：`worker.mode: 'in-process' | 'child-process'`（缺省 in-process，保持既有部署行为）、
  `worker.runnerPath`、`worker.killTimeoutMs`。runner 缺失在派发前即报 `WORKER_RUNNER_MISSING`。
- 仍未实现：容器/VM 级隔离、多控制进程之间的租约移交。

### 本地安装自检

- `src/doctor.ts` + `src/doctor-cli.ts`（`npm run doctor`）：检查 Node 版本、库目录可写、SQLite
  `quick_check` 与 `application_id/user_version`、应用/工作/运行/Outbox/审批计数、Worker 路径/profile/
  runner/SDK、Rscript/Rterm 可用性；警告与失败分开，退出码反映是否有失败。
- `PlatformStore.integrityCheck()`：SQLite `quick_check` + schema 身份，供 doctor 与运维复用。

### 界面国际化补全

- 运行状态（QUEUED…UNKNOWN）走语言字典；导航、页面标题、打开会话、查看详情、请求停止、进入对话、
  刷新、归档、复核发起/通过/驳回等主要控件均使用字典；英文表必须覆盖全部中文键（有测试）。
  未识别的新状态原样显示，不伪装成成功。

### 验证（本轮追加）

- 新增 child-process 4 项（成功/提问往返/取消进程树/runner 缺失）与 doctor 4 项测试。
- 最终计数：platform-control **151/151**、platform-knowledge **24/24**、platform-workbench **71/71**；
  全仓 `verify-all` **18/18**（2026-11-17 第三批完成后实际运行）；`npm run doctor` 冒烟通过（识别 Node/R/库状态）。


## 2026-11-17 真实员工路径 E2E（真实宿主/真实模型/真实 Worker）

环境：DSH 原生 Web（3095）+ 平台控制面（3097，全新 SQLite 库）+ 真实 GLM 路由 + 真实 Worker profile；
浏览器为系统 Edge（Playwright msedge 通道），全部在界面操作，不调用内部 API 代替点击。

已验证（最终构建 22/22，0 页面错误、0 失败请求）：
首页企业外壳 → 设置页中英切换与 UTC 时区 → 项目空间内新建项目 → 五步向导（项目/应用/目录/目标/确认）
→ 工作详情自动绑定对话（四步状态条就绪）→ 原生 composer 真实模型流式回复 → 发起运行
→ 运行在 10 分钟界内到达 SUCCEEDED → 界面刷新显示“已完成” → 成果卡显示已封存文件（14 B，可下载）
→ 业务复核发起并通过 → 历史会话列出并如实报告无匹配 → 待我处理分组 → 390px 无水平溢出。

专项（6/6）：运行记录模式显示“不是实时对话”横幅并可回到实时对话；复核决定在刷新后仍为已通过。
真实产物核对：`employee-check.txt` 14 B，运行 SUCCEEDED 后封存并可在界面下载；复核记录 APPROVED；指标记录
`platform_run_transition{to=STARTED/RUNNING/SUCCEEDED}`。

本轮真实浏览器发现并修复：≤720px 时控制台动作区宽度 535px 超出 390px 视口被裁切（改为头部换行、
动作区 `width:100%; min-width:0`、分段按钮 `flex:1 1 0`，实测 362px）；历史会话工具栏两个下拉在桌面端
各占满一行（改为 `width:auto; min-width:150px`，实测同一行 150px）。

证据（临时，不入库）：`.runtime/employee-ui-2026-11-17/shots/*.png`、`summary.json`、`focused-results.json`。
该环境不是生产部署，也未覆盖企业身份、多用户并发或容器隔离。
