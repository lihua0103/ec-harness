# AGENTS.md — enterprise-demo-video

系统模块操作演示视频插件（S0 调研 + 四阶段流水线）。适用场景：用户要求「录制某模块
的操作/演示/带配音走查视频」，或要求把既有视频流水线复用到新模块。

## 固定工作流（顺序不可跳）

1. `enterprise_demo_preflight`：确认 ffmpeg / Chromium / playwright-core / python(edge-tts)
   四件套与随包资产齐备；缺口按回执出路处理，不盲目重试。
2. `enterprise_demo_survey`（S0，录制前先跑）：拉菜单树（menu-tree.txt）定覆盖清单 +
   中文标签计数做语言门禁——含中文的页面只高亮不打开，或经批准造英文演示数据/换数据源。
   不同账号/权限可见叶子不同，先知道有多少页再定清单。
3. 准备 walk 脚本：复制插件 `scripts/walk-template.mjs` 为 `<workDir>/walk.mjs`，只改
   三个【模块适配区】（G 区谓词 / 菜单入口 / 模块步骤段）。无登录冒烟用
   `scripts/smoke-walk.mjs`。**动笔前先 `enterprise_demo_kb(topic:"pitfalls")`**。
   弹层关闭一律 closeOverlay 三段式（模板内置），每段开始前 assertClean，长页用 scrollSteps。
4. `enterprise_demo_record`（workDir + base + credentialRef）→ 门禁：步骤 0 FAIL、
   打点>0、视频存在。FAIL 时读 logTail 改脚本重录，不逐帧看视频；recoverCount>0 时
   确认自愈段是否在成片范围，是则重录。
5. `enterprise_demo_anchors` → 门禁：黑条数≈动作数；[推断] 行夹在 blip 行之间；
   **brightness.ok=true**（<60 持续暗段=弹层遮罩累积，修 walk 重录，不带病进 S3）。
6. 写 `<workDir>/narration.json`（每条字幕必须有配音；首句 t=掐头+1.3，换素材掐头变了
   要同步改；句长按动作间隔裁剪，神经语音 +12% ≈ 2.5 词/秒 +0.5s 尾）→
   `enterprise_demo_narrate` → 门禁：lag>1s 的段精简文案或确认仍在画面窗口。
7. `enterprise_demo_compose` → 门禁：gates 全 true（首帧 YAVG≥150 / max_volume∈(-20,0]dB /
   尾留白≥2.5s / 字幕实证 diff≥0.4）才可宣称交付；交付说明 md 必须列「真实点击清单」
   与「只高亮清单」，并附 S0 覆盖清单与未覆盖项。

## 三道门禁（U/A/D 简版）

- **U-Gate（写 walk 前理解需求）**：模块入口路由、各 tab/页面判定文案（中英）、演示
  版本、可真实点击与必须高亮的按钮清单、S0 覆盖清单与语言门禁结论——未确认项先问
  用户，不代拟。
- **A-Gate（锚点验收）**：S2 回执 inferredKeys 占比 >30% 或 brightness.ok=false 即
  pass=false，必须回查 walk 打点间隔（页面卡顿会挤压黑条）或弹层关闭逻辑（遮罩累积），
  不得带病进 S3。
- **D-Gate（交付四查）**：产物只落 workDir/out；成片命名带版本；回执门禁全 true
  （含字幕实证）；交付说明写明界面语言、时长、真实点击产物、数据零变更声明、S0 覆盖缺口。

## 红线（最高优先级，违反即事故）

1. **只点按钮不动数据**：弹窗一律「打开→取消」；无确认层且直连写库的按钮只高亮
   不点击（写清单前先读目标系统源码确认有无确认层）；真实点击必须经用户明确同意，
   并在交付说明写明「真实产生了 X」。closeOverlay 只点「放弃编辑」类关闭确认的主按钮，
   破坏性词（删除/发布/提交）的消息框走取消。
2. **回执口径**：只允许步骤日志、UI 标签、行数计数、亮度/电平指标。禁止把页面帧/
   截图读进会话，禁止目测验收。
3. **凭据**：录制密码只经宿主凭据（credentialRef）解析注入子进程，不进参数/回执/
   walk 脚本文件。
4. **单点互踢**：录制期间同账号不得在别处登录；同一时刻只跑一场会话（录制/调研互斥）；
   登录被拒（账号被占/密码错）时换账号或请用户释放，**不循环重试**。

## 目录契约（单目录输出）

一个模块一个 workDir（绝对路径），全部产物落该目录：
`menu-tree.txt / walk.mjs / cursor.mjs(自动) / timings.json / record/*.webm /
flash.txt+blips.txt(S2中间) / trim.json / anchors.json / narration.json /
narration-plan.json / segs/*.wav / narration-meta.json / captions.srt /
out/<module>[-vN].mp4`。不要把中间产物散落到 workDir 之外，不要动 cursor.mjs。

## 铁律

- webm 时钟漂移非线性：配音对位只认 S2 黑条锚点，禁止墙钟/时间戳直除。
- S2/S4 模块无关，改需求只动 S1 walk 适配区与 S3 文案；改通用脚本（cursor/锚点/
  铺轨/探测阈值）必须跑包内全量测试 + 真链路 E2E 回归。
- 知识沉淀：新坑回填 `knowledge/pitfalls.md`（含预防性门禁措辞），方法论不沉淀字段值。
