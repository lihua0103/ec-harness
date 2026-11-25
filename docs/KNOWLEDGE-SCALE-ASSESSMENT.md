# DSH 插件知识库规模评估

日期：2026-11-16 · 版本 0.1 · 状态：评估事实 + 缺口清单（不含实施）。上层：[多插件总架构](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md) · [平台经验知识库合同](PLATFORM-EXPERIENCE-KNOWLEDGE.md) · [跨进程知识验证合同](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md)。

> **2026-11-16 P0 整改落地**：本表 P0 前两项与激活缺口已实施并通过 `scripts/verify-all.cjs` 17/17——存储 v2（索引+FTS5 trigram+标签表，v1 库自动迁移）、FTS 检索管线（20 000 条选择性查询 2 ms / 未命中 0 ms，对照实测 1 868 ms）、四插件 `knowledge/manifest.json` + 检查器规则、listing/dvp 窄声明可激活、participants/viz 接入；详见[架构文档](ENTERPRISE-KNOWLEDGE-ARCHITECTURE.md)状态注。本文其余结论按整改前基线保留。

**结论**：当前实现是一份治理语义正确的**单机原型**，不满足“几十至上百插件、每插件自持知识沉淀”的大型智能知识库规模。四类根本缺口：检索层为全表解码子串匹配、每插件知识沉淀无合同无门禁（4 个插件中 2 个为零）、学习闭环只靠模型手工 capture、跨进程验证与文档语料未接入。以下数字均为本轮实测/实测源码事实，不是业务验收。

## 1. 评估口径

| 维度 | 大型知识库要求 | 依据 |
|---|---|---|
| 容量 | 每插件数十至数百条已沉淀方法；总量 10³–10⁴ 级（几十至上百插件） | [开发规范 §3.1](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)「面向几十至上百插件」 |
| 检索延迟 | 单次查询 <100ms 量级，可支撑工具内多次检索 | 员工在会话内按需检索，不是离线报表 |
| 检索质量 | 中文/中英混排可命中，有相关性排序而非 ID 字典序 | [经验库合同 §4.1、§5](PLATFORM-EXPERIENCE-KNOWLEDGE.md) 明确要求验证 FTS5/trigram |
| 沉淀覆盖 | 每个插件的领域方法都有对应记录、分类、适用前提和验证器 | 本轮用户要求「每个插件功能都需要有自己对应的知识库沉淀」 |
| 治理 | 写入唯一、claim/coverage 激活语义、快照可追溯、撤权可追 | [知识验证合同](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md) |
| 语料 | 平台文档、插件文档可被检索纳入知识面（含分片） | 当前 61 份 md / 752 KB 对模型不可检索 |

## 2. 实测事实

### 2.1 检索层（`packages/platform-knowledge`）

`KnowledgeService.search` 每次先 `store.scoped()` 把该插件全部修订正文取回、逐条 `JSON.parse` + `normalizeDraft` + `canonical` 序列化，再做 Unicode 子串匹配（`service.ts:163-201`、`store.ts:108-116`）。实测（合成 20 字段中文方法，`node:sqlite`）：

| 记录数 | 命中查询 | 未命中查询 | 首屏 100 条 | 末页 100 条 | 批量写入 |
|---|---|---|---|---|---|
| 1 000 | 137 ms | 88 ms | 92 ms | 80 ms | 3.4 s |
| 5 000 | 321 ms | 284 ms | 279 ms | 276 ms | 16.7 s |
| 20 000 | 1 868 ms | 1 852 ms | 1 612 ms | 1 504 ms | 67 s |

未命中与命中同代价（无索引，等于全量解码）。SQLite 只有主键索引：`knowledge_revisions(id,revision)`，`plugin_id/scope/state` 均未建索引，`knowledge_fts`/`knowledge_tags` 两表在合同中规划、代码中不存在。另：`snapshot()` 按 100 条分页遍历全库（`service.ts:330-356`），20 000 条时单次快照约 200 次查询 ≈ 5 分钟。

同时确认：`node:sqlite` 的 **FTS5 与 trigram 分词可用**（本轮以 `CREATE VIRTUAL TABLE ... USING fts5` / `tokenize='trigram'` 实测成功），中文全文检索不需要引入新依赖或独立搜索集群。

### 2.2 沉淀覆盖（每插件矩阵）

| 插件 | 注入 `clinicalKnowledge` | 种子数 | 知识工具 | 其他工具 | 状态 |
|---|---|---|---|---|---|
| dm-listing | 是 | 5 | 5（manual_methods / scenario_methods / capture / validate / events） | 16 | 全部 CANDIDATE，且**不可能 ACTIVE**（见 2.3） |
| dm-dvp | 是 | 6 | 4（methods / capture / validate / events） | 8 | 5 条无 claims；仅 `changemark.format` 有 coverage |
| dm-participants | **否** | 0 | 0 | 9 | 知识只在 17 KB 内联 skill 文本里 |
| dm-viz | **否** | 0 | 0 | 14 | 设计稿 §4.3 规划 `chart.selection`/`chart.style`/`chart.acceptance` 三类记录，未实现 |

`plugins/dm-participants` 的设计文档没有任何知识章节；`plugins/dm-viz` 有规划无代码。两者 `inject = ['tools','skills']`，连服务都未接入。这直接说明“每插件自持沉淀”目前是**靠自觉**，不是合同也不是门禁：

- `scripts/check-development-standard.mjs` 只有 `CROSS_PLUGIN`、`PACKAGE_SRC_BYPASS`、`NORMATIVE_DOC` 三条规则；
- `scripts/verify-all.cjs` 只要求每包一条 `scripts.verify`，与知识沉淀无关；
- `scripts/verify-applications.mjs` 只校验 `capabilityId` 与登记链路；
- [开发规范 §4 包交付矩阵](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)未把“知识贡献/种子”列为 Host 插件必需交付。

### 2.3 激活语义：listing 侧结构性不可达

`service.validate` 要求候选声明的 `claims` **全部**被验证器 `coverage` 覆盖才写 `CONTENT_CLAIMS` 并 ACTIVE（`service.ts:232-292`）。而：

- `plugins/dm-listing/src/knowledge-validators.ts` 的 `ValidationSuite` **没有 `coverage` 字段**，`knowledgeIds` 只含 `dm-listing.intake.methods`；
- `plugins/dm-listing/src/knowledge-seeds.ts` 的 5 条种子**全部没有 `claims`**。

因此 listing 的知识无论跑多少次验证器都只能得到 `TOOL_REGRESSION_ONLY`。dm-dvp 只有 `changemark.format` 具备完整 claim+coverage，其余 5 条方法正文（模板四层、fire-when 方言、方案抽取、UAT 边界、用例设计）同样永远停在 CANDIDATE。

线上库实测：`.runtime/dsh-home/platform/knowledge.sqlite` 共 **11 条修订，全部 CANDIDATE，0 条 validation，0 条 snapshot，11 条事件**。即“验证—激活—快照”这条主链路在真实库里从未跑通过一次。

### 2.4 学习闭环

`capture` 只由模型工具 `*_knowledge_capture` 调用（`plugins/dm-listing/src/index.ts:343`、`plugins/dm-dvp/src/index.ts:195`）；[经验库合同 §6.1](PLATFORM-EXPERIENCE-KNOWLEDGE.md) 规划的 `run.failed`、`program.revised`、`qc.completed`、`business.clarified` 自动捕获**均未接线**。`snapshot()` 除测试外无生产调用方，运行与知识版本没有绑定。`project_decision` 的激活、scope 晋升（`KNOWLEDGE_PROMOTION_REQUIRES_NEW_ID` 之后的人工迁移）也都未实现。

### 2.5 跨进程与文档语料

- `registerValidator` 直接接收 `execute` 函数（`service.ts:56-94`），[知识验证合同](PLATFORM-KNOWLEDGE-VALIDATION-CONTRACT.md)要求的独立 ValidationExecutor、回执身份、租约、CAS 核验**未实现**；当前语义仅在单进程内成立。
- `docs/` 61 份 md、约 752 KB，`plugins+packages` 20 份 md、约 114 KB，全部只对人类可读；知识库没有文档分片、来源引用或检索入口。`platform_knowledge_search` 只查经验库，不查文档。

## 3. 已经站得住的部分

这些不应在整改中退化：三作用域（shared/plugin/project）与分类分离、`contentDigest` 绑定修订、种子导入幂等（pluginId+版本+digest）、`SEED_CONFLICT_DYNAMIC_REVISION` 不静默覆盖人工修订、CAS `expectedRevision`、历史修订不可改写、事件审计、快照不可变、`claims`/`coverage` 区分“工具回归”与“内容断言验证”。字段级容量上限（正文 50 000 字符、草稿 200 KB）对长文档也够用。

## 4. 缺口分级与整改顺序

| 级别 | 缺口 | 落点 |
|---|---|---|
| P0 | 检索为全表解码子串；无索引、无排序、无中文分词 | `store.ts` 增 `plugin_id/scope/state` 索引 + FTS5 trigram 表；`search` 改为 SQL 预过滤 + FTS 排序 |
| P0 | 每插件知识沉淀无合同、无门禁 | 规范 §4 增“Host 插件必须声明知识贡献或显式声明无方法知识”；`check-development-standard.mjs` 增规则；`verify-applications.mjs` 读取 knowledge manifest |
| P0 | listing 与 dvp 5 条方法正文结构上不可 ACTIVE | 为每条方法拆出可复现 claims，补 `coverage`；无法拆分的正文明确标注“仅参考、不可激活”，不伪装 |
| P1 | participants / viz 零沉淀 | 按 dm-viz §4.3 与 participants 实际方法补 `knowledge-seeds.ts` + 验证器 + 工具面 |
| P1 | 种子无机器可读语料（`knowledge/` 只有 README） | 落地 `knowledge/seeds/manifest.json` + 结构化记录，技能内联文本改为引用同一来源 |
| P1 | 学习闭环靠手抄 | 接运行/QC 事件到 CANDIDATE 捕获，绑定 runId+版本；`snapshot()` 进运行基线 |
| P2 | 跨进程验证与回执身份 | 按 K 合同实现 ValidationExecutor 与一次性回执权限 |
| P2 | 文档语料不可检索 | 文档分片入语料（引用+摘要），`platform_knowledge_search` 支持 `source: doc` |

## 5. 不改变的平台边界

固化三层约束：知识服务**只有一个**，不按插件新建 SQLite 或第二套向量基础设施（[经验库 §4.1](PLATFORM-EXPERIENCE-KNOWLEDGE.md)、[总架构 §12](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md)）；检索升级继续用关系库 + 全文检索，向量库仍以真实需求为准；`ACTIVE` 不授予数据权限，也不代表临床批准。

## 6. 本轮未验证项

未运行 `scripts/verify-all.cjs` 全仓门禁；未改动任何源码；未在真实 DSH 装配中复测检索；20 000 条压力数据为合成构造，不代表真实方法正文分布。已运行：`dm-listing` 知识定向测试 13/13、`dm-dvp` 知识定向测试 6/6、SQLite FTS5/trigram 可用性探测、容量延迟压测。
