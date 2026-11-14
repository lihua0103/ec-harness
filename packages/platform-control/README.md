# @ec-clinical/platform-control

平台控制面 bundle：应用发布注册、确定性执行计划绑定、持久运行/事件/审计。

- 应用登记是**纯数据**：descriptor、requiredCapabilities、providers、runtimeBundleDigest；平台解析
  `platform-runtime` 的确定性 ExecutionPlan 并保存摘要，不 import/执行应用代码。
- 运行创建冻结 appVersion、releaseDigest、planDigest、输入摘要；运行状态持久化并 CAS revision。
- **Work** 是员工的一项持续工作：项目、应用版本与标题；Run 是它下面的执行尝试。同一 Work 同时最多
  一个非终态 Run（`WORK_ACTIVE_RUN_EXISTS`）；归档后拒绝新 Run 与重试。直接创建 Run 仍保留用于
  兼容与诊断，但不进入工作台主流程。
- 模型目录是部署审定的 metadata-only 快照：目录 ID、RuntimeBundle 摘要、默认选择与模型项（含 adapter、
  可用性、能力/来源标记与允许参数）；不接受密钥、任意 baseURL 或客户端伪造 provider/model 路由。
- 运行创建时解析 **显式选择 → 保存偏好 → 部署默认**，重新做服务端可用性校验并冻结
  `ModelConfigSnapshot`（selectionId/provider/model/adapter/catalogDigest/runtimeBundleDigest/options/
  验证标记）。未知、停用或跨 RuntimeBundle 的模型明确失败；不静默改用其他模型。
- `platform_run_cancel` 只请求取消：QUEUED 立即 CANCELLED；已派发需监督器确认进程停止后 `cancel-settled`。
- 工具不暴露 dispatch/finish/fail；这些是监督器内部方法，不能由模型 JSON 自报完成。
- 默认不配置 `RunExecutor`：创建/取消排队运行可用，派发返回 `EXECUTOR_NOT_CONFIGURED`；配置 `worker` 后使用 DSH SDK/profile 执行。
  派发时运行快照的 provider/model/options 传给 Worker；`worker.adapter` 与快照 adapter 不一致时
  `WORKER_MODEL_ROUTE_MISMATCH`。
- **完成事实 fail-closed**：缺失 `exitProven`、`finishReason != completed`、未显式 `cleanedUp`、后代
  未按身份结算或输入未按派发前缀证明消费时，运行进入 UNKNOWN，不写 SUCCEEDED。
- **成果封存**：Worker 只报告源路径与摘要；控制面关闭进程后复制字节到 `artifacts/<runId>/<name>`，
  复制时复算 SHA-256；不一致则运行失败且不登记成果。只有封存副本计入完成屏障。
- **授权下载**：`GET /api/runs/:id/artifacts/:name/download` 逐请求鉴权并在读取时复验摘要，
  投影不暴露封存路径；封存文件被改动返回 `RUN_ARTIFACT_TAMPERED`。
- **可恢复事件流**：`GET /api/runs/:id/events/stream`（SSE）按持久 sequence 游标
  （`Last-Event-ID`/`after`）重放平台状态事件，流中断后可从最后事件续传。
- **原生问答收件箱**：SDK `onUserQuestion` 请求持久化为 `run_interactions`（绑定 run/session/
  requestId），控制面等待 CAS 答复；UI 通过 `GET /api/runs/:id/interactions` 读取、
  `POST /api/interactions/:id/answer` 提交。重复答复、运行终止后的晚答、未列出选项均拒绝；
  取消/终止时未答问题置 CANCELLED/EXPIRED 并向 SDK 返回 `{cancelled:true}`。
- **输入批次**：`input_baselines` 按 Work 追加 revision，旧基线不重写；`GET/POST
  /api/works/:id/input-baselines` 分页读取/追加（POST 需 `work.input`，归档工作拒绝）。
  批次记录来源引用与 SHA-256 摘要，员工不在工作台手填摘要。
- **工作上下文与提交接缝**：`GET /api/works/:id/context` 一次授权返回项目/空间/应用/绑定/域；
  `POST /api/submissions` 由认证主体派生提交者；`(domainId,sessionId,requestId)` 幂等，
  回执丢失保持 UNKNOWN，不自动重放。
- **只读迁移盘点**：`summarizeMigration` / `scripts/native-workbench-migrate.cjs` 以只读方式打开
  控制面库，统计 Work/Run/成果/绑定并输出稳定摘要；损坏库报 UNREADABLE，不按空库继续。
- **模型级授权**：按 selection scope 过滤目录/偏好/创建/重试，猜 ID 与不存在一致拒绝；
  模型读取与选择写公开审计；策略缺失 fail-closed。

## 配置

```yaml
- id: ec-platform-control
  name: '@ec-clinical/platform-control/cordis'
  config:
    storePath: platform/control.sqlite # 相对 DSH_HOME 或绝对路径
    allowedApps: [listing, dvp] # 可选；缺省不限制本地操作者可见应用
    requireArtifacts: true # 成功 Worker 至少需登记一个产物
    scheduler: # worker 配置存在时默认启用；只调度平台 QUEUED run
      enabled: true
      intervalMs: 5000
    reconcileOnStartup: false # true 时把上一控制进程遗留的 STARTING/RUNNING 标为失败
    worker: # 可选；缺省 EXECUTOR_NOT_CONFIGURED
      profile: worker
      dshHome: /absolute/worker-home
      workspace: /absolute/run-workspaces
      runtimeBundleDigest: <64-hex approved bundle digest; must equal the run plan's>
      patches: [/absolute/worker.patch.yml]
      adapter: dsh-llm-deepseek # 可选；设置后运行快照的 adapter 必须一致
      provider: deepseek-official # 仅当运行没有模型快照时的部署默认路由
      model: deepseek-v4-flash
      maxTokens: 49152
      timeoutMs: 1800000
      initializeTimeoutMs: 60000
      shutdownTimeoutMs: 5000
```

未知配置键、非法应用 ID 或非绝对 worker 路径会在装配时报 `PLATFORM_CONFIG_INVALID`。Worker 通过
`@deepseek-ai/dsh-sdk-client` 启动 DSH profile；模块未安装时派发报 `WORKER_SDK_UNAVAILABLE`。
可用 `node scripts/setup-worker-profile.cjs --home <worker-home>` 生成隔离 worker profile 模板。

## 工具

`platform_app_register/list/get/revoke`、`platform_work_create/list/get/archive/runs/run_create`、
`platform_run_create/get/list/cancel/events/artifacts/attempts/retry`、
`platform_run_append_input/inputs`、`platform_model_catalog`、`platform_model_catalog_register`、
`platform_model_preference_set`、`platform_audit_events`、`platform_control_status`、`platform_workbench_snapshot`。
配置 worker 后，`RunScheduler` 每 `scheduler.intervalMs` 自动派发一条 QUEUED run；重叠 tick 跳过。

模型目录注册 JSON 示例（selectionId 是平台签发的 opaque ID，不是客户端可拼的 provider/model 字符串）：

```json
{
  "catalogId": "deployment.default",
  "runtimeBundleDigest": "<must equal the release plan digest>",
  "defaultSelectionId": "model.deepseek-flash",
  "entries": [
    {
      "selectionId": "model.deepseek-flash",
      "provider": "deepseek-official",
      "model": "deepseek-flash",
      "displayName": "DeepSeek-V4.1-Flash",
      "adapter": "dsh-llm-deepseek",
      "adapterVersion": "0.2.2-rc.1",
      "enabled": true,
      "verification": "provider-declared",
      "capabilities": { "contextWindow": 1048576, "modalities": ["text", "image"] },
      "parameters": { "reasoningEffort": ["low", "medium", "high"], "maxTokens": true }
    }
  ]
}
```

```bash
cd packages/platform-control && pnpm install
```

```bash
cd packages/platform-control && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" npm run verify
```

## 边界

本地单操作者策略（`LocalOperatorPolicy`）只用于开发；企业部署通过 `ctx.platformControl.setPolicy(...)`
替换为身份与项目授权服务。控制面不执行应用代码；Worker 通过 DSH SDK/profile 外部执行，进程监督、租约、
调度与前端 API 尚未完整实现。
Worker 结果清单的产物摘要由适配器在隔离工作目录内计算，控制面仍不把“Worker 报告成功”当作业务正确。

模型目录是由**部署**提供的声明式快照，不是控制面通过 `ctx.llm` 实时发现的目录；注册时只做结构校验，
不联系供应方、不验证凭据、不证明 adapter 实际可调用。DSH03（目录与 `listProviders/listModels` 一致）
仍需部署侧目录探测与真实 DSH 集成验收，当前记为 NOT_RUN。运行快照的 `selectedAt`/`catalogDigest`
可用于审计追溯，但一次成功 Worker E2E 不代表模型选择闭环或 DSH01–DSH10 通过。

## 本地工作台 API

`src/http.ts` 在同一源上提供工作台 HTTP API 与静态资源；`src/api-cli.ts` 启动本地服务器：

```bash
node_modules/.bin/tsx src/api-cli.ts --app ../../apps/enterprise-workbench --seed --port 3083
```

`--seed` 只注册合成探针应用与本地模型目录，不调用模型。服务器绑定 loopback，并使用固定本地
operator principal；它**不是**身份网关，生产必须替换认证与项目授权。API 对每次读写调用服务层授权，
运行投影不返回输入正文，静态资源只允许 app 目录内的白名单文件。

真实模型 E2E：`scripts/platform-worker-e2e.mjs`（需 `ZAI_CODING_CN_API_KEY` 与生成的 worker profile）。
2026-11-11 首轮成功产出 21 字节 `out.txt` 并登记产物；重复运行曾超 210 秒被取消，尚不稳定。
