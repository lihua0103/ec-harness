# walk 脚本适配指南（walk-guide）

S1 是唯一模块相关阶段。把插件 `scripts/walk-template.mjs` 复制为 `<workDir>/walk.mjs`，
**只改三个【模块适配区】**，其余通用机制保持原样；`scripts/smoke-walk.mjs` 是无登录
最小骨架参考。录制工具会自动把 `cursor.mjs` 同步进 workDir，walk 脚本
`import './cursor.mjs'` 即可。

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

## 数据安全实现要点（红线落进脚本，不靠自觉）

- 弹窗一律 `dismiss()`：取消优先 → X → Esc，绝不点确定。
- 无确认层且直连写库的按钮（先读目标系统源码确认）：只 `doAim()` 高亮 + beat，
  在 step 日志里写明「只高亮不点击」。
- 真实点击：默认禁止；用户明确同意后允许，且 step 日志与交付说明都要写明真实产物。
- 导出类下拉：只展示菜单项后 Escape，不点导出（避免下载弹窗）。
- 全程 `waitIdle`（loading mask 消失）+ `beat()` 与内容量匹配，不做无意义长等。

## 连贯性设计（画面质量）

- 每个动作带光标滑动 + 点击扩散圈；等待期间光标先滑向下一个目标，不出冻结帧。
- 真实 click/hover 前必须先 `doAim()`（虚拟光标先到位），否则画面箭头不动、UI 凭空弹出。
- 片头直接从模块列表开始（登录/首页/预热段全部掐掉）；预热段只做组件挂载、不进成片。
