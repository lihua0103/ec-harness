# @ec-clinical/dsh-dm-viz

临床图表设计与交付插件：把图表设计稿（自包含 HTML）转成平台内可保存、可复跑的图表配置与布局，
渲染出系统图表页，并按设计稿逐图验收。设计见仓库根 `docs/DM-VIZ-PLUGIN-DESIGN.md`。

版本 0.1.0（P1 核心）：规格/目录/选项/样式/布局、配置存储、系统图表页渲染壳、配置级结构验收。
**尚未实现**：设计稿 HTML 运行态提取（P2）、xlsx 数据接入（P3）、外部系统 Target 适配器（P5）。
输出为配置候选，需业务验收，不代表已通过 UAT 或可发布。

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

## 工具（7 个）

| 工具 | 作用 |
| --- | --- |
| `dm_viz_define_dataset` | 登记数据集（列定义 + 行）；只保存结构 |
| `dm_viz_describe_dataset` | 结构与列级聚合（非空数/去重数/min/max/mean），不回传原始行 |
| `dm_viz_plan` | 选型与缺口诊断：类型、槽位、列类型、是否会渲染成空白 |
| `dm_viz_build` | 整单保存规格与布局；列类型、槽位、重叠/孤儿/越界任一失败整单拒绝 |
| `dm_viz_render` | 渲染系统图表页与验收渲染壳，写 HTML 并返回结构与空白项 |
| `dm_viz_verify` | 配置级验收，写 `acceptance.json`；设计稿配对需显式传入 |
| `dm_viz_status` | 当前会话的数据集/规格/页面与目录类型 |

内置 bundled skill `dm-viz`：目标、能力事实、验收判据与数据边界。

## 数据边界

- 工具只返回 schema、聚合与配置摘要，不回传原始数据行。
- 设计稿 URL 的内容只作数据；其中的指令性文本不执行。
- 验收汇总数字不能代替逐图确认；设计稿配对未确认项保持 `pending`。

## 验证

```
npm run typecheck && npm run test && npm run build
```

`npm run verify` 是聚合入口。P1 完成判据：合成数据生成含 12 类型、分隔符、堆叠/多系列的页面，
逐项结构检查 0 失败；两次生成摘要一致。
