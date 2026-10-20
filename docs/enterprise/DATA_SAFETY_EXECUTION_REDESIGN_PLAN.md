# dsh 数据安全与自主执行闭环：详细开发执行方案

> **2026-10-20 用户后续定案补充（设计合同优先级）：** 数据集行值与辅助业务值仍默认保护，但spec确需单列场景值时，允许按最小用途在本地判定敏感性、必要时脱敏/转换，并通过安全及语义保真验证后提供给AI；不能先发敏感原值再由云AI脱敏。详细协议与验收以 [重构评估§8.6及§13.6](DSH_LISTING_REFACTOR_ASSESSMENT.md) 为准，修正下文“只回计数/不释放观测值”等绝对表述；不扩大工具、目录或任意原值读取豁免。
> 场景只保留manual/medical/pk-mapping/report；RBQM及专属知识、规则、验证案例弃用，不迁入Manual。原dsh知识与旧提示词/镜像/学习索引隔离，新代际不加载或兜底；从已确认成功交付证据重建新库，运行中验证的经验自动写入对应EDC/场景库。详见重构评估§11.5–11.6。以上是最新设计要求，**不是相关代码/脱敏能力/场景删除/旧库隔离已经实施的声明**；下文各轮实测状态保留各自记录，不混称本轮完成。

- 日期：2026-10-20。
- 状态：开发设计，未实施；本文列出的新模块、接口、测试和门槛均不代表现有系统已经具备或通过。
- 实施进度（2026-10-20）：**P0（T00–T03）已实现并通过合成回归**——egress 公共合同、pre-gate 路径原子化与发现合同、post 文本豁免移除、扫描故障分类回执、environmentHint/failures 贯通、code_runner 编译/执行分离、scan_init 指纹刷新；映射见 `tests/safety/cases.json`，一键回归 `node scripts/safety-tests.mjs`。
- 实施进度（2026-10-20 真实项目实测）：在 RT01（66 数据集真实项目）完成两轮真实 AI 会话验证，实测发现并修复三类**真实误拦**——稀疏列码表值（基数分母用错非空数）、小表 EDC 元数据常量列、标识列名判定过宽（方案号被误当个体标识）；同时移除我自己引入的两个业务上限（50 张表上限挡住 51 表交付、64 项分析请求上限挡住 66 数据集）。红线经每次改动复验：237 个高基数列全部受保护、受试者号 19/19、模型写盘回读被正确拦截。回归固化于 `test_real_project_false_positives.py`。**T13 的真实路径验收部分完成**；T05/T08/T09/T10 仍未实施，三项宽豁免仍在，红线未严格成立。
- 目标：安全开关开启时，AI 完整获得获准的需求和结构，能自主编程、执行、诊断、修正及验证；真实行值与辅助业务值保留在本地。
- 改造范围：`packages/enterprise/*`、`profiles/enterprise/*`、企业测试、企业脚本及知识契约；不修改 upstream 子模块，不重写业务模板。
- 本次交付：仅更新本文件；不改业务代码或配置，不切换安全开关，不启动服务，不执行真实数据任务。
- 修订说明：将评审转为接口、文件、开发任务和验收合同；纠正“doc/ 自动授权”“匹配 JSON schema 即可信”等歧义；对 ZCode 安全机制的未经验证判断不再作为设计依据。

## 0. 开发总决策与执行索引

### 0.1 本轮定案

1. **保留本地计算自由，治理进入模型的内容。** 数据能被本地 R/Python 使用，不等于能由 stdout、错误、附件或交付物回读进入模型。
2. **复用一个用户开关。** `dataSecurityService` 仍由 ui-settings 提供；新增出口服务是其执行机制，不是第二套权限、开关或审批系统。
3. **先补安全证据，再收紧旧通道。** 受控分析、静态诊断、需求读取和恢复必须与统一出口一起交付，不能让模型只能盲写。
4. **公共实现放现有包。** 在 tool-audit 内提供 `@dsh-enterprise/tool-audit/egress` 子路径和宿主出口服务；listing 消费此接口，避免新建纯库包却触发现有“企业包均为插件”的装配假设。
5. **企业宿主统一执法。** pre guard、post 投影、模型请求门禁、会话策略继承分层实现，不把 post-execute 当成最终出口。
6. **不靠模型自证。** `_source`、metadata/aggregate 标签、字段名、JSON schema、运行器自报计数，都不是出域授权。
7. **最多新增一个模型可见工具。** 使用 `enterprise_listing_analyze` 承载受控探索、验收及运行状态查询；其余升级现有工具。
8. **安全与正确性分开验收。** 运行成功、结果允许释放、业务验证通过是三个不同结论。
9. **按功能门槛发布，不承诺固定工期。** P0 是诊断和误拦修复；只有 P1、P2 联合通过后，才能宣称新的受保护任务边界生效。
10. **开发方案不是部署批准。** 可按本文开发合成测试和企业代码；现网替换交付物自审通道属于行为变更，需发布确认。安全目标本身不以“用户暂未确认”变成永久例外。

### 0.2 实施导航

| 阅读者/任务 | 直接使用章节 |
|---|---|
| 理解根因及边界 | 1–2 |
| 宿主、工具、模型请求接入 | 3、9 |
| 类型、角色、快照、分析和诊断实现 | 4–8 |
| 分派开发任务与合并顺序 | 10–11 |
| 编写测试、执行命令、准备验收 | 12–13 |
| 切换、回滚和交付审核 | 14–15 |

## 1. 根因与已核实的实现约束

### 1.1 同一模型为何会有不同效果

“使用相同模型名称”不等于得到相同输入和工具能力。模型能否完成任务取决于需求是否完整可达、工具如何执行、错误与验证证据是否返回，以及失败后能否恢复。当前 dsh 在这些环节均有确定的工程缺口。

**未审计 ZCode 的实际出站载荷，不能断言 ZCode 一定泄露数据，也不能断言它已强制满足同样的两条红线。** 对比时应固定模型实际标识、推理/采样参数、上下文预算、知识与数据版本，用合成标记检查真实模型请求；比较合法证据、重试和结果，而不是仅比较模型名称或警告次数。

### 1.2 当前代码事实

以下为本次静态核实结果，不是运行测试结论。行号仅作为本次定位，开发时以符号名为准。

| 当前位置 | 已核实问题 | 开发影响 |
|---|---|---|
| `tool-audit/src/dataset-guard.ts`：`candidateReferences`、`inspectToolExecution` | 对非内容参数按空白/符号切分后匹配后缀；不区分发现与读取；enterprise 前缀豁免 | 路径须原子处理，能力由宿主注册而非猜名称 |
| `listing/src/index.ts`：`blockedProtectedResult`、post-execute | 真实命中、无 Worker、预热失败、扫描异常共用“包含受保护数据”提示 | 故障码、执行状态与恢复动作必须分离 |
| 同文件：`EXECUTION_TOOLS`、交付目录文本判断 | shell、输出目录字样、宽 enterprise 前缀跳过扫描；未绑定项目也放行 | 不能用减少警告证明安全；首次任务与 R 路径也要绑定保护 |
| 同文件：`postResultText` | 附加上下文取一侧，而宿主接受结果时会合并两侧 | 同时治理原结果与后续决策的全部上下文 |
| 同文件：`failure`；`listing/src/worker.ts` | `environmentHint/failures` 未贯通；普通 Error 自定义属性不保证进入正式工具错误协议 | 使用安全结果 DTO，不依赖给 Error 附加字段 |
| `listing/python/worker.py`：inspect、ensure、scan_init | 部分全局状态先提交；相同项目可复用过期快照/索引；主/扫描版本未绑定 | 单一快照构建、原子提交、版本确认 |
| 同文件：保护值索引与扫描 | 低基数、词形等启发式既减少碰撞，也无法证明业务值获准释放 | 扫描降为补充；已验证来源和受控操作是主判断 |
| `listing/python/code_runner.py`、`sandbox.py` | 编译与运行错误混合；运行器结果来自执行任意代码的子进程 | 先静态编译；运行器消息和工件均视为不可信输入 |
| `listing/python/discovery.py` | doc/ 优先；同名可当需求副本；文档 chunk 是字符切片，非语义页 | 名称/目录仅提供候选；文档版本和范围重新定义 |
| `listing/src/r-runner.ts`：`RLaneRunner.run` | R summary 的 message、warnings、listings 等未可信投影；R 不经 Python bindProject | 两条 R 车道统一接入出口，不能只改 Python |
| `ui-settings` 与两个消费者 | 消费者直接访问未声明注入的服务属性，异常回落开启；普通对象桩不能验证真实 Cordis 行为 | 用公开软读取方式并做真实服务装配测试 |

### 1.3 已核实的官方扩展点

只通过公开 exports 使用这些能力；下表不构成修改 upstream 的授权。

| 上游位置（相对 `upstream/deepseek-harness/`） | 已核实契约 | 企业侧用法 |
|---|---|---|
| `packages/core/tools/src/index.ts`：711、1110 | `tools.guard` 同步返回 `string | undefined`，单调拒绝 | 只查已准备的策略，不在 guard 中预热、执行替代工具或异步等待 |
| 同文件：1463–1653、1742–1779 | post 接受值或内容替换；只改 content 会保留 canonical value；原与新增 contexts 会合并；block 丢弃原 contexts | 企业工具在 execute 内生成安全值；未知结果整体扣留，不做“只清洗可见文本” |
| 同文件：1870–1877 | 部分失败路径不经过 post；普通异常信息会变成错误正文 | 最终请求门禁必须覆盖错误及 finalize 之后新增内容 |
| `packages/spill/spill-policy/src/index.ts`：190 | spill 是 post 链中的一个监听器，不是所有 post 结束后的固定步骤 | 用顺序测试证明安全投影先于落入模型历史；原始临时文件始终受保护 |
| `packages/core/tools/src/code-mode.ts`：489–579 | 程序取得 canonical value 后还存在独立日志和 deferred context | 检查嵌套工具值、错误、日志及上下文，不能仅改 UI 文本 |
| `packages/llm/llm/src/index.ts`：53–65 | `llm/stream(options,next)` 能在进入 adapter 前拒绝；不是最终 HTTP 字节门禁 | 检查完整语义请求与请求归属，并在合成测试捕获实际 transport |
| `packages/llm/llm/src/types.ts`：341–376 | 请求有可选 sessionId/purpose，没有通用 securityContext | 不虚构字段；使用企业侧请求关联记录 |
| `packages/core/agent/src/index.ts`：114–155、300–341 | create/resume 可等待 setup；currentInitiator 是归属线索，不是授权证明 | 根入口可准备状态；全局 pre-step 兜底，交叉验证会话身份 |
| `packages/preset/agent-presets/src/index.ts`：275–324 | 子代理共享 standing preset，但不复制父代理私有状态；setup 不是全局 factory middleware | 强制策略放企业 host，子代理按可信 lineage 恢复 |
| `packages/host/apiproxy/src/api-proxy.ts` | 附件、会话历史、导出与工具输出不共用一个出口 | 区分用户本地查看与模型上传，测试附件回读及历史重放 |

标准工具链大致为：pre → guard → execute/render → post（其中可能 spill）→ finalize → result/日志。模型链为：提示词与上下文装配 → pre-step → 历史投影 → 冻结请求 → llm/stream → adapter/附件解析 → 网络发送。因此必须采用多层接入，不能把某个中间步骤当成全局安全证明。

## 2. 数据安全和能力合同

### 2.1 不变的两条红线

- 数据集真实行值不进入模型上下文。
- 辅助 Excel 业务单元格值不进入模型上下文。

改名、复制、转码、存入 RDS/JSON/Excel/日志/图片，不改变保护属性。模型可读需求与结构；本地程序可读真实值并输出交付物；授权用户可本地查看真实交付物和诊断。工件引用不授权模型回读正文。

### 2.2 必须保留的工作能力

- 文件发现、相关需求逐行读取、已登记代码与模板阅读/编辑。
- 本地 R/Python 自由导入、读取、关联、计算；不因代码文本提及数据路径就拒绝。
- 获取必要结构、受控验证证据、静态定位和稳定错误码，能持续修码。
- 单个无关输入失败不拖垮任务；缺必需输入或口径未确证不得伪造通过。
- 未知映射先验证需求/设计候选；不能擅选近似字段、样例值或相近规则。
- 模板只承载通用契约，项目业务由需求生成，不把本次合成示例固化成业务规则。

### 2.3 威胁模型与承诺范围

本轮解决合作式 AI 的意外泄露、错误放行、误拦和恢复失败。重点治理自动工具执行、文档读取、子代理、压缩、历史重放和附件进入模型的链路。

任意代码拥有同用户文件/进程/网络权限时，分进程和 schema 校验不是对主动恶意程序的完备隔离。不能承诺抵御全部编码、隐写、进程篡改或直接联网外传。若部署要求这一强度，必须另外批准 OS/文件/网络隔离；本轮不暗中禁止 import、算法或本地 IO。

用户手动向外部产品粘贴数据、其他未纳管程序的网络行为不属于本插件可保证的范围。受保护任务的附件、旧历史及外部工具结果仍必须通过本方案的来源和输出门禁，不能以“用户上传”“历史已有”自动放行。

### 2.4 开关兼容和策略阶段

- 保留现有 `enabled`、默认开启、配置非法/服务缺失时开启、现有设置 API 与持久化形态；不增加模型可写的关闭入口。
- 使用公开 `ctx.get('dataSecurityService')` 软读取，避免新增硬依赖使服务缺失时整个守卫不加载。异步加载未完成时先按开启处理。
- 关闭开关沿用既有策略关闭语义；协议、类型和业务校验不因此关闭，也不补造原本未采集的日志。
- 安全效果验收均在开启下进行；关闭兼容性单独使用合成测试验证，不以关闭状态证明安全达标。不读取真实数据请求正文给另一个模型审计。
- 诊断记录包含开关观测状态和策略版本。P0/P1 开发状态与正式 enforcement 发布状态是发布元信息，不新增面向用户的第二个开关。

**全局接入不等于全局临床模式。** 宿主按以下顺序分流：

| 开关与上下文 | 策略行为 |
|---|---|
| enabled=false | 跳过数据安全策略；保留协议、业务与既有宿主权限检查 |
| enabled=true，已确证 ordinary | 保留普通任务行为；不得访问其他受保护上下文的资源或沿用其历史 |
| enabled=true，protected | 执行完整角色、执行输出、来源与请求门禁 |
| enabled=true，unclassified/关联冲突 | 开放批准的任务文本、文件发现和登记能力；未知内容不出站，不自动当普通任务 |

分类来源固定为宿主任务入口与资源登记：企业数据任务入口、已有受保护项目/会话、父会话 lineage 均设 protected；既有普通任务入口在没有受保护资源绑定/历史时设 ordinary。旧会话或无法确定的入口设 unclassified。模型工具参数和消息中声明 ordinary 无效。普通任务首次请求受保护资源时，必须在读取/执行前升级为 protected 并准备上下文；不能先执行再补分类。未知匿名 LLM 调用仅在开启的受保护策略管辖范围按 9.4 拒绝，不能据此拦住已确证普通任务的正常调用。

## 3. 目标架构与文件落点

### 3.1 数据流

1. 宿主为任务建立保护上下文和资源登记，先于首次模型请求；不等待 inspect 才保护。
2. 模型读取获准的需求/结构，提交代码或结构化分析请求。
3. 本地执行器读取固定版本输入；任意代码的产物、流和异常先落本地受保护区。
4. 可信宿主/分析进程根据输入身份和固定操作产生安全视图。
5. 工具返回安全视图；出口服务记录交付证据，统一处理额外上下文、spill 和错误。
6. 模型请求门禁检查最终语义请求及附件来源；通过后才委托模型 adapter。
7. 本地独立验证产生批准的差异计数；工件通过引用交付给用户，不把真实差异读回模型。

### 3.2 共享实现选择

新增公共子路径而非独立插件包：

- `tool-audit/package.json` 导出 `./egress`，指向 `lib/egress.js` 和声明文件。
- listing 显式依赖 `@dsh-enterprise/tool-audit`，使用包名导入；不跨包导入 `src/*.ts`，不以 tsconfig paths 掩盖构建问题。
- tool-audit 的宿主插件注册出口服务；公共子路径导入无副作用、不导入插件入口、不反向依赖 listing。
- ui-settings 是开关 Provider；tool-audit 是出口 Service/Provider；listing、通用执行适配器和会话入口是 Consumer。
- 企业 profile 继续显式装配现有包。需要的官方服务通过公开接口访问；新增 listener/guard/provider 必须有明确清理路径。
- 强制门禁与可重载出口服务分开生命周期：现有 tool-audit 包另导出 `./egress-host` 宿主入口，在 profile 注册独立 `enterprise-egress-host` row，拥有常驻 guard、pre-step、request-gate；既有 tool-audit row 提供可重载资源/策略 Provider。无需新包，也不新增用户安全开关。
- 开关服务或出口 Provider 初始化/缺失/重载期间，常驻门禁继续扣留未批准请求。强制门禁 row 不支持在其他消费者仍工作的情况下单独热卸载；需要卸载时先关闭受保护任务入口并终止/收敛在途任务和模型流，再随宿主停机移除监听器。部署阻止单独热卸载，测试验证退出顺序；不能声称用户任意删除整个安全插件后系统还能自保。

### 3.3 文件改动地图

表中“新增”是计划文件，不是现存能力。可在不改变职责的前提下细分文件，不另起并行安全系统。

| 文件/目录 | 动作与职责 |
|---|---|
| `tool-audit/src/egress.ts`（新增） | 无副作用公共出口，导出协议类型、接口、纯校验与策略读取函数 |
| `tool-audit/src/egress-host.ts`（新增） | 同包独立宿主入口/row；常驻强制门禁、服务缺失降级、停机顺序与会话恢复协调 |
| `tool-audit/src/egress/contracts.ts`（新增） | DTO、固定事件码、操作码和运行时 schema；不信任 TS 类型断言 |
| `tool-audit/src/egress/service.ts`（新增） | 保护上下文、资源/释放记录、Provider 注册、策略生命周期 |
| `tool-audit/src/egress/tool-capabilities.ts`（新增） | 可信注册工具身份与能力映射，不按前缀授信 |
| `tool-audit/src/egress/request-gate.ts`（新增） | llm/stream 归属核验、允许内容/附件核验、固定失败反馈 |
| `tool-audit/src/dataset-guard.ts`、`src/index.ts` | 路径原子处理、同步兜底 guard、服务与生命周期接入 |
| `listing/src/index.ts`、`src/worker.ts` | DTO 透传、现有工具适配、analyze、快照和失败恢复；不继续扩充单体错误字符串 |
| `listing/src/execution-adapter.ts`、`run-registry.ts`（新增） | 通用执行包装、运行状态、幂等与作业查询；原始内容不入模型 |
| `listing/src/diagnostics.ts`（新增） | Python/R 共享的固定诊断和源码定位投影 |
| `listing/src/r-runner.ts` | manual/PK 共用边界、摘要校验、原始诊断工件、发布版本 |
| `listing/python/snapshot.py`（新增） | 输入版本、局部构建、原子提交、失败清单与缓存绑定 |
| `listing/python/document_access.py`（新增） | 范围授权、语义分页、稳定文档 ID、内容交付证据 |
| `listing/python/controlled_analysis.py`（新增） | 固定分析操作实现、结构化参数、可信回执 |
| `listing/python/worker.py` | 保留调度入口，迁出快照/文档/分析职责，统一协议 |
| `listing/python/discovery.py`、`source_registry.py`、`data_guard.py` | 解析兼容复用；候选角色与出域授权分离；不靠 `_source` 决策 |
| `listing/python/code_runner.py`、`sandbox.py` | 编译/执行/编码分阶段，不信子进程诊断与自报指标 |
| `ui-settings/src/*` 及测试 | 保持原开关，补真实 Cordis 装配和状态一致性验证 |
| `profiles/enterprise/*` | 受保护会话、受控工具、适配器及官方服务组合 |
| `tests/architecture/*`、`tests/safety/*`（新增安全目录） | 导出与装配、真实工具管线、合成模型载荷、回放测试 |
| `scripts/safety-tests.mjs`、`safety-e2e.mjs`（拟新增） | 隔离测试环境与参数化端到端驱动，无固定业务项目路径 |
| 企业知识库/skill 镜像、`CODING_STANDARDS.md` | 对齐新工具合同和 streaming 拒绝语义；不修改用户全局资产作为默认部署步骤 |

## 4. 统一协议：先实现合同再接工具

### 4.1 内部身份与来源

以下为拟新增类型，非上游已有接口：

```ts
interface ProtectionContext {
  contextId: string
  sessionId: string
  parentSessionId?: string
  mode: 'ordinary' | 'protected' | 'unclassified'
  classificationEvidenceRef: string
  projectRef?: string
  policyVersion: string
  readiness: 'preparing' | 'ready' | 'degraded'
}

type ResourceRole =
  | 'requirement' | 'design-metadata' | 'code' | 'template'
  | 'source-data' | 'auxiliary-business' | 'derived-data' | 'unresolved'

interface ResourceRecord {
  resourceRef: string
  canonicalPath: string // 仅宿主本地，模型默认使用不透明引用
  version: string
  role: ResourceRole
  scopeRef: string
  evidenceRef: string
  sourceRefs: string[]
  status: 'ready' | 'unavailable' | 'stale'
}
```

- 引用由宿主生成并与会话/项目绑定，不由模型指定某个 `_source` 值代替。
- fileId 与内容版本分离；路径别名、大小写、junction/symlink 统一解析并校验授权范围。
- 内容哈希和原路径可留本地；对模型使用不透明版本 ID，避免把业务文件名或单元格哈希当可公开标识。
- 同名不等于同内容；不能因副本名称相同跳过保护。文件变更后旧角色授权和释放记录不能复用。
- 共享开关与出口服务不是同一个状态：开关开启但服务不可用时返回基础设施故障，不能退回旧宽豁免。

### 4.2 模型可见结果 DTO

所有企业数据工具输出协议升级为版本 2，以下是语义合同：

```ts
type ExecutionState = 'not_started' | 'running' | 'succeeded' | 'failed' | 'unknown'
type DeliveryState = 'ready' | 'pending' | 'withheld'
type ValidationState = 'not_run' | 'passed' | 'failed' | 'incomplete'

interface SafeResultV2 {
  protocolVersion: 2
  operation: string       // 固定枚举
  contextRef: string
  snapshotRef?: string
  runId?: string
  executionState: ExecutionState
  deliveryState: DeliveryState
  validationState: ValidationState
  code: string            // 固定错误/状态码
  summary?: object        // 按 operation 使用闭合 schema，不接受任意对象
  diagnostics: SafeDiagnostic[]
  dependencyFailures: SafeInputFailure[]
  recovery: RecoveryAction[]
  artifacts: SafeArtifactRef[]
}
```

运行时按 operation 校验，未知字段拒收或扣留；`object` 仅是文档简写，代码必须用判别联合与闭合 JSON schema。

- `SafeDiagnostic`：固定 errorClass/stage、已登记 programRef/version、静态行列号、经源映射确认的 symbolRef、固定 hintCode；无原始 message、locals 或任意类名。
- `SafeInputFailure`：inputRef、固定原因码、影响的 requirementRef/operationRef、required/optional；不回显文件内容或动态解析异常。
- `RecoveryAction`：固定 action（如 query_run、read_schema、revise_program、provide_input、retry_analysis），不包含模型猜测的 shell 命令。retryable 是受控 boolean，自动次数由宿主执行。
- `SafeArtifactRef`：artifactRef、类型、供用户查看的受控链接标识、是否可向模型释放；不能把真实命名当安全摘要。
- `environmentHint` 改为固定 hintCode 与经版本校验的安全结构参数；在 Python、TS、工具 renderer、Session Log/replay 中一致。
- 工具期望内的失败返回此 DTO，而不是靠 `Object.assign(Error, …)` 传递属性。只有协议外故障抛固定无值错误，且仍受最终请求门禁约束。

示例仅使用合成状态，不包含业务值：

```json
{
  "protocolVersion": 2,
  "operation": "run_r",
  "contextRef": "ctx-example",
  "snapshotRef": "snapshot-example",
  "runId": "run-example",
  "executionState": "succeeded",
  "deliveryState": "withheld",
  "validationState": "not_run",
  "code": "UNVERIFIED_OUTPUT_WITHHELD",
  "diagnostics": [],
  "dependencyFailures": [],
  "recovery": [{"action": "query_run", "retryable": false}],
  "artifacts": [{"artifactRef": "artifact-example", "kind": "local-diagnostic", "modelReadable": false}]
}
```

该例表示程序确已完成、某部分输出未释放，不代表任务已经验收成功，也不能指导模型重新执行程序。

### 4.3 出口服务 API 与可信票据

拟提供以下企业内部接口；模型不可直接调用这些管理 API：

```ts
interface DataEgressService {
  prepareContext(input: HostContextInput): Promise<ProtectionContext>
  registerProvider(provider: TrustedProvider): () => void
  registerResource(input: HostResourceEvidence): ResourceRecord
  decideRead(input: ResourceReadRequest): ReadDecision
  release(input: TrustedReleaseInput): SafeRelease
  checkRequest(input: HostRequestCheck): RequestDecision
  revokeVersion(resourceRef: string, version: string): void
}
```

- Provider 在插件装配时注册，绑定实际模块/工具定义和 operation 版本；名称相同不等于受信。
- `SafeRelease` 的正文与内部释放票据分离。票据关联精确规范化内容、资源版本、范围、operation 和会话；不是往模型可填写的 JSON 里加 `safe:true`。
- 可信执行器须在未运行模型代码的进程/模块边界计算指标；任意 runner 返回的 schema 合法 JSON 不能直接调用 release。
- 版本变化禁止旧授权用于新版本，并使依赖旧版本的当前覆盖、验证和发布资格失效；不自动撤销旧版本已批准正文的历史释放记录。历史记录仅可按原上下文、版本、范围重放，不能证明当前版本已读取或已验证。授权撤销、原释放判断错误或策略收紧时，对历史重新裁决并重建安全视图；会话不匹配和内容变更不能复用原票据。
- 模型历史可由安全正文与非敏感引用重放；本地受保护原始工件不能嵌入 Session Log 的模型消息。

实现时至少固定以下内部入参，不能用 `unknown` 贯穿后再靠类型断言放行：

| 内部类型 | 最少字段与生成方 |
|---|---|
| HostContextInput | 宿主 sessionId、可信 parentSessionId、workspaceRef、projectRef（可空）、policyVersion、protected/ordinary 的确定依据；分类由宿主入口决定，模型不能自报 ordinary |
| HostResourceEvidence | contextRef、规范路径、固定版本、role、区域定位、来源资源引用、证据类型及证据版本；路径和证据正文只留本地 |
| ResourceReadRequest | contextRef、resourceRef、期望版本、scopeRef、已验证的工具能力；请求范围不得扩张登记范围 |
| TrustedProvider | 插件装配身份、operation 集合/版本、闭合结果 schema、释放政策版本、清理句柄；同名注册冲突拒绝 |
| TrustedReleaseInput | 仅内部持有的 Provider 身份、contextRef、snapshotRef、输入版本引用、operation/版本、规范化安全正文及范围；不接受 runner 自带的批准标签 |
| HostRequestCheck | 实际请求对象、宿主提供的会话/initiator 关联、来源记录版本、批准路由/附件集合；不从正文提取“授权” |

read/release 的决定至少区分 allow、withhold、stale、not_ready；请求门禁决定只允许 allow 或 deny。跨进程返回值先校验为 Provider 的数据输入，再由宿主决定是否 release，不直接反序列化成可信票据。

### 4.4 固定错误码与响应策略

| 错误/状态码 | 含义 | 宿主行为与模型动作 |
|---|---|---|
| `PROTECTED_CONTENT_WITHHELD` | 请求了受保护内容 | 扣留正文，返回结构/分析入口；不称执行失败 |
| `UNVERIFIED_OUTPUT_WITHHELD` | 来源或生成过程不满足释放合同 | 保留本地工件；返回静态诊断/分析引用 |
| `POLICY_NOT_READY` | 保护上下文未准备好 | pre-step 内有界初始化；目录等已知安全能力可用 |
| `SCAN_WARMING` | 补充索引预热中 | 等待同版本就绪，不重复执行业务程序 |
| `SCAN_TIMEOUT` / `SCAN_FAILED` | 扫描基础设施故障 | 最多一次重建/重试扫描；仍失败只扣留未验证结果 |
| `SNAPSHOT_STALE` / `INPUT_CHANGED` | 输入版本不符或读取时变化 | 新快照构建；旧输出不得自动发布 |
| `REQUIRED_INPUT_UNAVAILABLE` | 必需输入缺失/不可解析 | 阻止依赖步骤，披露具体输入引用 |
| `STATIC_COMPILE_ERROR` | 对已登记源码的预执行编译失败 | 返回固定类别和静态位置，未启动业务执行 |
| `RUNTIME_ERROR` / `ENCODING_ERROR` | 执行或产物编码失败 | 返回安全定位与本地诊断引用，不回流异常原文 |
| `EXECUTION_UNKNOWN` | 超时/断连后无法确认是否完成 | 先 query_run/核验工件，禁止自动重跑 |
| `RESULT_SCHEMA_INVALID` | runner/Provider 消息不满足协议 | 不接纳为可信结果；依赖交付不通过 |
| `PROGRAM_OUTPUT_CONTRACT_REQUIRED` | 旧程序不能保证运行暂存与版本化发布 | 迁移通用输出配置；不自动重渲染业务区 |
| `JOB_REFERENCE_REQUIRED` | 发布没有唯一、明确的当前作业引用 | 请求明确作业版本；不回退上次成功产物 |
| `RELEASE_POLICY_UNAVAILABLE` | 结果没有适用的统计/状态释放政策 | 本地保留结果并报告能力缺口；不靠扫描未命中放行 |
| `REQUIREMENT_COVERAGE_INCOMPLETE` | 必需需求范围未实际交付 | 返回缺失范围；不声称模型已完整阅读 |
| `REQUEST_PROVENANCE_UNVERIFIED` | 最终请求含未经批准的内容/附件 | 不进入 adapter，固定可恢复反馈，不回显被拒正文 |

## 5. 资源角色、快照与需求读取

### 5.1 默认角色判定：证据先于目录

**不使用“首个路径规则命中即授权”。** 优先核对版本、来源和冲突：

| 条件 | 判定/处理 |
|---|---|
| 用户明确指定需求文件，宿主可解析并定位当前场景所需范围 | 只登记确证范围为 requirement；非需求 sheet/列仍隔离 |
| 现有 ALS/设计适配器识别出结构，且来源/版本/字段范围可确证 | 对相应范围登记 design-metadata；识别置信度本身不是授权 |
| 宿主登记的源码/模板，或受控编辑产生的新版本 | code/template；编辑版本及来源记录同步 |
| 数据集、辅助业务表及其衍生文件 | source-data/auxiliary-business/derived-data |
| doc/、文件名含 spec、位于 Output 或拥有常见扩展名 | 仅候选线索，不授予模型读取权限 |
| 混合 Excel | 按 sheet/列/区域登记；未明确范围默认不释放值 |
| 未确证或证据冲突 | unresolved；提供结构探测与需确认项，不拖垮不依赖它的步骤 |

用户指定整文件不自动覆盖其中已知业务行；自动识别与场景契约完成正常文件的登记，不要求用户逐文件批准。只有证据冲突、必需范围无法定位等真实需求决策才转用户。

元数据中的列名、标签、sheet 名、路径也可能来自业务值：原始输入字段只在已登记结构范围内释放；pivot 生成的业务值列名、按值生成的文件名不能靠“结构”二字放行。UI 可显示本地原名，模型默认拿稳定引用或获准名称。

### 5.2 原子快照

新增 `build_snapshot`，inspect/ensure/scan_init 不再各写一套状态：

1. inspect 先确定资源清单和可用状态，不要求它预知全部业务依赖；创建 run/analysis 时再冻结该操作的必需/可选输入。目录发现不读取业务值到模型。
2. 对实际读取的全部输入记录版本。stat 仅用于快速变更检测；授权及复用以内容版本和策略版本为准。
3. 在局部读取、解析、建立结构与失败记录。读取前后验证内容稳定；发生变化返回 INPUT_CHANGED，不提交混合版本。
4. 构建角色证据、schema、依赖状态及可用的补充索引。坏文件可以作为明确 unavailable 状态进入快照，不等于全局初始化崩溃。
5. 原子提交完整 Snapshot 对象；非预期构建失败保留旧快照，但不得把旧快照冒充此次请求结果。
6. 主 Worker、扫描 Worker 和缓存均确认 snapshotRef/policyVersion；相同项目路径不能直接视为相同版本。

快照至少保存：inputRef/version、schemaVersion、requirementVersion、policyVersion、available/unavailable/empty 状态、failureCode、注册范围及角色证据。空数据与读取失败必须区分。

快照持有不可变内容副本、内存对象或等价固定版本句柄；可信分析、验证和发布消费该版本，不按可变原路径重新读取。宿主托管的预编译与执行绑定同一 programVersion，验证与发布绑定同一 artifactVersion。不能建立固定句柄时在使用前后复核并按 INPUT_CHANGED 失败，不将结果归属于旧版本。snapshotRef 对任意代码只证明已提供输入的版本，不证明其所有实际 IO；未确证依赖不能标完整依赖闭包。

缓存：先写临时文件再原子替换；版本键覆盖实际读取源、策略与适配器版本；缓存不携带可被模型代码修改后自授信的授权事实。保留既有跨进程哈希稳定性自检，但不把自检当内容来源证明。

### 5.3 依赖级失败

- analyze 使用其显式 inputs；生成、验证、发布引用需求矩阵中的 required/optional 依赖。
- required 不可用时阻止该步骤；optional 不可用时返回影响范围并使相应验证 incomplete。
- 模型声明“无依赖”不能代替宿主已登记的需求依赖；任意脚本未声明外部 IO 时不能获得“完全可重复/可安全自动重跑”标签。
- 输入候选同名时保留各自状态，按可解释的来源规则选择；首次候选失败不能吞掉后续来源，也不能静默换源。
- 某数据读不动并不证明它不可能被其他工具读取。来源未知的结果仍扣留，不能因补充索引缺该文件就放行。

### 5.4 需求分页与覆盖账本

现有按字符切 JSON 的 chunk 不再作为正式语义页：

- 文本按行、Excel 按 sheet/行列范围、PDF/DOCX 按本地解析器提供的页/段落定位；不支持格式返回固定能力错误，不把 base64 当已理解内容。
- 继续遵循已确认场景和用户约束的禁读/列白名单；本项目既定 spec 阅读约束包含跳过 Cover Page 类 sheet 与无关列。不得把名称启发式泛化为其他任务的全局授权/拒绝规则，也不得在本轮悄悄放宽现有禁读范围。
- 范围在单元格值抽取前生效：可读取定位所需容器/结构元数据，不得先物化禁读 sheet/列的值再投影。解析器不支持时返回固定能力错误，不回退整表读取；混合范围冲突保持隔离。
- 请求携带 documentRef/version、scopeRef、cursor；响应携带本页范围、总覆盖范围、nextCursor、内容校验引用。
- 默认页正文预算不高于 32 KiB，按最终 UTF-8 序列化字节计算，并扣除宿主信封预算；实际 inline 限制在集成探针中确认。单个超大单元格使用带位置的片段，不截断丢义。
- Worker 返回页仅算 prepared。实际安全正文进入最终工具结果/请求后记 delivered；spill 时记 pending_readback，回读同一批准版本后才计入覆盖。
- 文档改动、范围变更使对应覆盖失效；模型自报 read=true 不更新账本。
- 开发/探索可继续；最终交付必须覆盖本次需求范围并完成需求理解矩阵。账本证明内容可达，不证明模型理解正确；独立验证仍必须执行。

### 5.5 值扫描的明确边界

- 版本和范围均确证的 requirement/design-metadata/code/template 读取，可信受控操作回执，不再接受全局值碰撞否决。
- unresolved、来源不明结果、历史迁移中的可疑文本只能做补充扫描；**扫描未命中不等于获准释放**。
- 确实来自原始业务数据的内容，即使短、低基数、词形普通或碰巧与合法统计相等，也不自动成为设计值。
- 同样，可信计数恰好等于某个业务数值，不因数值相同就扣留。权限依据来源和操作，而非值的长相。

## 6. 受控分析 API：可实现的首批操作

### 6.1 工具请求合同

`enterprise_listing_analyze` 使用判别联合参数，不能接收任意 Python/R/SQL 表达式或 callback：

```ts
type AnalyzeRequest =
  | { operation: 'schema'; snapshotRef: string; inputs: string[]; cursor?: string }
  | { operation: 'key_check'; snapshotRef: string; input: string; keyRefs: string[] }
  | { operation: 'join_check'; snapshotRef: string; left: string; right: string;
      keyPairs: Array<{ leftFieldRef: string; rightFieldRef: string }>;
      expectedCardinality: '1:1' | '1:n' | 'n:1' | 'n:n'; nullPolicy: 'never_match' | 'match' }
  | { operation: 'rule_check'; snapshotRef: string; ruleRef: string; inputs: string[] }
  | { operation: 'mapping_check'; snapshotRef: string; input: string; fieldRef: string; mappingRef: string }
  | { operation: 'compare_artifacts'; snapshotRef: string; actualRef: string; expectedRef: string;
      comparisonRef: string }
  | { operation: 'run_status'; runId: string }
```

- 全部引用在宿主解析，必须属于当前保护上下文与指定版本；不能把模型给的文件路径直接升级为授权句柄。
- keys、映射、规则与比对口径必须能追溯到登记 schema/需求/获准基准。
- 不接受任意过滤条件来试探个体值；没有安全释放依据时可本地执行，但模型仅得 withheld 与待确认引用。
- ruleRef 对应声明式规则：缺失、比较、集合、日期区间、布尔组合等基础算子，常量来自已登记需求/设计引用。未知算子返回不支持，不能用 eval 兜底。
- 首批规则范围以 manual、PK、medical/RBQM 合成代表任务覆盖为验收条件；复杂规则仍可由任意本地代码计算，但只有独立验证路径已实现才能标 passed。

### 6.2 每个操作的计算与释放合同

| 操作 | 可信计算 | 可释放内容 | 不释放内容 |
|---|---|---|---|
| schema | 读取登记结构 | 字段引用、获准标签、类型、格式绑定、关系 | 观测值列表、业务 pivot 列名 |
| key_check | 明确缺失/空串口径后检查键 | 总行数、缺失键行数、重复组数、重复涉及行数、唯一性结论 | 重复键本身、受试者列表 |
| join_check | 固定空值规则/键映射下关联 | 左右总行数、匹配/未匹配行数、关联基数冲突数；指标定义写入协议 | 记录对、个体匹配结果 |
| rule_check | 可信解析器执行登记规则 | examined/pass/fail/indeterminate 计数与规则引用 | 命中行和动态原文 |
| mapping_check | 验证登记候选码表 | evaluated/matched/unmatched/ambiguous 计数 | 未知原值集合、自由文本 |
| compare_artifacts | 独立读取固定版本并按登记键比较 | 行列数、schema/type/label 差异数、新增/缺失/修改计数、不同单元格总数 | 逐格前后值、真实行键 |
| run_status | 查询宿主作业记录并核验工件版本 | 执行/交付/验证状态、安全恢复动作 | 原始日志、未批准工件正文 |

计数必须为有限、非负整数；单位、分母、空值规则和指标名来自固定协议。比较键不唯一时显式失败或 incomplete，不能悄悄按位置配对。比较的两边版本、列序、标签、类型、缺失值等价口径在 comparisonRef 中冻结。

首版指标定义同时写入 TS/Python 共用的合成合同夹具，禁止两端各自理解：

- key_check：默认只有类型化缺失值计 missing，空字符串是否缺失由登记规则决定；复合键任一分量缺失计 missingKeyRowCount。duplicateGroupCount 只计非缺失键中出现次数大于 1 的组；duplicateRowCount 计这些组涉及的全部行，而非仅多余行。
- join_check：leftMatchedRowCount/rightMatchedRowCount 分别按原输入行计“至少一个匹配”；各自与 unmatched 之和等于各自总行数。joinedPairCount 单独计记录对数，不能把一对多展开后的对数冒充匹配行数。cardinalityConflictKeyCount 按 expectedCardinality 计算冲突键组数；NA 是否参与匹配由必填 nullPolicy 冻结。
- rule_check：每个被检查单位必须进入 pass/fail/indeterminate 之一，三者之和等于 examinedCount；检查单位和分母由 ruleRef 定义，不能默认“一行就是一个受试者”。
- compare_artifacts：新增/缺失先按唯一键判定；修改行数仅在共同键上计算；不同单元格数只统计共同键且已对齐的列。结构不兼容或键不唯一时不继续生成看似准确的值级通过结论。

### 6.3 统计释放政策

- “由宿主算出来”是必要条件，不是充分条件。逐个体输出、小组筛选、最小/最大值、top-k、原始去重值、样例行都不默认释放。
- 首版只释放符合已版本化 ReleasePolicy 的指标；不给通用任意分组接口。政策逐项登记允许的输入来源类别、固定总体范围、operation/指标、粒度和查询累计规则，默认候选是上述整输入质量/覆盖/比对操作，而不是无条件批准。
- 任意 runner 产生工件的行数、形状和差异数，即使独立重算也不自动获准；须匹配已登记需求和工件合同。缺少适用政策时 withheld；更粗的 passed/failed 同样需要释放依据，不能默认用它绕过扣留。
- 规则候选来自获准需求，不允许反复提交猜测常量构造个体查询。按可信任务 lineage、输入范围、规则/候选关系记录查询累计，不能因新 runId、子代理或重启清零；拒绝未登记筛选，不只检查单次格式。
- 可能直接揭示单记录的结果由 ReleasePolicy 决定，未确证时扣留。小样本阈值如需使用必须由数据政策明确，不拍脑袋写固定 k，且 k 不能单独证明安全。政策不支持某任务时列出能力缺口，在 T06 的代表任务上补齐并验收，不让执行阶段不断试错探测。
- 无法确证的映射转本地待确认项；不得为追求“全自动完成”把未知文本送模型或代理实现。

### 6.4 可信执行边界

受控分析运行在独立于任意代码 runner 的可信模块/进程，直接解析固定版本句柄并重算指标。不要把一个 `safe_summary()` 函数注入用户 namespace 后信任它的返回值。

R summary、Python outputs、用户脚本 JSON 都是待验证产物。可用它们定位工件，但模型可见计数必须由独立读取/分析确认；未验证字段不进入可信 summary。

## 7. 执行适配、诊断与恢复

### 7.1 程序执行入口

- 保留 run_code/run_r/run_pk；通用 shell 在受保护任务中也使用同一出口协议。
- 不解析 shell 字符串来证明安全。企业 profile 使用公开工具注册/能力 Provider：必要时禁用原注册并安装受控适配；不能在 monotonic guard 中静默替换调用。
- 工具定义不能同层重名；上游保留名不能强行覆盖。Code Mode 保留官方入口，但其嵌套值、日志及 contexts 受统一门禁。
- 通用执行的原始 stdout/stderr 留受保护诊断工件；状态、静态诊断和可信指标进入 DTO。普通非数据任务不因安装插件就自动被临床模式接管。
- 不能在 P0 就全面收紧 stdout：在 P1 能力就绪前保持旧行为并标明边界未完成；最终切换必须成组完成。

### 7.2 Python/R 共同诊断规则

1. 可信侧先对已登记源码做静态编译/解析，不接触数据；可释放对应 programRef、版本、行列号及已获准源码定位。
2. 执行分 `prepare/compile/execute/encode/validate/publish`，错误类型来自固定枚举；未知类归 other，不回传可由代码自定义的异常类名。
3. traceback 不带 locals、动态源码或异常原文。运行时抛出的 SyntaxError 不按静态编译错误处理。
4. symbolRef 必须来自可信静态分析/登记 schema，并有错误位置对应关系；不能仅因为动态异常文本某段恰好出现在代码字符串中就原样回传。
5. `outputsDefined` 使用 true/false/unknown：只有可确认观察才赋值；不能把缺字段默认为 false。它不是业务成功证明。
6. Python 的数据编码错误与进程失败分别报告；R 的 message/warnings/listings/outputs 全部按运行时 schema 处理，未知正文留本地。
7. 完整日志、逐格差异由本地授权用户查看；模型获得诊断引用、结构事实和恢复动作。
8. 无法安全提取错误细节时，固定错误码加代码位置与本地工件比“编造有帮助的错误”更正确。用真实合成修错任务验证该信息足以继续工作。

### 7.3 runner 产物校验

- 子进程 JSON 属于不可信输入：限制尺寸/深度、字段集合、标量类型、重复列名、attrs 范围；禁止通过 `_source` 升级信任。
- 产物传输定义明确 dtype、空表类型、列序/标签保真合同；不要让 JSON 重建静默改变比较结果。
- 模型代码可影响自身进程，普通模块隔离测试不证明 result.json 的可信性。宿主重新校验并独立计算可见指标。
- R 的输出路径、文件名和计数即使满足基本类型也不自动公开；先登记工件，输出引用和获准显示名。
- 两条 R 车道先绑定保护上下文、输入版本及 runId，再执行；不能依赖 Python inspect 的副作用。
- 凭据只由宿主解析后进入本地执行环境；R 现有 password 参数迁移为 credentialRef/宿主配置，兼容旧自动化仅限本地宿主配置，不在模型可见参数与日志中保留明文。

### 7.4 状态机、幂等与重入

```text
not_started → running → succeeded / failed
                   └→ unknown（断连、超时、取消后无法确认）
unknown → 查询/工件核验 → succeeded / failed / 仍 unknown
```

- 执行状态独立于 deliveryState 与 validationState。程序完成但输出扣留，不重跑；程序完成但验证未过，不交付为 passed。
- runId 在启动前持久化；状态提交包含 snapshot/program/requirement/config/operation 版本与预期工件引用。
- 幂等键覆盖上述版本。只有受控分析或已明确输入/输出、无外部副作用的托管作业可自动复用/重试。
- 任意 shell/R/Python 的隐式文件读取、网络、数据库或时间依赖无法被插件完整推断。依赖未声明时不承诺自动幂等，不自动重跑 unknown 作业。
- 扫描/投影失败只重试扫描/投影，绝不重新执行业务程序。基础设施最多一次自动重建，次数在同一 run/phase 记录，不因模型换命令而归零。
- 发布显式绑定 runId + snapshotRef + validation evidence；禁止直接发布 `_last_outputs`。新运行失败不会把旧产物误标成本次成功。
- 工件版本改变、输入更新、需求更新使发布证据失效；旧产物仍可本地留存，但要用独立版本引用。

### 7.5 R/Python 统一发布：先暂存再提交

选定实现为**每 run 独立暂存 + 宿主版本化发布**，不是仅在 R 写完最终目录后补 runId：

1. 在已约定的项目输出根内创建宿主管理的运行暂存区和版本区；不得自动改到其他盘/目录。不可写即报错。未验证工件不覆盖现有正式文件。
2. run_r/run_pk 与 Python 执行只产生待验证工件引用；宿主扩展现有 `enterprise_listing_publish`，支持三条执行路径的 runId、snapshotRef、artifactVersion、validationRef，不新增第二个发布工具。
3. 托管 R 程序通过显式通用输出根参数写暂存区；在执行前检查该版本是否实现契约。现存程序不支持时返回 `PROGRAM_OUTPUT_CONTRACT_REQUIRED`，仅修改经登记的通用路径配置段并验证业务区未变；不得自动重渲染或替换业务代码。不能无侵入迁移时列待确认，不假装可安全暂存。
4. 独立验证通过后生成不可变版本目录，再原子提交“当前批准版本”清单/指针。用户下载与正式交付只认该清单；需保留旧文件名时由发布器导出兼容副本，不以多文件逐一覆盖冒充原子提交。
5. 验证失败、进程崩溃或发布中断保留上一个批准版本；未提交版本仅供本地诊断。恢复核验清单与工件版本，不能因为暂存文件存在就宣称发布成功。
6. 暂存/版本目录也是 derived-data；其文件、日志和路径不授予模型正文访问。回滚同样核验批准指针，不移动或删除用户已有产物。

## 8. 运行记录、交付物与审查方式

### 8.1 本地记录与留存

- 作业/资源/释放/需求覆盖记录使用版本化 schema、原子写入和恢复校验。
- 原始数据、stdout/stderr、诊断和逐格差异留本地受保护工件区；不放普通可回读的临时文本或模型历史。
- 审计只记录事件码、工具身份、资源/程序版本引用、阶段、执行/释放/验证状态、恢复动作、重试次数、耗时。
- 不记录原值、原始异常、密码或危险输出摘要；文件名含业务值时仅记录 artifactRef。
- 保留期与清理范围配置化；卸载/取消清理只处理本服务拥有且已确认不在运行的工件，不按宽目录前缀删除其他会话产物。

### 8.2 交付物自审迁移

目标不是取消独立审查，而是将“模型直接阅读真实交付行”替换为：

- 获准结构读取与需求映射检查；
- 独立 compare_artifacts/rule_check；
- P1/P2/P3 等审查结论引用需求和本地证据，不引用真实单元格值；
- 未确证事项明确给用户本地核对，不伪造 pass。

审查实现不能复用被审程序的业务函数自证正确；有批准基准做本地结构/值级比较，无基准做独立规则重算。审查工具或 skill 不能靠“审查身份”获得数据豁免。

现网旧审查通道切换需要发布确认和真实任务等价验收。未批准切换时不得标记新版红线已收官；不把“等待确认”写成永久允许读取真实交付物。

## 9. 全出口接入与来源治理

### 9.1 首次任务、会话及子代理

- 出口服务装在企业 host，不装在仅父 agent 私有 scope，也不在 standing preset 中发布不允许的 root service。
- 全局 agent/pre-step 在模型请求前准备/恢复上下文；企业可控的根 create/resume 入口使用 setup 初始化。setup 不是自动作用于所有子代理的全局 hook。
- 会话保护按宿主 sessionId、可信 parentSession/lineage、项目与策略版本恢复；不能只用 `Map<agentObject,…>` 保存。
- 按 2.4 已分类的 protected/unclassified root 未选择项目时，只开放批准任务文本、目录/资源发现及需求绑定；项目绑定后再开放相关数据计算。已确证 ordinary 的会话不受此临床任务限制。未知状态不是“安全关闭”。
- 子代理、resume、fork、续问和 compaction 均继承保护；外部代理没有等价接入时不允许携带受保护任务材料出站。
- fork 对实际复制的 seed 前缀逐条建立派生历史释放证明，绑定父证明、具体消息/事件、精确内容与目标 session，按当前策略复核；不能仅凭 parentSession 整段授信。spawn 不继承未复制的历史证明；resume 恢复同 session 的证明。缺证明的旧历史不能直接复制入模。
- 历史 session 若包含旧宽豁免时期的原始结果，先本地重建安全视图再恢复；不能先发给模型压缩来“清洗”。

### 9.2 可信工具能力与 pre/post

- 能力分为 discover/stat、scoped_read、controlled_analysis、managed_execute、unknown。身份来自注册定义/Provider，不按 glob、shell、enterprise_ 字符串猜。
- 发现工具仅返回获准路径/结构，不因 pattern 中有 `.xlsx/.csv/.zip` 拒绝。按业务值命名的路径用引用替代，不能一概声明“文件名永远安全”。
- read 根据资源版本和范围判定；数据内容请求返回 withheld 与替代入口，不能谎称已完整读取。
- post 必须结合 result 与后续 decision 的最终语义处理 value、content、meta、error、feedback、两侧 additionalContexts。
- 可信工具尽量在 execute 内返回安全 DTO。未知结果需要扣留时采用 block 并只附安全反馈；不能只替换 content 留下原始 value，也不能用空 contexts 假设清空原 contexts。
- 取消参数/结果文本含 Output/04_Out 的放行；最终取消路径、shell 名称和企业前缀宽豁免。
- pre 不得因“代码中出现数据后缀”拒绝已登记源码编辑/执行；未知读工具则不以参数关键词猜测是否安全。

### 9.3 spill、Code Mode 与异常路径

- 记录官方插件装配顺序，合成探针覆盖 post、spill、finalize、result。只有结果确实完成投影才创建释放证据。
- 安全需求页 spill 后保留 document/version/scope 票据与回读映射；原始日志 spill 保留 protected 属性。
- 工具自有临时文件、shell 流文件、嵌套工具日志也进入资源登记；未登记文件不因扩展名是 txt 就可读。
- 原始 canonical value 只允许在本地受控计算边界使用，不能流入模型或模型可回读日志；Code Mode 测试必须分别检查程序值、文本日志和 deferred context。
- post 之前的异常、post 自身异常及 finalize 新增内容由固定异常协议和最终请求门禁共同处理。不能以“该异常没经过 post”放行。

### 9.4 最终模型请求门禁

先按 2.4 分流；以下是安全开启且属于 protected/unclassified 管辖范围时，在官方 `llm/stream` 委托前的检查，不新增对普通会话或关闭状态的临床阻断：

1. 标准 loop 的 sessionId 结合企业记录核验；存在 currentInitiator 时做一致性检查。二者均不是可由字符串自授的权限。
2. 默认 compaction 已携带 sessionId；其他辅助请求逐项审计。无会话且无可信 initiator 的请求默认拒绝；必要的安全辅助调用通过企业 wrapper 登记一次性、精确请求许可。
3. 将最终消息块、工具 schema/description、错误、system/runtime context、附件引用与批准来源对应；不只扫描最后一条工具文本。要求精确版本/范围匹配，不凭摘要关键词判安全。
4. 历史内容优先用释放记录重建；系统提示、代码、需求片段等固定/登记来源可直接验证。新模型文本不获得访问数据的权限，其上下文应已只含获准信息；外部新注入内容须单独登记。
5. 不明来源或不受控附件扣留，返回固定 REQUEST_PROVENANCE_UNVERIFIED；不把被拒正文加入错误提示。
6. 批准分支 `yield* next()`；拒绝分支在调用 next 前终止，保证不进入 adapter。调整企业编码规范：正常委托恰好一次 next，契约允许的拒绝分支不得在 finally 中又调用 next。
7. llm/stream 只校验或拒绝，不在回调内改写/重发冻结请求；next 不接替换参数。拒绝结束当前 turn，不假设会自动进入 adapter 错误重试。企业宿主恢复协调器在该 turn 完全结束后，最多一次创建新的受保护会话，仅投递已批准材料并建立新的来源证明；已有 run/artifact 引用重新授权，禁止重跑业务作业。恢复次数按 lineage 记录。UI 明示恢复关联；没有完成这个宿主恢复入口时返回固定失败，不宣称自动恢复可用，更不能去掉门禁重发。

**工程硬门槛：** 先用真实上游工具/请求链和假 adapter 证明企业层可完整关联来源。若某来源无法以公开 API 跟踪，该功能在受保护 profile 中保持不可用，并记录兼容性阻塞；不修改上游私有实现或用“未扫描到值”弥补。

### 9.5 附件、图像、UI 与实际网络

- llm/stream 检查的是 adapter 前的语义请求。附件随后可能由 adapter 读取、上传或转 base64，不能把前置检查当最终字节审计。
- 首版受保护任务只允许固定版本、批准来源的附件；含真实数据图片/截图只给用户本地查看。无法验证附件字节版本和上传路径时禁止该附件进入模型，文本需求改走本地解析后的批准范围。
- 合成 E2E 同时捕获聊天 payload 和文件上传，覆盖上传失败后的 base64 fallback、缓存与重试。
- WebUI 本地显示交付物不等于向模型发送；再次“发送给 AI”、附件读取、session export→import 均重新走角色/来源门禁。
- 会话日志、UI 事件、工件导出是否只在本地授权范围可达，由现有部署权限控制；不能把它们混成模型出口，也不能让模型 read 这些本地敏感记录。
- 其他插件的直接网络/外部 AI 调用不自动受 llm/stream 管理；受保护 profile 必须核查并禁用未经同等适配的通道。全机网络 DLP 仍属于 2.3 的独立范围。

## 10. 开发任务清单与验收条件

### P0：建立基线，修复确定误伤，不宣称安全收官

#### T00 — 基线、隔离夹具与扩展点探针

- 文件：`tests/safety/*`、`scripts/safety-tests.mjs`、企业测试配置。
- 工作：建立仅合成数据的临时 HOME/TEMP/注册表环境；记录当前 pre/guard/post/spill/finalize/request 顺序；分类现有警告。
- 指标：策略后缀拒绝、真实来源命中、扫描未就绪、扫描超时/失败、碰撞疑似、无效调用、工具误选、阶段耗时。
- 限制：仅凭哈希命中无法判“真实泄露”；分类须保留 unknown，合成场景才有确定真值。真实任务基线只记录安全计数，不额外导出载荷。
- 验收：探针覆盖普通/错误/嵌套/子代理/首次调用；记录官方公开 API 可行性，禁止用 mock 掩盖缺失接入。
- 依赖：无；T00 的结果是进入最终架构开发的第一道门槛。

#### T01 — 公共出口合同与真实开关装配

- 文件：tool-audit 公共子路径、服务骨架、package exports；listing 依赖；ui-settings 与装配测试。
- 工作：实现 4.1–4.4 类型/运行时 schema、软读取开关、固定码及 Provider 生命周期；验证 plain Node 构建后导入。
- 验收：默认/损坏配置开启、合法关闭生效；分别验证开关服务缺失、出口 Provider 缺失、在途流期间重载及强制门禁整体停机顺序。Provider 不可用时常驻门禁仍在；禁止独立卸载门禁后继续受保护调用。不依赖普通对象桩作为唯一证明。
- 依赖：T00。

#### T02 — 前置路径/能力误拦及明显文本豁免修复

- 文件：dataset-guard.ts、listing post、能力映射与现有测试。
- 工作：已知 path 字段完整处理；可信 list/glob/stat 只做发现合同；移除“结果任意含 Output/04_Out 即整体放行”。
- 过渡：如保留旧交付物读取，仅限可信文件读取定义与规范化路径，仍标记为旧策略风险；不能给 shell/其他结果新增路径豁免。
- 验收：空格/中文/大小写/嵌套路径、纯模式、无 IO 代码文本正常；文本字样不能改变放行决策。
- 依赖：T01。最终取消全部目录授权仍由 T10 完成。

#### T03 — 诊断分类、回执透传与运行状态基础

- 文件：worker.ts、index.ts、diagnostics.ts、run-registry.ts。
- 工作：分别标注 pre 未执行与 post 已执行；贯通 environmentHint/failures；拒绝回流原始 error；记录 runId 和运行事实。模型可见回执变更必须同批提交 schema、renderer、最小操作指引及回放测试，不等到 T12 才同步。
- 验收：扫描故障不显示“检测到数据”；post 扣留不诱发重跑；Python→TS→最终结果→回放字段一致；旧提示不会指导模型按旧协议重跑。
- 依赖：T01。没有足够事实时返回 unknown，不默认 not_started。

P0 发布说明必须保留：shell 及企业前缀等旧宽豁免尚未完全替换，红线未严格成立；禁止把 P0 作为最终版本验收。

### P1：补齐可信能力并接通全链路

#### T04 — 资源角色与原子快照

- 文件：snapshot.py、discovery.py、source_registry.py、worker.py、出口资源服务。
- 工作：落实第 5 节；统一 inspect/ensure/scan_init；稳定 ID/内容版本/策略版本；坏输入状态和 required/optional 依赖。
- 验收：各阶段失败不提交半快照；同项目换数据/同大小同 mtime 改写可发现；主/扫描错版不得认 ready；名称/目录不授信。
- 依赖：T01、T03。

#### T05 — 范围需求读取、字节分页与交付证据

- 文件：document_access.py、read_document/read_metadata 工具、需求覆盖记录。
- 工作：语义页、范围白名单、稳定版本/cursor、spill 回读映射、超大单元格处理；metadata 各集合独立分页，失败清单不每页重复全量。
- 验收：禁止页和无关列未读取；批准范围逐行完整；UTF-8 字节预算不超；被 spill 的 prepared 页不得冒充 delivered。
- 依赖：T04；最终回放/上下文覆盖在 T11 完成。

#### T06 — analyze 首批可信操作

- 文件：controlled_analysis.py、worker 协议、analyze 工具及闭合 schema。
- 工作：实现第 6 节七种 operation；明确计数定义、规则/映射/比较引用和支持范围；与任意代码 runner 分离。
- 验收：合成真值独立核对；非法句柄/动态代码/任意过滤不接受；批准计数同原值碰撞仍通过；个体/分组值不释放；无适用 ReleasePolicy 时 fail-closed。验证单记录、衍生工件、连续差分查询和粗状态，查询累计不随子代理/重启清零。
- 依赖：T04，可与 T05 并行。

#### T07 — Python 运行与静态诊断

- 文件：sandbox.py、code_runner.py、worker.py、execution-adapter.ts。
- 工作：可信预编译、阶段码、日志本地化、runner JSON 严格校验、输出保真与重复列检查；不信任子进程自报安全摘要。
- 验收：静态语法错误可修；动态 SyntaxError/自定义异常/locals 不出域；encode/timeout/取消状态准确；完整执行-诊断-修码循环通过。
- 依赖：T03、T04；可信指标依赖 T06。

#### T08 — R manual/PK 执行对齐

- 文件：r-runner.ts、diagnostics.ts、对应单测及 R 侧通用协议段。
- 工作：同一 DTO、输入版本/runId/保护绑定；summary 字段投影与独立核验；宿主凭据引用；按 7.5 实现运行暂存和输出契约检查，旧程序仅迁移通用配置段，不重渲染业务区。
- 验收：两条 R 车道成功/失败/无摘要/坏 JSON/非法计数/未知字段/警告路径一致；安全开启不回流 message/warnings/listings 原文；执行或验证失败不覆盖现有批准产物；不支持输出重定向的旧程序明确阻断托管发布。
- 依赖：T03、T04、T06。R 真实集成测试不得用假 Rscript 单测替代。

#### T09 — 宿主会话、最终请求与附件门禁

- 文件：出口 service/request-gate、企业 profile、会话接入和集成测试。
- 工作：落实第 9 节的首次请求、恢复/子代理/compaction、匿名辅助调用、附件批准来源；实现 fork 派生历史证明、旧历史迁移和 turn 结束后的有界新会话恢复协调器；明确不受控插件禁用范围。
- 验收：未 inspect 也保护；fork 的批准历史能继续，混入未批准事件仍拒绝；修码后旧诊断可重放但不能验证新 run；异常/finalize/额外上下文不漏；拒绝时 adapter/上传计数为零，恢复不重复业务作业。
- 依赖：T00、T01、T04，可在 T05–T08 期间先用合成 Provider 开发。

#### T10 — 成组切换工具出口

- 文件：tool-audit、listing post、通用执行适配、profile 组合。
- 工作：可信 DTO/票据就位后统一出口；删除 shell、enterprise 前缀、目录豁免；补两侧 contexts、Code Mode、工具日志和错误路径。
- 验收：安全操作不依赖值索引就绪；未验证输出扣留；相同合成数据经不同工具/目录/产物保护一致；无绕行提示词依赖。
- 依赖：T05–T09 全部通过。不得仅先合并收紧然后等待替代能力。

### P2：闭环、验收与发布

#### T11 — 发布版本、幂等、需求闭环与独立审查

- 文件：run-registry、publish、覆盖账本、compare/rule 验证记录、审查知识。
- 工作：扩展既有 publish 统一三条执行路径，按 7.5 提交版本化工件及批准指针；显式 runId/版本发布、旧输出隔离、unknown 查询、同作业去重；验证需求覆盖、理解矩阵和独立审查结论。
- 验收：失败重跑不发布旧工件；需求/输入变更使证据失效；post 重试不重复执行；未知口径 incomplete 而不是 pass。
- 依赖：T06、T10。

#### T12 — 工具合同与现有知识同步

- 文件：现有工具描述、系统提示、企业知识库/skill 镜像、编码规范。
- 工作：收尾统一输出 V2、固定错误码、安全自审方式；去掉“换 shell/换目录/关闭开关”恢复建议；新增工具总数≤1。各任务最小模型操作指引已与对应实现同批交付，T12 负责全量审查/知识一致性，不是首次更新提示词。
- 验收：所有指引都有实际入口；无旧提示要求模型读原始产物；Session Log/replay 可重建安全上下文。
- 依赖：T10、T11；不自动覆盖用户全局 skill。

#### T13 — 真实路径验收与发布记录

- 文件：参数化安全 E2E、测试报告、企业 CHANGELOG/相关 ADR。
- 工作：合成载荷全出口检查；WebUI→AI→工具→本地 R/Python→交付→独立验证；同模型对照；故障恢复与回滚演练。
- 验收：满足第 12、14 节全部门槛，记录未覆盖面；没有数据/模型授权时标 NOT RUN，不声称通过。
- 依赖：T11、T12。

## 11. 依赖顺序、并行分工与合并单位

```text
T00 → T01 → T02、T03
T03 → T04
T04 → T05、T06、T07、T08、T09
T05–T09 全部就绪 → T10 → T11 → T12 → T13
```

T07/T08 可先开发协议，可信指标验收须等 T06；T09 可在早期用假 Provider 做接入探针。多人并行时：

- 宿主组：T01/T02/T09，负责契约和所有出口；
- 数据/需求组：T04/T05/T06，负责版本、角色、可信计算；
- 执行组：T03/T07/T08/T11，负责运行事实和修错闭环；
- 验证组：T00/T10 集成测试/T13，独立于被审业务生成逻辑。

合并顺序建议：合同/装配、误拦/诊断、快照/需求、分析、Python/R、统一出口、发布/回放/E2E。每个合并单位包含实现、合成测试、模型可见契约变化和兼容记录。P1 切换提交不可把收紧与替代能力分离上线。

## 12. 测试矩阵与通过标准

### 12.1 单元与集成用例

所有保护值仅使用合成标记；不输出可直接用于绕过现网的示例命令。

| ID | 场景 | 必须断言 |
|---|---|---|
| S01 | glob/list/stat 含保护后缀 | 返回获准文件信息，不触发读取拒绝 |
| S02 | 空格/中文/大小写/嵌套、路径别名 | 相同资源身份和范围；路径不切碎 |
| S03 | 代码文本含数据路径但没有读取输出 | 正常编辑/编译；不因字符串后缀拒绝 |
| S04 | 需求或计数与保护值相同 | 已批准来源正常返回，不受全局碰撞否决 |
| S05 | 原始值进入 stdout/stderr/动态异常 | 模型请求中没有标记；本地诊断可定位 |
| S06 | R summary 各字段、非法类型/数值 | 不可信字段扣留；不得依赖 TS 类型断言 |
| S07 | Output 路径、目录复制、文本字样 | 不改变内容保护属性 |
| S08 | value/content/meta/error/feedback/两侧 contexts | 每个面分别放标记，全部被控制 |
| S09 | Code Mode 嵌套值/日志/图片上下文 | 检查本地程序值与模型视图的差异，模型不见原值 |
| S10 | pre/post/render/finalize 异常与取消 | 固定安全错误；不存在绕过 post 的出站漏口 |
| S11 | 扫描预热/超时/崩溃 | 错误码准确；≤1 次基础设施重建；安全读取仍可用 |
| S12 | 快照构建各阶段故障 | 无半提交；旧版本不冒充本次成功 |
| S13 | 同项目换批次、同大小/mtime 变化 | 输入/索引/覆盖/发布证据正确失效 |
| S14 | 受控编辑与外部改写可信文件 | 前者产生新登记版本；后者不得继承授权 |
| S15 | 混合 Excel、同名不同内容、设计识别误判 | 只释放确证范围；低基数不自动授信 |
| S16 | 动态 SyntaxError/自定义类名/编码失败 | 无动态正文；静态源码位置仍可修错 |
| S17 | runner 伪造属性/无效 JSON/重复列 | 不形成可信结果；不损坏父进程状态 |
| S18 | 单个坏可选/必需输入 | 仅影响依赖步骤；缺必需输入不能发布 passed |
| S19 | 大需求/超长单元格/UTF-8/真实 spill | 批准范围完整、字节预算有效、回读后才计覆盖 |
| S20 | post 扣留、unknown、重复调用 | 不重复业务执行；幂等仅用于可证明作业 |
| S21 | 未 inspect 的首次请求、R 先执行 | 保护上下文先于数据出站 |
| S22 | fork/spawn/resume/compaction/外部子代理 | 策略继承或明确阻断，不按新 agent 放行 |
| S23 | 图像/附件上传、缓存、base64 fallback | 假 transport 上聊天与上传均检查；未批准路径无请求 |
| S24 | 旧历史/原始日志回读/session 导入 | 不以历史身份豁免；安全重放可继续 |
| S25 | 合法质量计数、个体过滤、重复试探 | 合法操作可用；未批准个体/分组值不出站 |
| S26 | 新运行失败、旧 `_last_outputs` 残留 | 不能把旧产物发布成本次成功 |
| S27 | 服务缺失/初始化/关闭/重载 | 与现有开关语义一致，未准备状态不误称泄露 |
| S28 | 可卸载、公开 exports、构建后导入 | 无重复监听/资源泄漏，plain Node 与 profile 均成功 |
| S29 | 真实独立审查 | 结构/值级或规则重算成立；不能用同一业务函数自证 |
| S30 | 普通非数据任务 | 不因安装 listing 而被临床模式误接管 |

### 12.2 现有测试复用方式

- `tool-audit/src/dataset-guard.test.ts`：路径、能力与前置判断。
- `listing/src/index.test.ts`、`data-guard.test.ts`、`worker.test.ts`、`risk-regression.test.ts`：DTO、消息分片、post 与恢复；需增加真实上游管线测试。
- `listing/src/r-runner.test.ts`、`r-pk-runner.test.ts`：摘要、版本与凭据协议；假 Rscript 只作单测。
- `listing/python/tests/test_worker_dispatch.py`、`test_doc_content_guard.py`、`test_scan_cache_stability.py`、`test_discovery.py`、`test_design_inference.py`、`test_sandbox.py`：合成输入与故障注入。
- 现有低基数/宽豁免测试有些固定旧策略，须注明被哪条新合同替换，不能为了“绿灯”保留不正确豁免，也不能直接删除覆盖。
- Python fixture 补全所有全局状态恢复，包括 fingerprint；TS fixture 隔离临时目录和 EDC 注册表，避免 apply 的清理副作用。
- 不直接收集整个 Python tests 目录；真实项目 smoke 必须改为显式 opt-in，不依赖目录存在即执行。

S01–S30 是场景组，不是“30 个测试”。T00 建立 `tests/safety/cases.json`（拟新增）映射，每条包含 caseId、taskId、实现符号、测试文件、可执行 node ID、fixture、故障点、预期 DTO、最终请求/上传断言。无可执行映射不得标通过；负例必须配合法操作正例。至少落实：

| 场景组 | 现有/拟新增测试落点 | 必加细项 |
|---|---|---|
| S12/S13/S18/S26 | `test_worker_dispatch.py`、`test_snapshot.py`（新增） | 提交后阶段异常、扫描错版、同名首源失败、成功→失败→无 runId 发布、登记后实际消费前文件变化 |
| S15/S18/S19 | `test_discovery.py`、`test_design_inference.py`、`test_document_access.py`（新增） | 混合角色与解析访问哨兵；证明禁读单元格未抽取，而非仅未返回 |
| S16/S17 | `test_sandbox.py`、`test_runner_protocol.py`（新增） | 结果文件/编码器可被影响时仍不授信、伪造诊断位置、异常前定义 outputs |
| S05/S08/S10/S23/S24 | `tests/safety/tool-pipeline.test.ts`、`request-gate.test.ts`（新增） | 真上游管线到假 transport、附件上传、finalize/错误、回放；不能只断言 TS Error 属性 |
| S04/S25 | `test_controlled_analysis.py`（新增）及跨语言合同夹具 | 单记录/衍生工件/粗状态/累计查询，批准计数碰撞正例 |
| S20/S22/S27/S28 | `tests/safety/lifecycle.test.ts`、`publication.test.ts`（新增） | fork 历史证明、正常修码、门禁/Provider 生命周期、版本发布中断 |
| S27/S28/S30 | `tests/safety/rollback.test.ts`（新增） | 普通/受保护分流、关闭兼容；回滚后旧宽豁免仍不能出站 |


### 12.3 真实用户路径 E2E

至少执行以下任务形态：manual、PK、medical/RBQM 代表流程；使用中性 fixture 名称，业务规则来自需求，不放硬编码项目逻辑。

每种形态覆盖冷启动、需求变更、换批次、执行错误、坏辅助文件、大需求、子代理与重入。必须走 WebUI→AI→实际工具→本地程序→工件→独立比对，不把 worker 直调或 API prompt 驱动当成全部 UI 验收。

分两层：

1. **合成保护验证**：同模型或假 adapter 中捕获实际请求与附件上传，仅扫描合成标记；验证未批准出站数为 0。
2. **授权真实任务验证**：安全开关保持开启，真实数据与基准比较全部在本地；模型只接收批准的差异计数/结构事实。未授权或缺输入时记录 NOT RUN，不擅找真实项目补测。

有批准基准：结构、值、类型、标签、列序、缺失口径逐项比对。无基准：独立规则重算；无法独立确认的需求必须列 incomplete。

### 12.4 发布通过标准

- S01–S30 的适用用例全部通过；未适用项有明确理由，不用空测试假通过。
- 声明测试面上的合成保护标记未授权出站数为 0；合法操作误拦数为 0。
- 故障恢复有界，无重复业务执行，无无限工具重试。
- 需求相关范围完整交付，理解矩阵与独立验证记录齐全。
- 所有约定交付结构/值级或规则检查满足验收；未知需求没有被标 passed。
- 实际请求、Session Log/replay、工具日志和附件检查一致；不能只看 UI 卡片。
- 对 P0 基线量化警告分类、无效调用、工具误选、阶段耗时与完成率。警告减少本身不是安全证据。
- 无 upstream 修改，无真实项目名称/数据值/凭据进入新文档、日志、提交或公共模板。

## 13. 开发环境与验证命令

### 13.1 环境检查

仓库当前要求 Node `^22.19.0 || >=24.0.0`、pnpm `11.7.0`。依赖使用 pnpm；不新增其他锁文件。Python/R 解释器与依赖由宿主解析，需统一 `DSH_PYTHON`/实际解释器选择与 `check_deps.py` 清单，避免“检查 A、执行 B”。

测试前创建一次性隔离环境：TEMP/TMP、DSH_HOME、DSH_EDC_PROFILES、工具可写目录均指向专用临时根；仅挂载源码和合成输入，不挂载真实数据或凭据。清除非测试 DSH_RSCRIPT 等覆盖。测试脚本在 finally 恢复环境，只删除自己创建且确认归属的目录。

以下命令为**后续开发验证入口，本次没有执行**。在仓库根的隔离 PowerShell 终端运行：

```powershell
pnpm --version
node --version
pnpm run build
pnpm run typecheck
pnpm --filter '@dsh-enterprise/tool-audit' run test
pnpm --filter '@dsh-enterprise/ui-settings' run test
pnpm --filter '@dsh-enterprise/listing' run test
pnpm exec vitest run --dir tests
pnpm run check:architecture
pnpm run check:upstream
```

`typecheck` 当前使用构建式命令，可能写 lib/tsbuildinfo，不能把它描述为只读。

Profile 核验另列两种，不能混称已隔离：

- 仓库装配核验：`pnpm run profile:verify`。现有 `scripts/profile.mjs` 会将 DSH_HOME 设为仓库根，外部临时环境变量不能覆盖这一行为；它使用仓库 profile，并要求 upstream 和独立 profile 的依赖已经就绪。只证明配置装配，不证明运行行为。
- 隔离装配验收：T00 的测试驱动生成临时 profile，并通过官方 CLI 公共入口直接加载该 profile，显式绑定测试 home、假凭据/模型路由。不得把现有命令原样套进临时 DSH_HOME 就声称完成隔离；测试环境不得读取生产配置。

Python 必须显式执行；根 `pnpm test` 不包含 pytest：

```powershell
python -B -m pytest -p no:cacheprovider -q `
  packages/enterprise/listing/python/tests/test_data_guard.py `
  packages/enterprise/listing/python/tests/test_worker_dispatch.py `
  packages/enterprise/listing/python/tests/test_doc_content_guard.py `
  packages/enterprise/listing/python/tests/test_scan_cache_stability.py `
  packages/enterprise/listing/python/tests/test_discovery.py `
  packages/enterprise/listing/python/tests/test_design_inference.py `
  packages/enterprise/listing/python/tests/test_sandbox.py
```

开发后扩展 `scripts/safety-tests.mjs` 的显式合成用例列表，而非通配收集真实 smoke。新脚本由 Node spawn 参数数组跨平台运行命令，不依赖 shell 字符串拼接。

### 13.2 E2E 驱动约束

- 拟新增 `scripts/safety-e2e.mjs` 接受中性 fixtureRef、lane、case、模型实际标识、采样/推理参数、策略版本、结果目录；不写死项目目录、端口、基准映射。
- 从现有冷启动/续问驱动复用会话组织方法，不复用会删除旧程序/产物的操作；不得因需要基线就清空用户输出。
- 真浏览器验证使用已有浏览器工具和用户路径；驱动只负责 fixture、证据和结果整理，不能以 `session.prompt` 自动化替代浏览器验收。
- 不把 `pnpm start` 当无副作用测试：现有 start 脚本可能安装依赖、处理端口和清理缓存；服务启动只在后续已批准隔离环境执行。
- 真实 R 集成单列运行；假解释器只能证明协议，不能证明 R 程序正确。

## 14. 切换、兼容和回滚

### 14.1 兼容策略

- 保留现有工具名称和常用输入；V2 发布调用必须绑定 snapshotRef/runId/artifactVersion/validationRef，其他操作按自身 schema 要求提供引用。旧发布调用仅可由宿主补齐其明确绑定的当前作业引用；无绑定、多候选，或存在后续 failed/unknown 作业时返回固定 `JOB_REFERENCE_REQUIRED`，不回退 last-successful。旧产物只能显式选择版本并重新核验后发布。
- 协议版本 2 的 renderer、知识、审查和测试一起升级；旧 JSON 不因字段碰巧相同就被当作可信 V2。
- 输入格式兼容：保留 SAS/Excel/归档/ALS 的现有解析能力；安全角色与解析器识别分离。
- 不改变用户目录布局；根目录需求、嵌套目录、中文空格都按登记范围工作。
- 不迁移真实数据、不自动重新渲染业务程序、不更新外部用户 skill、不改安全开关。

### 14.2 发布门禁

1. T00 证实公开扩展点可覆盖目标路径；不满足则记录阻塞，不声称设计已能部署。
2. P0 可独立发布误拦/诊断修复，但明确剩余旧边界风险。
3. P1 在隔离环境成组验证替代能力与出口收紧；不得在现网静默双写原始载荷做 shadow 对照。
4. P2 完成真实路径、安全、正确性、性能基线与回滚演练。
5. 部署确认新自审方式及未支持通道的限制；发布说明列明测试面与非承诺范围。

### 14.3 回滚原则

- 失败回滚代码/协议到兼容版本，不关闭用户安全开关，不自动恢复危险宽豁免。
- 若旧版本不能满足当前保护要求，暂停受影响的数据出站/新交付，保留本地作业和安全需求阅读；不能以恢复效率为由回到不安全放行。
- 保存 run/snapshot/工件版本，未知作业先查状态；不通过重跑“修复”回滚后的不确定性。
- 资源登记与运行记录有版本迁移及只读兼容路径；不可读的新版本标不兼容，不猜字段。
- 服务恢复后仅重试投影、扫描或分析；业务程序重跑必须满足 7.4 的明确条件。

T13 必须交付回滚兼容矩阵，列出最低安全版本、允许的 tool-audit/listing/ui-settings/profile 组合、DTO/资源/run/snapshot 的读写版本，以及始终保留的 egress-host 门禁版本。当前宽豁免版本不自动成为合格回滚目标。只允许经演练的组合；无法读取新记录时拒绝受影响入口，不启动旧宽豁免版。

没有安全兼容目标时，回滚方案是停止受影响入口并保留本地工件，而不是整包回退后继续运行。独立断言“回滚后仍不能经旧 shell/enterprise/目录豁免出站”，并验证普通安全能力可用、未知作业未重跑；不能只测服务能重启。

## 15. 完工清单与结论

开发交付时必须给出：

- [ ] T00–T13 的完成状态、改动文件和对应测试编号。
- [ ] 公开扩展点顺序探针、真实 Cordis 装配与构建后导入证据。
- [ ] 统一 DTO、固定码、资源版本、Provider/释放记录的 schema。
- [ ] Python/R/通用执行/子代理/附件/历史全部接入或明确不支持清单。
- [ ] 合成未授权出站为 0、合法操作误拦为 0 的载荷检查报告。
- [ ] WebUI 真实路径的需求覆盖、修错闭环及本地独立验证报告。
- [ ] 基线对比、失败恢复/回滚演练、未测项和已知限制。
- [ ] 企业知识、工具描述、CHANGELOG/ADR 与部署确认记录。
- [ ] upstream 未修改，真实值/凭据/真实项目标识未进入新增产出。

**最终完成标准：安全开关持续开启；模型获得完成任务所需的合法证据；本地程序持续计算和修错；真实行值仍留本地；交付由独立验证证明正确。**

本文已经将开发选择、接口、文件、依赖和验收条件写明；它不是实现完成或“零泄露”的认证。任何未通过的接入探针、未验证的真实任务、未批准的部署行为，都必须按其真实状态记录，不能用警告减少或单元测试通过代替系统收官。
