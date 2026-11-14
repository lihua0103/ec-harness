# 退役执行记录（2026-11-12）

范围：按 `RETIREMENT-PLAN-2026-11-12.md` 执行阶段 0–3。阶段 0–2 为可回退、非破坏操作；
阶段 3 入口切换在用户于本会话直接确认后执行，并完成回退验证。阶段 4（删除/归档）与任何写迁移均未执行。

## 阶段 0：冻结与备份（完成）

- 服务状态：执行前已停止 3095/3096/3098，无写入者。
- 备份目录：`.runtime/nw-retirement/backup-20261112T171025`（1.1 MB）。
- 内容：
  - `store/workbench.sqlite` + `-wal`/`-shm`（旧入口使用的控制库）；
  - `store/native-workbench.sqlite` + `-wal`/`-shm`（T12 合成种子库，一并保留）；
  - `store/artifacts/`（封存成果目录，当前为空）；
  - `old-app/enterprise-workbench/`（旧前端原样副本）；
  - `profile/package.json`、`profile/cordis.patch.yml`（隔离 profile 装配文件）。
- 完整性清单：`MANIFEST.sha256`（51 个文件，逐文件 SHA-256）。

## 阶段 1：备份副本只读预演（完成）

- 启动方式：`api-cli.ts --port 3098 --store <backup>/store/workbench.sqlite --app apps/enterprise-workbench`。
- 只读检查：
  - `GET /api/health` → `{"ok":true}`；
  - `GET /api/workbench` → 7 个 Works、0 Runs，与 dry-run 计数一致；
  - 浏览器打开旧入口，页面列出同名 7 个 Works、0 Runs，未执行任何写操作。
- 证据：`evidence/RETIREMENT-OLD-ENTRY-REHEARSAL.png`。
- 备注：该库是本地合成/测试数据（7 个 "A 方案返回工作台" 测试工作，0 运行、0 成果），
  不是生产业务库。备份同时保留了 T12 合成种子库，避免遗漏另一份演示数据。

## 阶段 2：迁移 dry-run（完成，未写入）

- 命令：
  ```bash
  node scripts/native-workbench-migrate.cjs \
    --store <backup>/store/workbench.sqlite \
    --sessions-home .runtime/nw-web-home/sessions \
    --out docs/native-workbench/evidence/RETIREMENT-DRYRUN-1.json
  ```
- 两次 dry-run 摘要一致：`a50557a5c093471b85833676149a5cf75351d0867d7ea2b7175c426884560a4c`。
- 数量：项目 1、工作空间 1、工作 7、运行 0、输入 0、成果 0、绑定 7、审计 19、草稿 0、提交 0、
  执行域 1、输入批次 0、应用发布 1、模型目录 1。
- 每个 Work 的判定：**可验证 Session 7、无 Session 只读保留 0、Session 未知 0**。
- 浏览器本地记录：`none`（没有可迁移的 v4/v3 记录）。
- 逐 Work：

| Work | 标题 | 判定 | Runs | Artifacts | Session |
|---|---|---|---|---|---|
| 0b6377d3… | A 方案返回工作台 722444 | verified-session | 0 | 0 | session-adb80e5b… |
| 32622f1b… | A 方案返回工作台 685224 | verified-session | 0 | 0 | session-9acd3665… |
| 893697d1… | A 方案返回工作台 658024 | verified-session | 0 | 0 | session-011a236c… |
| 9152c6a2… | A 方案返回工作台 862356 | verified-session | 0 | 0 | session-297c5d3b… |
| a99a5477… | A 方案返回工作台 785824 | verified-session | 0 | 0 | session-a28e82de… |
| cfda6c3f… | A 方案返回工作台 829485 | verified-session | 0 | 0 | session-f00275d3… |
| f194a2cb… | A 方案返回工作台 597663 | verified-session | 0 | 0 | session-99080b38… |

完整字段见 `evidence/RETIREMENT-DRYRUN-1.json` / `-2.json`。

## 阶段 3：入口切换（完成，2026-11-12 用户直接确认）

- **切换前**（旧默认）：控制面 `--port 3096` 默认服务旧前端；`GET /` → 200，页面标题
  `EMERALD · 企业 AI 工作台`；`GET /api/workbench` → 200。截图 `evidence/RETIREMENT-PRE-SWITCH-OLD-ENTRY.png`。
- **切换动作**：
  1. `packages/platform-control/src/api-cli.ts`：不再默认指向 `apps/enterprise-workbench`；只有显式
     `--app <dir>` 才服务静态前端（API-only 为默认）。
  2. `scripts/native-workbench-start.cjs`：local/hosted 启动不再传 `--app`。
  3. 旧目录 `apps/enterprise-workbench` **保留、未删除、未移动、未改内容**。
- **切换后**（API-only）：控制面 `GET /` → 404，`GET /api/health`/`/api/workbench` → 200；
  原生 web 3095 的同源代理 → 200；原生平台页首屏、页内五入口、工作列表均正常。
  平台页激活时原生侧栏完全隐藏（平台页 x=0、宽 1440），进入原生会话恢复侧栏，返回工作台再次隐藏。
  截图 `evidence/RETIREMENT-POST-SWITCH-NATIVE-FULL.png`、`RETIREMENT-CONVERSATION-RESTORED.png`、
  `RETIREMENT-RETURNED-FULL.png`；切换/恢复 8/8：`evidence/RETIREMENT-SHELL-TRANSITION.json`。
- **回退验证**（已实际执行）：显式
  `node --import tsx/esm src/api-cli.ts --port 3098 --store <store> --app apps/enterprise-workbench`
  → `GET /` 200 且返回旧页标题，`GET /api/workbench` 200；验证后停止 3098。
  **回退命令保留在文档中，旧目录可直接恢复服务。**
- 文档历史指针：`docs/README.md`、`docs/native-workbench/STATUS.md`、本文件均指向“旧入口已停止对外服务，
  历史验收记录保留”。

## 阶段 4：删除/归档（未执行）

`apps/enterprise-workbench` 未删除、未移动、未改内容；旧测试与 README 保留。按计划需在观察期后再次确认。

## 门禁

- platform-control：`tsc --noEmit` + 全部测试 **107/107**（迁移判定测试 8/8）。
- platform-workbench：verify（45/45）。
- `verify-all`：13/13；开发规范：PASSED。
- 上游 `upstream/deepseek-harness-git`：`git status` 0 项。
- 未提交、未推送、未改生产 profile。
