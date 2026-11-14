# 企业工作台 UI 概念稿对齐（2026-11-13）

对象：`packages/platform-workbench`（原生 WebUI 企业工作台插件，Host + Client）。
输入：已评审概念稿 `prototypes/enterprise-workbench/design.html?r=2#view-work` 与 `design.css`。
形态不变：仍是**一个插件 keyed `main` 整页**，会话正文由上游 `conversation.content` 工厂提供；
本轮只改视觉系统、首页信息架构与工作控制台的外框，不新增第二套聊天、iframe 或 React。

## 1. 改了什么

| 部位 | 变更前 | 变更后 |
|---|---|---|
| 设计 token | 14px 正文 / 30px H1 / 10px 圆角 / 蓝绿 `#004b61` 主色 / 22–28px 间距 | 13px 正文 / 24px H1 / 5–7px 圆角 / 玉绿 `#087b6b` 主色 / 概念稿间距与 `#eff4f5` 画布 |
| 顶栏 | 65px，仅面包屑 + 文字刷新 + 复选框 | 56px，品牌标记 + EMERALD 字标 + 分隔线 + 面包屑 + 连接点 + 刷新/密度/设置图标钮 |
| 导航 | 212px，浅底新建按钮，五项无计数，无最近列表 | 210px，实心玉绿新建按钮，工作优先排序，待我处理计数，最近打开列表，底部平台设置块；滚动时吸顶 |
| 首页 | hero + 最近工作分组列表 + 项目芯片 + 模型/状态卡；**页面无内边距** | hero（日期眉题/工作区芯片）+ AI 工作入口 + 工作队列表格 + 画布脚注；右栏需要你处理 / 运行就绪 / 我的项目；整屏填充 |
| 工作入口 | 无 | 快捷目标来自**员工最近使用的应用**（回退到已发布目录），项目下拉与默认模型行均为真实数据，点击进入预填的新建工作表单 |
| 运行就绪 | 无 | 应用目录 / 模型目录 / Worker 执行器三条实测事实；未配置即显示待配置，不伪造就绪 |
| 会话视图 | 一条返回栏 + 整列原生会话 | 工作控制台：企业头（项目·应用·运行编号 + 状态胶囊 + 查看目标 / 请求停止）+ 右侧运行状态 / 文件成果 / 运行历史侧栏；线程仍是原生工厂 |
| 问答 | 白底 fieldset + 下拉 | 琥珀问题卡 + 原生 radio/checkbox 芯片（键盘可达、焦点环保留） |
| 归档工作 | 与进行中工作混排 | 队列默认只列进行中；脚注“显示已归档 N 项”开关，归档记录仍可达 |
| 读取中的成果 | 立即显示“该运行没有登记成果” | 读取完成前显示“正在读取成果…”，不把未读完当作没有 |
| 答复/运行操作后的计数 | 首页待处理计数与运行状态停留在旧 bootstrap，需手动刷新 | 答复、停止、重试、确认已停止都会同时刷新外壳 bootstrap，计数与状态立即一致 |
| 工作列表检索 | 无检索/筛选/排序，只能从上往下翻 | 队列头加入搜索（标题/项目/应用）、状态筛选（进行中/已归档/全部）、三种排序；数量超过 bootstrap 单页时如实标注并支持加载全部 |
| 待处理中的跨页工作 | 工作不在已加载页时显示“工作不可见”且不可点 | 按需读取该工作的上下文补出标题，点击直接打开到对应运行的问题卡 |

运行控制（停止/重试/确认已停止）抽为 `useRunControl`，控制台头与侧栏共用一份 busy/error/notice，
不出现两个互相矛盾的操作状态。控制台每 15 秒在页面可见时重读运行记录，卸载即清理定时器。

## 2. 与概念稿的有意偏离

1. **元信息对比度**：概念稿 8–11px 元信息灰实测 2.4–4.4:1。保留同一冷灰绿色系，统一为
   `#5c7278`（浅色）/ `#93a5ab`（暗色），使全部文本配对 ≥ 4.5:1。
2. **暗色主题**：概念稿只有浅色；暗色由同一玉绿色相推导，并逐条覆盖浅色硬编码值。
3. **身份区**：控制面 bootstrap 不含员工身份，因此顶栏不放虚构头像/缩写，导航底部是真实的
   平台设置入口与执行器状态。
4. **线程内容**：概念稿画了示意气泡/工具条/思考块；实现里这些一律由原生会话渲染，插件不复制。

## 3. 验证（实际执行）

环境：Node 24.9.0；隔离 profile `.runtime/nw-web-home`；本地控制面 `--store` 指向该 profile 的
`native-workbench.sqlite`（合成种子数据：1 项目 / 2 应用 / 4 工作 / 4 运行 / 2 模型，`executor=not-configured`）。

```bash
# 1) 包验证
cd packages/platform-workbench && npm run verify
```

结果：typecheck 通过（含 `--noUnusedLocals --noUnusedParameters` 清零）、bundle 构建通过、
**55/55** 测试通过（新增相对时间/标题字母块/状态色调用纯逻辑用例、概念稿界面契约与控制台高度链约束用例、
暗色实心按钮必须排在通用描边按钮之后的回归守卫、`selectWorkRows` 检索/筛选/排序用例与 `listWorks` 分页参数用例）。

```bash
# 2) 控制面（探针 store；端口 3097，避开其他会话占用的 3096）
cd packages/platform-control
node node_modules/tsx/dist/cli.mjs src/api-cli.ts --port 3097 \
  --store ../../.runtime/nw-probe-web-home/platform/native-workbench.sqlite
```

```bash
# 3) 原生 web（独立的探针 home，指向探针控制面）
PLATFORM_WORKBENCH_CONTROL_URL=http://127.0.0.1:3097 node .runtime/nw-verify-web.cjs
```

**探针必须用独立的 DSH_HOME**。`.runtime/nw-web-home` 归「启动dsh插件平台」会话使用，而
`storages/workspace.json`、`profiles/web/.plugin-manager`、`sessions/` 都是单写者假设的状态——两个 web
同时跑会互相覆盖且不报错，两边的验证结论都会失真。本任务的探针 home 是 `.runtime/nw-probe-web-home`
（由 `nw-web-home` 复制而来；复制时排除 `node_modules`，再用目录联接把
`profiles/web/node_modules/@ec-clinical/platform-workbench` 指回仓库包）。

想让预览跨回合常驻时，把它作为**单一前台进程**放进交互终端（`run_in_terminal` 或用户自己的终端），
而不是 Bash 后台任务：后者会在回合边界被回收。PowerShell：

```powershell
$env:DSH_HOME = '<repo>\.runtime\nw-probe-web-home'; $env:PLATFORM_WORKBENCH_CONTROL_URL = 'http://127.0.0.1:3097'
cd <repo>\upstream\deepseek-harness-git
node --import tsx/esm ../../scripts/dsh-web-launcher.cjs web --host 127.0.0.1 --port 3098
```

> 端口与 home 归属（2026-11-14 协调）：3095/3096 + `nw-web-home` 由「启动dsh插件平台」会话占用
> （真实执行器部署），本任务不重启、不改其 store 与 home；探针固定用 3097（控制面）+ 3098（web）+
> `nw-probe-web-home`。`.claude/launch.json` 的 `native-workbench-*` 两项已对齐。

```bash
# 4) 真实宿主浏览器回归（系统 Edge 通道，无 mock）
node .runtime/nw-ui-verify.cjs "http://127.0.0.1:3095/?token=<printed-token>"
```

结果：**28/28 通过，0 运行时错误，0 失败请求**。覆盖：首页各面板与真实运行状态、快捷目标预选应用、
新建工作端到端、工作详情运行/封存成果/下载、控制台原生会话（`data-conversation-session` 命中绑定
Session、composer 在位、无原生主 Header 混入）、一屏无溢出、侧栏运行切换、四个导航页、紧凑密度、
暗色、390px 窄屏首页与控制台、归档端到端与归档开关往返。

```bash
# 5) 主题对比度实测
node .runtime/nw-dark-contrast.cjs "http://127.0.0.1:3095/?token=<printed-token>"
```

结果：浅色/暗色 × 首页/控制台共 **128 组**文本配对，全部 ≥ 4.5:1。首轮浅色 25 组、暗色 10 组不达标，
按 §2.1 修正；问答专项又查出**暗色实心主按钮 1.26:1**（见 §3.1），修复后该配对为 7.42:1。

```bash
# 5b) 问答专项（需要一条 PENDING 问题；探针 store 里那条早已被历史验收答完）
node .runtime/nw-seed-question.cjs
node .runtime/nw-question-verify.cjs "http://127.0.0.1:3095/?token=<printed-token>"
```

结果：**10/10 通过，0 运行时错误、0 失败请求**。覆盖：首页“需要你处理”由空态变为真实条目且导航计数为 1、
待我处理页列出“2 个问题”、琥珀问题卡渲染单选 3 芯片＋多选 3 芯片＋两个自定义输入、
浅暗两主题卡片文本全部 ≥4.5:1、选中态芯片可读、提交答复端到端（记录转 ANSWERED、卡片消失、
空态回归）、**首页计数与空态在答复后自动归零**。

### 3.1 专项查出并修复的两个真实缺陷

1. **暗色实心主按钮不可读（1.26:1）**：暗色块里 `.ec-wb button.ec-wb-button{color:…}` 与
   `.ec-wb button.ec-wb-primary{color:…}` 特异度相同，通用描边规则排在后面就把玉绿底上的文字改成了浅灰。
   影响所有主按钮（创建工作/发起运行/打开会话/提交答复/首页 CTA）。已把实心按钮重新着色移到通用规则之后，
   并加静态回归守卫（`tests/ux-contract.test.ts`）。首页对比度探针也补上了实心按钮采样点。
2. **答复后计数不刷新**：`InteractionPanel`/`RunActions`/控制台运行操作只刷新局部数据，外壳 bootstrap 不变，
   首页“需要你处理”和运行状态会停在旧值直到手动刷新。已让这三处同时调用外壳 `load()`。

### 3.2 规模检索（第二遍）

`/api/workbench` 只返回前 50 条工作，因此“只在已加载页里搜索”会让真实存在的记录被判为不存在
（实测搜“季度”得到 0 条，而该工作排在第 50 条之后）。处理方式：

- 队列头提供搜索（工作标题 / 项目名 / 应用名）、状态筛选、三种排序，全部即时生效，纯逻辑在
  `reports.selectWorkRows` 并有单元测试。
- 目录未加载完时，脚注写明“已加载 X/N”并提供“加载全部 N 项后再搜索”；**第一次输入搜索词会自动补齐剩余页**，
  所以“没有匹配”不再可能等于“不在本页”。
- 空结果区分两种原因：已加载全量 → “没有匹配的工作”；仍有未加载记录 → “其余 N 项尚未加载，可能就在其中”
  并就地给出加载按钮。
- 待处理条目若指向未加载的工作，按其上下文补出标题（每个未知工作一次有界请求），点击即可打开。
- 单次加载上限 5000 条，超出时如实提示并用搜索缩小范围，不静默截断。

```bash
node .runtime/nw-queue-verify.cjs "http://127.0.0.1:3095/?token=<printed-token>"
```

结果：**18/18 通过，0 运行时错误、0 失败请求**。覆盖：部分加载标注与“加载全部”、显式加载后标签消失、
标题/应用/项目三种搜索、全量下的空结果与清除筛选、标题/项目排序、状态筛选与超集关系、
刷新后重新标注并在**首次搜索时自动补齐**（跨页记录可被搜到）、390px 工具栏无溢出。
该脚本会临时创建 42 条 `ZZ 检索验证 *` 合成工作把目录推过 50 条，验证后已按 id 删除并重启控制面还原。

```bash
# 6) 规范与全仓门禁
node scripts/check-development-standard.mjs
node scripts/verify-all.cjs
```

结果：规范检查通过（插件互引与包边界无违规）；全仓门禁 **13/13** 验证命令通过。

证据文件：`.runtime/nw-ui-verify.json`、`.runtime/nw-question-verify.json`、`.runtime/nw-dark-contrast.json`、
`.runtime/nw-ui-shots/*.png`（脚本与截图为临时证据，不入库）；关键证据已归档到
`evidence/UI-REFRESH-2026-11-13-{home,console,dark,mobile,pending,question-light,question-dark}.png`
与 `evidence/UI-REFRESH-2026-11-13-{browser,question}.json`。

## 4. 未做（不写成完成）

- 真实 Worker 执行器下的运行链路：本轮控制面未配置执行器，就绪面板如实显示“执行器待配置”。
- 真实模型对话回归：控制台绑定的是 profile 中已有的原生 Session，未在本轮发起新的模型调用。
- locale 资源：界面文案仍为内置中文，`locale/` 仍为空，属规范 §5.3 的未完成项。
- 企业 SSO、集中模式非 owner 问答/审批、卸载往返清理：沿用既有未闭合状态。
- 本轮结论只覆盖上述实际执行的检查，不构成业务验收、部署验收或生产就绪。