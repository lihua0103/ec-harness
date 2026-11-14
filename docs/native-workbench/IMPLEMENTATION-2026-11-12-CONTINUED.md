# 本轮续跑实现记录（2026-11-12）

对应任务书 `docs/NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md` 的 T07/T09/T10/T11。
本文只记录**实际执行并验证**的部分；总状态以 `STATUS.md` 为准。

## 环境

- 仓库 HEAD `53fd85e`；上游 `0.2.2-rc.1` @ `fcc0ad46`（源码零改动）。
- Node 24.9.0；隔离 profile `.runtime/nw-web-home`；控制面 `.runtime/nw-t07-home` 合成数据。
- 未提交、未推送、未改生产 profile。

## T07 成果、输入批次与业务版本

控制面：

- `service.ts` 新增 `inputBaselinesForWork` / `appendInputBaseline`；新增动作 `work.input`
  （operator 可用，service principal 拒绝）。
- `http.ts` 新增 `GET/POST /api/works/:id/input-baselines`；GET 分页、POST 追加，归档工作 409。
- `migration.ts` / `index.ts` 导出迁移盘点（T10）。
- 测试：`tests/work-inputs-http.test.ts`（3）：空状态与倒序分页、非法摘要/未知工作/归档、
  service principal 越权拒绝。

集成包：

- `src/api.ts`：新增 `workRuns`、`workInputBaselines`、`runArtifacts`、`runInputs`；
  默认 `fetch` 在构造时绑定 `globalThis`（修复浏览器 `Illegal invocation`）。
- `src/reports.ts`：分页窗口、成果封存摘要、下载路径（拒绝 `.`/`..`）、运行状态标签、字节格式化。
- `WorkbenchPage.tsx`：工作详情含运行历史、成果（封存/未封存、摘要、大小、下载）、
  本次执行输入、Work 级输入批次；各自分页与空状态；错误码 + 重试。
- `index.ts`：同源代理转发 `content-disposition`/`content-length` 等下载所需响应头，仍不转发内部头。
- 测试：reports 5、api 5、ux 契约 3、host 代理 6、bundle 2、work-context 6 → 共 26。

## T09 UX、可访问性与异常恢复

- `src/client/styles.ts`：`.ec-wb` 作用域；宿主 `--dsw-*` token + 可读回退；暗色、窄屏单列、
  紧凑密度、`:focus-visible`、`prefers-reduced-motion`；无 fixed 定位。
- `index.ts` 用 `ctx.effect` 注入 `<style>` 并在卸载时移除；不触碰原生聊天样式。
- 页面：语义 heading/region、`role="status"` 通知、进入详情聚焦标题、每段独立重试、
  读取失败保留控制面 code；紧凑开关在列表与详情都可切换并持久化本地偏好。
- 未修改原生聊天算法、composer、队列或流式实现。

## T10 历史迁移与入口切换

- `src/migration.ts` + `scripts/native-workbench-migrate.cjs`：只读盘点控制面库与浏览器 v4/v3 记录；
  缺失= MISSING、损坏= UNREADABLE、未知记录= unknown；`--apply` 明确拒绝。
- 测试 `tests/migration.test.ts`（7）。
- dry-run 证据：`evidence/MIGRATION-DRYRUN-2026-11-12.json`；说明 `MIGRATION-2026-11-12.md`。
- 未做：正式写入、旧入口退役、回退演练（前置条件已列明）。

## T11 全链路验证

- 矩阵与结果：`ACCEPTANCE-2026-11-12.md`（10 PASS / 9 NOT_RUN / 5 BLOCKED）。
- 原生会话浏览器验证：两轮上下文、长输出增量、工具轨迹、输入同时输出、停止与继续、刷新恢复、
  排队提示与排队轮执行、原生壳未回归。
- 证据：`evidence/nw01-nw07-browser.json`、`nw02-nw06-browser.json`、`nw04-browser.json`、
  `t07-t09-browser.json` 及截图。
- 未跑项已标明原因，不把源码阅读或单元测试写成执行 PASS。

## 本轮验证结果（Node 24.9.0）

- `platform-control`：typecheck 通过，**105/105** 测试通过，build 成功。
- `platform-workbench`：typecheck + build 通过，**26/26** 测试通过。
- `node scripts/verify-all.cjs`：**13/13** 通过（包、工具与原型分别计数）。
- `node scripts/check-development-standard.mjs`：PASSED。

## 明确未做（不写成已完成）

- T10 正式迁移、旧入口退役、回退演练。
- T11 的 NOT_RUN/BLOCKED：集中域、真实身份/撤权、非 owner 问答审批、业务切片、
  Host 重启、写锁竞争、卸载往返、跨域切换。
- 业务审核绑定与 Listing/DVP 专属验收。

## 回退限制

- 新增表/接口均为附加；旧库打开自动补建，不改变已有表结构。
- 新增页面样式只作用于 `.ec-wb`，卸载时移除。
- 未提交、未推送、未改生产 profile。
