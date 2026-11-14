# 企业外壳重建实现记录（2026-11-12）

> **最终形态（A 方案，用户 2026-11-12 已确认）**：只保留一个 keyed `main` 页 `emerald-platform`，页面内部渲染
> 左侧企业导航 + 主内容 + 右侧上下文/成果；插件启动选中该页并收起原生侧栏；打开工作切到原生
> `conversation`，会话头部注册「返回工作台」。装配与边界见 `evidence/NATIVE-ASSEMBLY.md`，
> 浏览器 17/17（`evidence/t12-a-shell-browser.json`）。下面第 2 节保留首版的“五个 keyed 页”记录，已被本形态取代。

方向变更（用户已确认）：照旧 `apps/enterprise-workbench` / `prototypes/enterprise-workbench` 的布局与视觉，
把企业工作台重建为**企业外壳主导**的形态，而不是原生壳里的附属面板。本文件只记录实际执行并验证的部分。

## 1. 视觉基线冻结

- 服务：`node scripts/preview-enterprise-workbench.cjs`（`127.0.0.1:3081`）。
- 截图：`evidence/old-baseline-home.png`、`old-baseline-projects.png`、`old-baseline-new-work.png`、
  `old-baseline-work-detail.png`；度量：`evidence/old-baseline-metrics.json`。
- tokens 抽取与对照：`evidence/OLD-WORKBENCH-VISUAL-BASELINE.md`。
- 关键值：ink `#173f4b`、paper `#f4f7f8`、primary `#004b61`、green `#087b60`、line `#dfe8eb`；
  侧栏 232px、顶栏 65px、右栏 310px、卡片圆角 8–9px、正文 13–14px、焦点环 3px。

## 2. 企业外壳（首版：五个 keyed 页；已被 A 方案取代）

`packages/platform-workbench/src/client/index.ts`：

- 五个 `sidebar.panellist` 入口：**项目空间 / 应用中心 / 我的工作 / 待处理 / 平台设置**；
  每个入口对应一个 keyed `main` 页（`emerald-projects|apps|works|pending|settings`）。
- 启动时若 `layout.panelInfo.activePanelId === null`，自动选择「我的工作」；**首屏是企业首页**，不是裸聊天。
- 品牌槽更新为 `EMERALD 企业 AI` + 内联 mark。
- 「打开工作」仍走 `ctx.uiWorkspace.openSession`，`conversation` 保留键不变；不实现第二套聊天。

`WorkbenchPage.tsx`：

- **我的工作**：旧页式 hero（“今天，需要 AI 协助什么工作？”）、按项目分组的工作列表、项目/待处理/模型/平台状态侧栏。
- **项目空间**：项目卡片网格 + **新建项目**表单 + 工作空间列表 + 登记空间。
- **应用中心**：平台发布的应用卡片（可用/已撤销）。
- **待处理**：真实 PENDING 问题列表，点入工作详情定位该运行。
- **平台设置**：默认模型、模型目录、执行状态。
- **工作详情**：旧页式头部/状态/操作、左栏草稿/发起运行/运行历史/问答，右栏工作上下文/成果版本/输入批次/执行输入。
- 视觉：`styles.ts` 使用旧页色板与层级；所有规则作用域在 `.ec-wb`；暗色、窄屏、紧凑、减少动效显式。

## 3. 上游契约限制（必须如实记录）

- `sidebar` 是 **single slot**，已由 `ui-sidebar` 注册；再次注册抛
  `single slot "sidebar" already has a registration`。
- `sidebar.workspaces` 同为 single slot，由 `ui-workspace` 占据；**原生会话列不能替换、不能按工作过滤**。
- 因此“整体替换左侧导航、会话按工作分组、测试会话不混入”只能做到：
  - 企业导航用 `sidebar.panellist` 五行；
  - 默认 main 为企业首页；
  - 工作页按项目/工作分组，会话只从绑定工作进入；
  - 原生侧栏的会话列表仍由 ui-workspace 渲染（无法在不改上游的前提下隐藏）。
- 右侧上下文：放在企业工作详情的右栏（旧页布局）；未在原生会话内新增右栏，因为那需要替换
  `conversation`/`sidebar.workspaces` 或修改上游布局。若必须“会话内右栏”，需上游公开接缝或授权修改上游。

## 4. 三项能力缺口（已补齐）

| 能力 | 实现 | 正/负验证 |
|---|---|---|
| 新建项目 | `POST /api/projects` + 项目空间表单 | 浏览器：空名称禁用、创建后出现在列表；API：创建成功/403 保留 code |
| 取消运行 | `POST /api/runs/:id/cancel`（带 revision） | 浏览器：创建 QUEUED 运行→请求停止→已取消；API：终态 409 `RUN_TERMINAL` 保留 |
| 重试运行 | `POST /api/runs/:id/retry`（可选模型） | 浏览器：取消后重试生成第二条运行；API：终态/模型参数 |
| 对账 UNKNOWN | `POST /api/runs/:id/reconcile` | 浏览器：非 UNKNOWN 时按钮禁用（负例）；API：确认后才释放 |
| 归档工作 | `POST /api/works/:id/archive` | 浏览器：归档后显示“已归档”；归档后发起运行被禁用 |

浏览器实测（21/21 PASS）：`evidence/t12-shell-browser.json`、
`t12-shell-home.png`、`t12-shell-projects.png`、`t12-shell-apps.png`、`t12-shell-work-detail.png`、
`t12-shell-run-ops.png`、`t12-shell-archived.png`、`t12-shell-pending.png`、`t12-shell-settings.png`。

## 5. 门禁

- `platform-workbench` verify：typecheck + build + **45/45** 测试（新增 project/run/archive API 正负用例）。
- `platform-control` verify：**106/106**。
- `verify-all`：13/13；开发规范：PASSED（以本轮实际输出为准，见 STATUS）。
- 上游 `git status`：0 项；未提交、未推送、未删除旧入口。

## 6. 仍未做

- 原生侧栏会话列替换/按工作过滤（上游 single slot 限制）。
- 原生会话内右栏（同上）。
- 退役/正式迁移：按 `RETIREMENT-PLAN-2026-11-12.md`，需用户明确确认。
- 真实 SSO/撤权/集中域（NW11–NW14、NW20 仍 BLOCKED）。
