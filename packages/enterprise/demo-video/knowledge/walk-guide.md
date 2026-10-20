# walk 脚本适配指南（walk-guide）

S1 是唯一模块相关阶段。把插件 `scripts/walk-template.mjs` 复制为 `<workDir>/walk.mjs`，
**只改三个【模块适配区】**，其余通用机制保持原样；`scripts/smoke-walk.mjs` 是无登录
最小骨架参考。录制工具会自动把 `cursor.mjs` 同步进 workDir，walk 脚本
`import './cursor.mjs'` 即可。改脚本前先 `enterprise_demo_kb(topic:"pitfalls")`。

## S0 调研（录制前建议先跑）

`enterprise_demo_survey` 驱动随包 `menu-tree-probe.mjs`：递归展开侧边栏 →
`<workDir>/menu-tree.txt`（菜单树 + 分组/叶子计数）+ 可见菜单标签中文计数。用途：

1. **覆盖清单**：不同账号/权限可见叶子不同——先知道有多少页，再定每个页面的策略
   （打开走查 / 只高亮入口 / 交付说明标注缺口）。
2. **语言门禁**：中文标签计数 >0 的页面，录制时只高亮不打开；数据级中文换账号消不掉
   （pitfalls #3）——经批准造英文演示数据 / 换数据源 / 保留标注例外。

菜单树里可见的中文标签计数只是界面层体检；进页面后的逐页体检用模板内置的
`cjk()` 助手（可见性过滤中文计数，返回 `{total, top, canvases}`，不含中文内容）：
在每个将要打开的列表页/详情/抽屉里调一次，`total>0` 即改「只高亮」；
`canvases>0` 提示图表标签语言未程序化验证（ECharts canvas 抓不到）。

## 运行契约（工具注入的环境变量）

| 变量 | 含义 |
|---|---|
| `DV_WORK` | 工作目录（必填，工具注入） |
| `DV_BASE` | 目标系统地址（工具注入 record 的 base 参数；脚本内已做 trim+尾斜杠规范化） |
| `DV_USER` / `DV_PASS` | 录制账号（密码经宿主凭据解析注入，不落脚本文件） |
| `DV_VERSION` | 演示版本（可选；选已发布、各 tab 有数据的版本） |
| `DV_MODULE` | 模块标识（录像/成片命名） |
| `DV_CHROME` / `DV_PW` | Chromium 路径 / playwright-core 包目录（工具注入部署配置） |

## 输出契约（S2 的输入，勿改结构）

脚本 finally 块写 `<DV_WORK>/timings.json`：

```json
{
  "module": "…", "steps": [{"name":"…","ok":true,"t":1.2}],
  "actions": [{"key":"act_key","t":3.4}],
  "totalDuration": 61.2, "video": "<webm 绝对路径>",
  "flashWall": 33.5, "navigations": 2
}
```

- `actions` = 所有 `act('key')` 打点（S3 旁白按 key 对位）。
- `flashWall` = 片头 260ms 全屏黑场注入时的墙钟秒（掐头对齐基准，模板已内置，勿删）。

## 三个模块适配区

1. **G 区谓词**：列表判定（表头文案，中英双语"概念对"数组）、详情/主界面判定
   （每个 tab 概念至少一个可见按钮，`every(概念 => 任一命中)`）。
2. **菜单入口**：`clickMenu***` 同款三段式——叶子点不到 → 展开子菜单 → hash 路由兜底。
3. **主流程步骤段**：全部用 `doAim/doAimClick/rowOp/tabOps` 组合，每步前
   `act('旁白锚点key')`。锚点 key 命名：段落级 `tab_*`，动作级 `<前缀>_<动作>`。
   **每段开始前 `await assertClean('<段名>')`**（模板已在各段内置）。

## 数据安全实现要点（红线落进脚本，不靠自觉）

- 弹窗一律 `closeOverlay()`：三段式关闭链 + 遮罩归零轮询 + 幽灵 popper 清理，
  **绝不点确定**（唯一例外：before-close 的「放弃编辑」确认框点主按钮；含删除/发布/
  提交等破坏性词的消息框走取消——模板 `closeOverlay` 已内置该守卫）。
- 无确认层且直连写库的按钮（先读目标系统源码确认）：只 `doAim()` 高亮 + beat，
  在 step 日志里写明「只高亮不点击」。
- 真实点击：默认禁止；用户明确同意后允许，且 step 日志与交付说明都要写明真实产物。
- 导出类下拉：只展示菜单项后 Escape，不点导出（避免下载弹窗）。
- 全程 `waitIdle`（loading mask 消失）+ `beat()` 与内容量匹配，不做无意义长等。

## 弹层卫生三件套（模板内置，勿删）

- `closeOverlay(opt)`：Escape blur 下拉 → Cancel/X → before-close 确认框（守卫见上）
  → 轮询可见 `.el-overlay` 数归零 → `purgeStrayPoppers()`。`opt.mb=true` 表示当前是
  删除/发布类破坏性确认框，只走取消。
- `purgeStrayPoppers()`：弹层全关后清掉可见的残留 popper（抽屉内 el-select 下拉
  teleport 到 body，关抽屉不带走）。
- `assertClean(tag)`：每段开始前的卫生门；脏则自愈一次再查，仍脏记账（S2 亮度剖面
  会点名遮罩累积）。

## 交互深度与长页（画面质量）

- **能点开的都点开介绍**：筛选/表单下拉真实展开读选项、抽屉/弹窗打开巡视、tab 逐个
  切换、切换按钮真点。**先验证按钮真的有效**：点了无反应=死按钮不录；`btnState()`
  探测 disabled/missing。
- **长页逐屏滚动**：`scrollSteps(times, px, aimFn)`——找最大可滚容器分步滚，每步可
  aim 一个目标（边滚边带出懒渲染图表），结束自动回顶；万像素级长页 4 屏起步。
- **预热段先全页滚一遍**（模板 warmup 已内置）再开录，否则片头扫视拍到空图。
- 每个动作带光标滑动 + 点击扩散圈；真实 click/hover 前必须先 `doAim()`；
  等待期间光标先滑向下一个目标，不出冻结帧。
- 片头直接从模块列表开始（登录/首页/预热段全部掐掉）；预热段只做组件挂载、不进成片。

## 连贯性以外的录制纪律

- 登录被拒（密码错/账号被占）时模板自动停手并如实上报——换不互踢账号或请用户释放，
  **不要改脚本加重试**。
- 录制完成后回执 `recoverCount>0` → 确认 `[recover]` 是否落在成片范围（flashWall 之后），
  是则该段为废镜头需重录。
