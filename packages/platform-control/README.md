# @ec-clinical/platform-control

平台控制面 bundle：应用发布注册、确定性执行计划绑定、持久运行/事件/审计。

- 应用登记是**纯数据**：descriptor、requiredCapabilities、providers、runtimeBundleDigest；平台解析
  `platform-runtime` 的确定性 ExecutionPlan 并保存摘要，不 import/执行应用代码。
- 运行创建冻结 appVersion、releaseDigest、planDigest、输入摘要；运行状态持久化并 CAS revision。
- `platform_run_cancel` 只请求取消：QUEUED 立即 CANCELLED；已派发需监督器确认进程停止后 `cancel-settled`。
- 工具不暴露 dispatch/finish/fail；这些是监督器内部方法，不能由模型 JSON 自报完成。
- 默认不配置 `RunExecutor`：创建/取消排队运行可用，派发返回 `EXECUTOR_NOT_CONFIGURED`；配置 `worker` 后使用 DSH SDK/profile 执行。

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
      patches: [/absolute/worker.patch.yml]
      provider: deepseek-official
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

`platform_app_register/list/get/revoke`、`platform_run_create/get/list/cancel/events/artifacts/attempts/retry`、
`platform_run_append_input/inputs`、`platform_audit_events`、`platform_control_status`、`platform_workbench_snapshot`。
配置 worker 后，`RunScheduler` 每 `scheduler.intervalMs` 自动派发一条 QUEUED run；重叠 tick 跳过。

```bash
cd packages/platform-control && pnpm install
```

```bash
cd packages/platform-control && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" npm run verify
```

## 边界

本地单操作者策略（`LocalOperatorPolicy`）只用于开发；企业部署必须替换为身份与项目授权服务。
控制面不执行应用代码；Worker 通过 DSH SDK/profile 外部执行，进程监督、租约、调度与前端 API 尚未完整实现。
Worker 结果清单的产物摘要由适配器在隔离工作目录内计算，控制面仍不把“Worker 报告成功”当作业务正确。

真实模型 E2E：`scripts/platform-worker-e2e.mjs`（需 `ZAI_CODING_CN_API_KEY` 与生成的 worker profile）。
2026-11-11 首轮成功产出 21 字节 `out.txt` 并登记产物；重复运行曾超 210 秒被取消，尚不稳定。
