# dm-participants · 参与者档案图表插件

RBQM 参与者级监控（participant risk oversight）的 DSH 插件：把清洗后的 canonical
Excel 工作簿接入为参与者数据集，构建 18 张图（5 个临床角色分区），渲染与设计稿
一致的自包含页面，并按平台验收判据逐图配对、验收、封存。

## 数据通道（平台原生设计）

```
各家 EDC rawdata → 统一清洗处理 → Excel → RBQM 数据集 → 图表 builder 渲染
```

- `pt_viz_import_xlsx` 消费清洗后的 canonical 工作簿；`src/data.ts` 定义契约并
  逐字保留原始行（sourceRows + provenance：路径、SHA-256、导入时间、行/列计数、
  警告）。原始数据只保留不改写；工具边界只回传 schema 与聚合，不回传原始行。
- 缺列 → `PARTICIPANT_COLUMN_MISSING` 显式报错；整域工作表缺席 → 记入
  `unknownDomains`，对应周渲染为 unknown / notdue，不生成替代数值（不编造）。
- 设计稿对齐的合成 fixtures 仅用于设计保真验收，与真实数据通道分开
  （`participant-model.ts` 的 `fixtureParticipants()` vs `data.ts`）。

## 图表与配置

- 18 张图 = 11 张标准系列 + 7 张 custom renderItem（时间线 / 哑铃 / 泳道 /
  棒棒糖 / 方块 / 子弹 / 甘特）。
- 验收配对一律用 live builder option（`buildPtLiveModel`，custom 形态保留）；
  平台 JSON 配置候选（`buildPtBundle`）里 custom 图由标准化重建等价物承载
  （`participant-rebuild.ts`，standard-series 等价 + rebuilt 标注）——JSON 不能
  携带函数，两份产物的职责不同，不混用。

## 验收判据（与 dm-viz 自定义图表插件一致）

1. 设计顺序逐图配对（`pt_viz_design_extract` → `pt_viz_design_pair`）100% 一致；
   pending 不得默认通过。
2. 结构验收（`pt_viz_verify` → `acceptPage`）：0 空白、0 重叠、0 孤儿、0 构建错误。
3. 稳定摘要：`stableStringify` 下 digest 确定，可复跑比对。
4. 交付封存（`pt_viz_deliver`）：配置快照 + acceptance.json + 渲染页 HTML 写入
   交付目录，逐文件摘要。
5. 真实宿主验证：无头浏览器（本机 msedge 通道）DOM 级画布计数与空白检查。

## 工具

| 工具 | 作用 |
| --- | --- |
| `pt_viz_status` | 会话导入/构建状态与 18 图清单 |
| `pt_viz_import_xlsx` | canonical 工作簿 → 结构完整 Participant[]（provenance + sourceRows） |
| `pt_viz_describe_dataset` | 表级列聚合（不回传原始行） |
| `pt_viz_build` | fixture / imported 两种数据源 → 平台配置候选 + live 模型 |
| `pt_viz_render` | 自包含页面 HTML（设计稿 chrome + 内嵌 bundle） |
| `pt_viz_design_extract` | 无头浏览器逐图提取设计稿 option（DM_VIZ_CHROME） |
| `pt_viz_design_pair` | 设计稿 vs live 模型逐图配对 |
| `pt_viz_verify` | acceptPage + pairs → acceptance.json |
| `pt_viz_deliver` | sealDelivery + 渲染页封存 |

## 开发

```bash
pnpm install
pnpm run build      # 两个 esbuild 入口：lib/index.js（node）+ lib/pt-charts.js（浏览器 IIFE）
pnpm run verify     # typecheck + test + build + 规范检查
```

浏览器 bundle 暴露 `window.PT`（mount / setScope / openParticipant / option），
`?selftest=1` 时向 `pre#ptcheck` 写入挂载计数与逐图系列类型，供宿主自检。
