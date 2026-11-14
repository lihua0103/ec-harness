# T06 企业工作台整页（原生插件模式）验证证据

时间：2026-11-12。环境：Node 24.9.0；上游 `0.2.2-rc.1` @ `fcc0ad46`（**源码零改动**，`git status` 0 项）。
隔离开发 profile：`.runtime/nw-web-home/profiles/web`。

## 架构（为什么用插件模式，且这才是正确形态）

- 原生壳 `main` 是 **keyed slot**：保留键 `conversation` 放原生会话，**其他键可放插件自己的整页**。
  `apps/enterprise-workbench` 的轮询前端正是要由这个整页取代。
- `sidebar.panellist` 注册「工作台」导航入口，点击 `ctx.layout.selectPanel(id)` 切到整页。
- 页面数据走同源 `/platform-workbench/api/*`（宿主半代理到平台控制面）。
- 「打开工作」调用 `ctx.uiWorkspace.openSession(sessionId)`，直接进入**原生流式会话**，不另起聊天。

## 验证结果（PASS）

| 检查 | 结果 |
|---|---|
| 左侧出现「工作台」导航入口 | PASS：`sidebar.panellist` 渲染，可点击 |
| 整页渲染企业信息架构 | PASS：我的工作 / 项目 / 应用 / 待处理 四区，数据来自控制面 |
| 数据真实（非假数据） | PASS：显示真实项目「临床数据项目」、工作「季度方案整理」、应用 `ec.synthetic.probe@1.0.0` |
| 未绑定工作如实提示 | PASS：点未绑定的工作显示「此工作尚未关联原生会话」，不静默新建 |
| 绑定后「打开工作」进入原生会话 | PASS：切到绑定的原生会话「工作台平台连通性检查」，composer、流式回复、用量统计齐全 |
| 同一会话唯一绑定 | PASS：把已绑定会话再绑给另一个 Work 返回 409 `BINDING_SESSION_CONFLICT` |
| 反向 session→Work 解析 | PASS：`/platform-workbench/api/sessions/<sid>` 返回对应 Work |
| 未修改上游源码 | PASS：上游 `git status` 0 项 |

截图：`t06-workbench-panel.png`（工作台整页）、`t06-workbench-panel-bound.png`（绑定后）。

## 与旧实现的区别

- 旧 `apps/enterprise-workbench`：独立 ESM 页 + 2s 轮询 + 整体重绘，没有原生流式/队列/停止。
- 新整页：会话区就是原生会话本身（真实流式、工具活动、队列、停止、刷新恢复都由原生提供），
  企业侧只负责导航、工作上下文和成果入口。

## 仍未验证（如实）

- 成果/文件视图、运行历史在本整页内的完整交互（T07 前端）。
- 待处理队列在真实 `WAITING_FOR_USER` 运行下的端到端展示（本轮种子数据无等待项）。
- 集中部署、非 owner 问答/审批仍 BLOCKED。
- 旧 `apps/enterprise-workbench` 的退役与历史迁移属 T10，尚未执行。
