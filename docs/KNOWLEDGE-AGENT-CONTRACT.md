# 插件知识智能体合同（v2）

状态：已实现 v0.1 · 2026-11-20。适用：全部纳管 DSH 插件的知识智能体定义、授权范围、快照检索、事件投影与验证回执。依据[体系设计](DSH-ENTERPRISE-KNOWLEDGE-SYSTEM.md)与[开发验收计划](DSH-ENTERPRISE-KNOWLEDGE-DELIVERY-PLAN.md)。本文描述代码合同与已实现入口；真实宿主、领域质量与部署验收须按计划另行留证。

## 1. 智能体定义：`knowledge/manifest.json`（schemaVersion 2）

一个纳管插件身份一个定义，文件位于 `<插件目录>/knowledge/manifest.json`。解析入口：`platform-knowledge` 的 `parseKnowledgeManifest`（严格校验，未知字段、空定义、断链引用一律拒绝）。

| 字段 | 要求 |
|---|---|
| `pluginId` | 与装配清单一致；Host/Client 构件不另造身份 |
| `owner` / `agent.owner` | 必须写明负责人 |
| `agent.id` / `agent.version` | 智能体身份与定义版本；Run 按发布版本显式解析 |
| `agent.topics` / `agent.tools` / `agent.noMethodTools` | 主题与工具映射；“无方法”只逐能力说明，不能跳过整插件 |
| `taxonomy.topics` | 所有种子主题必须在其内 |
| `seeds[]` | 知识种子；`validator` 必须指向 `validators[]` 中覆盖该条目的套件 |
| `validators[]` | 已安装验证套件声明（版本、覆盖条目） |
| `feedback.events` / `feedback.projectionVersion` | 可信反馈事件类型与投影版本 |
| `goldenSet` | 领域黄金集：`query → expect[]` 与显式 `expectEmpty` 负例；`expect` 必须指向已声明种子 |
| `scope` | 适用组织/区域/项目；插件级知识通常为 `projects: "all"` |
| `corpus`（可选） | 批准语料来源与前缀 |

注册表 `KnowledgeAgentRegistry`：同一插件可并存多个版本（蓝绿/新旧同时运行）；同一 `(pluginId, agentVersion)` 内容一致为幂等、内容不同直接拒绝；`activate` 显式切换；`unregister` 清理注册但保留历史；不带版本 `resolve` 只解析当前激活版本，不猜“最新”。

## 2. 授权范围：`KnowledgeScopeBoundary`

部署装配方声明可信范围（`Config.scopes`）：

```ts
{ pluginId, orgId?, region?, projectIds?: string[], allProjects?: boolean, locale?, corpusDocPrefixes?: string[] }
```

- 工具参数只能收窄：`projectId` 必须在允许集合内；插件身份、组织、区域不得由模型改写（越界抛 `KNOWLEDGE_SCOPE_ESCALATION` / `KNOWLEDGE_PROJECT_OUT_OF_SCOPE`）。
- 未声明范围的插件调用失败关闭（`KNOWLEDGE_SCOPE_UNAVAILABLE`），不回落到模型自报身份。
- 语料检索按声明前缀在 SQL 内过滤；未声明前缀时整体拒绝（`KNOWLEDGE_CORPUS_SCOPE_REQUIRED`）。

## 3. 快照、固定集合与证据

- Run 创建时控制面只读计算 `{context, records:[{knowledgeId,revision,contentDigest}], snapshotDigest}`，保存到 Run 的 `knowledge` 字段（`readSnapshot`）。摘要仅作完整性证据，`records` 才是可重放的固定集合。
- `searchPinned(context, snapshot, options)`：只读绑定修订；后续升级不改变原 Run；撤回（`REVOKED`/`CONFLICT`）与撤权（不可见）逐条进入 `evidence.excluded`，不读活库、不换新版；摘要被篡改抛 `KNOWLEDGE_SNAPSHOT_INVALID`。
- 检索结果附带 `evidence`：`status`（`BOUND` / `EMPTY` / `DEGRADED` / `UNBOUND`）、固定集合摘要与条目数、本次实际返回、被排除条目及原因（`REVOKED` / `CONFLICT` / `UNAVAILABLE` / `NOT_VISIBLE` / `TAMPERED`）。
- `cite(context, runId, snapshot, refs)` 记录答案最终引用；引用必须来自同一快照且重复幂等；`reconcileCitations` 区分已引用、未引用与未知引用（未引用不冒称采纳）。

## 4. 事件投影与验证回执

- `captureFromProjection`：去重键 `(eventId, contributor, projectionVersion)`；重复投递返回原结局且不产生新修订；无证据时显式记录 `NO_REUSABLE_CONCLUSION` / `PENDING_ANALYSIS`；修订冲突记 `CONFLICT`，其余暂态失败记 `RETRY_REQUIRED`。投影失败不改写业务 Run 状态。
- 控制面在 `run.failed` / `run.unknown` 终结时，把 `(runId, pluginId, projectId, inputDigest)` 投影为 `PENDING_ANALYSIS`，供插件智能体后续提出候选。
- `validateWithReceipt`：回执绑定请求/候选/套件摘要；重复回执幂等返回原结局；同一请求的第二份不同回执拒绝（`KNOWLEDGE_RECEIPT_ALREADY_APPLIED`）；无 claims、覆盖不足、过期修订、未批准执行器均不激活。

## 5. 发布覆盖门禁

```bash
node scripts/verify-knowledge-coverage.mjs
```

```bash
node scripts/verify-knowledge-coverage.mjs --release --json --report coverage.json
```

- 分母来自仓库根 `knowledge-assembly.json`（批准的装配清单）；实际目录未登记即失败，新插件不能默认通过。
- `managed` 插件必须有合法 v2 定义、黄金集与不悬空的证据引用；`library` / `application` 必须写明分类理由；`platform-pending` 记录负责人与阻断理由。
- 仓库门禁（默认）对 pending 只报告；`--release` 将其作为发布阻断。覆盖率 = 通过 managed / 全部 managed。
- 该门禁只证明静态覆盖与定义完整性；黄金检索由 `scripts/verify-knowledge-golden.mjs` 执行，真实宿主与领域质量仍须按验收矩阵留证。

## 6. 尚未完成（不得报告为已验证）

- 真实 DSH 宿主双样本（A10–A12）、全插件领域黄金集与负例（A11、A13 的运行部分）。
- 工作台「知识依据/治理区」界面（撤回、不可用、未绑定分开展示）。
- 身份接线（可信 Principal → 范围声明）的部署配置、验证执行器独立部署与凭据、区域驻留/备份恢复演练（A14、A16）。