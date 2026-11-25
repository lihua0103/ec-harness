# 控制面备份恢复演练记录（2026-11-18）

**性质**：实机演练（E3-2）。不是文档承诺——以下每一步都在本机真实执行并留下产物。

## 演练一：真实控制面库（.runtime/dsh-home/platform/control.sqlite）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 备份 | `node node_modules/tsx/dist/cli.mjs src/backup-cli.ts backup --store ../../.runtime/dsh-home/platform/control.sqlite --out ../../.runtime/dsh-home/platform/backups/drill-2026-11-18` | `ok: true`，store 188416 bytes，SHA-256 `7ea49061…ba8629` |
| 校验 | `… verify --backup …/drill-2026-11-18` | `ok: true`，`problems: []` |
| 恢复 | `… restore --backup …/drill-2026-11-18 --store …/backups/drill-restore-2026-11-18/control.sqlite` | `ok: true`，head 与备份 digest 一致 |
| 复核 | `drill-compare.mts`（只读打开源库与恢复库逐表比对） | `identical: true`（18 张表逐一相符，user_version=1） |

**诚实边界**：该真实库当前没有业务数据（0 应用/0 工作/0 运行）——它是历史演示进程留下的空库。空库演练证明的是备份/校验/恢复/复核**链路**可用，不证明**内容**保真。

## 演练二：内容保真（tests/backup.test.ts，含失败路径）

内容保真由持久回归测试承担（每次 `verify-all` 都会重跑）：

- 非空库（应用 + 项目 + 工作 + 运行 + 封存产物）备份 → 校验 → 恢复 → 重新打开，逐项核对运行历史与产物字节一致。
- 篡改产物字节 → 校验失败 `ARTIFACT_DIGEST_MISMATCH` → 恢复被拒绝（`BACKUP_VERIFY_FAILED`）。
- 已存在非空备份目录 → 备份被拒绝（`BACKUP_TARGET_NOT_EMPTY`），不覆盖。

## 保留产物

- 备份：`.runtime/dsh-home/platform/backups/drill-2026-11-18/`（含 manifest.json 与 digest）
- 恢复产物：`.runtime/dsh-home/platform/backups/drill-restore-2026-11-18/`
- 比对脚本：`.runtime/dsh-home/platform/backups/drill-compare.mts`（只读，可重跑复核）

## 未覆盖的诚实声明

- 知识库（knowledge.sqlite）与原生 DSH 会话目录**不在**本备份范围（与控制面 `storage` 事实一致）。
- 未演练"生产进程持有库时"的在线备份节奏；`backupControlStore` 使用 SQLite 一致性快照，但建议按 runbook 在控制面停止或低峰时执行。
