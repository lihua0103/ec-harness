# 临床图表设计与交付插件（dm-viz）设计

版本：0.1（设计稿） · 日期：2026-11-14 · 状态：设计稿 + P1 核心实现。本文描述目标、契约与验收事实；实现进度以下方状态为准，不构成临床或部署验收。

**实施状态（2026-11-14）**：P1 核心已实现于 `plugins/dm-viz`——规格/目录/选项/样式/布局、配置存储、渲染壳、配置级验收；
已通过 `tsc --noEmit`、39 项测试和 esbuild 构建，开发规范检查通过。**未做**：浏览器实渲染验证（预览通道不可用）、
设计稿运行态提取（P2）、xlsx 接入（P3）、外部 Target 适配器（P5）。

来源：RBQM v5 自定义图表交付（IG-NIDDK DEV，2026-11-12～14）的实战经验复盘。**成功交付的原始会话**是 zcode 会话 `sess_a6d67e4c-0759-4cd2-9423-a4d68389ba23`（1063 条消息，197 轮用户输入，最终用户以"可以了"结束并随即要求沉淀 skill）。该会话的终态就是交付标准：

> **88 瓷砖 · 0 空白 · 71 canvas · 87 行布局 · 预览全通过**，全部由系统自定义图表功能配置，逐图对照设计稿 100% 一致。

经验同时记录在 RBQM 项目记忆 `rbqm-v5-design-to-system-delivery-skill`、`rbqm-402-v5-group1-lesson`，代码在 `RBQM/RBQM-web-front-end/src/components/ChartLibrary/`。

## 0. 结论

RBQM 这一轮真正沉淀下来的不是"一堆图表组件"，而是一条**确定性交付管线**：

> 设计稿 → 图表清单与选型 → 数据契约 → 图表规格 → 布局 → 渲染 → 逐图配对验收 → 交付证据

平台要做的不是把这套管线写成更长的提示词，而是把其中的映射、旋钮和验收标准变成**可执行工具与合同测试**，并把 RBQM 侧靠经验绕开的结构性缺陷在平台侧**从根上消掉**。

建议落成单个业务插件 `plugins/dm-viz`（应用 `ec.viz`，「图表设计与交付」），内部按纯函数核心 / Host 工具 / 知识贡献三层组织；当出现第二个消费插件时，再把纯函数核心平移为公共包 `packages/platform-viz`，不提前三拆。

### 已确认决策

| 决策 | 结论 | 影响 |
|---|---|---|
| 运行时图表类型注册 | **不做**（2026-11-14 确认）。图表形态由「目录类型 + 预设 + 逐图 `option` 逃生舱」表达 | 可写对象只有 Dataset / ChartSpec / Layout / Acceptance 四类；没有"注册类型"这一生命周期，也不继承 RBQM 的类型名占用、软删、update 忽略类型变更等缺陷 |
| 交付物 | **系统配置后的图表页**，不是设计稿 HTML（2026-11-14 澄清） | 设计稿 HTML 是输入与验收参照；交付＝数据集/规格/布局三类配置，以及由它们渲染出的系统页面。验收判据是系统配置结果与设计稿 100% 一致 |
| 设计稿输入 | 自包含 HTML（2026-11-14 确认） | 可运行态提取每图真实 option，结构与数值可机器比对 |
| 数据接入 | 先只接 xlsx（2026-11-14 确认） | P3 复用 `platform-workbook`，不扩 CSV/JSON |
| 能力归属 | **平台自有 DSH 能力**（2026-11-14 确认） | 默认目标就是平台自身；RBQM 等自有外系统通过外部 Target 适配器落位，见 §3.5、P5 |

## 1. 经验复盘

### 1.1 RBQM v5 实际执行的九步

| 步 | 动作 | 关键事实 |
|---|---|---|
| ① | 识别设计 HTML UI 稿 | 设计稿是自包含 HTML（ECharts + JS 数据模型）；结构=中央总览 + 分区 `section.block#b0..b12`，每区 4 张 `article.card[data-chart-card=bNpM]`，图容器 `.ec-chart[data-chart-id]` |
| ② | 运行态提取每图 option | `echarts.getInstanceByDom(el).getOption()` 逐图导出 JSON；**不读源码数据模型**——redesign/polish pass 会推翻源码里写的图型（v5.2 sunburst/treemap 被 v7 改回横条） |
| ③ | 图表选型 | 设计图型 → 系统类型码映射；**数据驱动优先，烘焙兜底** |
| ④ | 生成数据集 | 从提取 option 的轴/系列数据反推宽表或长表；列名取设计稿轴标签/图例文字 |
| ⑤ | 注册图表类型 | `baseType + defaultOption(JSON) + slots + panels` |
| ⑥ | 创建图表配置 | 绑数据集 + 字段槽位 + 聚合公式 + 样式 |
| ⑦ | 布局配置 | 24 列网格 × 36px 行高；分区条用分隔符组件承载；行 `chartType` 必须与配置一致，否则组件分派错误→空白 |
| ⑧ | 逐图配对验收 | 本地瓷砖截图 vs 预览页卡片截图 → 并排合成 → 人工逐对目检；一组 100% 才进下一组 |
| ⑨ | 交付确认 | 0 空白 + canvas 计数 + 加载罩消失 + "数据截至"时间戳 + 导出可用 |

最终产物：**88 瓷砖 · 0 空白 · 69 canvas · 87 行布局**，其中 19 张数据驱动、29 张烘焙、2 张热力图改走数据驱动；66 张数据集表、53 个自定义类型、53 个配置。

### 1.2 可复用的代码级资产

| 资产 | 位置 | 规模 | 价值 |
|---|---|---|---|
| ECharts 全类型目录 + `dataShape` 契约 | `components/ChartLibrary/dynamic/echartsCatalog.mjs` | 383 行 | 除 3D 外全部官方图表类型，每型声明数据形状（category / scatter / graph / boxplot / heatmap / map / radar / tree…） |
| 全类型 option 构建工厂 | `components/ChartLibrary/dynamic/buildDynamicOption.mjs` | 663 行 | `dataShape` → ECharts option 的归一化 + 预设深合并（数组替换语义）+ 地图注册 |
| 样式适配层 | `components/ChartLibrary/v2/chartStyleAdapter.mjs` | — | 配置驱动样式旋钮：`itemColors` / `seriesColors`（须双写 `itemStyle`+`lineStyle`）/ `stackAll` / `valueLabels` / `endLabels` / `seriesDash` / `centerText` / `legendWithValue` / `hideLabels` |
| 布局单一事实源 | 交付脚本 `tmp/csmv5/final-layout.mjs` | — | 规范摆位表一次写全 + 按名解析活配置 + 重叠自检 + 丢弃死链行 |
| 验收脚本族 | `extract-all.mjs` / `capture-all-pairs.mjs` / `find-blanks-v2.mjs` / `verify-v3.mjs` | — | 提取、双面截图、空白识别、渲染触发与全页确认 |
| 合成运行夹具 | `customChart/chartRuntime.preview.mjs` / `.test.mjs` | — | 无浏览器、无 API、无登录的合成验收页与组件回归 |

### 1.3 不可迁移的部分：RBQM 的结构性缺陷

这些是 RBQM 交付中被经验"绕开"的问题，平台侧必须消除，不能变成新插件的口诀：

| RBQM 现象 | RBQM 绕法 | dm-viz 的做法 |
|---|---|---|
| 201 builder 多系列只出 1 系列 | 改用 203 堆叠 | 多系列是柱/条图的一等能力，无类型选择陷阱 |
| 配置名软删不释放（10010 幽灵名） | 时间戳后缀 | 配置用不可变 ID；名称可改可复用 |
| update 忽略 `chartType` 变更 | 删旧建新 | 规格整体替换，无部分更新歧义 |
| `defaultOption` 返回字符串类型 | 前端补 `JSON.parse` | 存储层即结构化对象，无字符串往返 |
| heatmap 烘焙与通用载荷深合并冲突 | 换 2027 数据驱动 | 烘焙模式与数据模式互斥、显式声明 |
| 多行卡墙行序非确定 | 一卡一图 | 布局按 `i` 键稳定排序 |
| 分隔符计入取数队列→进度条永挂 | 循环头跳过 `type===3` | 进度只统计有取数的图表项 |
| 布局多脚本并行写→互相清场 | 单一全量重排脚本 | 布局写入是整体事务，禁止增量追加 |

### 1.4 成功交付标准的会话实证

这一节是插件的验收基准，全部来自该会话中真实发生的返工与纠偏。

### 1.4.1 被用户反复否决的三类做法

| 做法 | 用户原话 | 根因 | 插件必须怎么做 |
|---|---|---|---|
| 拿"全页扫描通过"的汇总数字交付 | "这么大个空白图你看不到？？？都说了，喊你一个一个检查" | 汇总计数掩盖了单格空白；DOM 计数不等于图表渲染 | 验收以**单图**为粒度，按设计稿顺序逐图给证据；汇总数字只能作为附加信息 |
| 一开始就凭猜测配置 | "你先整理梳理当前系统自定义图表功能…明确系统功能后再确定怎么配置。不要每次都是猜测" | 没先建立能力底图，选型靠猜 | 先输出能力清单与缺口，再生成规格（`dm_viz_plan` 必须先给"不可表达项"） |
| 用改渲染管线的方式修单图 | "别动我系统项目代码…" / "min-height:280px 硬编码这些是在修复系统缺陷啊" | 混淆了系统缺陷修复与单图 hack | 分清两类：**系统缺陷**修根因并测试；**单图差异**只能改规格/数据/类型，改不了就记为已知差异 |

### 1.4.2 成功路径的实际节奏

1. **锁定目标环境与项目**（本会话在此返工多次：先 401、再 402、最终本地 IG-NIDDK DEV id=209）。目标未锁定时不动配置。
2. **建立能力底图**：读源码确认五页面链路、槽位规则、样式键、类型分派阈值（`>=100000` → `DynamicChartV2`，否则 `CHART_MAP`）。
3. **按设计稿分区成组**：中央总览 → b0 → b1…b12，每组交付后逐图对照设计稿，**100% 才进下一组**。
4. **单图闭环**：出图 → 与本图设计卡片并排截图 → 人工/视觉确认 → 不符则定位（选型/绑定/聚合/类型）→ 修 → 重验。
5. **终态复核**：渐进滚动触发全部渲染 → 逐瓷砖检查空白 → 导出可用 → 进度完成 → 全页实拍。

### 1.4.3 最后一轮定位出的真实根因（示例，代表一类问题）

| 图 | 症状 | 根因 | 修法 |
|---|---|---|---|
| b7p3 / b8p1 | 空白 | `baseType=heatmap` 的烘焙类型与通用 builder 载荷深合并冲突 | 改数据驱动热力（三槽长表） |
| b1p2 | 空白 | 布局行 `chartType=2025` ≠ 配置 `chartType=100075`，组件分派到错误组件 | 布局行类型对齐配置类型 |
| b3p0 | 只出 1 系列 | 绑错数据集 + 缺 `calculationMethod` 聚合 + 设计是堆叠却用了分组类型 | 重绑表 + 每列 SUM + 201→203 + `stackAll` |

共同点：**都不是"样式没调好"，而是规格层的类型/绑定/聚合错误**。这正是插件要把"规格校验"放在渲染之前的原因。

## 2. 插件定位

### 2.1 做什么

`dm-viz` 是平台的**自定义图表配置系统**：把设计稿变成系统内可保存、可复跑、可验收的图表配置。

- 识别设计稿（自包含 HTML）的分区、图表卡与图型，运行态提取每图真实 option；
- 选型：设计图型 → 目录类型 + 预设；目录表达不了的形态用 `baked` 规格，并记录缺口；
- 配置：数据集 + 字段槽位 + 聚合 + 样式 → `ChartSpec`；分区与摆位 → `Layout`；
- 渲染：由配置驱动的**系统图表页**，数据更新后重新渲染即出新值；
- 验收：按设计稿顺序逐图配对，**系统配置的图表与设计稿 100% 一致**才交付，证据留档。

设计稿 HTML 不是交付物：它既是输入，也是验收时的对照面。

### 2.2 不做什么

- 不实现第二套 ECharts 封装层：直接用 ECharts 公开 option 语义，`defaultOption` 就是合法 option 子集。
- 不把设计稿 HTML 当作交付成品：成品是系统配置及其渲染页面，HTML 只作输入与对照。
- 不复制企业身份、调度、知识库、执行隔离——这些属于平台包。
- 不按文件名/资料类别推断数据授权；数据入口由 IT/API 与平台合同负责。
- 不把"渲染管线改代码"当作修单图的手段（RBQM 用户明确纠偏）；单图差异只能通过规格/数据/类型解决，解决不了就如实记为已知差异。
- 不做成按插件悬浮面板；入口走平台工作台应用中心（见 §5.4）。

### 2.3 与平台其他对象的关系

| 对象 | 关系 |
|---|---|
| `platform-workbook` | 只读消费：解析 xlsx，取工作表/区域/列类型 |
| `platform-knowledge` | 贡献选型、样式、验收三类方法记录 |
| `platform-control` | 交付物（配置快照 / 验收证据 / 渲染壳）作为运行成果登记与封存 |
| `platform-workbench` | 应用入口与成果预览，不新增聊天内核 |
| `dm-listing` / `dm-dvp` | 上游数据来源（Listing 结果、DVP 状态表），通过成果文件而非源码互引 |
| RBQM 等自有外系统 | **可选外部目标**。同一份 ChartSpec/Layout 可由适配器写到外部系统；适配器留在插件内，不进入平台公共包，见 §3.5 |

## 3. 数据模型

四个对象，全部为结构化 JSON，可整体序列化、整体替换、可哈希。

### 3.1 Dataset（数据集）

```ts
interface Dataset {
  id: string;                  // 不可变
  name: string;                // 可改，冲突即报错，不静默占用
  source: { artifactId: string; sheet: string; region?: Region } | { rows: Cell[][] };
  columns: Array<{
    key: string;               // 数据列键，规格引用它
    label: string;             // 展示名（默认取表头）
    type: 'number' | 'text' | 'date';
    role?: 'category' | 'value' | 'series' | 'detail';
  }>;
  rowCount: number;
  digest: string;              // 内容摘要，用于交付证据
}
```

- 列类型由实际取值推断并在注册时固化；**推断不出数值的列不得绑定到数值槽**（RBQM 10014 的根因），绑定前校验，报错带列名与实际类型。
- 非纯数值数据集允许附加 `idx` 数值兜底列，但必须在数据集元数据里标明是兜底而非业务指标。

### 3.2 ChartSpec（图表规格）

```ts
interface ChartSpec {
  id: string;
  title: string;
  mode: 'data' | 'baked';       // 必填，无默认
  type: string;                 // 目录类型键（line/bar/horizontalbar/pie/heatmap/sankey/…）
  preset?: string;              // 目录内预设变体（stacked / smooth / area …）
  datasetId?: string;           // mode=data 必填
  slots?: {                     // mode=data 必填
    category?: string;
    values: Array<{ column: string; aggregate?: 'SUM'|'AVG'|'COUNT'|'MIN'|'MAX'; label?: string }>;
    series?: string;            // 长表转宽：按该列分系列
    detail?: string[];
  };
  option?: Record<string, unknown>;  // mode=baked 必填；完整 ECharts option
  style?: StyleKeys;            // 见 §4.2
  note?: string;                // 已知差异、数据口径说明
}
```

- `mode` 必须显式声明。`baked` 规格的 `option` 含静态数据，数据变化不会自动更新——交付证据与 `ChartSpec.note` 必须写明"需重跑"，禁止静默定格。
- `type` 与 `preset` 必须命中 `catalog` 的声明；**不存在运行时新增的图表类型**。`option` 只影响当前规格，是可复制的逃生舱，不产生可复用类型。
- 规格不含布局坐标；同一规格可在多个页面复用。

### 3.3 Layout（页面布局）

```ts
interface Layout {
  pageId: string;
  columns: 24;                  // 固定
  rowHeight: 36;                // 固定
  items: Array<
    | { kind: 'chart'; specId: string; i: string; x: number; y: number; w: number; h: number }
    | { kind: 'divider'; i: string; x: number; y: number; w: number; h: number; style: DividerStyle }
  >;
}
```

- `items` 按 `i` 排序渲染，顺序确定。
- 写入是整体事务：校验 `i` 唯一、`specId` 存在、无重叠、无孤儿，任一失败整单拒绝。
- 分隔符（分区条）不参与取数进度统计。

### 3.4 Acceptance（验收记录）

```ts
interface Acceptance {
  pageId: string;
  specDigest: string;           // 规格内容摘要，规格变了旧证据自动失效
  structure: {
    items: number; rendered: number; blank: number;
    canvases: number; tables: number; dividers: number;
    overlaps: number; orphans: number; errors: string[];
  };
  pairs?: Array<{ specId: string; designRef: string; renderRef: string; verdict: 'match' | 'diff'; knownDiffs: string[] }>;
  result: 'pass' | 'fail';
}
```

`result` 只由检查得出，不由模型文字声明。

### 3.5 Target（目标系统）

同一份配置可以有两种落点，用适配器隔开，核心不感知目标：

```ts
interface Target {
  id: string;
  kind: 'platform' | 'external';
  /** 目标真实具备的能力，必须如实声明；不支持的项在 plan 阶段就报缺口 */
  capabilities(): {
    runtimeTypeRegistration: boolean;   // 目标是否需要先注册类型（RBQM 为 true，平台为 false）
    supportedTypes: string[];
    supportsBaked: boolean;
    maxSeriesPerChart?: number;
    gridColumns?: number;               // 目标网格列数（RBQM/平台均为 24）
  };
  apply(bundle: { datasets: Dataset[]; specs: ChartSpec[]; layout: Layout }): Promise<ApplyResult>;
}
```

- `platform`：写本插件存储并由自身渲染，是默认目标。
- `external`：适配器把同一份 bundle 映射成外部系统接口。RBQM 的适配器需要它的登录态与三组接口（数据集、图表配置、布局），`runtimeTypeRegistration: true`，且 201/203、10014 这类差异**只存在于适配器内部**，不回流到核心、不写进知识库当成通用规则。
- 外部适配器必须先用 `capabilities()` 暴露缺口；设计稿用到目标不支持的形态时，`plan` 直接报不可表达，不降级冒充。

## 4. 知识与样式

### 4.1 选型映射（纠正版）

RBQM 版映射表里的"绕行"项在此纠正为正常能力。目录是代码资产：新增形态＝改 `catalog.ts` 并补一条回归测试，不是运行时注册；设计稿出现目录表达不了的形态时，先用 `baked` 逃生舱并记录缺口，不扩类型。

| 设计形态 | 目录类型 | 模式 | 关键契约 |
|---|---|---|---|
| 单/多系列横条 | `horizontalbar` | data | `slots.category + slots.values[]`；堆叠用 `preset: stacked` |
| 单/多系列纵条 | `bar` | data | 同上 |
| 折线 / 面积 / 堆叠 | `line` | data | `seriesColors` 逐线；`stackAll` |
| 饼 / 环 | `pie` | data | `itemColors` 按扇区；环心文字 `centerText` |
| 热力图 | `heatmap` | data | 三槽长表：`category`(X) + `series`(Y) + `values[0]` |
| 箱线图 | `boxplot` | data | 五数列或预聚合 min/q1/med/q3/max |
| 桑基 / 关系 | `sankey` / `graph` | data 或 baked | `dataShape=graph`，nodes/links 必须同源 |
| 散点 / 气泡 / 涟漪 | `scatter` / `effectscatter` | data 或 baked | markLine/参考线走 `option` |
| 甘特 / 区间条 / 棒棒糖 / 森林图 / ECDF | `bar` / `line` / `custom` | baked | 透明底条 + duration 堆叠等组合形态 |
| KPI 卡行 | `cards` | data | 卡面字段固定契约；多行行序不保证，需钉序时一卡一图 |
| 世界 / 区域地图 | `map` | data 或 baked | 需注册 GeoJSON；visualMap 配色 |
| 表格 + 状态色 | `table` | data | 列渲染器按列键绑定；色带阈值在 style |

经验结论（保留）：**数据驱动优先**——数据更新即图表更新；烘焙只在 ECharts 组合形态无法被目录表达时使用，且必须标注。

### 4.2 样式键

沿用 RBQM 已验证的配置驱动旋钮，但作为 `ChartSpec.style` 的公开契约而非绕过白名单的旁路：

`itemColors` · `seriesColors`（line 须双写 `lineStyle.color`）· `stackAll` · `seriesDash` · `valueLabels` · `endLabels` · `centerText`/`centerSubText`/`centerTop` · `legendWithValue` · `hideLabels` · `seriesBarWidth` · `minHeight` · `yAxisInverse` · `palette`

每个键都必须有合成数据回归，证明"设置后 option 中对应字段正确、未设置时零差异"。

### 4.3 知识贡献

按 `platform-knowledge` 分类贡献三类记录：

- `chart.selection`：§4.1 映射与适用条件（含反例：什么时候不要用烘焙）。
- `chart.style`：§4.2 旋钮语义与陷阱（如折线色只染符号点）。
- `chart.acceptance`：验收标准与已知差异记录方式。

历史方法不构成工具权限；当前数据事实与用户裁定优先。

## 5. 插件形态

### 5.1 包结构

```
plugins/dm-viz/
  package.json          # @ec-clinical/dsh-dm-viz；dsh.bundle.patch；exports . 与 ./package.json
  cordis.patch.yml
  application.json      # appId ec.viz
  src/
    index.ts            # Host：注册工具与 skill，不做全局限制
    spec.ts             # Dataset / ChartSpec / Layout / Acceptance 的类型与校验（纯函数）
    catalog.ts          # 图表目录 + dataShape（由 echartsCatalog 移植）
    option.ts           # spec → ECharts option（由 buildDynamicOption 移植，去平台无关分支）
    style.ts            # §4.2 样式键适配
    datasets.ts         # 工作表 → Dataset（消费 platform-workbook 公开导出）
    layout.ts           # 网格、整体事务、确定性排序、重叠/孤儿自检
    render.ts           # 系统图表页渲染 + 验收渲染壳
    targets.ts          # Target 接口 + platform 默认目标；external 适配器另行注册
    accept.ts           # 结构验收 + 并排证据
    service.ts          # 会话内状态与产物落盘
    knowledge-seeds.ts
  knowledge/            # 选型、样式、验收三类种子
  tests/*.test.ts
  scripts/verify.mjs
  README.md
```

`src/spec.ts` / `catalog.ts` / `option.ts` / `style.ts` / `layout.ts` 不依赖 DSH 与浏览器，可独立测试；它们就是未来 `packages/platform-viz` 的平移对象。

### 5.2 工具面

工具是能力，不是流程：模型可以只调 `dm_viz_render`，也可以在没有任何设计稿时只用 `dm_viz_describe_dataset`。

| 工具 | 作用 | 事实 |
|---|---|---|
| `dm_viz_describe_dataset` | 列名、类型、行数、聚合分布 | 只回 schema 与聚合，**不回原始明细** |
| `dm_viz_plan` | 需求/设计结构 → `ChartSpec[]` 草案 + 缺口清单 | 给出选型理由与不可表达项，不假装可做 |
| `dm_viz_build` | 校验规格 + 布局并落盘 | 整单事务；失败返回逐条错误码 |
| `dm_viz_render` | 由配置渲染系统图表页（验收用渲染壳） | 同时返回结构自检（空白/重叠/孤儿/分派错误） |
| `dm_viz_verify` | 按设计稿顺序逐图配对 | 产出 `acceptance.json`；`pass` 只来自检查，未确认项为 `pending` |
| `dm_viz_status` | 当前会话的规格/产物/证据状态 | — |

### 5.3 Skill

一个 skill `dm-viz`，内容只写目标、能力与验收事实（写约束不写工具顺序）：

- 目标：从设计稿或需求得到可交付、可复跑的图表页与验收证据。
- 必须事实：`mode` 显式；空白=失败；已知差异必须记录；数据明细不进会话。
- 验收判据：§6 的检查项。

### 5.4 应用注册

```json
{
  "appId": "ec.viz",
  "displayName": "图表设计与交付",
  "description": "从设计稿或图表需求生成规格、布局与可复跑的图表页，产出验收证据。",
  "materialRoles": ["设计稿 / 图表需求", "数据产物", "样式约定（可选）"],
  "resultTypes": ["图表配置（数据集/规格/布局）", "图表页", "验收证据"],
  "capabilityId": "ec.viz.deliver"
}
```

入口通过工作台应用中心呈现，不做插件自定义悬浮面板。

## 6. 渲染与验收

### 6.1 渲染

- 渲染对象是**系统图表页**：由 Dataset + ChartSpec + Layout 驱动，与 RBQM 展示页同构（24 列网格、分区条、逐格绑定）。
- 验收需要一个可打开的页面：插件生成自包含的**渲染壳**（内联 ECharts + 由配置生成的 option + 布局），用于截图与逐图配对。渲染壳是验收面，不是交付物。
- 数据更新：数据驱动项重新渲染即出新值；`baked` 项必须重跑生成，并在证据中标注。
- PNG 导出作为可选能力（需要无头浏览器），不是默认依赖。

### 6.2 结构验收（必做，可自动）

验收粒度是**单个图表项**，不是整页汇总。整页计数只能作为附加信息，不能替代逐项结果。

| 检查 | 判据 |
|---|---|
| 空白 | `blank === 0`（图表格无 canvas/无数据提示即空白） |
| 渲染计数 | `canvases + tables === 图表项数` |
| 布局 | `overlaps === 0` 且 `orphans === 0` |
| 分派 | 每个 `item.specId` 都能解析到规格且类型存在 |
| 定位 | 每个 `i` 唯一；排序稳定（两次生成产物内容摘要一致） |
| 数据口径 | 聚合结果与数据集重算一致；`baked` 项在证据中标记"需重跑" |

### 6.3 设计稿并排验收（设计稿存在时必做）

**按设计稿顺序逐图进行，一格未确认不进入下一格。** 用整页截图代替单图确认是本会话被否决最多的问题。

- 设计稿为 HTML：运行态 `getOption()` 提取 → 与生成 option 做结构比对（系列数、类目、数值、颜色、图例、轴方向），不一致项逐条列出。
- 设计稿为截图：生成页逐格截图，与设计图并排合成，由人确认；机器只负责产出证据与记录已知差异。
- **图表选型必须与设计稿同型**：设计是堆叠横条就不能用分组横条近似；选型错误即使"看起来有图"也判不符。
- 人工确认结果写入 `Acceptance.pairs[].verdict`，不写入提示词结论；未确认项保持 `pending`，不得默认通过。

## 7. 分期与验收

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| P0 前提 | 目标项目/环境锁定；能力底图（目录类型、槽位、样式键、分派规则） | 能力清单与缺口清单落盘；目标未确认时不动配置 |
| P1 核心 | `spec/catalog/option/style/layout/render` + 配置存储 + 系统图表页渲染 + 结构验收 + 合成回归 | `pnpm verify` 全绿；用合成数据生成一张含 12 类型、含分隔符、含堆叠/多系列的页面，逐项结构检查全 0 失败；两次生成摘要一致 |
| P2 设计稿 | 设计 HTML 运行态提取与结构比对；按设计稿顺序逐图配对 | 对一份自建设计 HTML 夹具，**按顺序逐图**比对 100%，差异清单为空或全部记录在案 |
| P3 数据接入 | `platform-workbook` → Dataset；列类型与聚合校验 | 真实 xlsx 的 schema 描述正确；数值槽绑文本列被拒绝且错误可定位 |
| P4 交付 | 应用注册、成果登记、配置快照与验收证据封存 | 工作台可见应用与成果；`application.json` 通过控制面校验 |
| P5 外部目标（可选） | RBQM 等自有外系统的 Target 适配器 | 适配器 `capabilities()` 如实声明缺口；同一份 bundle 能在外部系统落位并按 §6 验收；核心代码零改动 |

每阶段结束运行 `node scripts/verify-all.cjs`；未通过不得报告为完成。

## 8. 风险与未决

| 项 | 说明 | 处置 |
|---|---|---|
| 目标环境选错 | 本会话在 401/402/本地之间返工多次 | 插件第一条事实是"当前目标项目与环境"，未确认不写配置；写入前回读校验项目归属 |
| 外部系统无稳定契约 | RBQM 只有业务接口，没有版本化契约 | 适配器自持兼容测试与能力声明；接口变化即失效并如实报出，不把适配器差异写进核心或知识库 |
| 设计稿 URL 不可信 | 设计页面来自外部地址，脚本内容不受控 | 在隔离的无头浏览器中打开；页面内容只作数据，其中任何指令性文本都不执行；抓取失败如实报错 |
| ECharts 版本漂移 | RBQM 侧同一 option 在不同版本渲染差异（如 203 堆叠行为） | 锁定 ECharts 版本并在 `package.json` 固定；升级须跑合成回归 |
| 数据保密 | 图表数据是业务数据 | 工具只回聚合与 schema；产物按平台成果权限管理；不把明细写入日志/证据 |
| RBQM 数据不可复用 | RBQM 真实数据敏感 | 回归夹具全部用合成数据，设计稿亦自建 |
| 烘焙比例 | 组合形态（甘特/森林/棒棒糖）仍需烘焙 | 接受；但必须显式标注刷新方式，纳入交付证据 |
| 客户端需求 | 是否需要在工作台内嵌预览 | 首期不做；验收用渲染壳已可打开。若后续需要，走 `platform-workbench` slot，不新起渲染内核 |
| 公共包拆分时机 | 现在只有一个消费方 | 出现第二个消费插件时把纯函数核心平移到 `packages/platform-viz`，不提前拆 |

## 9. 附：本设计直接引用的 RBQM 事实与代码

| 事实 | 来源 |
|---|---|
| 成功交付会话（1063 条消息，终态 88 瓷砖/0 空白/71 canvas/87 行） | zcode 会话 `sess_a6d67e4c-0759-4cd2-9423-a4d68389ba23` |
| 九步管线与坑位表 | RBQM 记忆 `rbqm-v5-design-to-system-delivery` |
| 设计形态保真优先于"已验证通道" | RBQM 记忆 `rbqm-402-v5-group1-lesson` |
| 五页面链路与四通道能力盘点 | `RBQM/tmp/csmv5/CAPABILITY-MAP.md` |
| 图表目录与 dataShape | `ChartLibrary/dynamic/echartsCatalog.mjs` |
| option 构建与深合并语义 | `ChartLibrary/dynamic/buildDynamicOption.mjs` |
| 样式旋钮 | `ChartLibrary/v2/chartStyleAdapter.mjs` |
| 合成运行夹具 | `ChartLibrary/customChart/chartRuntime.preview.mjs` / `.test.mjs` |
