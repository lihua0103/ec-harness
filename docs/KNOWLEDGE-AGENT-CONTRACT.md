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
- 控制面在 `run.failed` / `run.unknown` 终结时，把 `(runId, pluginId, projectId, inputDigest)` 投影为 `PENDING_ANALYSIS`，供插件智能体后续提出候选；复核决定以 `qc.completed` 投影（事件 ID `review:<reviewId>`）。
- `platform_knowledge_projections`：按上下文插件只读列出投影台账（`outcome` 可选、`limit` 夹紧到 200），是智能体读取 `PENDING_ANALYSIS` 的入口；读取不产生候选，提出候选仍走 `capture` 与验证器。
- `validateWithReceipt`：回执绑定请求/候选/套件摘要；重复回执幂等返回原结局；同一请求的第二份不同回执拒绝（`KNOWLEDGE_RECEIPT_ALREADY_APPLIED`）；无 claims、覆盖不足、过期修订、未批准执行器均不激活。
- **证据验收（2026-11-25 增补）**：运行期 capture 的候选无法被随包套件激活——coverage 绑定的候选摘要只有在写入之后才存在。`node scripts/knowledge-accept.mjs --store <库> --plugin <id> --knowledge <id> --spec <验收说明>` 由可信的操作者侧执行：从库内候选项派生覆盖绑定，并要求声明的每条 claim 恰有一项证据检查（证据文件内的 JSON 指针 + 比较；证据文件 sha256 随用例摘要写入回执），另须有负例与边界守护检查各至少一项；全部通过才经 `validate()` 标准事务转 ACTIVE（`validationScope=CONTENT_CLAIMS`），否则保持 CANDIDATE 并记 `VALIDATION_FAILED`。套件只验收构建时锁定的候选修订；模型侧工具不暴露该入口，仍不能自批。

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

- 真实 DSH 宿主双样本（A10–A12）与全插件领域质量签收（A11、A13 的运行部分）；黄金集只证明检索能召回声明条目，不证明方法质量。
- 工作台知识依据区的检索证据部分尚未展示：绑定快照与未绑定状态已可见，但 `evidence.excluded` 只在检索调用返回，需服务端把检索证据随运行保存后才能按撤回/降级分开展示。
- 身份接线（可信 Principal → 范围声明）的部署配置、验证执行器独立部署与凭据、区域驻留/备份恢复演练（A14、A16）。

已补齐（仅代码与检索层面）：7 个纳管插件均有 v2 定义；平台控制面/知识服务/工作台各自登记运行与故障处置种子，黄金集含负例与边界正例；控制面复核决定以 `qc.completed` 投影到知识服务（`eventId = review:<reviewId>`，同一决定只投一次）；工作台运行详情显示 Run 绑定的知识快照或"未绑定"。

## 7. 学习平台数据面（2026-11-21 增补，ADR-0004）

《DSH 企业智能体持续学习平台开发设计》L1/L2/L3 落地后，本合同扩展以下条目（持久化、授权与包边界变化见 [ADR-0004](adr/ADR-0004-KNOWLEDGE-LEARNING-DATA-PLANE.md)）：

- **个人偏好（§5 preferences.\*）**：值只能来自封闭注册表（`src/preferences.ts`，enum/boolean/locale）；owner 一律从可信身份派生，API 无 owner 参数；版本比较更新（`PREFERENCE_REVISION_STALE` 拒绝最后写入覆盖）；暂停不注入、删除写墓碑（备份恢复不复活）；乙永远读不到甲的条目。
- **私人方法草稿**：owner 隔离、不入检索面、不进快照，不当作事实或组织标准；删除幂等。
- **学习个案与提案（§5 learning.proposeFromCase）**：个案幂等键 `(tenant, pluginId, eventId, hypothesisKey)`；提案去项目化**新建**候选（禁 projectId、禁 scope 升级、禁直接 ACTIVE）；eventRef 用个案来源事件的真实 runId（KA12）；幂等键同内容返回原回执、异内容冲突；`NO_REUSABLE` 与 `PENDING` 都是有效结局。
- **发布清单（§5 release.\*）**：manifest 不可变内容寻址；当前指针 expectedVersion CAS；撤回走台账（新旧 Run 检索均排除 `WITHDRAWN`），回滚只切仍获准清单且不复活撤回条目；技术激活与业务放行分离。
- **LearningBinding**：`RunRecord.knowledge` 可附加发布指针引用与本人 ACTIVE 偏好引用（只有键与修订，永不携带偏好正文）；快照由服务端按 runRef 解析（`platform_knowledge_search_run`），不信任客户端自带快照。
- **持久投影（T04）**：控制面终端事实先入 `knowledge_capture_outbox`（幂等键 (kind,eventId)），泵投递 + 有限重试 + 死信 + 人工重放；知识投影失败不改业务 Run 状态。
- **权威服务面（L1）**：`createKnowledgeServiceServer` 暴露认证 REST 面（偏好/草稿/个案/发布/快照解析）；主体、租户、区域来自验证过的连接（转发头），不来自请求体；越权与不存在对无权限方不可区分。