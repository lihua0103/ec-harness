# 模块演示视频流水线总览（overview）

把一次「模块全操作走查 + 英文界面 + 神经语音配音 + 动作级同步字幕」沉淀为
S0 调研 + 四阶段流水线，随企业插件 `@dsh-enterprise/demo-video` 部署。
换任何模块：只改 S1 walk 脚本的【模块适配区】与 S3 的旁白文案；S2/S4 完全模块无关。

## 阶段接口（S0 + 四阶段）

| 阶段 | 工具 | 输入 | 输出 | 关键依赖 |
|---|---|---|---|---|
| S0 调研 | enterprise_demo_survey | workDir + base（+账号） | menu-tree.txt（覆盖清单）+ 中文标签计数 | playwright-core、Chromium |
| S1 录制 | enterprise_demo_record | workDir + walk.mjs + BASE/账号 | record/*.webm + timings.json | playwright-core、Chromium、预览产物 |
| S2 锚点 | enterprise_demo_anchors | webm + timings.json | trim.json + anchors.json{key→视频秒} + 亮度剖面 | ffmpeg 逐帧 signalstats |
| S3 文案 | enterprise_demo_narrate | narration.json + anchors + trim | segs/narration.wav + captions.srt | edge-tts（联网）、44.1k wav |
| S4 合成 | enterprise_demo_compose | webm/trim/wav/srt | out/<module>[-vN].mp4 | libass 字幕、drawbox 盖黑条 |

S0 是只读调研（零写入）：不同账号/权限可见叶子不同——先知道有多少页再定覆盖清单；
中文标签计数做语言门禁（含中文的页面录制时只高亮不打开，或经批准造英文演示数据/换数据源）。

## workDir 目录契约（单目录输出，一个模块一个目录）

```
<workDir>/
  menu-tree.txt         S0 产物：菜单树 + 分组/叶子/中文标签计数（覆盖清单素材）
  walk.mjs              S1 输入：AI 适配的走查脚本（复制插件 walk-template.mjs 改三区）
  cursor.mjs            录制工具自动同步（虚拟光标运行时，勿手改）
  timings.json          S1 产物：{module, steps[], actions[], totalDuration, video, flashWall, navigations}
  record/*.webm         S1 原始录像
  flash.txt / blips.txt S2 中间产物（全帧 YAVG 序列 / 顶边条带 YMIN 序列）
  trim.json / anchors.json  S2 产物（掐头秒 / 动作→视频秒映射）
  narration.json        S3 输入：AI 撰写的旁白 [{text, at, lead}]（首句用 t）
  narration-plan.json / segs/nar_XX.wav / segs/narration.wav  S3 计划/分段/铺轨
  narration-meta.json   S3 元数据（narrationEnd/totalSec/voice/rate）
  captions.srt          S3 字幕
  out/<module>[-vN].mp4 S4 交付（自动版本递增，保留旧版）
```

## 验收门（全部程序化，禁止目测/读帧）

- S0：pass=菜单树非空且未登录被拒；cjkMenuLabels>0 的页面定「只高亮」策略。
- S1：步骤 **0 FAIL**；`actionCount>0`；视频存在；`recoverCount>0` 时确认自愈段
  是否落在成片范围（flashWall 之后），是则重录。
- S2：`黑条数≈动作数`；[推断] 行须夹在 [blip] 行之间且漂移平滑；
  **`brightness.ok=true`**——闪光后出现 <60 持续暗段（连续 ≥2 个 5s 桶）= 弹层遮罩
  累积，成片会蒙黑，修 walk 弹层关闭逻辑后重录，不带病进 S3。
- S3：调度表 `lag>1s` 的段要么精简文案要么确认仍在对应画面窗口。
- S4：首帧 `YAVG≥150`（白底页面）；`max_volume∈(-20,0]dB`；尾留白 `≥2.5s`（不足时
  工具自动 tpad 克隆末帧补齐）；**字幕实证**——对源视频同一帧带/不带字幕各探一次
  YAVG，差值 ≥0.4 才算字幕真实烧录；gates 全 true 才算 pass。

## 数据安全红线（最高优先级）

1. **只点按钮不动数据**：弹窗一律「打开→取消」；无确认层且直连写库的按钮只高亮不点击
   （写清单前先读目标系统源码确认有无确认层）；真实点击必须经用户明确同意，并在交付说明写明「真实产生了 X」。
2. **回执口径**：只允许步骤日志、UI 标签、行数计数、亮度/电平指标。禁止把页面帧/截图
   读进会话验收（用 YAVG/电平/时长程序化验证）。
3. **凭据不进模型上下文**：密码经宿主凭据（credentialRef）解析后仅注入录制子进程环境变量。
4. **单点互踢**：录制期间同一账号不得在别处登录；录制/调研共用互斥；登录被拒
   （账号被占/密码错）时**换账号或请用户释放，不循环重试**。

## 旁白撰写口径（S3）

- 每条字幕必须有配音（纯字幕层方案已被否）——全部进 narration.json，captions-extra.json 留空。
- 首句用显式 `t = 掐头+1.3`；**换素材/掐头变了必须同步改首句 t**（否则 anchor<0 被过滤，出现 N-1/N 段）。
- 其余 `{text, at: 动作key, lead}`；句长按相邻动作间隔裁剪：S1 日志打点差 - 黑条漂移 ≈ 可用秒数；
  神经语音 +12% 语速 ≈ 2.5 词/秒 + 0.5s 尾。
- 改文案不用重录：锚点来自 S2；只有文案改动才需重跑 synth（narrate 工具内部自动按
  plan→synth→mix→srt 顺序重跑，不存在顺序颠倒坑）。

## 交付口径（S4 后）

- 交付物：`out/*.mp4` + 一份同名说明 md（模块、界面语言、时长、真实点击清单、
  写库类只高亮清单、成片指标、S0 覆盖清单与未覆盖项）。
- 成片命名 `<模块>[-v<N>].mp4`；工具自动版本递增，旧版保留。
