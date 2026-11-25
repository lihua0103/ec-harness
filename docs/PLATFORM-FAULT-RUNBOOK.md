# 平台控制面故障 Runbook（E3-5）

面向本地单操作者部署的**按症状排查**手册；操作口径（派发/租约/审批/指标/审计/备份命令本身）见 [平台运行手册](PLATFORM-OPERATIONS-RUNBOOK.md)。
原则：**先看事实，再动手；不确定就留证据（审计导出），不猜着修。**
所有命令在 `packages/platform-control` 下执行，Node 版本要求见 doctor 检查（≥ 24.9）。

## 0. 第一步永远是这三件事

1. **doctor**（环境自检，含库完整性/身份/Worker profile/R 运行时/SDK）：

   ```bash
   node node_modules/tsx/dist/cli.mjs src/doctor-cli.ts --store <control.sqlite 的绝对路径>
   ```

   退出码 0 = 无失败项（warn 不算失败）。工作台「平台设置 → 运营面板」也可看（服务端已接入时）。
2. **运营面板** `GET /api/ops/panel`：实测 p50/p95/p99、Outbox 深度、运行计数、配额事实、doctor 探针。**没有 SLO 目标**——面板只给测量值，不给"达标"绿灯。
3. **审计导出**（带 SHA-256 链，留证据）：

   ```bash
   curl -s "http://127.0.0.1:<port>/api/audit/export?limit=200" > audit.ndjson
   ```

## 1. 运行停在 QUEUED / 不执行

| 现象 | 根因 | 处置 |
|---|---|---|
| 创建即报 `EXECUTOR_NOT_CONFIGURED`（工作台显示"执行器 not-configured"） | 部署未配置 worker | 按 `--deployment` 配置 worker（profile/dshHome/workspace/runtimeBundleDigest）；运行保持持久，配置好后可重试 |
| 运行 QUEUED 不被调度 | scheduler 未启用或控制面进程退出 | 看 `/api/ops/panel` 的 outbox 与运行计数；重启控制面，必要时 `reconcileOnStartup: true` 清理上进程遗留 |
| `RUN_CATALOG_RUNTIME_MISMATCH` / `MODEL_CATALOG_UNAVAILABLE` | 模型目录与 runtime bundle 不一致，或未登记 | 重新登记目录（`registerModelCatalog`）；不要手工改库 |

## 2. 模型相关拒绝

| 错误码 | 含义 | 处置 |
|---|---|---|
| `MODEL_SELECTION_REQUIRED` | 部署有可用模型但本次运行未选 | 员工在工作台显式选择；平台不会静默替选 |
| `MODEL_PREFERENCE_UNAVAILABLE` | 保存的偏好已停用/不可见 | 改选；偏好不会自动迁移 |
| `MODEL_APPROVAL_REQUIRED` / `MODEL_APPROVAL_EXPIRED` | 部署开启 `requireModelApproval`，该模型无生效审批 | 由审批人 `POST /api/models/:selectionId/approval`（绑定具体 selection）；撤回用 `…/approval/revoke` |
| `MODEL_APPROVAL_SELECTION_UNKNOWN` | 想批准不在已登记目录里的模型 | 先登记目录再审批；**不存在**"先批后补"通道 |
| `MODEL_HEALTH_UNAVAILABLE` | `requireModelHealth` 开启且最近健康探测为 unavailable | 探测恢复后自动放行；不要清表"修"它 |

## 3. 配额拒绝（HTTP 429）

- `RUN_QUOTA_CONCURRENCY_EXCEEDED`：该项目进行中运行数达到 `quotas.maxConcurrentRunsPerProject`。取消/终结部分运行后自然释放。
- `RUN_QUOTA_DAILY_EXCEEDED`：当日（UTC）创建数达到 `quotas.maxRunsPerDayPerProject`。**失败与取消的运行同样消耗当日额度**；次日（UTC 0 点）自动恢复。
- 计数口径（见 `GET /api/quotas`）：只统计绑定 Work 的运行；不绑定 Work 的运行不计入——这是口径声明，不是覆盖承诺。
- 平台**不会**静默切换模型、区域或项目来绕开配额。

## 4. 存储与恢复

- 日常备份/校验/恢复走 `src/backup-cli.ts backup|verify|restore`（用法见文件头注释）。**恢复目标永不因备份未过校验而被覆盖。**
- 演练记录与证据：[BACKUP-DRILL-2026-11-18.md](BACKUP-DRILL-2026-11-18.md)。新部署上线前后各演练一次；此后每次备份策略变更后重演。
- 库打不开/`quick_check` 报错：不要 `VACUUM`/手改。先用最近的已校验备份恢复到**新路径**，核对 digest 与运行计数后再切换入口；旧库原样保留。
- 备份不覆盖：知识库（knowledge.sqlite）、原生 DSH 会话目录——恢复后这两处需按各自流程单独核对。

## 5. 交付包（E1-3）

- 封存（SEALED）≠ 交付（DELIVERED）≠ 接收（RECEIVED）；**下载不等于接收**。
- 修改冲突（`DELIVERY_PACKAGE_REVISION_STALE`）：刷新拿到最新 revision 重发，不要覆盖他人状态。
- 撤回（WITHDRAWN）/被替代（SUPERSEDED）是终态；旧包的审核快照不会迁移到新包——新包必须重新走自己的复核。
- 旧审核不自动迁移是设计事实，不是缺陷；发现"新包自动带了旧审批"才要上报。

## 6. 差异视图与不可比较（E1-4）

- `findings-diff` 返回 `comparable: false`（`APP_MISMATCH` / `APP_VERSION_MISMATCH`）时，平台拒绝比较——不要按行号手比。
- 运行失败且 reason 带 `WORKER_FINDINGS_INVALID`：应用提交了格式非法的发现（如重复业务键）。修复插件侧发现生成，平台不会静默裁剪。

## 7. Windows 环境已知边界

- 受限沙箱令牌读不到部分盘符路径、Rscript 直接启动会崩：**模型跑 R 一律走 Rterm 连写 `--file=`**，或由操作者代跑（见平台记忆 `windows-sandbox-execution-boundaries`）。
- R 环境由员工自装；doctor 会报 `runtime.r` warn，不阻断非 R 应用。

## 8. 升级与迁移

- 控制面库迁移是**加列建表**（`CREATE TABLE IF NOT EXISTS`，`PRAGMA user_version`），旧库首次以新代码打开时自动补表。
- `workbench.sqlite`（旧 api-cli 默认名）已被 `control.sqlite` 统一取代；**没有自动数据迁移**——需要旧数据请手工移动文件并在迁移后跑一次 doctor + 审计链核对。
- 升级后必做：doctor 全绿 → 运营面板 outbox 无积压 → 抽一条审计链核对 prevDigest 连续。

## 9. 明确的门控缺口（不装作有）

- **E4-1 真实 SSO/多租户**：等 IT IdP 合同；在此之前界面保持"单操作者"诚实标注，无登录/权限 UI（不造假安全）。
- **E4-2 容器/VM 隔离实测**：本机无 docker/WSL；中心 Worker 隔离只有代码级边界，无实测证据。
- 成本采集（E2-2）：上游 protocol 未声明 usage，成本保持未知，不伪造 0。
