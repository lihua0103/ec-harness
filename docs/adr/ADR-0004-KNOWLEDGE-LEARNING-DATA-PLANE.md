# ADR-0004: 企业智能体持续学习平台数据面（L1/L2/L3）

日期：2026-11-21 · 状态：已实施（代码与测试） · 需求来源：[DSH-AGENT-LEARNING-DEVELOPMENT.md](../DSH-AGENT-LEARNING-DEVELOPMENT.md) v0.1

## 背景

设计文档要求补齐三类能力：L1 权威服务（组织/区域/主体/项目隔离 + 经认证共享服务）、L2 个人记忆（类型化偏好、私人草稿与删除）、L3 复盘与发布（可信观测→处理结局→新候选→独立回执→不可变清单→新 Run 引用）。实施前设计文档为"待评审"，本 ADR 记录落地的持久化、授权与包边界决策。

## 决策

### D1 知识库 schema v5→v6（platform-knowledge 是唯一写者）

`knowledge.sqlite` 新增七类表（`packages/platform-knowledge/src/store.ts`，`SCHEMA_VERSION=6`）：

| 表 | 职责 | 关键约束 |
|---|---|---|
| `personal_settings` | 类型化个人偏好 | PK(tenant,owner,plugin_key,key)；删除=墓碑（DELETED+值清空）；版本比较更新 |
| `personal_drafts` | 私人方法草稿 | owner 隔离；不入 FTS、不进快照 |
| `learning_cases` | 学习个案台账 | UNIQUE(tenant,pluginId,eventId,hypothesisKey)；PENDING/NO_REUSABLE 均为有效结局 |
| `learning_proposals` | 提案幂等台账 | PK(tenant,idempotencyKey)：同键同内容→原回执，异内容→冲突 |
| `knowledge_releases` | 不可变发布清单 | manifest 内容寻址（digest）；state CURRENT/WITHDRAWN |
| `knowledge_release_pointers` | 当前指针 | expectedVersion CAS 原子切换 |
| `knowledge_release_withdrawals` | 撤回台账 | 逐 (release,knowledgeId,revision)；回滚不复活撤回条目 |

租户列统一 `NOT NULL DEFAULT ''`（''=未声明，本地部署），避免 SQLite NULL 主键歧义。

### D2 偏好键是封闭注册表，不是数据

`src/preferences.ts`：值只能是注册表内 enum/boolean/locale 标量——脚本、系统提示词、权限开关在结构上不可成为偏好值。新增键走软件变更（代码评审），不是热更新。

### D3 owner 从可信身份派生，API 无 owner 参数

偏好/草稿的 owner 一律取自 `KnowledgePrincipal.actorId`（控制面从 authenticator 派生；HTTP 面从连接头派生）。越权与不存在对无权限方不可区分（404 掩蔽）。主体断言强度由上游认证方负责；`headerIdentityAuthenticator` 只校验通道 token + 读取 `x-dsh-subject/org/region` 转发头（控制面是受信身份通道）。

### D4 发布感知快照与撤回台账

`snapshot-readonly.readSnapshot` 与 `KnowledgeService.createSnapshot` 共用同一实现（service 委托 readSnapshot，保证逐字节一致）：发布指针存在时快照取清单条目（剔除撤回台账/非 ACTIVE/不可见条目）；无指针保持活库语义。`searchPinned` 新增 `WITHDRAWN` 排除原因——撤回后新旧 Run 都不能重取失效正文（T06），回滚不复活撤回条目。

### D5 Run 绑定走只读文件口，交互面走 KnowledgeAccess seam

`createWorkRun` 保持同步事务：发布指针与偏好引用经 `readReleasePointer`/`readActivePreferenceRefs`（只读 SQLite 文件函数）解析，不引入跨进程写者。工作台交互操作（偏好/草稿/个案/提案/发布）经 `KnowledgeAccess` seam（`src/access.ts`）：同进程用 `InProcessKnowledgeAccess`，分进程用 `HttpKnowledgeAccess`（`knowledgeServiceUrl` 配置）→ `createKnowledgeServiceServer`（token 认证 + 主体转发头）。`RunRecord.knowledge` 只附加**引用**（release 指针、偏好键+修订），永不携带偏好正文——共享运行记录不暴露私有数据（§4 LearningBinding）。

**遗留（如实记录）**：控制面分进程且无本地知识库文件时，Run 绑定仍无法解析（与 v5 行为一致，不回归）；`POST /snapshot/resolve` HTTP 面已就绪，后续迭代把绑定源切到服务口。

### D6 知识捕获改持久 outbox（T04）

控制面 `knowledge_capture_outbox` 表：终端运行事实先入队（幂等键 (kind,eventId)），泵 `drainKnowledgeCaptureOutbox` 投递 + 退避重试 + 死信 + `replayKnowledgeCaptureDeadLetters` 人工重放；`RunScheduler.tick` 与派发同拍。sink 可返回 outcome：`RETRY_REQUIRED` 重试、`CONFLICT`/`PENDING_ANALYSIS` 等显式结局即交付完成。知识投影失败不改业务 Run 状态。

### D7 控制面授权面

`PlatformAction` 新增 `preference.read/write`、`learning.case.read/propose`、`knowledge.release.read/publish/withdraw/rollback`（operator 集合）。发布角色决定受众；技术激活（claims/coverage）与业务放行（发布指针）保持分离。

## 不做 / 后置

L4 真实盲评（需 QA 素材与留出项目）、L5 运维演练、L6 权重训练（ModelRelease/evaluation.compare）、PostgreSQL/向量索引/跨区分发、真实企业 SSO 主体源。以上均按设计文档记为"未执行"，不宣称达标。

## 后果

- 既有库打开即自动迁移到 v6（幂等 CREATE）；`user_version` 锚点测试同步为 6。
- 工作台新增「我的习惯」卡片与运行详情"本次使用说明"；偏好值永不出现在运行记录中。
- T01–T07 的可自动化验证由各包新增测试覆盖（preferences/learning-cases/releases/isolation/http + learning-outbox/run-learning-binding/preferences-http）。
