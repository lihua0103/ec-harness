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