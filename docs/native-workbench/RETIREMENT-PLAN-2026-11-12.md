# 旧入口退役与正式迁移方案（2026-11-12）

状态：**方案，未执行**。本文件只提出退役步骤、前置条件、回退与确认点；没有删除、移动或切换任何入口。
旧 `apps/enterprise-workbench` 仍是控制面的静态前端，控制面 HTTP API 不变（原生插件继续使用它）。

依据：`docs/NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md` §4 T10、`docs/native-workbench/STATUS.md`、
`docs/native-workbench/MIGRATION-2026-11-12.md`、`docs/native-workbench/ACCEPTANCE-2026-11-12-T12.md`。

## 1. 资产清单（当前实际引用）

| 资产 | 作用 | 退役影响 |
|---|---|---|
| `apps/enterprise-workbench/` | 旧正式前端（index.html、src/*.mjs、styles.css、tests、verify.mjs） | 退役对象 |
| `packages/platform-control/src/api-cli.ts:34` | `--app` 默认指向旧前端；同时承载 `/api/*` | **只移除静态前端默认值；API 必须保留** |
| `scripts/native-workbench-start.cjs:50,78` | local/hosted 启动时传 `--app` | 改为不传 `--app`（API-only）或传退役提示页 |
| `scripts/native-workbench-deploy.cjs` | 部署描述符生成 | 不改；与静态前端无强绑定 |
| `scripts/verify-all.cjs` | 自动发现 `apps/*` 并执行其 verify | 移除后目标数减少；需同步文档与计数 |
| `apps/enterprise-workbench/package.json` | `verify`/`main`/`exports` | 退役时删除或移入归档 |
| 文档：`docs/README.md`、`docs/native-workbench/*`、`docs/ENTERPRISE-*` | 旧入口定位与证据 | 退役后加历史指针，不删除历史验收记录 |
| 深链接 `?work=<id>&run=<id>` | 旧入口的书签/外部链接 | 原生页不接受 URL 深链接；需提示页/映射说明 |

不在退役范围：`prototypes/enterprise-workbench`（内部原型，不是正式入口）、控制面 API、DSH 上游、原生插件。

## 2. 能力对照（退役前必须逐项处理）

| 旧入口能力 | 原生工作台 | 结论 |
|---|---|---|
| 新建工作 | 已有（项目/空间/应用/标题/目标） | 覆盖 |
| 工作草稿（版本检查） | 已有 | 覆盖 |
| 发起运行 + 模型选择 | 已有 | 覆盖 |
| 问答回复 | 已有（一次性、终态拒绝） | 覆盖 |
| 默认模型偏好 | 已有 | 覆盖 |
| 成果/运行历史/输入批次 | 已有 | 覆盖 |
| 登记工作空间 | 已有 | 覆盖 |
| **新建项目** | **没有**（当前按“部署/管理员登记”处理） | **缺口**：退役前需决定——在原生页补建项目，或明确项目创建只走管理 API/脚本 |
| **取消/重试/对账运行** | **没有** | **缺口**：批量运行的运维能力；需补入口或明确由平台运维脚本承担 |
| **归档工作** | **没有** | **缺口**：需补入口或明确归档策略 |
| 深链接 `?work=&run=` | 不支持 URL 深链接 | 需退役提示页/历史链接说明 |
| 文件成果下载 | 已有（同源代理 + SHA-256） | 覆盖 |

**结论：上述三个“缺口”曾是退役硬前置。** 2026-11-12 企业外壳重建已补齐并验证：
新建项目、取消/重试/对账、归档工作均已在原生页接通控制面（`IMPLEMENTATION-2026-11-12-SHELL.md`、
`evidence/t12-shell-browser.json` 21/21）。退役仍不得自行启动：删除/切换是破坏性操作，需用户再次确认。

### 2.1 缺口补齐建议（推荐，均为原生页 UI 工作，不需要新 API）

| 缺口 | 已有控制面接口 | 建议实现 | 最低验收 |
|---|---|---|---|
| 新建项目 | `POST /api/projects`（operator） | 工作台“新建工作”上方增加项目表单（名称/编号，可选），创建后刷新项目列表 | 创建→出现在项目列表→可用于新建工作；无权限时显示控制面 code |
| 取消运行 | `POST /api/runs/:id/cancel`（需 revision） | 运行历史选中项增加“请求停止”；只调用原生/控制面 cancel，不直接写终态 | CANCELLING/CANCELLED 有真实结算；失败保留 code |
| 重试运行 | `POST /api/runs/:id/retry`（可带 modelSelectionId） | 终态运行增加“重试”，新 run 绑定同一 Work | 新 run 出现且旧 run 不变；单活跃运行冲突如实显示 |
| 对账 UNKNOWN | `POST /api/runs/:id/reconcile` | UNKNOWN 运行显示“确认已停止并释放空间”，需一次确认 | 只释放工作空间，不改写历史结果 |
| 归档工作 | `POST /api/works/:id/archive` | 工作详情增加“归档”，仅 ACTIVE 可用 | 归档后只读提示；新建运行被拒绝 |

补齐后应新增对应的正/负/恢复浏览器证据，再回到本方案的阶段 0。**这些实现本身不删除旧入口，仍属非破坏性改动。**

## 3. 分阶段步骤（破坏性操作只在第 4 阶段且需确认）

### 阶段 0：冻结与备份（只读，非破坏）

1. 选择维护窗口；通知旧入口用户；暂停旧入口的新运行（操作层约束，不改代码）。
2. 停止控制面进程（保证 SQLite 一致性）。
3. 备份：
   - 控制库 `platform/native-workbench.sqlite`（含 `-wal`/`-shm`）；
   - 封存成果目录与运行产物目录；
   - `apps/enterprise-workbench/` 目录原样；
   - 当前部署描述符与 DSH 隔离 profile `cordis.patch.yml`。
4. 记录迁移前 dry-run 摘要（只读）：
   ```bash
   node scripts/native-workbench-migrate.cjs --store <control.sqlite> \
     --browser-storage <export.json> --out <backup>/dryrun-before.json --json
   ```
   保存 `controlStore.digest` 作为后续一致性基线。

### 阶段 1：备份副本预演（非破坏）

1. 在备份副本（不是生产库）上启动控制面与原生 web，复跑：
   - 原生整页主流程（新建工作/草稿/运行/问答/模型）；
   - 原生 composer → Submission 关联；
   - 两个域/两个会话切换；
   - 成果下载、输入批次、运行历史。
2. 用 `--expect-digest <备份基线>` 复跑 dry-run，摘要必须一致；不一致即停止并解释差异。
3. 回退预演：用备份副本启动旧入口，确认它能读取同一批 Works/Runs；**不要让旧入口写入生产库**。
4. 记录预演结果；未通过不得进入阶段 2。

### 阶段 2：历史数据迁移（逐 Work，写操作需用户确认）

1. 对每个旧 Work：
   - 有可验证原生 Session：建立显式绑定（记录来源与 releaseDigest）；
   - 无 Session：只读展示旧 Run/成果；**用户明确确认后**才创建带来源的新 Session；
   - 不把旧 `activities` 内存记录补造成历史事件。
2. 旧 Run 作为批处理执行记录保留；不为它伪造聊天正文。
3. 浏览器 v4 原型记录不是生产数据，默认不迁移；如需要，先由用户导出，再按
   `scripts/native-workbench-migrate.cjs --browser-storage` 盘点。
4. 迁移后复跑 dry-run：数量与摘要可解释；不一致停止并回退。

### 阶段 3：入口切换（需用户确认；建议先只读并存）

推荐做法（可回退）：

1. 新增一个**退役提示页**（静态目录，例如 `apps/enterprise-workbench-retired/`）：
   - 说明“已迁移到 DSH 原生工作台”；
   - 对 `?work=<id>&run=<id>` 显示该 Work/Run 的只读标识与操作指引；
   - 不提供写操作。
2. `native-workbench-start.cjs`/`api-cli.ts` 的 `--app` 指向提示页（或省略 `--app`，API-only）。
3. 保留 `apps/enterprise-workbench/` 目录与备份 N 天（建议 14 天），仅停止对外服务，不立即删除。
4. 观察期：无回退请求、无旧链接工单、原生页使用正常。

### 阶段 4：清理（最后、破坏性、需再次确认）

仅在阶段 3 观察期通过且用户再次确认后：

1. 删除/归档 `apps/enterprise-workbench/`；
2. 更新 `scripts/native-workbench-start.cjs` 与 `api-cli.ts` 的默认 `--app`；
3. 更新 `scripts/verify-all.cjs` 目标计数与 `docs/README.md` 导航；
4. 删除旧前端专属测试与 `README.md` 引用；保留历史验收文档作为记录；
5. 复跑全部门禁与 `verify-all`，确认 API 与原生插件路径未受影响。

## 4. 回退方案

| 场景 | 回退动作 | 验证 |
|---|---|---|
| 原生页不可用/回归 | 恢复 `--app apps/enterprise-workbench`，重启控制面 | 旧入口能读 Works/Runs；不执行写操作覆盖新数据 |
| 迁移写错关联 | 使用迁移前备份库恢复；停止所有写入 | 恢复后 dry-run 摘要与备份基线一致 |
| 新表/绑定导致旧库读取异常 | 旧前端不依赖新表；新表均为 `CREATE TABLE IF NOT EXISTS` 附加 | 旧入口读取 Works/Runs 正常 |
| 深链接失效 | 保留提示页与 Work/Run 映射说明 | 旧链接可定位到对应 Work |

回退**不**降级 DSH Session 日志格式、不删除原生 Session、不用旧库覆盖新写入。

## 5. 验收门禁（切换前全部满足）

- [x] 第 2 节三个能力缺口已在原生页补齐并有浏览器/API 正负证据（2026-11-12）。
- [ ] 阶段 1 预演通过；备份副本 dry-run 摘要与基线一致。
- [ ] 阶段 2 迁移后复跑 dry-run，数量/摘要可解释；UNKNOWN/未绑定项有清单。
- [ ] 回退预演通过（旧入口可读、不写入）。
- [ ] 用户书面确认切换窗口与回退保留期。
- [ ] `node scripts/verify-all.cjs` 与 `node scripts/check-development-standard.mjs` 通过。
- [ ] 上游 `upstream/deepseek-harness-git` `git status` 为 0。

## 6. 风险与未决

- **项目创建归属**：原生页当前不创建项目；若不补入口，退役后项目只能由部署/管理 API 创建。需产品决定。
- **运行运维**：取消/重试/对账/归档不在原生页；需补入口或明确由平台脚本承担。
- **深链接**：旧 URL 无法直接映射到原生页；提示页只能做只读指引。
- **身份**：本地/测试 principal 不是 SSO；切入口不等于身份验收，NW11–NW13 仍 BLOCKED。
- **集中部署**：NW20 BLOCKED；退役方案只覆盖本地/单控制面形态。

## 7. 本方案不做什么

- 不删除任何文件、不切换任何默认入口、不写迁移数据。
- 不把 dry-run 当迁移，不把原生页 19/19 当业务验收。
- 不修改 DSH 上游，不修改生产 profile。
