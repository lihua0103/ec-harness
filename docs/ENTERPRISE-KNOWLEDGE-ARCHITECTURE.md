# 国际化企业级 AI 智能体知识库架构

版本：0.3 · 2026-11-17 · 状态：目标架构设计。**P0 + KA01–KA16 工程项已落地并全仓门禁通过（2026-11-17，`verify-all` 18/18；platform-control 113/113；platform-knowledge 21/21 + golden）**：存储 v3（作用域索引 + FTS5 trigram + 标签表 + `knowledge_chunks`/`knowledge_chunks_fts`，v1 库自动原地迁移）、FTS 检索管线（SQL 侧过滤/去重/排序/分页，实测 20 000 条选择性查询 2 ms、未命中 0 ms，对照 v1 全扫描 1 868 ms）、四插件 `knowledge/manifest.json` 沉淀合同与规范检查器五条规则、dm-participants/dm-viz 首次接入 `clinicalKnowledge` 并导入种子、listing/dvp 种子补窄声明（intake/firewhen/uat/changemark 可达 ACTIVE）、`platform-knowledge` 自有测试 20 项 + 黄金集进 verify。文档语料已对真实 `docs/` 57 份 md 建 813 个可定位分片（两次导入全幂等），`platform_knowledge_docs_search` 工具与 `scripts/ingest-knowledge-docs.mjs` 可用；Run 创建按 `descriptor.knowledgePluginId` 绑定只读快照摘要（与 `KnowledgeService.snapshot` 逐字节一致），控制面只读、唯一写者不变。新增：schema v4（orgId/region/i18n/eventRef）、租户/区域 SQL 过滤与上下文盖章、多语别名召回、运行事件候选、跨进程验证请求/回执协议、快照影响检查工具、四插件黄金集（KA15）已落地并纳入 `verify-all`。KA16 已提供 VACUUM INTO 一致备份/恢复冒烟；仍属部署责任且未完成真实生产演练。ClaimEvidence 结构化扩展已落地（coverage[].evidence 绑定 suite/version/caseIds；真实插件验证器已填写 evidence）；真实跨进程 ValidationExecutor 部署身份仍为目标，不属于本文承诺能力。本文其余部分仍为设计正文，不代表已实现。

上游合同（本文不重复其条款，冲突时以上游为准）：[平台经验知识库合同](PLATFORM-EXPERIENCE-KNOWLEDGE.md)（分类、作用域、学习状态机）· [跨进程知识验证合同](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md)（执行与状态提交分离）· [企业身份与数据入口契约](ENTERPRISE-IDENTITY-AND-DATA-CONTRACT.md)（Principal 派生、项目授权）· [应用发布合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)（不可变运行基线）· [多插件总架构](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md)（几十至上百插件、模块化单体优先）· [开发规范](DSH-PLUGIN-DEVELOPMENT-STANDARD.md) §3.3/§7。

现状与实测缺口见 [知识库规模评估](KNOWLEDGE-SCALE-ASSESSMENT.md)：4 个插件中 2 个零沉淀、20 000 条时单次检索约 1.9 s、listing 全量方法结构性不可 ACTIVE。本文的架构即针对这些缺口设计。

---

## 0. 一页结论

| 决策 | 内容 |
|---|---|
| 形态 | 一个**中心知识服务**（模块化单体，唯一写者）+ 受控 **ValidationExecutor** + 区域存储单元；不按插件建库，不建第二套 Agent 循环 |
| 分层 | L0 语料 → L1 知识对象 → L2 索引检索 → L3 验证激活 → L4 租户授权 → L5 消费面 |
| 检索 | 作用域 SQL 预过滤 → 全文召回（FTS5 trigram，中文可用）→ 标签/别名扩展 → 混合重排（可选 ANN）→ 证据装配；**未命中必须如实为零** |
| 沉淀 | 每插件必须提交 `knowledge/manifest.json`，把**每个业务工具组映射到知识主题**或显式声明无方法知识并给理由；纳入规范检查器与发布检查，不靠自觉 |
| 国际化 | 语言是记录的一个**面（facet）**，与作用域正交；缩写/别名索引支持中英混排；区域（region）是**物理分区**，跨区不共享可写库 |
| 租户 | `orgId` 从 Principal 派生并作为分区键；shared 作用域需平台写角色；作用域**永不由工具参数决定** |
| 运行 | 每次 Run 固定 `knowledgeSnapshotDigest`，在途不随知识更新漂移 |
| 演进 | Phase 1 单机 SQLite+WAL；Phase 2 中心服务 + Postgres/pgvector；Phase 3 区域单元。**按实测负载推进，不预先上向量集群** |

---

## 1. 定位与边界

### 1.1 知识库是什么

知识库保存**方法性判断**：什么现象、为什么、怎么改、何时适用、何时不适用、如何证明。它服务于两个行为：

1. **检索**：Agent 在会话中主动检索与当前插件/项目/场景相关的历史方法（不是每轮注入整库）。
2. **沉淀**：运行失败、程序修订、用户裁定、QC 结果被提炼为候选，经可复现断言验证后成为 ACTIVE，供后续运行复用。

### 1.2 四类对象必须分开（混用是本项目最大的历史风险）

| 对象 | 权威来源 | 知识库的角色 |
|---|---|---|
| 会话记录 | DSH Session | 不镜像。仅通过 runId 引用 |
| 运行事实（Run/launch/事件/产物） | 平台控制面 `runs`/`run_events`/`run_artifacts` | 不复制正文，只存引用 + digest |
| 文档语料（方案/模板/设计稿/ADR/规范） | `docs/`、插件文档、上游锁定源码 | 分片入语料索引，**引用不替代原文** |
| 方法知识（本文主体） | 知识服务 | 唯一可写、可验证、可撤回的对象 |

### 1.3 明确不做

- 不做通用 RAG 问答、不做向量库先上、不做独立搜索集群/消息中间件（[总架构 §12](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md)）。
- 不把知识当授权：检索命中不授予数据访问，ACTIVE 不授予临床批准（[开发规范 §7](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)）。
- 不做「按插件一个数据库」；不把同一可写库挂给多个 Worker。
- 不宣称 GxP/Part 11 合规、全球部署或数据驻留已验收。

---

## 2. 分层架构

```
┌──────────────────────────────── L5 消费面 ────────────────────────────────┐
│  Agent 工具（*_knowledge_search/capture/validate）│ 工作台检索与证据面板 │
│  插件 Skill（何时检索哪个主题）                  │ Run 内固定快照检索     │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ 仅供检索与候选提交，无激活写权
┌───────────────────────────────────▼──────────────────────────────────────┐
│ L4 租户与授权       Principal(orgId) → 作用域派生 → 分区预过滤            │
│   （拒绝跨 org / 跨 region / 非成员项目；工具参数不构成授权）              │
└───────────────────────────────────┬──────────────────────────────────────┘
┌───────────────────────────────────▼──────────────────────────────────────┐
│ L3 验证与激活       ValidationRequest → ValidationExecutor → Receipt       │
│   中心核验（摘要一致/覆盖完整/非空用例/CAS 修订）→ ACTIVE|CANDIDATE|CONFLICT│
└───────────────────────────────────┬──────────────────────────────────────┘
┌───────────────────────────────────▼──────────────────────────────────────┐
│ L2 索引与检索       作用域预过滤 → 全文召回 → 别名/标签扩展 → 混合重排     │
│   → 证据装配（状态/claims/来源/快照）                                     │
└───────────────────────────────────┬──────────────────────────────────────┘
┌───────────────────────────────────▼──────────────────────────────────────┐
│ L1 知识对象          修订不可变、head+revisions、tags、claims、provenance  │
└───────────────────────────────────┬──────────────────────────────────────┘
┌───────────────────────────────────▼──────────────────────────────────────┐
│ L0 语料             文档分片（chunk+行号+digest）│ 插件种子 manifest      │
│                     运行/产物引用（runId+摘要）  │ 术语表（多语言）       │
└──────────────────────────────────────────────────────────────────────────┘
```

写入路径只有一条：**中心服务**。Worker/Agent 只提交候选与验证请求；验证在独立执行域完成；回执经授权通道回到中心，由中心唯一提交状态。

---

## 3. 知识对象模型

### 3.1 记录（在现有 `KnowledgeDraft` 上扩展，保留全部既有字段）

```ts
type Scope = 'shared' | 'plugin' | 'project';
type Kind = 'technical_method' | 'edc_method' | 'scenario_method' | 'project_decision';
type State = 'CANDIDATE' | 'ACTIVE' | 'CONFLICT' | 'SUPERSEDED' | 'REVOKED';

interface KnowledgeRecordV2 {
  knowledgeId: string;            // 稳定 ID，永不因晋升而改；晋升另建 ID 并 derivedFrom 关联
  revision: number;               // 递增；正文/前提/反例/分类变化即新修订
  contentDigest: string;          // 规范化正文摘要，绑定验证回执
  scope: Scope;
  orgId: string;                  // 必填（shared 记录由平台 org 持有）
  pluginId?: string;
  projectId?: string;
  region: 'cn' | 'eu' | 'us';     // 物理分区标识，不跨区检索
  kind: Kind;

  // 分类与适用性（检索面）
  scenarios: string[];
  edc: string[];
  topics: string[];
  preconditions: string[];
  notApplicable: string[];

  // 正文
  title: string;
  problemSignal: string;
  cause: string;
  method: string;
  counterexamples: string[];

  // 证据（必填才可激活）
  claims: string[];               // 机器可复现的具体断言，≤64 条
  sources: string[];              // 文档路径#行号 / runId / 旧资料 / 用户裁定
  provenance: {
    origin: 'doc_corpus' | 'run_event' | 'user_decision' | 'legacy_seed' | 'validated_external';
    refs: Array<{ kind: string; id: string; digest?: string }>;
  };

  // 国际化面
  i18n: {
    primaryLocale: string;        // 'zh-CN' | 'en-US' | ...
    locales: string[];            // 已撰写/已翻译的语言
    aliases: Record<string, string[]>;  // 各语言下的缩写、同义词、常见错拼
    translation?: { fromLocale: string; fromRevision: number; state: 'authored' | 'translated' | 'stale' };
  };

  derivedFrom?: string;
  supersedes?: string;
}
```

**关键约束**（不改动既有语义，只是补齐规模与非英语场景）：

- `region`、`orgId`、`i18n` 必填；缺任何一项拒绝写入（避免默认值伪装成事实）。
- `aliases` 是检索面不是正文；不参与 `contentDigest` 的正文语义，但参与索引重建（单独摘要）。
- `translation.state='stale'` 的记录可检索但必须标注，且在默认排序中降权。

### 3.2 `claims` 与 `coverage`：从「标签匹配」升级为「可审计证据」

现状 `coverage` 只有 `{knowledgeId, candidateDigest, claims[]}`，无法说明 claim 由哪几个用例证明。扩展（向后兼容：旧字段保留）：

```ts
interface ClaimEvidence {
  knowledgeId: string;
  candidateDigest: string;        // 必须等于候选 contentDigest
  claims: readonly string[];      // 被覆盖的 claim 原文（必须逐字取自候选 claims）
  evidence: readonly {
    suiteId: string;              // 已安装验证器
    suiteVersion: string;
    suiteDigest: string;          // 规范化用例集摘要
    caseIds: readonly string[];   // 具体证明该 claim 的用例
    group: 'positive' | 'negative' | 'boundary';
  }[];
}
```

激活规则保持「全部 claim 被覆盖且用例通过」，但新增两条不可绕过的检查：

1. `claims` 中的每条 claim 至少被一条 `evidence[].caseIds` 实际覆盖；claim 出现但无用例 → `UNCOVERED_CLAIMS`，不激活。
2. `caseIds` 必须真实存在于该套件且**实际执行**（执行域回执），模型或 JSON 不能提供。

> 这直接修复 listing 全量与 dvp 5 条方法「结构上不可激活」的缺口：要么为每条方法补可复现 claim + 用例，要么明确标注「仅参考，不可激活」，二者都不允许含糊。

### 3.3 生命周期（沿用合同 §6，补晋升）

```
run.failed / program.revised / qc.completed / business.clarified
   → CANDIDATE（自动或手工；必须绑定 runId + 输入/产物摘要）
   → 去重/关联/冲突分析（contentDigest + bug-class）
   → ValidationExecutor 执行正/反/边界用例（非空，且覆盖 claims）
   → ACTIVE（写入 receipt）｜ CANDIDATE（覆盖不足）｜ CONFLICT（与既有方法前提冲突）
ACTIVE → 正文变更 = 新修订 CANDIDATE（旧 ACTIVE 继续原范围生效）→ 验证通过后原子切换，旧修订 SUPERSEDED
project_decision → 用户明确证据 + 项目 scope ACTIVE（跨项目需另建去项目化记录并重新验证）
REVOKED → 退出默认检索，仍可追查；受影响 Run 快照不静默修改
```

**晋升不是改 scope**（现有 `KNOWLEDGE_PROMOTION_REQUIRES_NEW_ID` 已强制）：project → plugin → shared 必须新建记录、去项目化（去掉患者行、项目常量、访视 OID）、重新完成 claims 与验证。平台拒绝「原地提级」。

---

## 4. 存储与索引

### 4.1 存储形态与分区

| 层 | Phase 1（当前） | Phase 2（中心服务） | Phase 3（区域单元） |
|---|---|---|---|
| 元数据与修订 | SQLite，`DSH_HOME/platform/knowledge.sqlite`，WAL+FULL | Postgres（单库，`org_id` 分区） | 每 region 一套 |
| 全文索引 | SQLite FTS5（trigram，已实测可用） | Postgres FTS / `pg_trgm` | 同 region |
| 向量索引 | 不建（真实需求后） | `pgvector` HNSW，规模 ≤ 5×10⁴ | 同 region |
| 文档语料 | 同库 `knowledge_chunks` | 同库 + 对象存储正文 | 同 region |
| 跨区 | 不适用 | 仅摘要注册表 + 引用 | 摘要注册表 |

硬约束：**一个可写存储单元只被一个进程持有写权**；跨进程写入走请求/回执，不共享挂载。

### 4.2 表结构（在现有 6 张表基础上补齐）

```sql
-- 现有：knowledge_revisions / knowledge_events / knowledge_validations
--       knowledge_seed_imports / knowledge_seed_states / knowledge_snapshots

-- 1) 作用域与检索的 SQL 预过滤索引（当前完全缺失，导致全表解码）
CREATE INDEX IF NOT EXISTS kr_scope ON knowledge_revisions(scope, org_id, plugin_id, project_id);
CREATE INDEX IF NOT EXISTS kr_state ON knowledge_revisions(state, plugin_id);
CREATE INDEX IF NOT EXISTS kr_digest ON knowledge_revisions(digest);

-- 2) 全文索引：trigram 支持中文与中英混排；external content 指向 revisions
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  id UNINDEXED, revision UNINDEXED, scope UNINDEXED, org_id UNINDEXED,
  plugin_id UNINDEXED, project_id UNINDEXED, topics, title, problem, cause, method,
  tokenize = 'trigram'
);

-- 3) 标签索引（scope 先过滤，标签后过滤；不进正文）
CREATE TABLE IF NOT EXISTS knowledge_tags(
  id TEXT NOT NULL, revision INTEGER NOT NULL, facet TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(id, revision, facet, value)
) STRICT;
CREATE INDEX IF NOT EXISTS kt_lookup ON knowledge_tags(facet, value);

-- 4) 文档语料分片：引用不替代原文；行号可点击
CREATE TABLE IF NOT EXISTS knowledge_chunks(
  chunk_id TEXT PRIMARY KEY,
  doc_path TEXT NOT NULL,          -- 相对仓库根，如 docs/DVP-TEMPLATE-SCHEMA.md
  line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
  heading TEXT NOT NULL,
  body TEXT NOT NULL,
  doc_digest TEXT NOT NULL,        -- 原文整份摘要，用于失效检测
  locale TEXT NOT NULL,
  topics TEXT NOT NULL,            -- 规范化 JSON 数组
  indexed_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS kc_doc ON knowledge_chunks(doc_path, doc_digest);

-- 5) 写租约：中心单写者 + Worker 只提交
CREATE TABLE IF NOT EXISTS knowledge_leases(
  partition TEXT PRIMARY KEY,      -- org:region 或 org:region:plugin
  holder TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at TEXT NOT NULL
) STRICT;

-- 6) 快照绑定（供 runs 表引用）
-- runs 增加列：knowledge_snapshot_digest TEXT
-- 该摘要 = digest({context, records:[{id,revision,contentDigest}]})
```

### 4.3 容量与增长

| 量 | Phase 1 估算 | 依据 |
|---|---|---|
| 插件数 | 10² | 规范 §3.1 |
| 每插件方法记录 | 30–300（首批 5–7） | 现状 5/6；目标「每功能有沉淀」后按工具组计 |
| 总记录（ACTIVE+CANDIDATE） | 3×10³–3×10⁴ | 插件数 × 每插件记录 |
| 每记录平均正文 | ~2 KB（上限 50 KB） | 现有 `KnowledgeDraft` 限额 |
| 文档分片 | 10³–3×10³ | 现有 81 份 md ≈ 866 KB |
| 事件行 | 记录的 5–20 倍 | 捕获/验证/激活/撤回 |

存储估算：3×10⁴ 条 × 2 KB ≈ 60 MB 正文 + FTS 索引约 1.5×≈ 90 MB + 事件 ≈ 200 MB。单机 SQLite 完全够；Phase 2 再按实测分流。

---

## 5. 检索管线

### 5.1 阶段（顺序固定，每阶段可单独测试）

```
查询(文本/主题/场景/EDC/locale)
  │
  ├─S1 规范化：NFKC、大小写折叠、全半角、去空白、CJK 分字与 bigram 化
  │
  ├─S2 作用域派生：Principal → (orgId, 成员项目集合, region) → SQL WHERE
  │       （工具参数只能收窄，永不扩大）
  │
  ├─S3 召回：FTS5 trigram 查询（title/problem/cause/method 加权）
  │        × 标签扩展（topics/scenarios/edc，经插件 taxonomy 别名）
  │        × 别名扩展（i18n.aliases：中英缩写、同义词、常见错拼）
  │
  ├─S4 混合重排：score = 0.55·BM25 + 0.25·tagOverlap + 0.20·aliasHit
  │        （ANN 启用后：0.40·BM25 + 0.25·tag + 0.15·alias + 0.20·cos）
  │        同分次序：ACTIVE 优先 → project > plugin > shared → 修订新 → ID 字典序
  │
  ├─S5 证据装配：状态、claims、前提/反例、provenance、i18n 命中语言、
  │        是否进入本轮快照、验证回执摘要
  │
  └─S6 快照绑定：Run 内只返回 pinned 修订集合；新修订标记「快照外」
```

### 5.2 降级与诚实

| 情形 | 必须返回 |
|---|---|
| FTS 不可用 | `searchMode:'SCOPE_SUBSTRING_FALLBACK'` + 明确 `degraded:true`，不静默降级 |
| 查询词全为停用词/单字 | 走标签检索并标注 `matchedBy:'tags'` |
| 无命中 | `total:0`，**不得**回落到「全库最新 N 条」冒充命中 |
| 非主语言命中 | 返回 `matchedLocale` 与 `servedLocale`，标注译文而非原文 |
| 快照外记录 | 单独分组 `outsideSnapshot`，不混入主结果 |
| 正文被截断 | `truncated:true` + 完整字符数与分页入口 |

### 5.3 延迟预算（目标，实现后实测填表）

| 阶段 | p50 | p95 | 备注 |
|---|---|---|---|
| S1–S2 | ≤ 2 ms | ≤ 6 ms | 纯字符串 + 一次索引查询 |
| S3 召回 | ≤ 12 ms | ≤ 40 ms | FTS5 trigram，≤ 3×10⁴ 记录 |
| S3 别名/标签 | ≤ 3 ms | ≤ 10 ms | 内存缓存 taxonomy |
| S4 重排 | ≤ 5 ms | ≤ 20 ms | BM25 纯计算 |
| S5 装配 | ≤ 8 ms | ≤ 30 ms | 只加载命中页正文 |
| **合计** | **≤ 30 ms** | **≤ 120 ms** | 对比现状 20 000 条 1 868 ms |

ANN 启用后增加 p95 ≤ 130 ms；总预算 p95 ≤ 250 ms。超过预算不得靠减少候选掩盖，须报 `budgetExceeded`。

---

## 6. 验证与激活

### 6.1 执行与提交分离（落实 K 合同）

```
中心                           ExecutionDomain(ValidationExecutor)          中心
 │ 1. 生成 ValidationRequest（requestId, idempotencyKey,
 │    candidateDigest, validatorArtifactDigest, caseSetDigest,
 │    executionPlanDigest, epoch, 一次性回执权限）
 ├────────────────────────────►│ 2. 只读加载候选 + 固定用例集
 │                             │ 3. 实际执行正/反/边界
 │                             │    （不接受上传 execute，不接受 expected）
 │◄────────────────────────────┤ 4. 签名回执（绑定上述全部摘要 + 逐项结果）
 │ 5. 核验：来源身份/epoch/摘要/覆盖完整/非空用例/全部有实际结果
 │ 6. 事务内重读候选 → 仍为匹配 CANDIDATE 才写 ACTIVE（CAS）
 │    过期/撤回/变更 → 只留 stale receipt，不激活
```

### 6.2 激活的诚实层级

| 层级 | 触发条件 | 能说明什么 |
|---|---|---|
| `TOOL_REGRESSION_ONLY` | 固定用例通过但 claim 未被逐条覆盖 | 只说明工具未退步 |
| `CONTENT_CLAIMS` | 全部 claim 被 `evidence.caseIds` 覆盖且通过 | 说明该断言在本环境成立 |
| `PROJECT_DECISION` | 用户明确裁定 + 项目 scope + spec 版本引用 | 只对本项目生效 |
| `BUSINESS_REVIEW` | 业务负责人复核记录（外部对象，不在知识服务内） | 不能由知识状态推导 |

不允许把 `BUSINESS_REVIEW` 作为激活条件（知识服务无权代替临床批准），也不允许把 `CONTENT_CLAIMS` 表述为业务验收。

### 6.3 撤回与影响

- 撤回 `REVOKED` 立即退出默认检索；`knowledge_events` 记录原因、actor、时间。
- 已绑定撤销记录的 Run 快照不修改；但 `workbench` 打开该 Run 时必须显示「引用已撤回」横幅并给出重新评估入口。
- 撤回不删除历史修订与回执（审计需要）。

---

## 7. 每插件沉淀合同（本轮核心要求）

要求：**每个插件的每个业务功能都要有对应的知识沉淀**。这必须可检查，不能靠自觉。

### 7.1 强制文件

```
plugins/<pluginId>/
  knowledge/
    manifest.json          # 必须；插件知识的唯一声明
    seeds/                 # 结构化种子（JSON），与 skill 文本同一来源
      methods.json
    README.md              # 人读说明：taxonomy、适用性、未覆盖项
```

`manifest.json` schema（实施时写入 `docs/DSH-PLUGIN-DEVELOPMENT-STANDARD.md` §4 交付矩阵）：

```json
{
  "pluginId": "dm-dvp",
  "schemaVersion": 1,
  "owner": "dm-dvp 维护者",
  "taxonomy": { "dvp": ["template", "firewhen", "protocol", "uat", "cases"] },
  "seedSet": { "path": "seeds/methods.json", "version": "2026.11.16.1", "digest": "<sha256>" },
  "validators": [
    { "id": "dm-dvp.methods-suite", "version": "1.0.0", "artifact": "lib/index.js",
      "covers": ["dm-dvp.changemark.format"] }
  ],
  "capabilities": [
    { "tool": "dm_dvp_parse_workbook", "topics": ["template"] },
    { "tool": "dm_dvp_render_checks",  "topics": ["firewhen"] },
    { "tool": "dm_dvp_read_protocol",  "topics": ["protocol"] },
    { "tool": "dm_dvp_write_workbook", "topics": ["template", "uat"] },
    { "tool": "dm_dvp_suggest_cases",  "topics": ["cases"] }
  ],
  "noMethodKnowledge": []
}
```

### 7.2 三条可检查规则

| 规则 ID | 检查 | 失败后果 |
|---|---|---|
| `KNOWLEDGE_MANIFEST_MISSING` | 插件有 `application.json` 但无 `knowledge/manifest.json` | 规范检查失败（PostToolUse 立即反馈） |
| `KNOWLEDGE_CAPABILITY_UNMAPPED` | 该插件注册的每个**业务工具**（排除 `*_status`/`*_knowledge_*` 等元工具）必须出现在 `capabilities[].tool`，或出现在 `noMethodKnowledge[].tool` 并给出理由 | 发布检查失败 |
| `KNOWLEDGE_TOPIC_UNRESOLVED` | `capabilities[].topics` 与 `taxonomy` 中每个主题都必须能在种子集合或 ACTIVE 记录中解析到至少一条 | 发布检查失败（可警告级降级，需 sdk 声明） |

`noMethodKnowledge` 的正当理由示例：纯 IO 适配器、纯渲染器、无领域判断的工具。理由必须具体（不能写「暂无」）。同时该工具的 Skill 文本必须说明「不提供方法知识，原因：X」，避免模型误以为查不到而反复检索。

### 7.3 当前四插件履约状态

| 插件 | manifest | 显式声明无方法知识 | 缺口 |
|---|---|---|---|
| dm-listing | 缺 | 不适用 | 需建 manifest；`dm_listing_*` 16 个业务工具需映射到 review/intake/pk/als/sas/edc/runtime/output-qc/delivery 主题 |
| dm-dvp | 缺 | 不适用 | 需建 manifest；5 条方法正文需补 claims/coverage 或标注「仅参考」 |
| dm-participants | 缺 | 缺 | 9 个工具全部未映射；需至少 `chart.*` 类主题（可复用 dm-viz 规划） |
| dm-viz | 缺 | 缺 | 14 个工具全部未映射；设计稿 §4.3 已规划 `chart.selection/style/acceptance` 三类 |

### 7.4 种子与 Skill 文本单一来源

现状双写：`plugins/dm-listing/src/knowledge-seeds.ts` 与 5 份 skill 常量文本（合计约 28 KB）分别维护；`knowledge/` 目录只有 README。目标：

- 正文只在 `knowledge/seeds/*.json` 维护；
- `importSeeds` 读 manifest 幂等导入；
- Skill 文本由 seed 渲染（标题 + 摘要 + 「详见 knowledgeId」），不再冗长复述正文；
- 规范检查器拒绝「与 manifest digest 不一致的种子正文」。

---

## 8. 租户、身份与数据驻留

| 要求 | 设计 |
|---|---|
| 作用域派生 | `Principal{actorId, orgId}` + 项目成员授权 → `(orgId, allowedProjectIds, region)`；**不接受工具参数提供的 orgId/projectId** |
| 分区键 | 所有表带 `org_id`；`shared` 记录归属平台 org，需平台写角色 |
| 跨组织 | SQL 预过滤即拒绝；返回 `KNOWLEDGE_NOT_FOUND`，不泄露存在性 |
| 数据驻留 | `region` 为物理分区；跨区复制 = 新记录（新 ID + `provenance` 指向原记录），不做隐式同步 |
| 撤权 | 成员关系撤销 → 停止该 Principal 的新检索与新候选提交；不修改已生效知识（知识不代表授权） |
| 审计 | 每次写入/激活/撤回记录 `actorId, orgId, requestId, receiptId, 摘要` |
| 凭据 | 验证执行器凭据只以 secretRef 绑定到 Run，不进知识正文、日志、浏览器、提示词 |

注意：`region` 分区是**数据组织约束**，不是合规声明；实际部署区域、跨境传输与监管适用由产品/IT/合规确认（[整改补充 §1](ENTERPRISE-WORKBENCH-DSH-REMEDIATION-ADDENDUM.md)）。

---

## 9. 国际化与多语言

### 9.1 语言是面，不是库

不为每种语言建一套记录。一条记录带 `primaryLocale` + `locales[]` + `aliases{}`；检索时：

1. 查询语言 L → 规范化；
2. `aliases[L]` 扩展召回（含中英缩写：`BE`/`生物等效`、`SAD`/`单次递增给药`）；
3. 命中记录按 `primaryLocale` 返回正文；若 L ≠ primary 且存在译文，返回译文并标注 `translated`；
4. `translation.state='stale'` 降权并标注。

### 9.2 必须国际化的内容

| 内容 | 要求 |
|---|---|
| 术语表 | `knowledge_glossary(term, locale, definition, sourceRef)`；同一概念多语言映射，供别名扩展与显示一致 |
| 校验码与错误 | 错误码稳定（英文枚举），可见文案走 locale（[开发规范 §5.3](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)） |
| 日期/数字/时区 | 存储 ISO 8601 UTC；显示按 locale；知识记录不存本地时间字符串 |
| 长文本/RTL | 检索结果与证据面板支持长文本换行与 RTL 扩展；不硬编码字符串宽度 |
| 语言清单 | 首批支持语言由产品/业务确认，本文不臆造 |
| 翻译溯源 | 译文必须记录 `fromRevision`；主语言正文变更即令译文 `stale` |

### 9.3 文档语料的语言

`docs/` 现有 81 份 md 中英混排（含 `DVP-GENERATION-RESEARCH.md` 的双语方案要求）。分片时：

- 以标题层级切块，附 `doc_path#line_start-line_end`；
- 中英混排块只做一次分片，不重复建中英两份；
- 术语与缩写抽入 glossary，供跨文档检索；
- `doc_digest` 变化即标记该文档全部分片 `stale`，检索时可降权并提示「文档已更新」。

---

## 10. 运行绑定与快照

现状：`KnowledgeService.snapshot()` 存在但除测试外无生产调用方，`runs` 表也没有知识快照列。目标：

```ts
// 平台控制面：创建 Run 时
const snapshot = knowledge.snapshot({ pluginId, projectId, orgId }, runId);
const run = runs.create({ ..., knowledgeSnapshotDigest: snapshot.snapshotDigest });
```

| 约束 | 说明 |
|---|---|
| 固定 | Run 内检索只返回快照内修订；新修订标 `outsideSnapshot` |
| 不漂移 | 知识更新不静默改变在途运行的方法结论 |
| 可追溯 | 成果证据（artifact evidence）记录 `knowledgeSnapshotDigest` |
| 可重放 | 同一 Run 恢复时使用原快照；新 Run 用新快照 |
| 撤回提示 | 快照内含已撤回记录时，Run 详情显示横幅并建议重新评估 |

---

## 11. 部署演进

| Phase | 形态 | 触发条件（不是时间表） |
|---|---|---|
| P1 单机 | 中心 SQLite + FTS5；ValidationExecutor 独立进程；单写者 | 当前；先补 P0（索引、FTS、per-plugin manifest） |
| P2 中心服务 | 中心服务 + Postgres + `pg_trgm`/FTS；可选出题 `pgvector` | 单机 p95 检索 > 120 ms 或写并发出现排队 |
| P3 区域单元 | 每 region 一套中心服务；跨区仅摘要注册表 | 业务确认区域部署与数据驻留要求 |

任何阶段都不改变：单一写者、请求/回执验证、作用域服务端派生、快照绑定。**不得**因为「国际化」直接跳到多活/多写。

---

## 12. 评测与回归

### 12.1 检索质量（每插件黄金集）

```json
{
  "pluginId": "dm-listing",
  "locale": "zh-CN",
  "queries": [
    { "q": "重复标记", "expect": ["dm-listing.review.methods"] },
    { "q": "duplicate marker", "expect": ["dm-listing.review.methods"] },
    { "q": "BE 周期", "expect": ["dm-listing.pk.be"] },
    { "q": "不存在的主题 XYZ", "expect": [] }
  ]
}
```

指标：`recall@5`、`MRR`、`noHitHonesty`（应为空时返回空的比例，目标 100%）、`crossScopeLeak`（跨组织/跨项目泄漏，目标 0）。

### 12.2 激活覆盖

`activeRatio`（ACTIVE / 有 claims 的候选）、`uncoveredClaims`（明文列出）、`manifestCoverage`（被 manifest 映射且能解析到记录的插件工具比例，目标 100%）。

### 12.3 交付门禁新增

| 检查 | 加入位置 |
|---|---|
| `check-development-standard.mjs`：已列 3 条规则 | PostToolUse + verify-all |
| `verify-applications.mjs`：读 manifest，校验 capability 映射 | verify-all |
| `verify-all` 中 `platform-knowledge` 增加真实测试（现 `verify` 仅 typecheck+build） | verify-all |
| 黄金集回归 | 每插件 `scripts/verify.mjs` |

---

## 13. 实施路线与验收

按 [规模评估](KNOWLEDGE-SCALE-ASSESSMENT.md) 的 P0/P1/P2 展开为可验收项：

| 编号 | 项 | 验收事实 |
|---|---|---|
| KA01 | 检索索引 | 3×10⁴ 记录下 p95 ≤ 120 ms；未命中 ≤ 命中同量级 |
| KA02 | FTS5 trigram | 中文/中英混排查询召回正确；`searchMode` 如实 |
| KA03 | 每插件 manifest | 4 个插件各有 `knowledge/manifest.json`；三条规则检查通过 |
| KA04 | 工具→主题映射 | 所有业务工具映射或显式声明无方法知识，比例 100% |
| KA05 | claims/coverage | listing 5 条 + dvp 5 条方法逐条有决定：有 claim+evidence 或被标注「仅参考」 |
| KA06 | 语义诚实 | 候选不足覆盖时不 ACTIVE；`uncoveredClaims` 可见 |
| KA07 | 区域分区 | 跨区检索不返回他区记录；跨区复制生成新 ID |
| KA08 | 租户隔离 | 跨 org 检索返回 NOT_FOUND；伪造 projectId 无效 |
| KA09 | 多语言检索 | 中英查询互查命中；译文标注；stale 译文降权 |
| KA10 | 文档语料 | `knowledge_chunks` 有分片；引用带 `#行号`；digest 变化即 stale。**已落地**：57 份 md / 813 分片；`scripts/ingest-knowledge-docs.mjs` 幂等；`platform_knowledge_docs_search` 返回引用；覆盖协议所有正文 |
| KA11 | Run 快照 | 每个 Run 有 `knowledgeSnapshotDigest`；在途不漂移。**已落地**：`descriptor.knowledgePluginId` 声明后创建时绑定只读摘要（与 `KnowledgeService.snapshot` 逐字节一致），未声明如实缺省；3 项控制面测试 |
| KA12 | 自动捕获 | 至少一条运行/QC 事件自动生成 CANDIDATE 并绑定 runId |
| KA13 | 跨进程验证 | 请求/回执/epoch/一次性权限；重复回执不二次转换 |
| KA14 | 撤回影响 | 已绑定撤销记录的 Run 显示横幅 |
| KA15 | 评测 | 每插件黄金集回归；`noHitHonesty` 100%，`crossScopeLeak` 0 |
| KA16 | 容量与保留 | 冷热分层与保留期；备份/恢复演练记录 |

KA01–KA06 是 P0（阻断规模），KA07–KA13 是 P1，KA14–KA16 是 P2。**每项都必须有可复跑的检查命令与实际输出**，不得用文档存在代替验证。

---

## 14. 未决与外部依赖

| 未决 | 归属 |
|---|---|
| 首批支持语言、区域部署与数据驻留 | 产品 / IT / 合规 |
| 术语表来源与审定 | 业务负责人 |
| 向量检索是否启用（真实查询分布） | 平台 + 业务（本架构默认不启用） |
| ValidationExecutor 身份机制（内部认证/短期凭据/签名） | IT / 部署 |
| 冷热分层与保留期、RPO/RTO | IT / 运维 |
| `platform-knowledge` 测试归属（现包无测试文件） | 平台维护者 |

本文所有条款在实现前不产生任何对外能力声明。任何「知识库已支持大规模/国际化」的结论，必须以上表编号的实际检查输出为依据。
