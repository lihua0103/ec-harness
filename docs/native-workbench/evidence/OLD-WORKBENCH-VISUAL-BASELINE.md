# 旧企业工作台视觉基线（2026-11-12）

目的：在重建企业外壳前冻结被用户认可的旧页视觉，作为新原生化工作台的对照基线。
服务：`node scripts/preview-enterprise-workbench.cjs`（默认 `127.0.0.1:3081`，只读原型资产）。
截图与度量：`evidence/old-baseline-*.png`、`evidence/old-baseline-metrics.json`（1440×900，Edge headless）。

## 截图

| 页面 | 文件 | 说明 |
|---|---|---|
| 首页 / AI 工作区 | `old-baseline-home.png` | 白色 232px 侧栏、纸色主区、大标题、composer 卡片、310px 右侧资料栏 |
| 项目空间 | `old-baseline-projects.png` | 项目卡片网格、目录/批次事实 |
| 新建工作 | `old-baseline-new-work.png` | 当前应用卡、类型分段、composer、示例建议 |
| 工作详情 | `old-baseline-work-detail.png` | 工作标题/元信息/状态、方案卡、补充 composer、右侧上下文 |

## 设计 tokens（从 `prototypes/enterprise-workbench/styles.css` 抽取）

### 色板

| Token | 值 | 用途 |
|---|---|---|
| ink | `#173f4b` | 主文字、标题、深色 toast |
| muted | `#657b83` | 次要文字、说明 |
| primary | `#004b61` | 主按钮、链接、激活导航 |
| green | `#087b60` | 成功/业务强调 |
| paper | `#f4f7f8` | 页面底色 |
| line | `#dfe8eb` | 边框/分隔 |
| soft | `#edf5f4` | 悬停/弱底 |
| white | `#ffffff` | 卡片/侧栏/顶栏 |
| amber | `#895b17` | 注意/未接入 |
| danger | `#a6424b` | 错误 |
| focus | `#13866f` | 键盘焦点环 |

### 字体与字号

- 字体：`"Segoe UI", "Microsoft YaHei", DengXian, sans-serif`；根字号 14px；行高 1.65。
- 层级：h1 27px（欢迎页 29px，宽屏 32px，`letter-spacing:-.4px`）；h2 18px；h3 14px；
  正文 13–14px；次要 12px；标签 10–11px；small 11px。
- 焦点：`outline: 3px solid #13866f; outline-offset: 3px`。

### 尺寸 / 间距 / 圆角

| 元素 | 度量 |
|---|---|
| 侧栏 | 宽 232px；padding 28px 17px 0；白色；右边框 1px `--line` |
| 顶栏 | 高 65px；padding 0 30px；白色；下边框 1px `--line` |
| 主区 | 工作区双栏 `minmax(0,1fr) 310px`；会话区 padding 29px 34px 22px |
| 卡片 | 白底、1px `--line`、圆角 8–9px、padding 19–25px |
| 主按钮 | 高 37px、padding 8px 14px、圆角 6px、字重 600 |
| 新建工作按钮 | 高 43px、圆角 8px、底色 `#f8fcfb`、边框 `#bfd7d6` |
| 导航项 | padding 11px 13px、圆角 7px、13px；激活背景 `#e7f3ef` |
| 输入/下拉 | 边框 `#cbdcde`、圆角 6px、padding 10px 12px |
| 徽标 | 10px、padding 3px 8px、圆角 4px |
| 栅格间距 | 首页/工作区 gap 20px；列表行 padding 12–17px |

### 交互与状态

- 悬停：白底转 `#f4faf7` 或 `#fbfdfc`；导航 `#f4f8f8`。
- 空状态：虚线卡片或居中说明，不隐藏区块。
- 暗色：旧页无暗色；新页按同一色相提供暗色 token（见 `styles.ts` `prefers-color-scheme: dark`）。
- 窄屏：≤1150px 侧栏 210px、右栏 270px；≤760px 侧栏抽屉、单栏、按钮全宽。

## 新页如何对齐

`packages/platform-workbench/src/client/styles.ts` 使用同一组色板与层级（`--ec-ink/--ec-paper/--ec-primary/--ec-green/--ec-line`），
并把旧页的 65px 顶栏、232px 侧栏视觉、310–340px 右栏、9px 卡片圆角、12–13px 标签、3px 焦点环映射到 `.ec-wb-*`。
所有规则仍作用域在 `.ec-wb` 下，卸载插件即移除。

## 上游契约限制（必须如实记录）

- 上游 `sidebar` 是 **single slot**，已由 `ui-sidebar` 注册；再次注册会抛
  `single slot "sidebar" already has a registration`（`ui-slots/src/index.ts:1256`）。
  因此**插件不能整体替换左侧栏**，只能用其声明的洞：
  `sidebar.brand.mark/name`、`sidebar.panellist`（全局面板行）、`sidebar.panellist.actions`、
  `sidebar.settings`、`sidebar.footer.action`。
- `sidebar.workspaces` 同样是 single slot，由 `ui-workspace` 占据；浏览器会话列表无法被替换或按工作过滤。
- 结论：新页把企业导航做成 `sidebar.panellist` 的五行（项目空间/应用中心/我的工作/待处理/平台设置），
  并把默认 main 切到「我的工作」；**原生会话列仍由 ui-workspace 渲染**，无法在不改上游的前提下隐藏或按工作分组。
  这是与“完全替换侧栏”的已知差距，不是本页样式可以修补的部分；如需彻底替换，必须先获得上游公开接缝或修改上游（当前禁止）。
