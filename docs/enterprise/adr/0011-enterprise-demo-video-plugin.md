# ADR-0011: 企业演示视频插件（enterprise-demo-video）

- 状态：已接受
- 日期：2026-09-21
- 负责人：Ding_jinghua
- 影响范围：新增 `packages/enterprise/demo-video`；`profiles/enterprise/package.json`（bundles+dependencies）；根 `tsconfig.json` references；`.oxlintrc.json`（walk 脚本规则豁免）；`docs/enterprise/CHANGELOG.md`

## 背景

系统模块操作演示视频（英文界面走查 + 神经语音配音 + 动作级同步字幕）此前以项目内
skill 形态沉淀（四阶段：录制→锚点→配音→合成），已有一个真实交付实例验证全链路。
诉求是把这条流水线从"个人会话技能"升级为随 dsh 企业层部署的插件，使任何会话里的
AI 都能按同一契约、同一验收门产出演示视频。

流水线的三个技术支点（实测得出）：

1. **动作级黑条打点 + 掐头闪光**：webm 是可变帧率，时钟漂移非线性（实测一轮
   -0.2s→+9.1s），任何墙钟映射都会失同步；只有画面内锚（顶边 120x6 黑条 110ms、
   片头 260ms 全屏黑场）可精确定位。
2. **VFR 下 black_end 不可靠**：画面静止段帧稀疏会把 110ms 黑条的 blackdetect 事件
   拉长到 0.5s+，因此闪光与黑条只能按时刻（场景检测窗口）区分，锚点取 black_start。
3. **旁白按锚点对位**：文案（narration.json 的 at/lead）与录制动作解耦，改文案不用重录。

## 决策

新增第五个企业插件 `@dsh-enterprise/demo-video`（cordis 插件模式，row id
`enterprise-demo-video`，inject tools/systemPrompt/credentials），注册六个工具：

| 工具 | 阶段 | 产物 |
|---|---|---|
| `enterprise_demo_preflight` | 0 | ffmpeg/Chromium/playwright-core/python(edge-tts) 自检 |
| `enterprise_demo_record` | S1 | webm + timings.json（walk 脚本子进程，DV_* 环境变量契约） |
| `enterprise_demo_anchors` | S2 | trim.json + anchors.json（场景检测+两指针对齐） |
| `enterprise_demo_narrate` | S3 | segs/narration.wav + captions.srt（edge-tts+纯 TS 铺轨） |
| `enterprise_demo_compose` | S4 | out/<module>[-vN].mp4 + 程序化验收门 |
| `enterprise_demo_kb` | — | 场景知识库（overview/pitfalls/walk-guide） |

- **S2/S3 的核心算法以纯函数用 TypeScript 重写**（wav 解析/铺轨、计划构建、字幕
  生成、两指针对齐、ffmpeg 输出解析），值级单测覆盖并对照首例行为锚定；S1 的 walk
  模板与虚拟光标作为随包资产（`scripts/`）保留 mjs 形态（浏览器注入脚本必须独立进程运行）。
- **部署参数走 cordis.patch.yml**（ffmpegPath/pythonExe/playwrightCorePath/chromePath/
  ttsVoice/ttsRate/超时），解析顺序 patch config > DV_* 环境变量 > PATH。
- **workDir 单目录契约**：一个模块一个绝对路径目录，全部产物落该目录（对齐"单目录
  输出"纪律）；成片版本自动递增，旧版保留。

## 不采用的方案

- **不修改官方源码/不复制 Agent Loop**：纯企业层插件，start.mjs 的目录遍历自动发现，
  零脚本改动（ADR-0001 第 7 条）。
- **不把后处理保留为 5 个独立 .mjs 子命令**：算法进 TS 才能值级单测与类型守护；
  mjs 版本只保留浏览器侧（walk/cursor），ffmpeg/TTS 编排全部进插件进程。
- **不做视觉验收**：沿用首例红线——回执只含步骤日志/UI 标签/计数/亮度电平指标，
  禁止页面帧回流会话；成片质量由 YAVG/电平/尾留白三门禁程序化判定。

## 数据与安全

- **只点按钮不动数据**：walk 模板内建"弹窗打开→取消；无确认层直连写库按钮只高亮"
  契约；真实点击必须用户明确同意且交付说明写明。
- **凭据**：录制密码经宿主凭据服务（credentialRef→resolve）解析后仅注入录制子进程
  环境变量（DV_PASS），不进模型参数、不进回执、不落 walk 脚本文件；日志回执过
  scrubSecrets + 主机掩码。
- **录制互斥**：插件级单飞（同一 dsh 进程同时只允许一场录制，单点互踢防线）。
- 模型可见内容：S1–S4 回执均为计数/路径/指标，无数据集值；本插件不触碰
  dataset/doc 红线范围（不读源数据文件）。

## 升级影响

官方升级需验证：`enterprise-demo-video` row 在 profile 实体树（profile:verify 已断言
5 企业 Bundle）；tools/systemPrompt 挂点（inject ['tools']）；ui-settings 未装配时
不影响本插件（无软依赖）；`scripts/check-architecture.mjs` 目录遍历自动覆盖新包。
walk 脚本与 cursor 的 `__dmv*` 页面全局契约如有变化，必须两侧同步并重跑 E2E。

## 验证

- `pnpm --filter @dsh-enterprise/demo-video test`：20 单测（纯核值级+装卸+schema+红线）
  + 2 ffmpeg 集成（真实 webm 夹具的锚点/合成门禁，无 ffmpeg 自动跳过）。
- 四阶段真链路 E2E（DV_E2E=1 门控）：无登录样例页 + 本机静态服务 → smoke-walk 录制 →
  锚点（8/8 黑条命中）→ edge-tts 真配音 8 句 → 合成 mp4，程序化指标：
  YAVG 227.9（白底）/ max_volume -2.5dB / 尾留白 4.32s / 总长 21.88s。
- 装配：architecture checks passed（5 插件 7 Bundle 层）、secret scan passed、
  profile verify passed（5 企业 Bundle）、typecheck passed。
- 启动：`pnpm start` 3080 WebUI boot 日志确认插件挂载。
