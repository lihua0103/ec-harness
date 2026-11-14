# 2026-11-11 整改记录（代码与验证）

本记录只陈述本轮实际修改与运行的测试，不把设计合同、单元测试或候选包完整性当作企业上线、安全或临床业务验收。

## 已修复

### 1. 知识“验证通过”语义

**问题**：已安装验证器只执行固定辅助函数用例，回执却把整条知识记为 `ACTIVE`，无法证明方法正文正确。

**修改：**

- `KnowledgeDraft` 新增可选 `claims`（可由验证器复现的具体断言）；`ValidationSuite` 新增 `coverage`
  （每个 knowledgeId 实际覆盖的 claims）。schema 校验大小、去重与目标一致性。
- `KnowledgeService.validate`：用例通过只形成 `TOOL_REGRESSION_ONLY` 回执；只有候选声明的全部 claims
  被套件覆盖且用例通过才写 `CONTENT_CLAIMS` 并 `ACTIVE`。无 claims、部分覆盖、测试失败、候选变化、
  验证器替换均保持 `CANDIDATE` 并记录 `VALIDATION_SCOPE_INSUFFICIENT` 或既有事件。
- 回执新增 `validationScope` 与 `claims{declared,covered,uncovered}`；capture 工具新增 `claimsCsv`。
- DVP 新增窄种子 `dm-dvp.changemark.format`（声明 2 条 claims）作为可复现激活示例；宽方法种子保持候选。
  Listing intake 种子未声明 claims，保持候选；测试覆盖激活、部分覆盖、无 claims 三条路径。

### 2. PDF 压缩对象流与静默丢页

**问题**：`ObjStm` 头是「对象号 偏移」，旧实现把偏移当对象号，压缩页对象全部不可达；生产 PDF 可能静默丢页。

**修改：**

- 正确解析 `/N` 对，按对象号注册、按偏移切片；记录对象流数量、展开对象数、失败数。
- 页树 `/Count` 与实际可解析页数核对；页对象缺失、内容流缺失/无法解析分别计数。
- 新增 `PAGE_TREE_INCOMPLETE`、`PAGE_OBJECT_MISSING`、`OBJECT_STREAM_INCOMPLETE`、
  `PAGE_CONTENT_MISSING/UNRESOLVED` 诊断及 `PAGE_COVERAGE_INCOMPLETE` notice。
- 合成 ObjStm PDF 夹具与页数不一致夹具通过，证明不再静默丢页。

### 3. DVP 大工作簿真分页

**问题**：`limit` 只截断，无法请求后续记录；统计与多 sheet 合并口径不一致。

**修改：**

- `parseDvpWorkbook` 支持 `section` + `offset`；`stats.paging[section]` 返回 `total/offset/returned/nextOffset`。
- `sections[role]` 的 total/returned/offset/nextOffset 按实际页统计；`manualReview` 合并两个人工评审 sheet。
- `offset` 未配 `section` 明确拒绝（`PAGING_SECTION_REQUIRED`）；非法 section 明确拒绝。
- 测试验证两页拼接等于全量、不重不漏。

### 4. 插件互引与公共能力归属

**问题**：DVP 直接引用 Listing 的 `src/workbook.ts`，知识服务适配器位于 Listing 包并只由 Listing patch 安装；
DVP 单独装配缺少 `clinicalKnowledge`。

**修改：**

- 新增 `packages/platform-workbook`：通用 OOXML 读取，无业务策略；Listing `src/workbook.ts` 仅兼容再导出。
- 新增 `packages/platform-knowledge` 独立 bundle：`lib/index.js`、`lib/cordis.js`、`cordis.patch.yml`、
  build/typecheck；知识服务由该 bundle 提供，业务插件不再拥有其生命周期。
- Listing patch 只装自身；DVP patch 只装自身；web/dvp profile 先装平台 bundle。dvp profile 已移除 Listing。
- `tests/independence.test.ts`：DVP 在只装 Prompt/Tools/Skills/PlatformKnowledge 时可装配、卸载不影响平台；
  静态扫描 DVP `src` 无 dm-listing import。
- 发布清单：两插件纳入 `platform-workbook` 源码；Listing 候选包不再内嵌知识服务入口。

### 5. 平台最小运行合同代码

新增 `packages/platform-runtime`（纯逻辑、无 DSH/UI 依赖，6 项测试通过）：

- `resolveExecutionPlan`：required capability → 确切 provider，验证缺失、冲突、版本不符、依赖闭包与循环；
  计划摘要稳定，与 provider 顺序无关；`assertPlanMatchesRelease` 检测运行计划漂移。
- `RunLedger`：QUEUED/STARTING/RUNNING/SUCCEEDED/FAILED/CANCELLED；CAS revision、持久 cancelRequested、
  fencing token、dispatch 前取消获胜、启动中取消需 `cancel-settled`、完成屏障四项事实齐全才允许成功。

该包是控制服务内核，不含进程监督、Worker 启动、身份授权或持久数据库；接入 DSH 运行链路仍需下一阶段实现。

### 6. 文档与元数据

- Listing 包描述改为真实项目工作流 + 合成执行验证 + 候选交付；版本 0.2.0。
- DVP 版本 0.3.0；README/DEVELOPMENT 增加 ObjStm、真分页、claims 语义、独立装配与验证范围。
- docs/README 更新当前状态；平台合同标注哪些内核已实现、哪些仍未接入。
- 开发规则统一于 [企业级 DSH 插件开发规范](DSH-PLUGIN-DEVELOPMENT-STANDARD.md)；旧工程规范入口已撤除，不维持兼容规则。

## 规范对齐（2026-11-11 续）

- **不限制 Harness**：移除 DVP skill 的固定工具步骤编号与“先分类后读取”表述；Listing 客户端提示词改为
  能力清单 + 目标，不再规定 overview→read_sheet→demo 的固定顺序；`dm_listing_read_sheet` 明确不要求先调用
  overview。领域数据边界（如 DVP Cover 不读取）保留，因为它们是业务事实，不是流程枷锁。
- **配置而非硬编码**：platform-control 支持 `storePath` / `allowedApps` 配置并在装配时校验；platform-knowledge
  支持 `storePath`。未知键明确报错。
- **Worker 选型**：[ADR-0002](adr/ADR-0002-WORKER-EXECUTOR.md) 决定使用 DSH profile/SDK 执行器，
  拒绝自定义子进程协议和控制服务内 import 领域代码；`DshProfileExecutor` 已实现并通过合成测试，
  默认未配置 worker 时仍报 `EXECUTOR_NOT_CONFIGURED`，不伪造执行。
- **插件边界**：业务插件仍只注册自身工具/技能/知识贡献，不修改全局工具集、模型 provider 或 Agent 循环。

## 规范执行落地（2026-11-11 第三轮）

- **可执行规范检查**：新增 `scripts/check-development-standard.mjs`，机器判定两条包边界规则——插件源码
  互引（含按包名引用其他插件）、插件相对导入 `packages/` 时目标不在该包 `exports` 声明内（绕过公共面）。
  自带 `--self-test` 夹具验证两类违规均被检出且合规导入不误报；`verify-all.cjs` 自动调用它。
- **包边界显式化**：实测发现 9 处插件源码导入 `platform-knowledge/src/*` 而 exports 只声明 lib；
  `platform-knowledge` 增加 `"./src/*": "./src/*"`，源码消费成为声明的公共面（与 platform-workbook 的
  src 导出口径一致）。复检 0 违规。
- **知识事件分页完整性**：`KnowledgeService.events` 的 `total` 从"最多取 1000 条的长度"改为 SQL
  `COUNT(*)`；新增回归：1005 条事件下 total 精确、跨过旧 1000 上限的翻页返回剩余 5 条、全量拼接不重不漏。
- **Listing 归档提交回滚**：`copyExtractedFiles` 提交失败时只回滚本次创建的文件（碰撞不删除调用方文件），
  回滚失败显式报 `ARCHIVE_COMMIT_CLEANUP_FAILED`。该错误路径已实现并通过类型检查与全套测试；
  尚无直接触发提交中途失败的夹具测试（需要 fs 替身），属已知测试缺口。
- **发布审批来源**：`scripts/release.mjs approve` 必须显式传入本次 `--provenance`，空白/缺失拒绝执行，
  不再硬编码历史授权文字（candidate 测试覆盖空白拒绝与重复放行）。

## 本轮实测（第三轮）

| 范围 | 命令 | 结果 |
|---|---|---|
| Listing | `npm run verify` | tsc 通过；70/70 测试通过（新增事件计数分页回归）；host/client bundle 构建通过 |
| DVP | `npm run verify` | tsc 通过；68/68 测试通过；host bundle 构建通过 |
| platform-workbook | `npm run typecheck` | 通过 |
| platform-knowledge | `npm run verify` | tsc 通过；bundle 构建通过 |
| platform-runtime | `npm run verify` | tsc 通过；7/7 测试通过 |
| platform-control | `npm run verify` | tsc 通过；23/23 测试通过；bundle 构建通过 |
| 全仓门禁 | `node scripts/verify-all.cjs` | 6/6 包验证命令通过；规范检查（插件互引/包边界导入）0 违规；自检夹具通过 |
| DSH Web 装配 | `node scripts/start-dsh-web.cjs`（3080） | 启动无错误；插件页显示 `@ec-clinical/dsh-dm-listing`、`@ec-clinical/dsh-dm-dvp`、`@ec-clinical/platform-knowledge`、`@ec-clinical/platform-control` 均安装并启用 |

测试使用合成/临时数据，未读取真实临床项目。DSH 只做了宿主装配烟测（页面显示四包启用），未发送模型业务请求、
未执行真实项目、未完成临床验收。

## 平台模型目录与工作台模型体验（第四轮）

- **控制面模型合同**：新增 `src/models.ts` 与 `model_catalog`/`model_preferences` 持久表。
  目录是部署注册的 metadata-only 快照（RuntimeBundle 摘要、默认选择、selectionId/provider/model/
  adapter、可用性与停用原因、能力与允许参数、验证来源）；校验拒绝密钥类字段、重复或路由式
  selectionId、不可用默认项。同一内容幂等，变更写审计。
- **Run 模型快照**：`platform_run_create` 按显式选择 → 保存偏好 → 部署默认解析，服务端重新校验并冻结
  `ModelConfigSnapshot`；未知/停用/跨 RuntimeBundle 明确失败，不静默 fallback。目录更新不改写历史 Run；
  retry 重新校验原 route，拒绝改映射。Worker dispatch 收到快照并传递给 SDK；adapter 不一致报
  `WORKER_MODEL_ROUTE_MISMATCH`。
- **工作台原型**：模型目录增加可用性、来源/验证与“未声明”能力；选择器禁止任意 provider/模型 ID；
  未知/不可用的旧选择显式阻止开始工作，不静默替换；修订消息与结果预览显示绑定的模型快照。
  预览服务器支持 `PORT`，避免与并行会话的 3081 冲突。
- **实测**：控制面 typecheck 通过、39/39 测试通过、bundle 构建通过；工作台 27/27 测试通过；
  浏览器验证模型选择/切换/设置页渲染，控制台无错误。未执行 DSH 实时目录探测、真实 adapter 握手、
  企业授权或真实模型调用。

## Work、工作台 API 与正式前端切片（第五轮）

- **Work 与准入**：新增 `works` 持久表/仓库与服务/工具；Run 可绑定 Work；同一 Work 同时最多一个
  非终态 Run；归档拒绝新 Run 与 retry。`dispatch` 改为完整分页读取全部输入，修复固定 100 条截断。
- **HTTP 工作台 API**：`packages/platform-control/src/http.ts` 提供同源 `/api/*`，服务层逐请求授权；
  运行投影不含输入正文；静态资源白名单 + CSP；错误映射稳定。`api-cli.ts` 绑定 loopback 并以固定
  本地 operator 启动，`--seed` 只注册合成应用与本地模型目录。
- **正式前端**：新增 `apps/enterprise-workbench`（工作列表、工作画布、运行尝试、模型控制、事件/输入/
  成果上下文、排队/取消/归档状态、窄屏布局），只消费 API，无预设回复或假执行。`verify-all` 纳入
  `apps/` 验证发现。
- **实测**：控制面 typecheck 通过、51/51 测试通过、bundle 构建通过；正式前端 6/6 状态测试通过；
  浏览器实测新建工作→排队运行→补充输入→取消→归档→切换模型新建尝试，控制台无错误；全仓待重跑。
  未执行真实 Worker、模型调用、企业身份或成果封存。

## 工作台体验诚实性与门禁严格化（第六轮）

- **工作台不再静默换模型**：目录中保存的偏好或当前选择不可用时，选择器显式显示“当前选择不可用，
  请显式选择模型”，并阻止“设为默认”；开始工作、新建尝试、重试前都校验当前所选模型可用，
  不可用即拒绝并给出原因，不再自动替换为目录中的第一个可用项或部署默认。旧的替换逻辑已删除。
- **历史完整性**：工作列表、某工作的运行尝试、事件、输入改为按平台分页取全量（`total/offset` 循环），
  修复 5 秒轮询下只显示前 100 条事件/输入的截断；中间页为空或响应无效时显式报 `PAGE_INCOMPLETE` /
  `PAGE_INVALID`，不把截断列表当完整历史。
- **写操作断网诚实性**：读请求断网提示重试；写请求断网改为“结果未知，请先刷新核对，不要直接重复提交”，
  不再错误宣称“当前操作没有提交”。
- **运行状态完整映射**：前端补齐 `WAITING_FOR_USER`、`FINALIZING`、`CANCELLING`、`UNKNOWN`；
  `UNKNOWN` 与 `FINALIZING` 不提供补充输入/新建重试入口（`canAppend` 白名单），提示需要可信结算或
  对账。重试请求携带界面当前显式选择的模型。
- **聚合门禁严格化**（`scripts/verify-all.cjs`）：必须显式声明 `scripts.verify`，不再缺省择一执行
  typecheck/test/build；配置 Bundle 按 manifest 的实际 `dsh.bundle.patch` 检查，不强制 `src/`、`build.mjs`
  或固定 patch 名；规范检查器缺失即失败；把检查器 `--self-test`、聚合器自检、各原型 `verify.mjs`
  纳入检查；子进程非零退出、启动异常或信号中止均计失败。
- **实测（Node 24.9.0，本轮全仓基线）**：`scripts/verify-all.cjs` **12/12 检查通过**——Listing 70/70、
  DVP 68/68、platform-control 58/58、platform-runtime 7/7、platform-identity 7/7、正式工作台 10/10、
  platform-knowledge/workbook 类型与构建、聚合器自检 19/19、原型 27/27、规范检查器自检通过。
- **DSH 装配组合**：以独立端口加载 web profile 执行 `--dump-config`（不启动服务、不调用模型），退出码 0，
  组合结果包含 `@ec-clinical/platform-control`、`@ec-clinical/platform-knowledge`、`@ec-clinical/dsh-dm-listing`、
  `@ec-clinical/dsh-dm-dvp` 四个包。这是配置组合证据，不等于运行时挂载/工具调用的集成验收。
- **未完成**：预览面板在当前窗口未打开时上报视口 0×0，点击交互无法执行，浏览器交互回归 NOT_RUN
  （截图可渲染但不构成交互验收）；需在可见窗口或用真实浏览器重跑
  新建工作→排队→模型切换→取消→重试流程。

## 成果封存、事件流与原生问答（第七轮）

- **成果封存与授权下载**：Worker 关闭后由控制面复制字节到 `artifacts/<runId>/<name>`，复制时复算
  SHA-256 与大小；不一致运行失败且不登记；只有封存副本计入完成屏障。下载接口重新鉴权并在读取时
  复验，篡改返回 `RUN_ARTIFACT_TAMPERED`，投影不暴露封存路径。
- **可恢复事件流**：`GET /api/runs/:id/events/stream`（SSE）按持久 sequence 游标
  （`Last-Event-ID`/`after`）重放，断线可续传；工作台优先用流、保留 5 秒轮询兜底。
- **原生问答收件箱**：SDK `onUserQuestion` 持久化为 `run_interactions`（run/session/requestId），
  控制面等待 CAS 答复；重复答复、未知选项/空答复、运行终止后的晚答均拒绝；取消/终止时未答问题
  置 CANCELLED/EXPIRED 并向 SDK 返回 `{cancelled:true}`；工作台提供选项/多选/自定义答复。
- **实测（Node 24.9.0）**：platform-control 64/64；全仓 `scripts/verify-all.cjs` **12/12 检查通过**。
  未运行真实模型、未接 DSH 工具审批/平台业务审核通道、未做运行状态机 WAITING_FOR_USER。

## 补充方案剩余工作矩阵（2026-11-11，按实际证据）

状态口径：PASS=有本轮实际执行证据；PARTIAL=代码合同/回归已完成但缺集成或真实环境证据；
NOT_RUN=未执行；BLOCKED=需 IT/业务/部署授权或环境。

| 编号 | 状态 | 已具备的事实 | 仍缺 |
|---|---|---|---|
| DSH01 | PARTIAL | Run 快照记录 selection/provider/model/adapter/options，Worker 按快照传参；有快照的成功缺 `model/selection` 证据时为 UNKNOWN | 真实 SDK 握手与实际 adapter route 的网络级证据 |
| DSH02 | PARTIAL | RuntimeBundle 摘要匹配、adapter 不一致拒绝、撤销后 dispatch 再校验 | profile/patch/adapter 制品闭包验证；缺 adapter 明确失败的真实运行 |
| DSH03 | BLOCKED | 部署注册目录 + 结构校验 + 来源标记（provider-declared/platform-verified/unverified） | 部署侧 `ctx.llm` 探测与带 profile/adapter 摘要的目录快照发布 |
| DSH04 | PARTIAL | selection 级策略过滤目录/偏好/创建/重试，猜 ID 与不存在同样拒绝，审计 model/selection 事件，策略缺失 fail-closed | 真实企业组织/项目/区域身份接入（IT） |
| DSH05 | PARTIAL | 目录变更不改写历史快照；UNKNOWN 隔离同 Work 新 Run；outcome 绑定 launch+epoch | 真实 A/B 模型执行与恢复证据 |
| DSH06 | PARTIAL | 停用/撤销/路由重映射拒绝，无静默 fallback；排队再校验 | 运行期凭据过期/限额的真实错误分类证据 |
| DSH07 | PARTIAL | SDK 原生用户问题已接入持久收件箱：绑定 request/session、CAS 一次性答复、取消/终止置 CANCELLED/EXPIRED、晚答拒绝，API 与工作台收件箱可用 | DSH 工具审批通道（approvalRequests/client.onRequest）与平台业务审核通道未接入；运行状态机未引入 WAITING_FOR_USER（提问期间保持 RUNNING）；断线后的账号级收件箱同步未做 |
| DSH08 | PARTIAL | 平台状态事件持久化、可恢复 SSE 流按游标重放；输入消费按实际派发前缀 + claim 证明；晚追加保持 PENDING | DSH 通知持久水位与 run 终态由真实结算产生的集成验收 |
| DSH09 | PARTIAL | close 幂等、先 close 后 hash 成果、`exitProven` 缺失记 UNKNOWN、取消不假报结算 | 进程树终止证据、崩溃接管与 `resumeSession` 原 home/session 恢复实测 |
| DSH10 | NOT_RUN | 控制面为通用 capability/selection 结构，无 Listing/DVP 分支 | 第二合成 provider + 第三 probe 应用的配置发现验收 |

补充方案其他剩余（与上表不重复）：

1. **工作台体验**：SSE 实时更新、原生提问收件箱与等待答复/封存中/未知状态已实现；尚无 DSH 工具审批
   收件箱、平台业务审核通道、浏览器成果预览、locale 资源外置与 RTL 评估、非开发员工试点
   （U07–U14 的产品/研究部分）。
2. **成果与证据**：已实现控制面封存副本、授权下载与读取时摘要复验；仍缺浏览器预览（不执行文件脚本）、
   Evidence/ReviewRecord 分层展示与业务复核记录（WP6 剩余）。
3. **企业运行**：身份/项目授权/secretRef/网络与资源限额、撤权处置、进程监督与租约续期（WP7、WP4 剩余）。
4. **知识验证**：验证回执来源核验与跨进程候选激活（WP9）未在本轮推进。
5. **发布工程**：远端托管、分支保护、CI 全量通道实际运行、SBOM/许可清单（WP3/WP10 剩余）。
6. **格式一致性**：历史压缩式文件的独立格式化提交。
7. **真实项目业务验收**：Listing 真实项目端到端、DVP 真实方案/模板复核需按授权项目执行并留证，
   合成回归不代替业务验收。

上述 NOT_RUN/BLOCKED 项不能用本轮单元测试或全仓门禁代替；需在对应环境取得证据后逐项更新。
本文件此前“仍未完成”列表中的原型/Worker 配置等表述已被上表取代，以当前源码与上表为准。