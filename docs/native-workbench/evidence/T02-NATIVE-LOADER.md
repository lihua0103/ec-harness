# T02 原生 WebUI 集成：真实装配与浏览器验证证据

时间：2026-11-12。环境：Node 24.9.0；上游 `0.2.2-rc.1` @ `fcc0ad46`（**源码零改动**，`git status` 0 项）。
隔离开发 profile：`.runtime/nw-web-home/profiles/web`（不进 git，不触碰生产 home）。

## 装配方式（不改上游）

- `packages/platform-workbench` 声明 `dsh.client`（平台 web + 注入 renderer/sidebar/conversation/workspace），
  导出 `./client`。
- 浏览器半由 `build.mjs` 编译成**原生 client-module factory**：
  `window.__ModuleLoader__.load({ id: "@ec-clinical/platform-workbench", factory: (require) => ... })`；
  React 与全部 `@deepseek-ai/*` 通过 factory 的 `require` 由宿主模块表提供，**不打包第二份 React**。
- profile 通过 `cordis.patch.yml` 的 `insert` 行加载该包（client 插件是 Loader row，不是 bundle）。

## 验证结果（PASS）

| 检查 | 结果 |
|---|---|
| 原生壳 boot graph 收录该包 | PASS：`<script>` 启动图含 `@ec-clinical/platform-workbench` |
| `/plugins` 服务其 factory | PASS：combo 200，body 含 `__ModuleLoader__.load` 与包 id |
| 浏览器挂载、零控制台错误 | PASS：brand slot 渲染 “EMERALD 企业 AI 工作台”，无 error/warning |
| 品牌 slot 只注册一次 | PASS：`svg[aria-label=EMERALD]`=1 |
| 刷新不重复挂载、不新建会话 | PASS：刷新后 mark=1、会话列表仍为同一会话 |
| 真实两轮同 Session | PASS：第一轮“收到”，第二轮回忆上下文再答“收到”，同会话、流式、已完成 |
| 同源控制面代理 | PASS：原生壳 `/platform-workbench/api/health`→200；`/api/workbench`→200（种子应用可见）；浏览器内 fetch 同源 200 |
| 反向会话→Work 解析 | PASS：`/platform-workbench/api/sessions/<已绑定>` 返回 work/binding；未知 session 返回 null |
| 未配置控制面 | PASS：未设 `PLATFORM_WORKBENCH_CONTROL_URL` 时该前缀如实返回 503 `CONTROL_PLANE_UNCONFIGURED`（不伪造 API） |
| 未修改上游源码 | PASS：上游 `git status` 0 项，HEAD 仍为锁定 commit |

截图：`t02-native-brand.png`（品牌 slot）、`t02-native-two-rounds.png`（两轮对话）。

## 仍未验证（如实）

- **卸载清理 slots/连接**：未做 enable/disable 往返测试。
- **工具调用活动、停止结算、断网重连**：本轮未执行（窗口时间与凭据成本）。
- **集中模式非 owner 问答/审批**：上游 README 明确 owner-only，仍为 BLOCKED，见 CONTRACT-MATRIX §2。
- 本验证使用 `.runtime/nw-web-home` 隔离 profile 与既有 ZAI 路由；不是企业 SSO 或生产部署验收。

## 复现

```bash
node -e "..."   # 见 IMPLEMENTATION 记录：写入隔离 profile 后
# 启动：DSH_HOME=.runtime/nw-web-home，cwd=upstream，dsh web --host 127.0.0.1 --port 3095
```

（grep 浏览器验证脚本见 `.runtime/nw-web-probe*.cjs`，不进 git。）
