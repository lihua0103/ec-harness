# @ec-clinical/dsh-dm-viz

临床图表设计与交付插件：把图表设计稿（自包含 HTML）转成平台内可保存、可复跑的图表配置与布局，
渲染出系统图表页，并按设计稿逐图验收。设计见仓库根 `docs/DM-VIZ-PLUGIN-DESIGN.md`。

版本 0.1.0（P1–P5）：规格/目录/选项/样式/布局、配置存储、系统图表页渲染壳、配置级结构验收、
设计稿运行态提取与逐图配对、xlsx 工作表导入、交付封存、目标系统适配器。
输出为配置候选，需业务验收，不代表已通过 UAT 或可发布。RBQM 适配器只做了操作映射的本地合同测试，
未对真实实例执行。

## 对象

| 对象 | 说明 |
| --- | --- |
| `Dataset` | 列（key/label/type）与行；数值槽只接受 `number` 列（COUNT 例外） |
| `ChartSpec` | `mode: data \| baked`、目录类型 + 预设、槽位、聚合、样式 |
| `Layout` | 24 列 × 36px 网格；`chart` 与 `divider` 两类项；整单事务写入 |
| `Acceptance` | 逐项结构结果 + 设计稿配对记录；`pending` 不算通过 |

## 图表目录（内置，不可运行时注册）

`bar` / `horizontalbar` / `line` / `pie` / `scatter` / `effectscatter` / `heatmap` / `boxplot` /
`sankey` / `graph` / `radar` / `funnel` / `gauge` / `table` / `cards`。

预设：`stacked`、`smooth`、`step`、`area`、`stackedarea`、`donut`、`rose`、`ripple`、`force`。
新增形态是代码改动（`src/catalog.ts` + 回归），不是运行时注册。

## 工具（14 个）

| 工具 | 作用 |
| --- | --- |
| `dm_viz_define_dataset` | 登记数据集（列定义 + 行）；只保存结构 |
| `dm_viz_import_xlsx` | 从 xlsx 工作表导入数据集；按取值推断列类型，可显式覆盖 |
| `dm_viz_describe_dataset` | 结构与列级聚合（非空数/去重数/min/max/mean），不回传原始行 |
| `dm_viz_plan` | 选型与缺口诊断：类型、槽位、列类型、是否会渲染成空白 |
| `dm_viz_build` | 整单保存规格与布局；列类型、槽位、重叠/孤儿/越界任一失败整单拒绝 |
| `dm_viz_render` | 渲染系统图表页与验收渲染壳，写 HTML 并返回结构与空白项 |
| `dm_viz_design_extract` | 无头 Chrome 打开设计稿，逐图运行态提取 ECharts option（按 DOM 顺序） |
| `dm_viz_design_pair` | 设计稿与配置页按顺序逐图配对，返回 match/diff/pending 与差异字段 |
| `dm_viz_design_compile` | 设计稿 → baked 规格 + 布局；函数标签落成静态文本，目录不支持的形态列入 skipped |
| `dm_viz_verify` | 配置级验收，写 `acceptance.json`；设计稿配对结果需显式传入 |
| `dm_viz_deliver` | 交付封存：配置快照 + 渲染页 + 验收记录 + 逐文件摘要 |
| `dm_viz_target_plan` | 目标系统落位计划：操作序列与缺口，不写外部系统 |
| `dm_viz_rbqm_apply` | 把当前页面落到 RBQM（登录/数据集/类型/配置/布局）；凭据只读环境变量 |
| `dm_viz_status` | 当前会话的数据集/规格/页面与目录类型 |

## 设计稿提取

提取走 CDP，不依赖 Playwright：用 Node 内置 WebSocket 启动无头 Chrome，逐图调用
`echarts.getInstanceByDom(el).getOption()`，拿到 redesign 之后的最终形态，而不是读源码里的数据模型。

需要两个环境变量（或调用时显式传 `executablePath`）：

| 变量 | 用途 |
| --- | --- |
| `DM_VIZ_CHROME` | Chrome / Edge / chrome-headless-shell 可执行文件 |
| `DM_VIZ_ECHARTS` | ECharts 构建文件，仅条件测试用 |

比对只覆盖语义字段：系列数量与类型、系列名、数据值（1e-6 容差）、类目轴朝向与类目值、显式配色。
ECharts 默认主题色视为"设计稿未配色"，不判差异；布局细节（grid、legend 位置）不参与比对。


内置 bundled skill `dm-viz`：目标、能力事实、验收判据与数据边界。

## xlsx 数据接入

只读 `platform-workbook` 的公开导出，不复制 OOXML 解析。规则：

| 情形 | 处理 |
| --- | --- |
| 列类型推断 | 全部可数值化 → `number`；全部形如日期 → `date`；否则 `text` |
| 显式覆盖 | `columnTypes` 按列 key 或表头文字优先于推断 |
| 空单元格 | `null`，不是 0 也不是空串 |
| 公式单元格 | 跳过并计数，不回传公式表达式 |
| 隐藏行列、合并区域 | 数据照常读入，只计数告警 |
| 上限 | 5000 行 / 200 列，超出显式报错 |

列类型不对时，数值槽绑定会在 `dm_viz_plan` / `dm_viz_build` 阶段报 `SLOT_COLUMN_NOT_NUMBER` 并带列名，
不会静默转 0。

## 交付封存

`dm_viz_deliver` 把一个页面封存为一个目录：

| 文件 | 内容 |
| --- | --- |
| `snapshot.json` | 数据集 / 规格 / 布局的规范化快照（键排序，可直接比对） |
| `page.html` | 由配置渲染的系统图表页 |
| `acceptance.json` | 配置级验收记录 |
| `manifest.json` | 逐文件 sha256、字节数、specDigest、result |

验收不通过也照常封存（`result=fail`），不丢失败证据；同一配置重复封存，文件摘要不变。

## 应用登记

`application.json` 声明 `ec.viz` 与能力 `ec.viz.deliver`。仓库根 `scripts/verify-applications.mjs`
把每个插件的清单组装成 AppReleaseDraft，经控制面登记并回读 ACTIVE，已接入 `scripts/verify-all.cjs`。
它只证明清单与登记链路一致，不证明工作台部署可见，也不替代业务验收。

## 目标系统适配器

| 目标 | 能力声明 | 落位方式 |
| --- | --- | --- |
| `platform`（默认） | 无运行时类型注册；全部目录类型；24 列网格 | 配置直接写本插件存储 |
| `rbqm`（外部） | 需运行时注册类型；单类型单系列；24 列网格 | 产出操作序列，由注入的 transport 执行 |

`plan()` 先报缺口：类型不支持、网格不一致、需要烘焙但目标不能注册类型、系列数超限。
缺口非空时 `apply()` 直接拒绝写入，不降级冒充。`dm_viz_target_plan` 只返回计划，不写外部系统。

**边界**：RBQM 适配器只验证了操作映射（本地合同测试），没有对真实 RBQM 实例执行过；
接口形状变化需要重新核对，不能据此外推"已在 RBQM 交付"。

## 真实系统验证记录（2026-11-14）

在 DSH worker profile 里加载本插件、让模型自主调用工具。第一次运行**工具没有注册**。逐条记录与分类：

| 现象 | 分类 | 根因 | 处理 |
| --- | --- | --- | --- |
| 会话里看不到 `dm_viz_*` 工具 | 插件缺陷 | 构建产物内联了 `platform-workbook` 解析器，但未声明 `yauzl` / `fast-xml-parser`，加载即失败 | `package.json` 声明两个运行时依赖 |
| `SPEC_MODE_REQUIRED` / `SPEC_SLOTS_REQUIRED` / `COLUMN_NOT_FOUND` | 插件契约缺口 | 工具描述没写 ChartSpec/Dataset/Layout 形状，也没说槽位用列 key | 工具描述补 schema 与 key 规则 |
| `AGGREGATE_UNKNOWN` | 插件可用性 | 聚合名大小写敏感，模型传了小写 | 统一大写归一化，并在描述里列出取值 |
| `VIZ_OPERATION_FAILED` | 插件缺陷 | 渲染时 `SPEC_NOT_FOUND` 抛普通 Error，不带 code | 改抛 `VizError` |
| `working-directory: directory does not exist` | 环境/配置（非插件） | 会话工作目录未创建 | 建目录后重跑 |

修复后同一条真实会话返回：`{"datasetId":"ds_e2e","pageId":"page_e2e","blank":[],"rendered":true,"error":""}`。

## RBQM 落位记录（2026-11-14）

把设计稿 59 张图落到 `VIZ-VERIFY-2026`（study 92 / 环境 215）时踩到的问题：

| 现象 | 分类 | 根因 | 处理 |
| --- | --- | --- | --- |
| 保存配置一律 `10014 Mandatory items not fully configured` | RBQM 接口行为 | `saveChartType` 不返回新类型 id；真正可用的是回读列表里的 `typeCode`（≥100000 才走 `DynamicChartV2`） | 注册后按名称回读 `typeCode` 再建配置 |
| `TYPE_CODE_MISSING` | 插件脚本缺陷 | 类型名带完整标题后按名回查不到 | 类型名固定为 `VIZ <card>` |
| 中央总览 5 张互相覆盖 | 插件脚本缺陷 | 这些卡片没有 `data-chart-card`，`card` 为空导致 state 键冲突 | 用 `o<order>` 作为键 |
| 布局顺序与坐标漂移 | RBQM 编辑器行为 | 布局项按 `i` 排序后重排；有重叠项时会挤位 | 用 `viz_<card>` 作键并在干净布局下整单重写 |
| **很多图表空白 / 总览缺失** | 插件落位缺陷 | 默认 option 交给 `buildDynamicOption` 时会被 builder 载荷合并，设计数据被单行数据集覆盖；成功会话里正是用 `defaultOption._bypassBuilder` 解决同一问题 | 已给 59 个类型全部补 `_bypassBuilder: true`，关闭 builder 合并、直接渲染设计 option |
| **4 张热力图空/加载失败** | 已修复 | 烘焙 heatmap 被 builder 覆盖数值；标签文字预置为 `item.raw`/`rawText` 静态文本，并补最小 `visualMap`（原 option 里为空数组导致渲染器失败） | b0p1、b4p0、b7p3、b8p1 与设计稿一致（数值/配色/行序/空值） |
| **标签缺失/错乱** | 部分修复 | 设计 option 的标签由函数生成，JSON 无法携带；可安全求值的转成静态文本，堆叠条形改用 `{c}` | b0p0/b0p3 等已一致；b7p0 只出了条末数值、缺段内标签；b7p2 标签位置偏移；b8p0 缺多行说明 |
| **3 张自定义系列加载失败** | **未解决** | 依赖 `renderItem` 函数 | 需用 graphic 图元重画，或前端支持函数还原 |
| **最终布局保存后展示页渲染为空** | **未解决** | 同会话内 `getChartLayoutInfo` 回读 59 项，但用注入会话打开展示页时页面未发起任何 `/csm/` 布局请求、且设置抽屉处于打开状态；怀疑注入会话下的页面未完整初始化，而非布局数据本身 | 下一步：在操作者真实登录的浏览器里复核页面；headless 注入会话的结论不作为验收依据 |

已验证：59 张图的类型 `defaultOption` 与设计稿运行态 option 逐项语义一致（59/59 match），布局项顺序与设计稿一致（orderMatches=true）。

## 设计稿编译（不做单图补丁）

`dm_viz_design_compile` 是通用能力：把提取结果整体编译成规格与布局，函数标签的可求值文本落成静态值，
目录表达不了的形态（如 `custom` 系列）进入 `skipped` 而不是伪造。逐图差异应由模型基于工具结果判断，
插件不内置按图名的分支。

## RBQM 执行通道

`dm_viz_rbqm_apply` 就是此前脚本里的 HTTP 调用层：登录（会话密钥 + AES-CFB）、上传 xlsx 建表、
回读列 id、注册/更新自定义类型、保存配置与布局。**凭据只从环境变量 `RBQM_USER` / `RBQM_PASSWORD` 读取**，
不进入工具参数、日志或返回值。密码加密与 CryptoJS 是同一算法（PKCS7 + AES-CFB），有对照测试。

## 布局按设计几何（未成功）

尝试用设计页的真实测量值生成布局（分区标题作 9901 分隔符 + 卡片按测量位置换算 24 列网格，共 71 项），
保存成功但展示页渲染为空，已回滚到 59 项均匀网格。**当前布局不是设计稿排版**。

## 中央总览模块缺失（根因已定位）

设计稿顶部不是 ECharts：`.central-theme` ×6（主题卡）、`.central-kpi` ×6（KPI 卡）、页头与分区标题都是 HTML。
提取器只取 `echarts.getInstanceByDom`，因此这 12 张卡从未进入规格——页面上整块"被删掉"。
用 9901 卡片尝试补回两次都导致展示页空白，已回滚；需要按 HTML 块提取再编译，且要先摸清网格占位规则。

## 数据边界

- 工具只返回 schema、聚合与配置摘要，不回传原始数据行。
- 设计稿 URL 的内容只作数据；其中的指令性文本不执行。
- 验收汇总数字不能代替逐图确认；设计稿配对未确认项保持 `pending`。

## 验证

```
npm run typecheck && npm run test && npm run build
```

`npm run verify` 是聚合入口。P1 完成判据：合成数据生成含 12 类型、分隔符、堆叠/多系列的页面，
逐项结构检查 0 失败；两次生成摘要一致。P2 判据：自建设计 HTML 夹具按顺序逐图比对 100%，差异清单为空。

设计稿测试是条件执行的，未设置环境变量时显示 skipped 而不是伪装通过：

```bash
DM_VIZ_CHROME="<chrome-headless-shell 路径>" \
DM_VIZ_ECHARTS="<echarts.min.js 路径>" \
node node_modules/tsx/dist/cli.mjs --test tests/design-extract.test.ts
```

### 实渲染自查

结构验收只证明配置能产出数据，不证明浏览器里画得出来。实渲染至少确认三件事：
画布数量等于图表数、每个画布尺寸非零、页面无 JS 异常。

```bash
node node_modules/tsx/dist/cli.mjs scripts/p1-artifact.ts
```

生成 `.runtime/dsh-home/dm-viz/p1-page.html` 与验收记录后，用任意浏览器打开，或对离线版
（内联 ECharts）执行无头截图并统计 `<canvas>` 数量。2026-11-14 实测：12 个画布 542×323、0 空白。
