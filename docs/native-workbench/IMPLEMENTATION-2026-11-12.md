# 本轮实现记录（2026-11-12）

对应任务书 `docs/NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md`。本文只记录**已实际执行并验证**的部分，
未执行/未闭合项如实标注。总状态以 `STATUS.md` 为准。

## 环境

- 仓库 HEAD `53fd85e`（main）；上游锁定 `0.2.2-rc.1` @ `fcc0ad46`。
- Node 24.9.0（合规）；下列结果为该环境下实测。
- 接手前的未提交工作未被覆盖；新增文件均为本任务产物。

## T00 基线
- `docs/native-workbench/evidence/BASELINE.md`、`STATUS.md`。

## T01 上游能力矩阵与 ADR
- `docs/native-workbench/CONTRACT-MATRIX.md`：逐能力记录公开 export/签名/角色限制/证据级别（S/A/B）。
- `docs/adr/ADR-0003-NATIVE-WEBUI-WORKBENCH.md`：原生 WebUI 作为正式底座，替代"专家辅助入口"。
- `docs/ENTERPRISE-WORKBENCH-DSH-REMEDIATION-ADDENDUM.md` 增加修订指针。

## T03 企业对象与持久存储（PARTIAL）
实现于 `packages/platform-control`：
- `store.ts`：新增 `execution_domains`、`work_session_bindings`、`submissions`、`input_baselines` 四表
  （STRICT、唯一约束、状态 CHECK）；`transaction()` 改为可嵌套（savepoint）。
- `session-bindings.ts`：`ExecutionDomainRepository`（注册/CAS 健康）、`WorkSessionBindingRepository`
  （首个绑定 primary；后续 primary 将旧 primary 降级为 reopened；fork/reopened 显式且需 sourceWorkId；
  域内 session 唯一；两域同名 session 不冲突）。
- 测试 `tests/session-bindings.test.ts`（6）。

## T04 身份与执行域访问适配（PARTIAL）
- `identity-access.ts`：`DirectoryAccessPolicy` —— 动作基线 + 跨组织拒绝 + 注入 `ProjectAccessDirectory`
  判定项目访问；service principal 不继承项目访问；目录异常按拒绝；`testAdapter` 标记测试目录。
- `policy.ts`：`Principal.orgId?`、domain/binding/submission 动作、`ResourceScope.orgId`、跨组织拒绝。
- 测试 `tests/identity-access.test.ts`（5）。
- 未闭合：`platform-identity.InMemoryAccessDirectory` 适配器与真实 SSO 未接线（NOT_RUN）。

## T05 交互提交与执行记录集成（PARTIAL）
- `submissions.ts`：`(domainId,sessionId,requestId)` 幂等、同 requestId 不同内容拒绝、
  RECORDED→ACCEPTED→CONSUMED 状态机、回执丢失保持 UNKNOWN 不自动重放、重启持久。
- `service.ts`：域/绑定/提交的服务方法与 `resolveWorkContext`；`recordSubmission` 强制
  `submittedBy === principal.actorId` 且 session 必须是该 Work 当前绑定。
- `http.ts`：`/api/domains`、`/api/domains/:id/state`、`/api/works/:id/{binding,bindings,context,submissions}`、
  `/api/submissions`（POST，submitter 由 principal 派生）、`/api/submissions/:id/{acknowledge,consume,unknown}`。
- 测试 `tests/submissions.test.ts`（5）、`tests/binding-http.test.ts`（5）。

## T06 企业导航/工作上下文（控制面部分，PARTIAL）
- `resolveWorkContext`：一次授权校验返回 work/project/workspace/app/binding/domain；深链接请求的
  sessionId+domainId 必须是该 Work 已绑定值，否则 `WORK_CONTEXT_NOT_FOUND`（404）。
- `GET /api/works/:id/context`。
- 未闭合：前端导航未切换到原生会话。

## T02 原生 Host/Client 集成包（PARTIAL）
新增 `packages/platform-workbench/`：
- `package.json`：host 半 `lib/index.js`、浏览器半 `lib/client.js`（`exports["./client"]`）、
  `dsh.client.inject` 声明原生依赖、`engines.node >=24.9`。
- `src/index.ts`：host 半，仅给 Loader 一个 host row。
- `src/client/index.ts` + `src/client/components.tsx`：注册上游已声明的 `sidebar.brand.mark` /
  `sidebar.brand.name` slot（inline SVG）；不导入私有组件、不挂第二套 React。
- `src/work-context.ts`：校验 `resolveWorkContext`、`resolveOpenTarget`（未绑定→`needs-binding`）、`isBoundDeepLink`。
- `src/api.ts`：同源 `/api/*` 客户端，非 2xx 保留控制面 code；提交意图不带 submitter。
- `build.mjs`：host/browser 分别 esbuild；React 与 `@deepseek-ai/*` external。
- 测试：work-context 6 + api 3 = **9/9**。
- **真实 profile Loader + 浏览器已验证**（证据 `evidence/T02-NATIVE-LOADER.md`、截图两张）：
  原生壳 boot graph 收录该包、`/plugins` 服务 factory、浏览器挂载零控制台错误、品牌 slot 只注册一次、
  刷新不重复且不新建会话、真实两轮同 Session（流式、已完成）。上游源码零改动。
- **Host 半新增同源控制面代理**（`src/index.ts`）：原生壳 `/platform-workbench/*` 转发到
  `PLATFORM_WORKBENCH_CONTROL_URL`；未配置返回 503、只转发白名单请求头、拒绝路径逃逸到外部 origin。
  真实验证：已配置→200（health/workbench/浏览器内 fetch），未配置→503；`/api/sessions/:id` 反向解析 Work。
- 仍**未验证**：卸载/禁用往返清理、工具活动、停止结算、断网重连。

## T07 输入批次（数据层，PARTIAL）
- `input-baselines.ts`：按 Work 追加 revision，旧基线不重写；`store.ts` 新增 `input_baselines` 表。
- 测试 `tests/input-baselines.test.ts`（2）。成果视图/前端未做。

## T08 本地与集中部署装配（PARTIAL）
- `src/workbench-deploy.ts`：两形态校验；`assertNoSecretInUrl` 拒绝含凭据/query 的 URL；`originAllowed`
  只允许白名单 Origin。测试 `tests/workbench-deploy.test.ts`（4）。
- `scripts/native-workbench-deploy.cjs`：参数化生成已验证部署描述（local/hosted），复用编译后校验器。
- `scripts/native-workbench-start.cjs`：local 启动单一控制进程；hosted 只允许 `--role control` 启动
  一个权威控制进程并拒绝共用 store。
- **真实运行证据**：
  - local 部署启动后 `GET /api/health` → 200，`GET /api/workbench` → 200 bootstrap。
  - 种子服务器全链路 10/10：项目/空间/工作 → 域 → 绑定会话(primary) → 解析上下文 → 外部深链接 404 →
    提交(RECORDED) → 重复提交幂等 → 应答(ACCEPTED) → 消费(CONSUMED) → 列表 1 条。
- 未闭合：集中形态的 HTTP/WS 反向代理入口、两个独立域实例、撤权后流撤销（NOT_RUN，需真实部署环境）。

## 本轮验证结果（Node 24.9.0）

- `platform-control`：typecheck 通过，**95/95** 测试通过，build 成功。
- `platform-workbench`：typecheck 通过，**15/15** 测试通过，build 成功（host+browser，client 为原生 factory）。
- `node scripts/verify-all.cjs`：**13/13 通过**。
- `node scripts/check-development-standard.mjs`：PASSED。

## 明确未做（不写成已完成）

- T02：卸载/禁用往返清理、工具活动、停止结算、断网重连；“打开工作” UI 入口（依赖 T06 导航）。
- T06：前端导航切换到原生会话。
- T09、T10、T11（NW01–NW24）未开始。
- 未提交、未推送、未改生产 profile。

## 回退限制

- 新增四张表为附加迁移（`CREATE TABLE IF NOT EXISTS`），不改变已有表结构；旧库打开后自动补建。
- 未提交、未推送、未改动生产 profile。
