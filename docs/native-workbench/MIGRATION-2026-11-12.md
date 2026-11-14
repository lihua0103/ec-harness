# T10 历史迁移与入口切换（2026-11-12）

状态：**PARTIAL — 只完成只读 dry-run 盘点与摘要守卫；正式迁移与旧入口退役未执行。**

> 第三棒更新（2026-11-12）：原生整页已覆盖旧入口主流程（新建工作/草稿/发起运行/问答回复/模型选择），
> 浏览器 19/19 通过（`evidence/t10-ui-smoke.json`）；迁移脚本新增 `--expect-digest` 预演守卫。
> **旧入口的删除/正式切换是破坏性操作，必须由用户明确确认；本轮未执行。**
> 第三棒 dry-run 证据：`evidence/nw22-dryrun-1.json`、`nw22-dryrun-2.json`（两次摘要一致
> `69a5f6c6…d2ff05`；`--expect-digest` 一致退出 0、不一致退出 4、`--apply` 退出 2）。
> 退役方案与三项能力缺口见 `RETIREMENT-PLAN-2026-11-12.md`；三项缺口已在原生页补齐。
> 退役执行（阶段 0–2）见 `RETIREMENT-EXECUTION-2026-11-12.md`：备份 + 旧入口只读预演 + 逐 Work dry-run
> （7 Works / 7 verified Session）；入口切换未执行，等待用户直接确认。

依据：`docs/NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md` §4 T10、`docs/native-workbench/STATUS.md`。

## 1. 本次实际完成

- 新增只读盘点模块 `packages/platform-control/src/migration.ts`（已导出、已编译、7 项测试通过）。
- 新增 CLI `scripts/native-workbench-migrate.cjs`：
  - 默认 dry-run，只读打开控制面 SQLite（`readOnly: true`），不创建/更新/删除任何记录；
  - 可读取浏览器导出的旧本地记录（v4/v3 或 `{ localStorageKey: value }` 转储）；
  - 输出数量、未绑定工作数、记录摘要 SHA-256，并可 `--out` 写入 JSON 报告；
  - `--apply` **明确拒绝**（`MIGRATION_APPLY_NOT_READY`），避免在替代入口未验证前写入。
- 证据：`evidence/MIGRATION-DRYRUN-2026-11-12.json`（合成演示数据库，非生产数据）。

## 2. 2026-11-12 dry-run 结果（合成数据）

命令：

```bash
node scripts/native-workbench-migrate.cjs \
  --store .runtime/nw-t07-home/platform/native-workbench.sqlite \
  --browser-storage .runtime/nw-migration-sample.json \
  --out docs/native-workbench/evidence/MIGRATION-DRYRUN-2026-11-12.json
```

输出要点：

| 来源 | 结果 |
|---|---|
| 控制面库 | `OK`；项目 1、工作 2、运行 1、输入 13、成果 12、绑定 1 |
| 未绑定原生会话的旧工作 | 1（迁移时只能只读展示） |
| 记录摘要 | `f83d5796c522c09d3b24f6c14efd6a3baabf893a8760e153124f478aabadefe7` |
| 浏览器本地记录 | v4；项目 1、工作 2、输入批次 3、消息 1、草稿 1、只读记录 1 |

两次 dry-run 的摘要必须一致；摘要覆盖 `workId/state` 与 `runId/state`，可用来在正式迁移前后核对身份与状态是否被意外改写。

## 3. 安全边界（已实现）

- 控制面库以只读方式打开；盘点是纯读。
- **建议在控制面停止或静默时盘点**（或对备份副本执行）：WAL 模式下只读连接可能看不到未检查点的页；
  不要把“运行中盘点”当成迁移一致性证明。
- 文件不存在 → `MISSING`（空部署）；文件不是 SQLite → `UNREADABLE`，不会按空库处理。
- 浏览器记录无法识别 → `unknown` 并给出原因，不把损坏记录计成 0 条工作后继续迁移。
- 旧 `activities` 只存在内存，报告明确说明“不补造历史事件”。
- 迁移不会创建第二个聊天内核；旧会话正文仍以 DSH 持久 Session 为准。

## 4. 尚未执行（不得写成完成）

- **正式迁移写入**：需要先完成并验证原生替代入口（T09/T11），再由用户明确确认；脚本已拒绝 `--apply`。
- **旧 Work → 原生 Session 关联**：有可验证 Session 的旧工作应建关联；缺失时只读展示，用户确认后才创建带来源的新 Session。
- **旧入口退役**：`apps/enterprise-workbench` 仍是控制面的静态前端。原生插件页现已覆盖其主流程
  （新建工作/草稿/发起运行/问答回复/模型选择，`evidence/t10-ui-smoke.json` 19/19），退役的**功能前置**已满足；
  但删除静态前端/切换正式入口仍是破坏性变更，需用户明确确认并完成回退演练后才可执行。
- **回退演练**：未执行；退役前必须证明回退部署不会降级 DSH 日志格式、不会用旧库覆盖新写入。

## 5. 正式迁移的前置清单

1. 原生工作台覆盖旧入口的全部可用操作（新建工作/空间绑定/发起运行/问答/模型选择）。
2. `NW01–NW07、NW19、NW21、NW24` 在隔离 profile 上通过（见 `ACCEPTANCE-2026-11-12.md`）。
3. 迁移前备份控制面库与封存成果目录，记录 dry-run 摘要。
4. 按 Work 逐条建立关联；无 Session 的工作只读；用户明确继续后才新建带来源的 Session。
5. 迁移后复跑 dry-run，摘要与数量必须可解释；不一致即停止并回退。
