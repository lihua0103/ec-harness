# @ec-clinical/platform-knowledge

平台公共知识服务与独立 Cordis bundle。业务插件通过 `ctx.clinicalKnowledge` 使用它，
不得在自身包内复制或拥有该服务生命周期。

## 安装与验证

```bash
cd packages/platform-knowledge && pnpm install
```

```bash
cd packages/platform-knowledge && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" npm run verify
```

bundle 配置可指定存储路径（相对 `DSH_HOME` 或绝对路径）；缺省为 `platform/knowledge.sqlite`。
**工具入口必须声明可信授权范围**（M1-01）：未在 `scopes` 中列出的插件调用一律失败关闭，参数不能改写
插件身份/组织/区域，只能收窄到允许项目；语料检索还需声明 `corpusDocPrefixes`。

```yaml
- id: ec-platform-knowledge
  name: '@ec-clinical/platform-knowledge/cordis'
  config:
    storePath: platform/knowledge.sqlite
    corpusDocPrefixes: ['docs/']
    scopes:
      - pluginId: dm-dvp
        orgId: org-a
        region: cn
        allProjects: true
```

## 身份接线（M1-01 剩余）

部署侧配置 `IdentityScopeConfig`（`parseIdentityScopeConfig` / `deriveScope`）把已验证的
Principal（身份服务派生，非模型自报）映射到各插件的知识范围声明。Principal 的 `pluginIds` 是上限，
未授权插件拒绝（`KNOWLEDGE_PLUGIN_NOT_AUTHORIZED`）；未绑定插件拒绝（`KNOWLEDGE_PLUGIN_NOT_BOUND`）；
组织/区域缺省继承 Principal；项目集合来自绑定声明。配置拒绝未知字段、重复插件与错误 schema。
本模块只定义数据合同与纯函数派生，不认证身份、不读取凭据、不发起网络请求。

## 知识智能体定义与覆盖门禁（M2-01/M3-02）

- 每个纳管插件在 `knowledge/manifest.json` 提供 schemaVersion 2 智能体定义（身份/版本/负责人/主题与工具映射/反馈投影/验证器/黄金集/适用范围）；解析入口 `parseKnowledgeManifest`，未知字段与断链引用一律拒绝。
- `KnowledgeAgentRegistry` 支持多版本并存与显式激活；同版本内容冲突拒绝，停用清理注册并保留历史。
- 发布覆盖门禁：`node scripts/verify-knowledge-coverage.mjs [--release]`，分母来自仓库根 `knowledge-assembly.json`，未登记目录、缺定义或悬空黄金集均阻断。
- 合同细节见 [插件知识智能体合同](../../docs/KNOWLEDGE-AGENT-CONTRACT.md)。

## 文档语料（KA10）与 Run 快照（KA11）

- `scripts/ingest-knowledge-docs.mjs` 把 `docs/**/*.md` 按标题切成带行号与标题路径的分片，幂等写入 `knowledge_chunks` + `knowledge_chunks_fts`；文档 digest 变化才整体替换该文档分片。
- 工具 `platform_knowledge_docs_search` 返回带 `doc_path#L起始-结束` 的引用与摘录，**引用不替代原文**；查询词 ≥3 码位走 FTS5，短词降级 SQL LIKE（`searchMode` 如实区分）。
- 控制面创建 Run 时对 `descriptor.knowledgePluginId` 声明知识域的应用，只读读取 `readSnapshot(path, {pluginId, projectId})`（摘要 + 实际修订集合）并写入 `run.knowledge`；摘要公式与 `KnowledgeService.snapshot` 逐字节一致，新 Run 用新集合、在途 Run 不漂移。控制面**不写**知识库。
- `searchPinned(context, snapshot)` 在固定修订集合内检索：升级不改变原 Run；撤回/撤权/不可用逐条进入 `evidence.excluded`；`cite` 记录最终引用并与实际返回对账。详见[插件知识智能体合同](../../docs/KNOWLEDGE-AGENT-CONTRACT.md)。
- 事件投影 `captureFromProjection` 按 `(eventId, contributor, projectionVersion)` 幂等；跨进程回执按摘要与请求幂等且一次性，重复不产生第二次状态变化。

## 激活语义

- `CANDIDATE` 候选可检索（显式 `states`），不进入默认 ACTIVE 检索。
- 已安装验证器的固定用例通过，只证明工具回归（`TOOL_REGRESSION_ONLY`）。
- 只有候选声明的全部 `claims` 都被该验证器 `coverage` 覆盖且用例通过，才转为 `ACTIVE`
  （`CONTENT_CLAIMS`），回执记录已验证的 claims。
- 无 claims、部分覆盖、测试失败、候选变化或验证器替换均不激活。

## 检索（schema v2）

- 存储 v2 自动迁移（v1 库打开时原地补建全文索引与标签行，不改写既有修订）。
- 查询词全部 ≥3 个码位且不含引号时走 **FTS5 trigram 全文检索**（`searchMode: 'FTS5_TRIGRAM'`）：
  作用域/状态/标签过滤、按 id 取最新命中修订、排序（作用域级别 → bm25 → id）与分页均在 SQL 内完成，
  只解码当前页；命中语义为 trigram 短语包含于记录字段值（不含 JSON 结构记号）。
- 短词（<3 码位）、含引号词、空查询或 FTS 不可用的环境降级为**作用域 Unicode 子串扫描**
  （`searchMode: 'SCOPED_UNICODE_SUBSTRING'`，与 v1 语义一致；空查询匹配全部）。
- 未命中如实返回零，不回落到“最新 N 条”；每插件沉淀合同见各插件 `knowledge/manifest.json`
  与 `scripts/check-development-standard.mjs`。

本包只负责状态与回执，不声称任何方法正文已被业务评审。