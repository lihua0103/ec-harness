import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 部署参数（cordis.patch.yml row config 下发；不写死在代码，CODING_STANDARDS）。 */
export interface DemoVideoConfig {
  /** ffmpeg 绝对路径（需含 libass 以烧字幕；@ffmpeg-installer 产物满足）。 */
  ffmpegPath?: string
  /** 旁白合成用 Python 解释器（需已装 edge-tts；缺省用 PATH 中的 python）。 */
  pythonExe?: string
  /** playwright-core 包目录（经 DV_PW 注入 walk 脚本的 require）。 */
  playwrightCorePath?: string
  /** 录制用 Chromium 可执行文件（经 DV_CHROME 注入）。 */
  chromePath?: string
  /** 神经语音默认音色。 */
  ttsVoice?: string
  /** 神经语音默认语速（edge-tts rate，如 "+12%"）。 */
  ttsRate?: string
  /** S1 录制超时毫秒。 */
  recordTimeoutMs?: number
  /** S4 合成超时毫秒。 */
  composeTimeoutMs?: number
}

export interface ResolvedTools {
  ffmpeg: string
  python: string
  /** 运行 walk 脚本的 node（=当前进程，保证与宿主同版本）。 */
  node: string
  playwrightCorePath?: string
  chromePath?: string
  ttsVoice: string
  ttsRate: string
  recordTimeoutMs: number
  composeTimeoutMs: number
  /** 随包运行时资产目录（walk 模板/cursor/synth-edge/smoke-walk）。 */
  scriptsDir: string
  knowledgeDir: string
}

const DEFAULT_RECORD_TIMEOUT_MS = 1_800_000
const DEFAULT_COMPOSE_TIMEOUT_MS = 600_000
const DEFAULT_TTS_TIMEOUT_MS = 300_000

export const TTS_TIMEOUT_MS = DEFAULT_TTS_TIMEOUT_MS

function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

/**
 * 工具路径解析顺序：cordis.patch.yml config > DV_* 环境变量 > PATH 同名可执行。
 * ffmpeg/python 缺失不阻断插件装配——preflight 工具给出精确缺口与出路，
 * 真正调用到对应阶段时才 fail-fast（反对误拦截，单点缺失不瘫痪其余阶段）。
 */
export function resolveTools(config: DemoVideoConfig = {}, env: NodeJS.ProcessEnv = process.env): ResolvedTools {
  const scriptsDir = fileURLToPath(new URL('../scripts', import.meta.url))
  const knowledgeDir = fileURLToPath(new URL('../knowledge', import.meta.url))
  return {
    ffmpeg: firstDefined(config.ffmpegPath, env.DV_FFMPEG) ?? 'ffmpeg',
    python: firstDefined(config.pythonExe, env.DV_PYTHON) ?? 'python',
    node: process.execPath,
    playwrightCorePath: firstDefined(config.playwrightCorePath, env.DV_PW),
    chromePath: firstDefined(config.chromePath, env.DV_CHROME),
    ttsVoice: firstDefined(config.ttsVoice, env.DV_TTS_VOICE) ?? 'en-US-AriaNeural',
    ttsRate: firstDefined(config.ttsRate, env.DV_TTS_RATE) ?? '+12%',
    recordTimeoutMs: config.recordTimeoutMs && config.recordTimeoutMs > 0 ? config.recordTimeoutMs : DEFAULT_RECORD_TIMEOUT_MS,
    composeTimeoutMs: config.composeTimeoutMs && config.composeTimeoutMs > 0 ? config.composeTimeoutMs : DEFAULT_COMPOSE_TIMEOUT_MS,
    scriptsDir,
    knowledgeDir,
  }
}

export function fileExists(p: string | undefined): boolean {
  return typeof p === 'string' && existsSync(p)
}
