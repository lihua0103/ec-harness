# 平台自主项目经验知识库

版本：1.0 · 2026-11-09 · 状态：实施设计，公共服务尚未实现

平台归属与职责以 [总架构1.1](ENTERPRISE-PLATFORM-ARCHITECTURE.md) 为准；本文是分类、存储、学习和验证的单一详细合同。当前Listing内静态经验文本不是本服务的完成证明。

## 1. 目标和非目标

让不同DSH插件持续积累“何时出现什么问题、原因、如何修复、何时适用、如何证明有效”的可检索经验，随项目运行复用并更新。首批种子来自历史Manual、PK BE和PK SAD/MAD的成功纠错；Medical引用Manual核心，Report保持独立成熟度。

不是日志仓库、会话全文镜像、整份旧程序答案库、固定业务流水线或新的安全拦截器。IT数据API未提供，不实现敏感值正则/读取白名单/投影审批。经验提炼不机械复制整段日志、患者行或项目常量，是泛化质量和数据组织要求，不再设为普通读取/编码门槛。

知识不拥有工具权限；当前spec、数据事实及明确用户裁定高于历史方法。没有知识命中也能正常编码。候选未激活不阻止项目试验，但不能称已验证通用经验。

## 2. 分类与作用域是两条轴

### 2.1 scope：在哪里有效

| scope | 所属 | 默认检索范围 | 推广方式 |
|---|---|---|---|
| shared | 平台 | 当前上下文可用的通用跨插件方法 | 明确通用性并通过验证后创建共享记录 |
| plugin | 稳定pluginId | 当前插件，不含其他插件的专属裁定 | 从项目经验提炼新记录、关联原证据 |
| project | pluginId + 明确projectId | 仅当前项目与插件 | 不就地改scope；另建去项目化方法候选 |

项目不串线是避免业务错误的语义范围，不是本轮数据安全机制。显式切换项目上下文可查看对应经验；默认查询不能混入其他项目的字段代理或阈值。projectId由项目登记明确产生，不从文件夹名字猜。

### 2.2 classification：关于什么

字段：`pluginId / scenarios[] / edc[] / topics[] / pattern / applicability`。scope为shared时无plugin所有权但可声明适用插件/主题；plugin/project记录必须有pluginId，只有project scope有projectId。

Listing taxonomy示例（仅插件定义，平台不硬编码）：

```text
dm-listing
  intake: 文件发现、完整需求、版本、批次、容器
  review: manual / medical -> 同一方法记录的两个适用场景
  pk: common / be / sad-mad
  als / sas / edc / runtime / output-qc / server-delivery
  report: 独立候选方法，不借三项目来源冒充实战已验证
```

场景组/继承由插件taxonomy贡献：查询medical可引用review共同方法，不复制一套Manual正文；be查询包含pk-common，不包含sad-mad专属规则。EDC标签也是前提，不将某系统OID和数据结构推给其他系统。

## 3. 记录与引用模型

建议结构（拟实现schema，不是当前SDK）：

| 字段 | 含义 |
|---|---|
| knowledgeId / revision / contentDigest | 稳定ID、递增修订、固定序列化内容摘要 |
| scope / pluginId / projectId | 作用域、插件、项目归属 |
| kind | technical_method / edc_method / scenario_method / project_decision |
| scenarios / edc / topics / applicability | 分类和实际适用条件 |
| title / problemSignal / cause / method | 问题表现、根因和可执行修法 |
| preconditions / notApplicable / counterexamples | 前提、不适用情况、错误使用反例 |
| provenance | 来源种子/旧资料/项目/运行/程序/spec修订引用；来源声称与核验状态分开 |
| evidenceRefs / caseRefs | 输入、失败、变更、复跑、QC及正反/边界案例引用 |
| state / conflicts / supersedes / derivedFrom | 生命周期、冲突、替代及推广来源 |
| createdAt / lastVerifiedAt / verification | 时间和绑定实际验证的回执引用 |
| decisionEvidence | 用户明确项目裁定的结构化事件引用，不由模型总结代替 |

内容摘要覆盖方法、前提、反例、分类、作用域和业务意义字段；追加运行使用记录单独存储，不因usage次数变化重算正文。引用须带版本/摘要，不只存可变路径。测试描述与实际测试运行是不同实体。

一条经验回答六个问题：问题是什么？为什么错？怎么改？什么时候能用？什么时候不能用？有哪些复现/反例证明？不能只有“已修复”“更稳健”或代码片段。

例：`listing.review.duplicate-marker`：当Condition明确要求flag=duplicated时，按spec键标记全部重复成员并保留未重复记录；另有Output if才筛选。反例是把标记直接改为仅输出重复行。验证须含两条重复+一条非重复、不同主键、不适用的筛选语义，而非匹配文档包含某短语。

## 4. 平台存储与交付

### 4.1 单机最小实现

拟实现代码：`packages/platform-knowledge/src/{schema,store,search,learning,service}.ts`。注册一个Cordis公共服务，Listing注入消费；不在每插件新建SQLite服务，不另起HTTP/向量基础设施。

动态库：`DSH_HOME/platform/knowledge.sqlite`，版本化迁移，WAL/FULL事务和CAS。中文及中英混合术语不能只依赖默认英文分词：优先验证目标SQLite的FTS5/trigram可用性，短词/不支持分词时用scope先过滤后的标签/子串检索，并明确分页和排序；缺FTS能力不能伪报“无知识命中”或丢失中文经验。建议表：

- `knowledge_revisions`：正文、digest、分类、scope与修订；unique(knowledgeId,revision)。
- `knowledge_heads`：当前状态/有效修订，CAS更新；旧修订不覆盖。
- `knowledge_tags` + `knowledge_fts`：作用域及plugin/project过滤的结构索引和全文索引。
- `knowledge_events`：捕获/验证/激活/冲突/替代/撤回审计。
- `verification_runs`：候选digest、实际执行与验证器/输入/输出/案例结果。
- `seed_imports`：包来源、seed manifest digest和导入记录。
- `run_knowledge_snapshots`：运行使用的ID/revision/digest集合及snapshotDigest。

核心不得认识Manual/PK具体字段，平台仅实施通用存储/状态/索引与验证调度。

### 4.2 插件种子

目标目录：`plugins/dm-listing/knowledge/seeds/manifest.json`及结构化记录/Markdown正文，发布包带稳定ID、版本、来源、适用范围和验证状态。现有`manual-methods.ts/pk-methods.ts/intake-methods.ts/scenario-methods.ts`是迁移源，不与JSON种子长期维护两套正文。

导入按pluginId+包版本+seed digest幂等；重启不重复插入。种子新版本创建新修订，不覆盖动态经验或用户项目裁定。同ID不同内容视为明确升级/冲突，不能按“最后写入”获胜。插件卸载注销贡献/新检索入口，不删除历史种子、项目经验或运行快照。

历史三项目种子先标记“来源已提炼，本库方法复现待完成”。迁移不伪造lastVerifiedAt；旧报告可作为来源，不当当前验证回执。已核验外部证据的导入应保留其构建/案例/验证器和适用范围，不能以一个布尔值批量激活。

## 5. 检索流程

1. 平台当前运行提供pluginId/projectId/scenario/edc和知识快照；工具参数不能偷偷把本项目检索扩大为所有项目。
2. 先过滤scope（shared、本插件、当前项目）及状态/适用分类，再检索全文/标签；不是全库搜出后展示过滤。
3. 默认ACTIVE；CANDIDATE/CONFLICT可显式查看，结果必须标注状态。候选可帮助探索，不伪装已验证。
4. 按当前项目明确裁定、精确适用方法和通用方法组织；当前spec仍为任务事实。冲突同时显示并澄清，不将检索排名当业务裁决。
5. taxonomy展开公共/继承主题，用knowledgeId+revision去重，返回匹配理由、正文、前提、反例、证据状态和引用。分页总量和nextCursor完整，稳定绑定查询/snapshot，不能掉未知列或截断正文而不提示。
6. 缓存键包括scope/context、revision与snapshot；撤回/激活后新查询失效。在途运行固定快照，知识更新不静默改代码；撤回可提示受影响运行重新评估。

Skill只说明何时检索哪个主题；不默认向每轮上下文注入整个库，不发明不可访问的外部文档引用。

## 6. 自主学习状态机

```text
实际失败/纠错/用户裁定/复跑/QC事件
    -> 项目经验CANDIDATE（记录根因、前提、修法、反例与来源）
    -> 去重/关联/冲突分析
    -> 方法复现 + 正例 + 负例 + 边界 + 相关回归
    -> ACTIVE 或 保留CANDIDATE / CONFLICT
ACTIVE -> 新修订CANDIDATE / SUPERSEDED / REVOKED
项目裁定 -> 明确用户证据后在项目scope ACTIVE；推广另建方法候选
```

### 6.1 捕获

事件建议：`run.failed`、`program.revised`、`execution.completed`、`qc.completed`、`business.clarified`、`delivery.rerun.completed`。Listing适配实际运行服务，不从一条模型“完成”消息推定事件。

Agent可以自主整理候选，平台绑定真实运行ID与版本；失败轮次和相同错误重复出现要保留。以内容digest/结构化bug-class查重，已有方法补使用/证据链接，不盲目生成重复条目。相反方法或前提冲突必须标CONFLICT，不能只凭相似度自动合并正文。

### 6.2 验证和激活

技术/EDC/scenario方法自动激活要求：明确前提和不适用条件；存在正反/边界案例；实际验证器对同一candidate revision/digest执行；所需案例与相关回归均有结果；无未解决冲突；证据时间/版本有效。只写测试名称或模型传`testPassed=true`不计。2026-11-11起，候选还需声明可由验证器复现的`claims`，且全部claims被验证器`coverage`覆盖并通过；固定辅助函数用例通过只记`TOOL_REGRESSION_ONLY`，不代表方法正文已验证。

平台验证服务消费真实执行器/QC事件，记录验证器和运行输入/输出摘要及失败明细。候选代码可由Agent正常执行，但不能由同一条候选函数生成预期答案再验证自己。项目业务预期来自spec/明确裁定或单独的验证夹具，无法自动确定时保留未决，不虚构独立审查。

项目裁定不强求变成代码单测：明确用户事件及所涉spec版本可在当前项目生效；它不是通用方法。扩大到plugin/shared必须另建条目、去项目化并完成方法验证，不直接改scope。验证激活只约束“经验可否作为已验证规则复用”，不阻止草稿、读取和本地运行。

### 6.3 修订、冲突和撤回

- 正文或适用范围变化产生新revision，旧验证不能自动继承；旧ACTIVE可继续原范围使用，新修订验证后原子切换。
- `SUPERSEDED`保留替代关系和旧使用快照；`REVOKED`对新默认检索无效，仍可追查原因。
- 并发更新expectedRevision不符拒绝并刷新，不覆盖已提交经验。
- 激活/撤回不修改在途运行知识快照。引用已撤回经验的交付须显示并重新判断，不伪称历史运行用了新方法。

## 7. 平台与插件接口（拟定，待按实际API实现）

平台服务方法：`registerContribution`、`importSeeds`、`search/get`、`capture`、`validate`、`activate/revoke`、`snapshot`、`status`。模型可用的最小工具是search/get/capture/validate/status，activate不暴露为接受模型布尔值的任意开关；实际验证完成由平台更新。

插件贡献：pluginId、taxonomy、seed manifest、适用性说明、验证器版本/所需案例、学习事件映射。验证器由已装配代码定义，候选文本本身不能注册新宿主可执行扩展；Agent仍可正常编程运行并产生案例证据。

跨包接线使用当前Cordis公开服务与defineTool合同，具体工具名/注入类型按源码确认。未来IT API不由KnowledgeService重建，接口缺失不阻塞本地检索/捕获/验证工作。

## 8. 三项目初始种子范围

| 来源 | 通用方法 | 必须避免的误推广 |
|---|---|---|
| Manual（Medical共用） | 逐列来源/范围/行条件/列处理/输出；标记≠筛选；连接/展开；空表、缺失、独立Excel/RDS检查 | 固定列/样式、访视OID、特殊实验室裁定、所有说明都编自动flag |
| PK BE | 号体系桥接、周期/给药参照、完整时间差、序列/处理与工件 | 默认BE、奇偶周期猜治疗、跨项目时间点和负值规则 |
| PK SAD/MAD | 队列、名义日小时、多剂参照、多基质、精度/盲态适用性 | 固定队列/阈值、自动队列级隐藏、默认CSF或全负值截0 |
| 共同识别/运行 | ALS多布局、SAS format/label、真实容器/批次、编码/locale、单文件服务器复跑 | 按目录名猜格式、试跑旧项目答案、缺包跳过算QC通过 |

来源：只读旧`ec-harness/.../knowledge-v2/`、`r-templates/`和`.zcode`方法说明；历史具体项目不作为当前模型答案/测试golden。不复制旧保护规则或未经授权字典；许可遵循原资产要求。

## 9. 验证矩阵

- 两个测试插件相同主题互不混入专属规则，shared正常共用；卸载Listing平台仍可用。
- 当前项目决策检索可见，其他项目决策不可默认命中；推广后新方法保留derivedFrom且无常量污染。
- Manual/Medical引用同一review记录；BE只继承PK共同方法不继承SAD/MAD专属规则。
- 捕获→实际正反/边界验证→自动激活→新运行可检索；失败/仅文本测试/模型自报均不能激活。
- 内容/前提修订旧验证失效、重复导入幂等、冲突不静默覆盖、CAS并发、重启持久、撤回及快照可追溯。
- 知识检索/接线测试、方法行为验证、模型自主冷启动、真实业务验收分别报告；不能互相替代。

## 10. 当前实现与本轮交付

最新实施（2026-11-11整改）：知识服务与Cordis bundle位于`packages/platform-knowledge`，业务插件只通过`clinicalKnowledge`注入使用；候选`claims`与验证器`coverage`已实现，未覆盖claims不激活。初版采用scope先过滤后的Unicode子串检索，不是FTS；技术案例验证、候选修订/CAS、种子幂等与快照代码已编写并有65/65定向测试。项目裁定激活、跨scope推广、真实运行事件学习及自动上下文绑定尚未完整实现。源代码与单元测试不等于企业部署验收。

上述章节继续作为目标合同。下一步先运行验证、修复失败，再按 [迁移计划](MIGRATION-AND-ACCEPTANCE.md) 完成门禁撤出、公共服务完善和项目/R开发链。旧安全归档尚未成功，不能报为已撤出。
