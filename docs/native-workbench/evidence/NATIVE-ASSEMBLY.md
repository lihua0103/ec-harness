# 原生装配证据：企业工作台作为 DSH 插件加载（2026-11-12；2026-11-13 修订为单页嵌入形态）

结论：企业工作台是 `@ec-clinical/platform-workbench` 的 **dsh.client / Host 双半插件**，由隔离 profile 的
Loader row 装配进 DSH 原生 WebUI；没有独立 Web 应用、没有 iframe、没有从插件启动独立服务。
`apps/enterprise-workbench` 只作为视觉/IA 基线，文件保留不动，插件运行时不引用它。

**2026-11-13 修订**：打开工作不再切页到原生 `conversation` —— 原生会话能力以 `variant:'embedded'`
嵌入平台整页内（单页形态）；`selectPanel(null)` 两页切换与「返回工作台」头部动作退役。
下文 §2/§3/§3.1 中描述两页切换的表述已按当前实现更新；标注「A 方案阶段证据」的为历史记录。

## 1. 装配配置片段（实际使用）

隔离 profile：`.runtime/nw-web-home/profiles/web`（不进 git，不是生产 profile）。

`profiles/web/package.json`：

```json
{
  "name": "dsh-profile-web-nw",
  "private": true,
  "dependencies": {
    "@ec-clinical/platform-workbench": "link:D:/project/company/ec-clinical-dsh/packages/platform-workbench"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
```

`profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: ec-platform-workbench
      name: "@ec-clinical/platform-workbench"
```

`packages/platform-workbench/package.json`：

```json
{
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-workspace"
      ],
      "platform": "web"
    }
  }
}
```

## 2. 加载方式

- **Host 半**：Loader 读取 `insert` 行，加载包根 `./lib/index.js`；该 half `inject: ['webServer']`，
  在原生 webserver 上注册 `/platform-workbench` 前缀 **handler** 路由，只代理到
  `PLATFORM_WORKBENCH_CONTROL_URL`（白名单请求头、同源写校验、路径/体积校验）。它不是独立服务。
- **Client 半**：`dsh.client` 声明使原生壳把 `./client` 构建成 `window.__ModuleLoader__.load({ id, factory })`
  工厂；React 与 `@deepseek-ai/*` 全部由宿主模块表提供（不打包第二份 React）。浏览器内 `inject` 为
  `['slots', 'layout', 'sessions']`（2026-11-13：不再注入 `uiWorkspace` —— 单页形态不再依赖工作区导航）。
- **页面**：只注册**一个** keyed `main` 页（`emerald-platform`），页面内部渲染左侧企业导航
  （项目空间/应用中心/我的工作/待处理/平台设置）+ 主内容 + 右侧上下文/成果；另注册一个
  `sidebar.panellist` 入口与品牌槽。
- **原生会话（单页嵌入）**：页面声明子 slot `workbench.session`（`scope:'session-maybe'`），其条目
  `EmbeddedSessionHost` 宿主上游 `conversation.content` 工厂的 `variant:'embedded'` 变体（无主 Header）。
  打开工作时插件**自持**该 Work 绑定 Session 的 `SessionReference`（`ctx.sessions.retain(id, {source:'platformWorkbench'})`，
  经 `SessionReferenceSourceMap` 模块扩充声明），把引用交给标准套件 `<SessionProvider session={reference}>`
  ——即上游右栏 Sidebar 会话视图的显式作用域模式；作用域绑定到该引用本身，**不触碰主视图选举**
  （粘性选举归 `ui-workspace` 导航所有，`mainView` retain 配方在此不可用，见 STATUS.md T13）。
  流式/工具/队列/停止/问答/刷新恢复均由原生会话栈提供；企业提交关联经同一插件保留引用上的
  持久事件窗观察（`submission-observer.ts`），不拦截 composer。离开会话视图或插件卸载时释放引用。
- **首屏**：插件启动时 `ctx.layout.selectPanel('emerald-platform')`，并在本浏览器首次装配时
  `ctx.layout.toggleSidebar()` 收起原生侧栏，让平台页占据主列；手动展开后不会被再次收起（本地标记）。

## 3. 浏览器实测（17/17 PASS；A 方案阶段证据，流程部分已被 §3.2 取代）

`evidence/t12-a-shell-browser.json`：

- 只有一个插件页面节点；平台页宽 1384px（1440 视口），首屏即企业首页。
- 内部企业导航五入口存在且可切换；无 iframe。
- 网络请求包含 `@ec-clinical/platform-workbench/client.js`；**没有任何 `apps/enterprise-workbench`、
  `prototypes/enterprise-workbench` 或 `/src/app.mjs` 请求**。
- 打开绑定工作后进入原生 conversation；会话头部出现「返回工作台」，点击回到平台页。
  （A 方案阶段证据；当前单页形态下打开工作不切页，嵌入在平台页内，见 §3.2。）

截图：`t12-a-shell-home.png`、`t12-a-shell-projects.png`、`t12-a-shell-apps.png`、
`t12-a-shell-pending.png`、`t12-a-shell-settings.png`、`t12-a-shell-conversation.png`、
`t12-a-shell-returned.png`。

### 3.2 单页嵌入形态浏览器实证（2026-11-13，当前实现）

`evidence/EMBEDDED-SESSION-EXPLICIT-SCOPE-E2E.png`（修复显式作用域后复验）：

- 企业外壳在位；打开工作后**平台页内**出现会话条（工作标题 + 「← 返回」）与嵌入会话体，
  `data-ec-embedded-session` 与 `data-conversation-session` 均为绑定 Session（`session-297c5d3b…`）。
- 经嵌入 composer 真实发送：流式回复写入绑定会话（约 8s），无第二次聊天协议、无 iframe。
- 控制面 Submission `b23cf010-c89c-4842-b036-124e8054c172` 状态 **CONSUMED**、会话字段正确；
  绑定前的 seed 历史（A-SHELL-T12）保留不回填。
- 导航路径：返回工作列表（嵌入卸载、7 行工作）→ 详情 → 打开会话 → 「← 返回工作详情」回详情。
- 0 控制台错误。
- 注：本次 E2E 从 upstream checkout 目录启动 `dsh web` 在上游工作区留下未跟踪 `web/` 生成物，
  使 dm-listing 溯源检查（`UPSTREAM_WORKTREE_DIRTY`）失败；已删除生成物后 `verify-all` 复验 **13/13**。

## 3.1 平台页全宽布局（2026-11-12 用户确认）

- 平台页激活时，插件隐藏原生 `sidebar` 列并把布局网格第一列归零，平台页从 x=0 占满 1440px；
  **单页嵌入形态下打开工作不离开平台页**，故会话期间侧栏保持隐藏；仅当另一 `main` 面板接管
  （或插件卸载）时恢复原生侧栏（原 inline 样式），回到平台页再次隐藏。
- 这是一段**受控、可逆的布局模式**：通过原生侧栏的 toggle 按钮定位其列与布局 frame，保存原始
  `display`/`gridTemplateColumns` 后临时覆盖，插件卸载/离开平台页时恢复；结构不匹配时退回图标轨，
  不抛错。它使用上游私有 DOM/网格结构，**升级上游后必须复验**。
- 实测（8/8）：`evidence/RETIREMENT-SHELL-TRANSITION.json`；截图
  `RETIREMENT-POST-SWITCH-NATIVE-FULL.png`、`RETIREMENT-CONVERSATION-RESTORED.png`、
  `RETIREMENT-RETURNED-FULL.png`。

## 4. 边界（上游所有，插件不改）

- 原生 `sidebar` 容器与 `conversation` main 键由上游拥有；插件不能替换，也不需要替换。
- 原生侧栏在收起状态仍显示上游图标轨；平台页内部导航是产品导航主体。
- `apps/enterprise-workbench` 仅作视觉/IA 基线：不 iframe、不引用其运行时、不从中启动服务；
  文件保留，退役待用户确认。

## 5. 复现

```bash
# 控制面（隔离 home，合成种子）
cd packages/platform-control
DSH_HOME=../../.runtime/nw-web-home node --import tsx/esm src/api-cli.ts --port 3096 --seed

# 原生 web（隔离 profile，加载插件）
cd upstream/deepseek-harness-git
DSH_HOME=../../.runtime/nw-web-home PLATFORM_WORKBENCH_CONTROL_URL=http://127.0.0.1:3096 \
  node --import tsx/esm ../../scripts/dsh-web-launcher.cjs web --host 127.0.0.1 --port 3095
```

注意：web 启动会在 upstream checkout 工作区生成未跟踪 `web/` profile 工作区（`dsh-profile-web`），
运行结束须删除，否则 dm-listing 发布溯源检查报 `UPSTREAM_WORKTREE_DIRTY`、`verify-all` 失败
（2026-11-13 实测复验）。

门禁（2026-11-13 单页嵌入形态复验）：platform-workbench **45/45**、`verify-all` **13/13**、
开发规范 **PASSED**；browser E2E 见 §3.2。
