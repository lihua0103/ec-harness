# @ec-clinical/platform-runtime

平台控制服务的最小内核：确定性执行计划与 Run 状态机。纯逻辑，不启动 Worker、不读 DSH、不依赖 UI。

## ExecutionPlan

- 每个 required capability 绑定确切的 `capabilityId@version` provider；不接受隐式 latest。
- 检测 provider 冲突、缺失、依赖缺失/版本不符、依赖循环。
- 计划按 capability 排序计算 `planDigest`；provider 输入顺序不影响结果。
- `assertPlanMatchesRelease` 在启动时核对计划与发布摘要，漂移即拒绝。

## RunLedger

- 状态：QUEUED / STARTING / RUNNING / SUCCEEDED / FAILED / CANCELLED。
- 每次事件 CAS 校验 revision；fencing token 必须严格递增。
- QUEUED 取消直接 CANCELLED；STARTING/RUNNING 取消只持久 `cancelRequested`，必须由监督器确认
  进程停止后 `cancel-settled`，期间不能 `finish` 成 SUCCEEDED。
- `finish` 要求 inputsSettled / descendantsDone / artifactsRegistered / cleanedUp 全部为真。

```bash
cd packages/platform-runtime && pnpm install
```

```bash
cd packages/platform-runtime && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" npm run verify
```

未包含：进程监督、launch 对账、DSH 会话绑定、持久数据库、身份授权与 Worker 资源隔离。