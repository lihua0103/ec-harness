# @ec-clinical/platform-viz

图表管线纯核心包：把"规格/目录/选项/样式/布局 → 渲染 → 结构验收 → 设计稿配对 → 交付封存"
的通用部分收拢为一个公共包，供多个业务插件复用；不含宿主工具注册、页面业务与临床领域策略。
按 `docs/DM-VIZ-PLUGIN-DESIGN.md` §5.1，在第二个消费插件出现时由 dm-viz 平移而来（2026-11-16）。

## 模块

| 模块 | 内容 |
| --- | --- |
| `errors` | `VizError`（code+detail JSON 契约）、`fail` |
| `spec` | `Dataset` / `ChartSpec` / `Layout` / `Bundle`、校验、稳定序列化与摘要 |
| `catalog` | 内置图表类型目录（不可运行时注册） |
| `option` | 槽位 + 数据集 → ECharts option（数据驱动 builder） |
| `style` | 样式键应用 |
| `plan` | 选型与缺口诊断 |
| `render` | 渲染模型与自包含 HTML 壳（24 列 × 36px 网格） |
| `accept` | 配置级结构验收（逐项，`pending` 不算通过） |
| `design` | 无头 Chrome CDP 设计稿运行态提取、选项语义比对、逐图配对 |
| `design-compile` | 提取结果 → baked 规格 + 布局 |
| `design-notes` | 卡片说明文字（question/caption/note/evidence）画布内重绘 |
| `store` | 会话级配置存储（数据集/规格/布局整体事务写入） |
| `xlsx` | 工作表 → Dataset（只读 platform-workbook 公开导出） |
| `deliver` | 交付封存（snapshot + page.html + acceptance + manifest） |
| `text` | 粗排文字宽度估算 |

## 消费方式

仓库约定：消费插件以相对路径引入 `packages/platform-viz/src/index.js`，esbuild 打包时内联；
不声明对本包的运行时依赖。插件之间禁止互相引用源码——共享逻辑一律收进本包。

## 验证

```
npm run verify
```

（typecheck 含 tests；设计稿提取测试为条件测试，未设 `DM_VIZ_CHROME` 时显式 skipped。）
