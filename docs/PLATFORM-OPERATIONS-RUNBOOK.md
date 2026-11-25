# 平台运行手册：派发、租约、审批、指标、审计与恢复

日期：2026-11-17 · 状态：**部署与运维操作说明**。对应实现见
[平台控制面实现](PLATFORM-CONTROL-IMPLEMENTATION.md) 的 2026-11-17 增补。本文中的数字与命令是本轮
实际实现的能力，不代表已完成生产演练或企业身份接入。

## 1. 运行派发（Outbox）

- 创建 Run 时，运行与 `run.dispatch` 消息在同一事务写入；崩溃后重启会继续派发。
- 调度器每个 tick：续租 → 对账过期租约 → 领取到期消息并派发。
- 观察：
  - `platform_control_status` → `outbox: { PENDING, CLAIMED, DONE, DEAD }`
  - `platform_run_outbox`（按 runId）返回派发状态、尝试次数、下次重试与最近错误
- 消息进入 `DEAD` 的常见原因：发布已撤销、审批缺失或过期、工作已归档、运行已取消、5 次退避后仍失败。
  `DEAD` 不会自动重试；先修复原因，再由用户创建新的 Run（不要复用旧 Run）。
- 并发上限：配置 `maxConcurrentRuns`（0/缺省不限）时，达到上限的 tick 返回 `claimed: 0`，
  消息保持 PENDING 且不消耗尝试次数；有运行结算后自动继续。

## 2. 启动租约与 UNKNOWN

- 每次派发写入 `launch_attempts` 租约（owner、expiresAt、heartbeatAt）以及执行进程事实
  （`processMode`: `in-process` 表示 SDK 在控制进程内运行，`child-process` 表示部署提供的独立进程）。
- 租约到期后运行进入 `UNKNOWN`（`LAUNCH_LEASE_EXPIRED`）。这表示“没有人证明它还活着”，
  **不是**失败、也不是可以自动重试。
- 处置顺序：
  1. 确认旧进程/容器已停止（部署侧证据）。
  2. 操作者确认后调用 `platform` 对账（工作台“确认已停止”或 `reconcile` 接口）。
  3. 需要继续工作时创建新的 Run；旧 Run 保留其 `UNKNOWN` 历史与产物。
- 控制进程重启：`reconcileOnStartup` 会把遗留 STARTING/RUNNING 标为 `UNKNOWN` 并清理租约。

## 3. 发布审批

```bash
# 读取发布摘要
curl -s http://127.0.0.1:3097/api/apps/ec.listing/1.0.0 | jq .releaseDigest

# 记录审批（绑定精确摘要）
curl -s -X POST http://127.0.0.1:3097/api/apps/ec.listing/1.0.0/approval \
  -H 'content-type: application/json' \
  -d '{"releaseDigest":"<digest>","approvedBy":"qa-lead","evidence":"uat-run-7","rollbackTarget":"0.9.0"}'

# 撤销
curl -s -X POST http://127.0.0.1:3097/api/apps/ec.listing/1.0.0/approval/revoke \
  -H 'content-type: application/json' -d '{"reason":"superseded by 1.0.1"}'
```

- 配置 `requireReleaseApproval: true` 后，创建/重试运行要求 ACTIVE、未过期、摘要一致的审批。
- 审批摘要与当前发布不一致时拒绝（`APP_APPROVAL_DIGEST_MISMATCH`）。
- 审批记录是部署事实；它不授予数据访问，也不替代业务复核。

## 4. 模型健康

- 由部署探针调用工具 `platform_model_health_record`（或服务方法 `recordModelHealth`）写入探测结果；
  读取用 `platform_model_health`，HTTP `GET /api/models` 同时返回 `health` 数组。

- 状态：`healthy | degraded | unavailable | unknown`；`unavailable` 必须带原因。
- `requireModelHealth: true` 时，创建、重试与派发都会重新校验；未探测保持 `unknown`，不当作健康。
- 工作台设置页显示每个模型项的健康事实与探测时间。

## 5. 指标与日志

- `GET /api/metrics` → JSON（counter/gauge/histogram 的 p50/p95/p99）。
- `GET /api/metrics?format=prometheus` → Prometheus 文本。
- 日志为 stderr 上的结构化 JSON（`PLATFORM_LOG_LEVEL=debug|info|warn|error`），自动脱敏
  input/prompt/token 等键；日志不是审计记录。
- 常用指标：
  - `platform_http_requests` / `platform_http_duration_ms`
  - `platform_run_created` / `platform_run_transition`
  - `platform_outbox_retry` / `platform_outbox_dead`
  - `platform_launch_lease_expired`
  - `platform_model_health`

## 6. 审计导出

```bash
curl -s -D - 'http://127.0.0.1:3097/api/audit/export?limit=1000' -o audit.ndjson
# 响应头 X-Audit-Head 为链头摘要，X-Audit-Last-Sequence 为游标
```

- 每行含 `prevDigest` 与 `digest`；升序哈希链。删除、改写或重排一行都会破坏验证。
- 使用游标继续导出：`?after=<lastSequence>`；按对象导出：`?target=<workId|runId|appId@version>`。
- 需要签名时，由部署对 `X-Audit-Head` 加签；平台不宣称不可抵赖。

## 7. 备份与恢复

```bash
# 备份（目标目录必须为空或不存在）
npm --prefix packages/platform-control run backup -- backup \
  --store <DSH_HOME>/platform/control.sqlite \
  --artifacts <DSH_HOME>/platform/artifacts \
  --out /backup/platform-20261117

# 校验
npm --prefix packages/platform-control run backup -- verify --backup /backup/platform-20261117

# 恢复到新位置（先校验，失败不落盘）
npm --prefix packages/platform-control run backup -- restore \
  --backup /backup/platform-20261117 \
  --store /restore/platform/control.sqlite \
  --artifacts /restore/platform/artifacts
```

- `VACUUM INTO` 保证事务一致；产物目录按相对路径 + 摘要入清单。
- 恢复后建议：启动控制面、检查 `platform_control_status`、抽查 Run/Artifact 摘要与工作台打开。
- 这不是高可用方案，也没有承诺 RPO/RTO；保留策略由部署决定。

## 8. 知识验证回执

- 中心用 `createValidationRequestFor` 签发请求（候选 digest、套件版本/digest、用例集 digest）。
- 执行域返回回执后，中心用 `validateWithReceipt` 核验执行器白名单、请求绑定、用例数量/分组/期望摘要，
  再按 claims/coverage/evidence 规则激活。失败仍记录回执与事件，候选保持 CANDIDATE。
- 未实现：真实跨进程通道、执行器身份凭据与租约；这些由部署合同承担。

## 9. 已知边界（不要写成已完成）

- 企业身份/租户/项目授权未接入；当前部署仍是本机单操作者或部署提供的鉴权代理。
- SDK harness 在控制进程内运行，没有独立 PID/进程树终止证明；多进程租约移交未实现。
- 没有分布式追踪、指标存储、告警与集中日志；指标是进程内快照。
- 未做真实模型、真实员工可用性或生产部署验收。
## 10. 发布回滚

```bash
curl -s -X POST http://127.0.0.1:3097/api/apps/ec.listing/1.0.0/rollback \
  -H 'content-type: application/json' \
  -d '{"toVersion":"0.9.0","reason":"regression in 1.0.0"}'
```

- 撤销 1.0.0，保留 0.9.0 为 ACTIVE 目标；启用审批时 0.9.0 必须已批准且未过期。
- 历史运行与成果不改写；新运行只能落在仍 ACTIVE 的版本。

## 11. 交付复核

```bash
# 发起复核（仅 SUCCEEDED 运行）
curl -s -X POST http://127.0.0.1:3097/api/runs/<runId>/reviews \
  -H 'content-type: application/json' -d '{"note":"请复核本批结果"}'

# 决定（CAS：expectedRevision 必须等于当前 review.revision）
curl -s -X POST http://127.0.0.1:3097/api/reviews/<reviewId>/decision \
  -H 'content-type: application/json' \
  -d '{"decision":"APPROVED","expectedRevision":1,"note":"已核对"}'
```

- 驳回必须写原因；决定不可改写；每运行同时最多一个未结复核。
- 复核记录不是电子签名，也不替代公司正式审批流程。

## 12. 知识沉淀接缝

- 部署可通过 `PlatformControlService.setKnowledgeCaptureSink` 订阅终态运行事实（摘要与标识，不含输入正文）。
- sink 只能创建 CANDIDATE；sink 抛错只会产生 `KNOWLEDGE_CAPTURE_SINK_FAILED` 审计，不改变运行结局。

## 13. 本地自安装自检与子进程模式

```bash
# 自检（可选 --deployment 读取真实部署配置）
npm --prefix packages/platform-control run doctor -- --store <DSH_HOME>/platform/control.sqlite
```

- 退出码 0 表示没有失败项；`warn` 不阻断（例如未找到 Rscript、尚未配置 Worker）。
- 检查项：Node ≥ 24.9、库目录可写、SQLite quick_check 与库身份、数据计数、Worker 路径/profile/runner/SDK、R 运行时。

```yaml
worker:
  mode: child-process      # in-process（默认）| child-process
  runnerPath: ...          # 可选；缺省使用包内 scripts/worker-runner.mjs
  killTimeoutMs: 5000      # 取消/超时后等待真实退出的上限
```

- 子进程模式下取消会终止整棵进程树，并只在观察到真实退出后结算；超时未退出记 UNKNOWN。
- 子进程提问通过平台收件箱往返，不依赖终端；未回答的问题随运行终止失效。
