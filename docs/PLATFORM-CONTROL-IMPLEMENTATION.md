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

### 工具

`platform_app_register/list/get/revoke`、`platform_run_create/get/list/cancel/events/artifacts/attempts/retry`、
`platform_run_append_input/inputs`、`platform_audit_events`、`platform_control_status`、`platform_workbench_snapshot`。

运行输入以 `RunInputCommit` 持久化（序号、摘要、PENDING/CONSUMED/…状态）；创建运行即写入第 1 条，
非终态可追加。Worker 派发时读取当前提交列表，但追加后的消费事实仍由后续监督器/会话事件确认，工具不能自报 CONSUMED。
`launch_attempts` 记录每次 dispatch 的 launchId/fencing token/开始结束与终态；启动对账把未结尝试标为 UNKNOWN。

配置（`cordis.patch.yml` 的 `config`）：`storePath`（相对 `DSH_HOME` 或绝对路径）、`allowedApps`
（本地操作者可见应用白名单）。未知键在装配时报 `PLATFORM_CONFIG_INVALID`。

## 尚未实现

- **Worker 进程监督**：launchId 对账、进程树终止证据、崩溃恢复、租约/fencing 持久化尚未接入；
  超时只 abort/close，不提供独立 PID 证据。`reconcileOnStartup` 只把遗留活动运行标为失败，不做自动恢复。
- **调度与重试**：`RunScheduler` 只做单条 QUEUED 派发，没有 outbox/退避/重试策略；同 Work 单活动 Run
  的约束尚未在服务层实现。
- **前端 API/UI**：已有 `platform_workbench_snapshot` 数据工具，工作台尚未接真实 UI。
- **企业身份与数据接口**：仍使用本机策略与文件系统；无真实项目授权、数据 API 或租户隔离。
- **SDK 依赖**：`@deepseek-ai/dsh-sdk-client` 需由部署提供；未安装时派发明确失败。
- **统一 Git/CI**：工作区仍不是受统一管理的 Git 仓库；仅提供 `scripts/verify-all.cjs` 可复跑命令。

## 验证（2026-11-11）

- `npm run verify`：typecheck 通过；17/17 控制面测试通过；bundle 构建通过。
- 测试覆盖：应用登记幂等/冲突/撤销、计划解析失败、运行创建/派发/开始/屏障/完成、取消前后语义、
  Worker 结果产物登记、越界产物拒绝、启动对账、调度批处理、重启恢复、CAS、审计。
- 全仓 `scripts/verify-all.cjs`：6/6 包验证命令通过。
- DSH Web（3080）装配烟测：插件页显示 platform-control 与 platform-knowledge、Listing、DVP 均启用；
  未发送模型业务请求。
- **真实模型 Worker E2E（2026-11-11）**：`scripts/platform-worker-e2e.mjs` 注册合成应用 → DSH SDK/profile
  worker → 模型写入 `out.txt` 与 `platform-result.json` → 控制面登记产物并 SUCCEEDED；产物 21 字节，
  sha256 `09d0cd32…`，首轮约 89 秒。同一脚本第二次运行超过 210 秒未终止，已按脚本超时逻辑取消；
  因此当前只记录一次成功实证，不宣称稳定吞吐。SDK 集成层另有 [11/11 验收](SDK-INTEGRATION-ACCEPTANCE.md)，
  那是引擎/SDK 验收，不等于平台 Worker 稳定性或业务验收。

本实现是控制面骨架，不是 Worker、企业身份或生产运行验收。