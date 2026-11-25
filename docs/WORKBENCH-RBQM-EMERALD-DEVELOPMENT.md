# DSH 员工工作台：RBQM 翡翠绿版开发说明

**交付对象：** 工作台前端、设计复核、QA。**目标：** 在现有方案 B 研究工作桌上准确实现 RBQM Emerald 的色彩层次，不重写页面，不动中间原生会话。本文规定选择翡翠绿方案时如何开发；不表示已批准切换生产默认主题。

| 评审入口 | 用途 |
|---|---|
| [12 号：首页、工作索引与底稿](../prototypes/enterprise-workbench/visual-study/12-rbqm-emerald-desk.png) | 浅色环境的视觉参照：双深栏、明亮资料面、单个渐变主动作。 |
| [13 号：会话页与运行资料](../prototypes/enterprise-workbench/visual-study/13-rbqm-emerald-session.png) | 同一外壳，中心由宿主提供。不能按截图重画聊天内容。 |
| [方案 B 总开发计划](WORKBENCH-INDEX-DESK-DEVELOPMENT-PLAN.md) | 继续采用其业务、路由、授权、响应式和验收合同；仅当实施本方案时，本文色值替代总计划的夜蓝色值。无需先实现夜蓝版，也不引入双主题切换器。 |
| [开发规范](DSH-PLUGIN-DEVELOPMENT-STANDARD.md) / [单侧栏合同](WORKBENCH-SINGLE-SIDEBAR-ARCHITECTURE.md) | 宿主基准 `0.2.2-rc.1`；员工侧栏是一套全局导航，工作索引不是第二套项目导航。 |

## 1. 开工基线：已经有什么，具体差在哪

2026-11-22 核对的是**当前工作树**。总计划中的部分「拟建」文件已经存在。以下差距是源码核对结果，不是运行态截图结论；不要据此覆盖其他会话的未提交工作。

| 位置 | 当前实现 | 本次改动 |
|---|---|---|
| [styles.ts](../packages/platform-workbench/src/client/styles.ts) | 已有 `--ec-rail-*`、`--ec-index-*` 和正文 token；如导航 `#0E3A44`、索引 `#0F434E`、主色 `#0C7368`、纸色 `#F6F9FA`。`WORKBENCH_CSS = BASE_CSS + DESK_CSS`。 | 修订现有 token，分离「平面色」与「渐变背景图」；不写第二套全局 stylesheet，不以源文件注释里的 Emerald 名字代替验色。 |
| [desk-styles.ts](../packages/platform-workbench/src/client/desk-styles.ts) | 索引列、窄屏索引、筛选浮层都读 `--ec-index-bg`；主动作已有 `.ec-wb-brief-enter`；容器断点已有。 | 仅导航表面和主动作使用渐变。弹层留实底，避免无意间每个下拉框都出现相同渐变。处理窄屏和暗色的最终级联。 |
| [sidebar-nav.tsx](../packages/platform-workbench/src/client/sidebar-nav.tsx)、[work-index.tsx](../packages/platform-workbench/src/client/work-index.tsx) | 全局导航和工作索引分别已有 owner；索引行用 `aria-current`，搜索与筛选、有折叠和抽屉态。 | 通常不改 TSX。确需区分视觉角色时，只在插件自有节点新增 class；不要改事件、焦点管理、路由命令或添加重复 CTA。 |
| [work-brief.tsx](../packages/platform-workbench/src/client/work-brief.tsx)、[work-desk-frame.tsx](../packages/platform-workbench/src/client/work-desk-frame.tsx) | 摘要已有选中 Work 的 runs、artifacts、events 请求、进入动作和封存下载；框架已有结构。 | 按现有加载、空、失败、归档和正常分支设色。不能为凑 12 号稿增加某条待复核事项、一个假文件或额外请求。 |
| [WorkbenchPage.tsx](../packages/platform-workbench/src/client/WorkbenchPage.tsx)、[client/index.ts](../packages/platform-workbench/src/client/index.ts) | 企业壳通过插件 effect 装配，`SessionProvider`、`workbench.session`、`WorkConsole` 与原生视图共同工作。 | 仅核对，默认零改动；原生标签、消息、队列、输入框、提示条、Session 引用与恢复行为均排除在主题工程之外。 |

**验收优先级：** 原生会话与真实业务行为 > 可读性/可访问性 > 12/13 号稿的表面与层次 > 像素细节。例如：截图中的「＋」不能成为新增全局创建路径。样稿内有文件内容示意，而真实界面只能依据已授权元数据绘制通用封面，不得读取临床文件生成缩略图。

## 2. 色值的来源与移植规则

只读参照 RBQM 仓库的 `RBQM-web-front-end/src/style/index.scss:128–185`（亮色）、`:187–230`（暗色）、`:241–250`（主按钮），以及 `RBQM-web-front-end/src/layout/theme/index.ts:22–32`（菜单、选中侧标）。[试色脚本](../prototypes/enterprise-workbench/visual-study/render_rbqm_trial.py)保留了映射。**不复制 RBQM 全局 SCSS，不依赖 Element Plus，不在 `html` 上写 RBQM 主题属性，不修改 RBQM 仓库。** 样稿中的第二列深索引是 DSH 的应用方式，不是声称 RBQM 本身有两套全局侧栏。

### 2.1 默认主题（深导航、浅工作面）

下表中已有 token 原位调整；标为「新增」的是建议的插件私有变量，不是上游 DSH 接口。

| 角色 | token 或样式位置 | 目标值与用途 |
|---|---|---|
| 全局轨 | `--ec-rail-bg` | `#053A4C`。常规/折叠状态同色；不要把整页刷成这个颜色。 |
| 工作索引 | `--ec-index-bg`；新增 `--ec-index-surface-image` | 实底 `#064F67`；纵向 `linear-gradient(180deg,#064F67 0%,#073F54 100%)`。只在索引列及其窄屏等价容器画一次。 |
| 深区正文 | `--ec-rail-ink/text`、`--ec-index-ink/text/muted` | 当前项标题白 `#FFFFFF`；导航文字、项目名及时间 `#CFE0E6`。不得把浅面的 `--ec-muted` 继承到此处。 |
| 当前与悬停 | `--ec-rail-active`、`--ec-index-active`；两区 `*-accent`、`*-hover` | 选中实底 `#13676C`、3 px 左标 `#57C487`、标题加粗；悬停 `#0D5C70`。选中后鼠标离开仍可识别。键盘焦点必须是独立轮廓。 |
| 深区搜索/筛选 | 搜索输入、下拉和弹层局部样式 | 输入实底 `#073F54`，字 `#FFFFFF`；普通分隔 `#497381` 只作装饰，输入边界/焦点另测 3:1。底部连接信息保留文字，不只留一个绿点。 |
| 工作面 | `--ec-paper/white/soft`、资料栏局部表面 | 画布 `#F4F7F7`，卡面与顶栏 `#FFFFFF`，资料栏 `#F2FAFA`；分隔 `#CDDCDC`，卡内细分隔 `#E3EDEC`。不要给资料栏和文件卡再加一层深色。 |
| 浅区正文 | `--ec-ink/secondary/muted` | 标题 `#153847`，正文 `#24485A`，辅助说明 `#536D78`。`#7A9098` 不用于要读的小字。 |
| 主动作 | `--ec-primary` + 新增 `--ec-enter-image` | 基色 `#007B82`，**进入工作会话**使用 `linear-gradient(135deg,#007B82 0%,#064F67 100%)`，白字。次要操作不刷渐变；下载/文字动作 `#056A72`。 |
| 待人处理 | `--ec-amber`、`--ec-amber-weak` 或状态组件 token | `#795212` 字 / `#FFF8E9` 底，点 `#9C6D1C`。这是提高小字对比度的 DSH 适配；不是每个执行中状态都叫「待复核」。 |
| 完成/失败 | 浅区状态组件 | 完成 `#216544` / `#EEF8F3`；错误采用 RBQM 深红 `#C23B45` / `#FFF0F1`，上线前实测。不得以品牌色或跑完的勾号代替业务复核通过。 |

**对齐示例（示意片段，不是新增平行样式表）：**

```css
/* 放回现有 token 块；不要在另一个 .ec-wb 块重复声明全部 token。 */
.ec-wb {
  --ec-index-bg: #064f67;
  --ec-index-surface-image: linear-gradient(180deg, #064f67, #073f54);
  --ec-enter-image: linear-gradient(135deg, #007b82, #064f67);
}
.ec-wb .ec-wb-desk-index {
  background-color: var(--ec-index-bg);
  background-image: var(--ec-index-surface-image);
}
.ec-wb button.ec-wb-brief-enter:not(:disabled) {
  background-color: var(--ec-primary);
  background-image: var(--ec-enter-image);
  color: #fff;
}
```

在现有规则内替换而不是尾部堆覆盖；检查 `background` 简写是否清掉 `background-image`。为 hover 明确给出变深的背景（例如实底 `#056A72` 并去除 image），pressed 用 `#064F67`；disabled 去除渐变，保留真实 `disabled` 与动作进行中的文案，避免仍像可点主按钮。深区焦点可用 `#A8E0E2` 的完整 2 px 外框，浅区用 `#056A72`；与左侧选中条分开。高对比系统下允许系统颜色接管，不用 `forced-color-adjust:none` 锁全壳。

### 2.2 系统暗色不是把白色画布反相

12/13 号是**默认主题**，不提供暗色验收证据。沿现有 `prefers-color-scheme: dark` 和宿主约定，在同一语义 token 的暗色块对照 RBQM：画布 `#04141A`，卡面 `#0D2026`，一级文字 `#E8F4F6`，次文 `#B0C9CF`，分隔 `#24484E`，可读链接 `#6BD0D5`。主按钮可保留默认的深渐变和白字；若换亮青底，必须改深色前景并重测，不沿用白字。深轨和索引在暗画布上仍要有可辨的边界。待办/失败浅透明色要与实际底色合成后计算对比度。不要设置会话容器或宿主根的 `color-scheme` 来改变原生输入外观。

## 3. 按页实施

**首页 / 12 号稿。** 从全局轨、索引到画布依次变亮。优先处理 `.ec-wb-desk-index`、`.ec-wb-desk-index-frame`、`.ec-wb-desk-row[aria-current="true"]`、搜索输入/placeholder、筛选弹层、`.ec-wb-brief-enter` 与文件下载链接。长工作名、日期、搜索取消、加载更多和错误重试也要使用所属面的 token。单个文件的封面可取青灰底 `#DDE7E7`，不出现未获证实的工作簿页名。选中索引仅预览；主按钮才进入会话；保留归档只读、未封存不可下载、超时不冒充零条等行为。

**工作页 / 13 号稿。** 顶栏和企业标题沿用浅表面，右栏背景/分组用品牌浅色；状态、文件成果、运行历史和复核操作仍由现有组件管理。只给插件自有 class 写样式；禁止 `.ec-wb-desk-stage *`、自定义滚动覆盖原生线程、修改 `.ec-wb-console-thread` 后代、通过 `key={theme}` 重建 `WorkConsole`。颜色变化不应产生 API 请求、绑定、创建 Session 或改变选中 Run。历史会话不加业务资料栏。

**窄屏与辅助交互。** 延用 `desk-styles.ts` 的容器断点（主区约 1120 / 840 / 800 px），不是按整窗硬编码四列。依次核对固定索引、临时索引面板、首页内联索引：同一索引在三处都保持深底浅字；筛选下拉和系统原生 option 的前景/底色要成对验证。全局抽屉、索引面板与右栏面板不能因样式变化叠成两个活动遮罩。Esc、Tab、关闭回焦、紧凑布局、英文长标题、200% 缩放、减少动态维持原合同。

## 4. 工单、依赖与停止条件

| 工单 | 实际工作 | 可交接产物 / 通过条件 |
|---|---|---|
| E0 基线 | 确认实时 diff 与文件写入人，记录实际加载的插件构建、宿主版本、隔离 profile 和窗口尺寸。用合成数据拍首页及工作页。 | 开发前证据；分清「已有工作树改动」与本次改动。不操作正在使用的员工 profile。 |
| E1 颜色基础（E0 后） | 在 `styles.ts` 对齐浅色 token 和暗色覆盖，保留原 token 的非色彩用途；核对同名属性的 dark override。 | 可复用映射；没有新增依赖、全局主题开关或 `html/body` 规则。 |
| E2 组件收口（E1 后） | 在 `desk-styles.ts` 对齐三种索引载体、主动作、文件卡和右栏；巡查旧硬编码色，按背景使用同语义替换。优先 CSS 修改。 | 默认/选中/hover/focus/disabled、窄屏以及暗色样例；对未涉及页面的共享 token 做抽查。 |
| E3 自动检查（E2 后） | 在 [UX 契约测试](../packages/platform-workbench/tests/ux-contract.test.ts) 或新增主题测试，用最终的 `WORKBENCH_CSS` 检查 token 解析、明暗对比、作用域与样式卸载。不删旧的原生中心保护断言。 | 类型、构建、测试和仓库总门禁记录。渐变验证实际端点/最弱点，不只检查声明字符串。 |
| E4 宿主验收（E3 后） | 用隔离的真实 DSH 员工装配走下表；截图注明构建、分辨率、主题和数据性质。 | 视觉截图及行为证据，逐条记通过/失败/未跑；缺宿主只能交代码与静态结果，不能宣称可发布。 |

同一组文件只指定一位写入者，尤其是 `styles.ts`、`desk-styles.ts` 及相关测试。若发现必须改会话引用、消息提交、业务 API 或生产 profile 才能达成配色，**停止并记录偏差**；这些不是本次主题工程的依赖项。

## 5. 验收单：不能只看颜色值

| ID | 场景 | 通过标准 |
|---|---|---|
| V1 | 1512×948、默认主题、隔离首页 | 视觉对照 12 号稿；取样导航实色、索引顶/底、选中底/侧标及按钮两端。标题、时间、文件名可读。宿主列宽差异可说明，不强改宿主几何。 |
| V2 | 移动指针、Tab、选中、关闭筛选、提交中的按钮 | 悬停、当前、焦点三态可独立识别；普通文字 ≥4.5:1，必要控件边界和焦点 ≥3:1。不可用动作不会被误触。 |
| V3 | 无数据、错误、无权、归档、未封存、普通会话无成果 | 不把未知显示成空/已完成；下载与进入动作保持原条件。成功、复核与失败至少有文字，不单凭色点判断。 |
| V4 | 1280×800、1024×768、390×844；调整宿主侧栏宽度 | 容器断点生效；静态列/弹出面板/内联索引色系一致，原生 select 的选项不是白底白字；关闭后焦点回到触发器，无横向溢出。 |
| V5 | 真宿主中同一 Work 的会话开着草稿，切换偏好/收起资料，查看「对话／轨迹」和历史 Run，再回 Work | 输入草稿、原生 View 与 Work/Run 对应关系正确，没有重复提交、released reference 或第二个输入框。比较 before/after 的同一静止会话，忽略光标闪烁与真实时间；不是拿 PNG 相等代替行为验证。 |
| V6 | 暗色、中文/英文、紧凑、200% 缩放；项目/应用/设置各抽查一个页面 | 阅读面、次文字、焦点、错误、弹层可读，原生会话仍用宿主主题；可复现截图附结果。 |
| V7 | 在隔离环境停用/重载插件、恢复原构建 | 仅现有 effect 拥有本插件 stylesheet，卸载没有遗留全局样式；工作、会话、成果仍可恢复。 |

**六组已知静态对照值**（只证明指定前景/背景，不是运行系统无障碍认证）：

| 前景 / 背景 | 角色 | 对比度 |
|---|---|---:|
| `#CFE0E6` / `#13676C` | 选中行元数据 | 4.85:1 |
| `#FFFFFF` / `#007B82` | 主按钮渐变亮端 | 5.05:1 |
| `#CFE0E6` / `#064F67` | 索引普通文字 | 6.66:1 |
| `#536D78` / `#F4F7F7` | 浅画布次文 | 5.09:1 |
| `#795212` / `#FFF8E9` | 待复核 | 6.56:1 |
| `#216544` / `#EEF8F3` | 完成 | 6.43:1 |

### 验证入口（交付实现时，由仓库根目录执行）

先确认 Node 满足仓库门槛（≥24.9.0）：

```bash
node --version
```

插件验证（类型、构建、测试）：

```bash
npm --prefix packages/platform-workbench run verify
```

交付前执行规范检查与全包验证：

```bash
node scripts/verify-all.cjs
```

本地设计稿的可选重绘命令（Windows，需 Pillow、NumPy、系统字体与同目录历史素材；只重绘 12/13 号静态 PNG，不是启动插件）：

```bash
python -I -B prototypes/enterprise-workbench/visual-study/render_rbqm_trial.py
```

**交付与回退：** 留存本次触及文件、构建标识、门禁输出、V1–V7 证据和限制。出现串色到原生会话、不可读控件、丢草稿、重复提交或卸载残留时阻断交付，在隔离环境恢复上一个已记录可用构建；不重置整个工作树、不清用户数据、不动 RBQM。只有主题被采纳且实机验收完成，才另行决定是否更新总计划默认基准、登记正式发布和切换部署。本次文档交付不执行这些步骤。
