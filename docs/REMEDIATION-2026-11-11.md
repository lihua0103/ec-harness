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
| platform-control | `npm run verify` | tsc 通过；17/17 测试通过；bundle 构建通过 |
| 全仓门禁 | `node scripts/verify-all.cjs` | 6/6 包验证命令通过；规范检查（插件互引/包边界导入）0 违规；自检夹具通过 |
| DSH Web 装配 | `node scripts/start-dsh-web.cjs`（3080） | 启动无错误；插件页显示 `@ec-clinical/dsh-dm-listing`、`@ec-clinical/dsh-dm-dvp`、`@ec-clinical/platform-knowledge`、`@ec-clinical/platform-control` 均安装并启用 |

测试使用合成/临时数据，未读取真实临床项目。DSH 只做了宿主装配烟测（页面显示四包启用），未发送模型业务请求、
未执行真实项目、未完成临床验收。

## 仍未完成（不属于本轮可独立修复的代码缺陷）

1. **企业身份、授权与数据入口**：需要 IT/API 合同与部署环境；当前插件仍使用本机文件与操作者 R 配置。
2. **DSH Worker 集成**：`platform-runtime`/`platform-control` 已提供计划解析、持久运行、事件与审计；
   `RunExecutor` 尚未配置，不能实际启动 Worker；进程监督、租约与调度待实现。
3. **工作台仍为原型**：未接真实执行、认证与文件服务；不能以原型演示当平台验收。
4. **真实项目业务验收**：Listing 真实项目端到端、DVP 真实方案/模板复核仍需按项目执行并留证。
5. **统一代码托管与 CI**：外层工作区已建立 Git 基线（`main` 首个提交含源码、规范、钩子与门禁；忽略 node_modules、构建产物、运行证据与固定上游检出）。远端托管、分支保护与 CI 实际运行未完成：`.github/workflows/verify.yml` 的守卫通道即本项目检查脚本，完整通道需拉取上游 DSH 构建并安装 R，尚未在托管 runner 执行，不能视为已验证。
6. **全仓格式化**：已新增 `.editorconfig`、`.prettierrc.json`，并格式化 Listing 入口与 platform-knowledge
   核心模块；其余历史压缩式文件仍待一次独立、无逻辑变更的格式化提交。