import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { blipAnchors, detectBlipEvents, detectFlashTrim } from './ffmpeg.js'
import type { ResolvedTools } from './paths.js'
import { computeAnchors, type TimingsFile } from './anchors.js'
import { assertWorkDir, fail } from './util.js'

export interface AnchorsStageArgs {
  workDir: string
  /** timings.json 路径；缺省 <workDir>/timings.json。 */
  timingsPath?: string
  signal?: AbortSignal
}

export interface AnchorsReceipt {
  pass: boolean
  trim: number
  flashStart: number
  startDrift: number
  blipCount: number
  actionCount: number
  matchedBlip: number
  orphanBlips: number
  inferredKeys: string[]
  matches: Array<{ key: string; videoT: number; source: 'blip' | 'inferred' }>
  anchorsPath: string
  trimPath: string
  warnings: string[]
}

/**
 * S2 锚点：闪光场景检测定掐头（黑出+0.1s）→ 顶边条带 blackdetect 提取打点黑条
 * → 两指针逐动作对齐（漂移就地更新）→ anchors.json + trim.json。
 * 这是 S3 配音同步的唯一基准（webm 时钟漂移非线性，墙钟方案全灭）。
 */
export async function runAnchorsStage(tools: ResolvedTools, args: AnchorsStageArgs): Promise<AnchorsReceipt> {
  const workDir = assertWorkDir(args.workDir)
  const timingsPath = args.timingsPath != null && args.timingsPath.trim() !== ''
    ? assertAbsolutePath(args.timingsPath)
    : join(workDir, 'timings.json')
  if (!existsSync(timingsPath)) {
    throw fail('DEMO_STAGE_ORDER', `未找到 ${timingsPath}：请先跑 S1（enterprise_demo_record）。`)
  }
  let timings: TimingsFile
  try {
    timings = JSON.parse(readFileSync(timingsPath, 'utf8')) as TimingsFile
  } catch (error) {
    throw fail('DEMO_TIMINGS_INVALID', `timings.json 解析失败：${(error as Error).message}`)
  }
  if (!Array.isArray(timings.actions) || timings.actions.length === 0) {
    throw fail('DEMO_TIMINGS_INVALID', 'timings.json 无动作打点（actions 为空）：walk 脚本主流程必须调用 act() 打点，否则旁白无法同步。')
  }
  if (!timings.video || !existsSync(timings.video)) {
    throw fail('DEMO_VIDEO_MISSING', 'timings.json 里的视频文件不存在：S1 产物被移动或删除，请重跑录制。')
  }

  const flash = await detectFlashTrim(tools.ffmpeg, timings.video, workDir, { signal: args.signal })
  const events = await detectBlipEvents(tools.ffmpeg, timings.video, { signal: args.signal })
  const blips = blipAnchors(events, flash.flashStart, flash.trim - 0.1)
  const result = computeAnchors(timings, flash.flashStart, blips)

  const anchorsPath = join(workDir, 'anchors.json')
  const trimPath = join(workDir, 'trim.json')
  writeFileSync(anchorsPath, JSON.stringify(result.anchors, null, 1))
  writeFileSync(trimPath, JSON.stringify({ trim: flash.trim, flashStart: flash.flashStart }, null, 1))

  const matchedBlip = result.matches.filter(m => m.source === 'blip').length
  const orphanBlips = blips.length - matchedBlip
  const warnings: string[] = []
  if (result.inferredKeys.length > 0) {
    warnings.push(`${result.inferredKeys.length} 个动作无黑条命中按漂移推断：${result.inferredKeys.join(', ')}（推断行须夹在 blip 行之间且漂移平滑，否则需检查 walk 打点）`)
  }
  if (orphanBlips > 0) warnings.push(`${orphanBlips} 条黑条未匹配到动作（孤儿，多为页面加载卡顿挤压）：确认动作间隔是否过密`)
  const inferredRatio = result.inferredKeys.length / timings.actions.length
  const pass = inferredRatio <= 0.3

  return {
    pass,
    trim: flash.trim,
    flashStart: flash.flashStart,
    startDrift: result.startDrift,
    blipCount: blips.length,
    actionCount: timings.actions.length,
    matchedBlip,
    orphanBlips,
    inferredKeys: result.inferredKeys,
    matches: result.matches.map(m => ({ key: m.key, videoT: m.videoT, source: m.source })),
    anchorsPath,
    trimPath,
    warnings,
  }
}

function assertAbsolutePath(p: string): string {
  if (!isAbsolute(p.trim())) throw fail('DEMO_TIMINGS_INVALID', 'timingsPath 必须是绝对路径。')
  return p.trim()
}
