/**
 * 企业演示视频插件入口（模块操作演示视频四阶段流水线）。
 *
 * S1 录制（Playwright walk 脚本）→ S2 锚点（ffmpeg 闪光掐头 + 黑条对齐）→
 * S3 配音字幕（edge-tts + 铺轨 + srt）→ S4 合成（libx264 + 程序化验收门）。
 * 源自经真实交付验证的模块演示视频流水线（首例：风险管理模块英文界面 34 句
 * 配音 2:46 成片）；S2/S4 模块无关，模块差异只出现在 S1 walk 脚本的
 * 【模块适配区】与 S3 旁白文案。
 *
 * 数据安全红线（knowledge/overview.md）：只点按钮不动数据；回执只含步骤日志、
 * UI 标签、行数计数、亮度/电平指标，页面帧与数据值永不回流；录制账号密码经
 * 宿主凭据解析后仅注入子进程环境变量。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { DemoVideoConfig } from './paths.js'
import { fileExists, resolveTools, TTS_TIMEOUT_MS } from './paths.js'
import { runProc } from './proc.js'
import { runRecordStage } from './record.js'
import { runAnchorsStage } from './anchors-run.js'
import { runNarrateStage } from './narration.js'
import { runComposeStage } from './compose.js'
import { fail } from './util.js'

export const name = 'enterprise-demo-video'
export const inject = ['tools', 'systemPrompt', 'credentials']

export type { DemoVideoConfig } from './paths.js'

const KB_TOPICS = ['overview', 'pitfalls', 'walk-guide'] as const
type KbTopic = (typeof KB_TOPICS)[number]

interface ToolExecutionContext {
  signal: AbortSignal
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (_args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: unknown, exec: ToolExecutionContext) => Promise<unknown>
}

interface DemoVideoContext {
  tools: { register: (definition: ToolDefinition) => () => void }
  systemPrompt: { section: (section: { name: string; order: number; text: string }) => () => void }
  /** 宿主凭据服务；模型只提交引用名，录制密码明文不出现在参数或回执。 */
  credentials?: { resolve(ref: string): Promise<{ value?: string } | undefined> }
  logger?: { info: (message: string) => void; warn?: (message: string) => void }
}

const output = {
  // Harness 只接受标准 JSON Schema；工具回执均为 JSON object。
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function registerTool(ctx: DemoVideoContext, definition: Omit<ToolDefinition, 'output'>): () => void {
  return ctx.tools.register({ ...definition, output })
}

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

async function resolveRecordPassword(
  ctx: DemoVideoContext, credentialRef: string | undefined,
): Promise<string | undefined> {
  if (credentialRef === undefined) return undefined
  if (!CREDENTIAL_REF_PATTERN.test(credentialRef)) {
    throw fail('DEMO_CREDENTIAL_REF_INVALID', 'credentialRef 必须是宿主凭据名（标识符），不是密码本身；也不要尝试凭据名变体。')
  }
  try {
    const resolved = await ctx.credentials?.resolve(credentialRef)
    const value = resolved?.value
    if (typeof value !== 'string' || value.length === 0) {
      throw fail('DEMO_CREDENTIAL_NOT_CONFIGURED', `宿主凭据 ${credentialRef} 未配置录制账号密码。请部署方在宿主凭据服务中配置后重试。`)
    }
    return value
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('DEMO_CREDENTIAL_')) throw error
    throw fail('DEMO_CREDENTIAL_RESOLVE_FAILED', `宿主凭据 ${credentialRef} 解析失败。`)
  }
}

export function apply(ctx: Context, config: DemoVideoConfig = {}): void {
  const demo = ctx as unknown as DemoVideoContext
  const tools = resolveTools(config)
  // 录制互斥：同一 dsh 进程同时只允许一场录制（同账号单点互踢会产生废镜头）。
  let activeRecording: string | null = null

  demo.systemPrompt.section({
    name: 'tool:enterprise-demo', order: 126,
    text: `# 模块演示视频工具契约（enterprise-demo）

四阶段流水线：S1 \`enterprise_demo_record\`（Playwright 走查录制）→ S2
\`enterprise_demo_anchors\`（闪光掐头+黑条锚点）→ S3 \`enterprise_demo_narrate\`
（神经语音配音+同步字幕）→ S4 \`enterprise_demo_compose\`（合成 mp4+程序化验收）。
一个模块一个 workDir（绝对路径），产物全部落在该目录；S2/S4 模块无关。

## 数据安全红线（最高优先级）
1. 只点按钮不动数据：弹窗一律「打开→取消」；无确认层且直连写库的按钮只高亮不点击；
   真实点击必须经用户明确同意，并在交付说明写明「真实产生了 X」。
2. 回执只允许步骤日志、UI 标签、行数计数、亮度/电平指标；禁止把页面帧/截图读进会话
   验收（用回执门禁：YAVG/电平/时长程序化判定，不目测）。
3. 录制密码不进模型上下文：传宿主凭据引用名（credentialRef），明文仅注入录制子进程。
4. 录制期间同一账号不得在别处登录（单点互踢产生废镜头）；同一时刻只跑一场录制。

## 工作流
1. \`enterprise_demo_preflight\`：首次使用先检查 ffmpeg/Chromium/playwright-core/python(edge-tts) 四件套。
2. 准备 walk 脚本：把插件 scripts/walk-template.mjs 复制为 <workDir>/walk.mjs，只改三个
   【模块适配区】（G 区谓词/菜单入口/模块步骤段）；无登录冒烟用 scripts/smoke-walk.mjs。
   动作锚点 key 在主流程 act('key') 处定义，S3 旁白按 key 对位。改脚本前先读
   \`enterprise_demo_kb(topic:"pitfalls")\`。
3. enterprise_demo_record（传 workDir/base/credentialRef）：验收门=步骤 0 FAIL、打点>0、视频存在。
4. enterprise_demo_anchors：验收门=黑条数≈动作数；[推断] 行须夹在 blip 行之间。
5. 写 <workDir>/narration.json：[{text, at, lead}]（首句 t=掐头+1.3）。口径：每条字幕必须
   有配音；句长按相邻动作间隔裁剪（神经语音 +12% ≈ 2.5 词/秒 + 0.5s 尾）。
6. enterprise_demo_narrate：验收门=调度表 lag>1s 的段精简文案或确认仍在画面窗口内。
7. enterprise_demo_compose：验收门=gates 全 true（首帧 YAVG≥150 / max_volume∈(-20,0]dB /
   尾留白≥2.5s）才算交付；交付时附同名说明 md（真实点击清单与只高亮清单必列）。

webm 时钟漂移是非线性的，任何墙钟方案都会失同步——黑条锚点是唯一基准，不要试图
用时间戳直除来对齐配音。`,
  })

  registerTool(demo, {
    name: 'enterprise_demo_preflight',
    description: '检查演示视频流水线四件套（ffmpeg / Chromium / playwright-core / python 的 edge-tts）与插件运行时资产，返回解析后的路径与缺口出路。首次录制前必调。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() {
      const checks: Array<{ name: string; ok: boolean; detail: string }> = []
      let ffmpegOk = false
      try {
        const r = await runProc(tools.ffmpeg, ['-version'], { timeoutMs: 15000 })
        ffmpegOk = r.code === 0
        checks.push({ name: 'ffmpeg', ok: ffmpegOk, detail: ffmpegOk ? r.stdout.split('\n')[0] : `退出码 ${r.code}（检查 cordis.patch.yml 的 ffmpegPath 或 DV_FFMPEG）` })
      } catch (error) {
        checks.push({ name: 'ffmpeg', ok: false, detail: `不可执行：${tools.ffmpeg}（${(error as Error).message.slice(0, 120)}）` })
      }
      let ttsOk = false
      try {
        const r = await runProc(tools.python, ['-c', 'import edge_tts, sys; print(sys.version.split()[0])'], { timeoutMs: 30000 })
        ttsOk = r.code === 0
        checks.push({ name: 'python+edge-tts', ok: ttsOk, detail: ttsOk ? `python ${r.stdout.trim()} + edge-tts` : `edge-tts 缺失（python -m pip install edge-tts）；stderr：${r.stderr.slice(0, 120)}` })
      } catch (error) {
        checks.push({ name: 'python+edge-tts', ok: false, detail: `python 不可执行：${tools.python}（${(error as Error).message.slice(0, 120)}）` })
      }
      const chromeOk = fileExists(tools.chromePath)
      checks.push({ name: 'chromium', ok: chromeOk, detail: chromeOk ? String(tools.chromePath) : '未配置或路径不存在（cordis.patch.yml chromePath / DV_CHROME）' })
      const pwOk = fileExists(tools.playwrightCorePath)
      checks.push({ name: 'playwright-core', ok: pwOk, detail: pwOk ? String(tools.playwrightCorePath) : '未配置或路径不存在（cordis.patch.yml playwrightCorePath / DV_PW）' })
      const assets = ['walk-template.mjs', 'cursor.mjs', 'synth-edge.py', 'smoke-walk.mjs']
        .map(f => join(tools.scriptsDir, f))
      const assetsOk = assets.every(existsSync)
      checks.push({ name: '运行时资产', ok: assetsOk, detail: assetsOk ? tools.scriptsDir : `缺失：${assets.filter(a => !existsSync(a)).join(', ')}` })
      const coreReady = ffmpegOk && ttsOk && assetsOk
      return {
        pass: coreReady,
        coreReady,
        recordReady: coreReady && chromeOk && pwOk,
        tools: {
          ffmpeg: tools.ffmpeg, python: tools.python,
          playwrightCorePath: tools.playwrightCorePath ?? null, chromePath: tools.chromePath ?? null,
          scriptsDir: tools.scriptsDir, ttsVoice: tools.ttsVoice, ttsRate: tools.ttsRate,
        },
        checks,
      }
    },
  })

  registerTool(demo, {
    name: 'enterprise_demo_record',
    description: 'S1 录制：以 DV_* 环境变量驱动 <workDir>/walk.mjs 走查脚本（Playwright 录屏），产出 webm 与 timings.json。回执只含步骤日志/计数/指标；验收门=0 FAIL、打点>0、视频存在。密码经 credentialRef 由宿主解析，不写进参数。',
    parameters: { type: 'object', properties: {
      workDir: { type: 'string', description: '工作目录绝对路径（一个模块一个目录，产物全落该目录）' },
      module: { type: 'string', description: '模块标识（录像/成片命名；缺省 demo）' },
      walkScript: { type: 'string', description: 'walk 脚本绝对路径（可选；缺省 <workDir>/walk.mjs）' },
      base: { type: 'string', description: '目标系统地址，如 http://localhost:4173' },
      user: { type: 'string', description: '录制账号名（可选；无登录页可省）' },
      credentialRef: { type: 'string', description: '宿主凭据引用名（可选）；不要填密码本身' },
      version: { type: 'string', description: '演示版本标签（可选，经 DV_VERSION 注入）' },
      timeoutMs: { type: 'integer', description: '录制超时毫秒（可选；缺省部署配置 1800000）' },
    }, required: ['workDir', 'base'], additionalProperties: false },
    async execute(args, exec) {
      const a = args as {
        workDir: string; module?: string; walkScript?: string; base: string; user?: string
        credentialRef?: string; version?: string; timeoutMs?: number
      }
      if (activeRecording !== null) {
        throw fail('DEMO_RECORD_BUSY', `已有录制在进行（${activeRecording}）：同一时刻只允许一场录制（单点互踢会产生废镜头），请等其结束。`)
      }
      const password = await resolveRecordPassword(demo, a.credentialRef)
      activeRecording = a.module ?? 'demo'
      try {
        return await runRecordStage(tools, {
          workDir: a.workDir, module: a.module, walkScript: a.walkScript, base: a.base,
          user: a.user, password, version: a.version, timeoutMs: a.timeoutMs, signal: exec.signal,
        })
      } finally {
        activeRecording = null
      }
    },
  })

  registerTool(demo, {
    name: 'enterprise_demo_anchors',
    description: 'S2 锚点：ffmpeg 场景检测定掐头点（闪光黑出+0.1s），顶边条带 blackdetect 提取动作黑条，两指针逐动作对齐（漂移就地更新），产出 anchors.json + trim.json。验收门=黑条数≈动作数。',
    parameters: { type: 'object', properties: {
      workDir: { type: 'string', description: '工作目录绝对路径' },
      timingsPath: { type: 'string', description: 'timings.json 路径（可选；缺省 <workDir>/timings.json）' },
    }, required: ['workDir'], additionalProperties: false },
    async execute(args, exec) {
      const a = args as { workDir: string; timingsPath?: string }
      return runAnchorsStage(tools, { workDir: a.workDir, timingsPath: a.timingsPath, signal: exec.signal })
    },
  })

  registerTool(demo, {
    name: 'enterprise_demo_narrate',
    description: 'S3 配音字幕：narration.json 按黑条锚点生成计划，edge-tts 合成分段并铺轨成 narration.wav，同步产出 captions.srt。改文案不用重录。验收门=调度表 lag>1s 的段需精简或确认。',
    parameters: { type: 'object', properties: {
      workDir: { type: 'string', description: '工作目录绝对路径' },
      narrationPath: { type: 'string', description: '旁白 JSON 绝对路径（可选；缺省 <workDir>/narration.json）' },
      totalSec: { type: 'number', description: '成片总秒数（可选；缺省=视频时长-掐头）' },
      voice: { type: 'string', description: '神经语音音色（可选；缺省部署配置 en-US-AriaNeural）' },
      rate: { type: 'string', description: '语速（可选；如 "+12%"）' },
    }, required: ['workDir'], additionalProperties: false },
    async execute(args, exec) {
      const a = args as { workDir: string; narrationPath?: string; totalSec?: number; voice?: string; rate?: string }
      return runNarrateStage(tools, {
        workDir: a.workDir, narrationPath: a.narrationPath, totalSec: a.totalSec,
        voice: a.voice, rate: a.rate, signal: exec.signal,
      })
    },
  })

  registerTool(demo, {
    name: 'enterprise_demo_compose',
    description: 'S4 合成：掐头 webm + 旁白 wav + 烧录字幕合成为 mp4（libx264+aac+faststart，自动版本递增保留旧版），并程序化验收（首帧 YAVG/音量电平/尾留白）。gates 全 true 才算 pass。',
    parameters: { type: 'object', properties: {
      workDir: { type: 'string', description: '工作目录绝对路径' },
      module: { type: 'string', description: '模块标识（缺省成片名 <module>.mp4）' },
      outName: { type: 'string', description: '成片名（不含目录与扩展名；已存在自动 -v2/-v3 递增）' },
    }, required: ['workDir'], additionalProperties: false },
    async execute(args, exec) {
      const a = args as { workDir: string; module?: string; outName?: string }
      return runComposeStage(tools, { workDir: a.workDir, module: a.module, outName: a.outName, signal: exec.signal })
    },
  })

  registerTool(demo, {
    name: 'enterprise_demo_kb',
    description: '读取演示视频流水线场景知识库：overview（四阶段契约+红线+验收门）/ pitfalls（全链路实测坑清单，改 walk 脚本前必读）/ walk-guide（模块适配三区+输出契约）。知识内容为方法论与门禁，不含任何数据值。',
    parameters: { type: 'object', properties: {
      topic: { type: 'string', enum: [...KB_TOPICS], description: '主题（可选，缺省 overview）' },
    }, required: [], additionalProperties: false },
    async execute(args) {
      const { topic } = (args ?? {}) as { topic?: KbTopic }
      const picked: KbTopic = topic ?? 'overview'
      if (!KB_TOPICS.includes(picked)) {
        throw fail('DEMO_KB_TOPIC_INVALID', `未知主题：${picked}（可选 ${KB_TOPICS.join('/')}）`)
      }
      const p = join(tools.knowledgeDir, `${picked}.md`)
      if (!existsSync(p)) {
        throw fail('DEMO_KB_FILE_MISSING', `知识库文件缺失：${picked}.md（部署不完整）`)
      }
      return { topic: picked, content: readFileSync(p, 'utf8') }
    },
  })

  // 部署自检：运行时资产随包完整性（缺文件在启动期就暴露，不等到录制失败）。
  const requiredAssets = ['scripts/walk-template.mjs', 'scripts/cursor.mjs', 'scripts/synth-edge.py',
    'scripts/smoke-walk.mjs', 'knowledge/overview.md', 'knowledge/pitfalls.md', 'knowledge/walk-guide.md']
  const missingAssets = requiredAssets
    .map(rel => fileURLToPath(new URL(`../${rel}`, import.meta.url)))
    .filter(p => !existsSync(p))
  if (missingAssets.length > 0) {
    demo.logger?.warn?.(`[enterprise-demo-video] 运行时资产缺失：${missingAssets.join(', ')}`)
  }
  demo.logger?.info?.(
    `[enterprise-demo-video] demo video pipeline registered (ffmpeg=${tools.ffmpeg}, ` +
    `python=${tools.python}, ttsTimeout=${TTS_TIMEOUT_MS}ms, workDir 契约=单模块单目录)`,
  )
}
