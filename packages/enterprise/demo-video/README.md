# @dsh-enterprise/demo-video

系统模块操作演示视频企业插件：把「S0 覆盖调研 + 模块全操作走查 + 英文界面 + 神经语音
配音 + 动作级同步字幕」固化为可复用的四阶段流水线，AI 通过 7 个工具驱动并按程序化
验收门交付。

## 工具面

| 工具 | 阶段 | 说明 |
|---|---|---|
| `enterprise_demo_preflight` | 0 | 四件套（ffmpeg/Chromium/playwright-core/python edge-tts）与资产自检 |
| `enterprise_demo_survey` | S0 | 菜单树探针（覆盖清单）+ 可见菜单标签中文计数（语言门禁）；只读零写入 |
| `enterprise_demo_record` | S1 | 驱动 `<workDir>/walk.mjs`（Playwright 录屏）→ webm + timings.json |
| `enterprise_demo_anchors` | S2 | 逐帧亮度掐头 + 顶边黑条逐动作对齐 → trim.json + anchors.json + 亮度剖面 |
| `enterprise_demo_narrate` | S3 | narration.json → edge-tts 分段 → 铺轨 wav + captions.srt |
| `enterprise_demo_compose` | S4 | 掐头+配音+烧字幕合成 mp4 + 程序化验收（YAVG/电平/尾留白/字幕实证） |
| `enterprise_demo_kb` | — | 场景知识库（overview / pitfalls / walk-guide） |

## 目录结构

- `src/` 插件入口与 S0+四阶段编排（S2/S3 的核心算法为纯函数，值级单测覆盖）
- `scripts/` 随包运行时资产：walk 模板（完整实例）、smoke-walk（无登录最小骨架）、
  menu-tree-probe（S0 菜单树探针）、cursor（虚拟光标）、synth-edge.py（edge-tts 合成）
- `knowledge/` 场景知识库（S0+四阶段契约/34 条实测坑/适配指南）
- `examples/` 无登录样例页（冒烟与 E2E 夹具）

## 数据安全

见 `AGENTS.md` 红线节与 `knowledge/overview.md`。要点：只点按钮不动数据；closeOverlay
只点「放弃编辑」类关闭确认主按钮，破坏性词消息框走取消；回执只含步骤日志/UI 标签/
计数/亮度电平指标；录制密码经宿主凭据注入子进程环境变量；录制与调研共用会话互斥。

## 部署参数（cordis.patch.yml）

`ffmpegPath` / `pythonExe` / `playwrightCorePath` / `chromePath` / `ttsVoice` / `ttsRate` /
`recordTimeoutMs` / `composeTimeoutMs`。解析顺序：patch config > `DV_*` 环境变量 > PATH。

## 测试

```cmd
pnpm --filter @dsh-enterprise/demo-video test          # 单测 + 装卸测
set DV_E2E=1 && pnpm --filter @dsh-enterprise/demo-video test   # 追加四阶段真链路 E2E
```

无 ffmpeg 的环境自动跳过 ffmpeg 集成组；E2E 无网络时旁白降级为本地正弦 wav 并在
输出中如实标注 `ttsSkipped=true`。

设计记录：`docs/enterprise/adr/0011-enterprise-demo-video-plugin.md`（含 2026-09-22 修订）。
