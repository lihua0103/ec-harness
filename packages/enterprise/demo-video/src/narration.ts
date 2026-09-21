import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { probeDuration } from './ffmpeg.js'
import { TTS_TIMEOUT_MS, type ResolvedTools } from './paths.js'
import { runProc, tail } from './proc.js'
import { buildPlan, buildSrtEntries, toSrt, type ExtraCaption, type NarrationEntry } from './plan.js'
import { assertWorkDir, fail } from './util.js'
import { buildWav, mixPlan, wavDurationSeconds } from './wav.js'

export interface NarrateStageArgs {
  workDir: string
  /** narration.json 绝对路径；缺省 <workDir>/narration.json。 */
  narrationPath?: string
  /** 成片总秒数；缺省=视频时长 - 掐头。 */
  totalSec?: number
  voice?: string
  rate?: string
  signal?: AbortSignal
}

export interface NarrateReceipt {
  pass: boolean
  planCount: number
  missingAnchors: string[]
  droppedEarly: number
  narrationEnd: number
  totalSec: number
  lagWarnings: Array<{ idx: number; lag: number }>
  srtCount: number
  wavPath: string
  srtPath: string
  warnings: string[]
}

/**
 * S3 文案层：narration.json → 计划（黑条锚点）→ edge-tts 合成分段 → 铺轨 wav
 * → captions.srt。改文案不用重录——锚点来自 S2 的 anchors.json。
 */
export async function runNarrateStage(tools: ResolvedTools, args: NarrateStageArgs): Promise<NarrateReceipt> {
  const workDir = assertWorkDir(args.workDir)
  const anchorsPath = join(workDir, 'anchors.json')
  const trimPath = join(workDir, 'trim.json')
  const timingsPath = join(workDir, 'timings.json')
  if (!existsSync(anchorsPath) || !existsSync(trimPath)) {
    throw fail('DEMO_STAGE_ORDER', '缺少 anchors.json/trim.json：请先跑 S2（enterprise_demo_anchors），S3 的配音同步以黑条锚点为唯一基准。')
  }
  const narrationPath = args.narrationPath != null && args.narrationPath.trim() !== ''
    ? assertAbsolutePath(args.narrationPath)
    : join(workDir, 'narration.json')
  if (!existsSync(narrationPath)) {
    throw fail('DEMO_NARRATION_MISSING', `未找到旁白文案：${narrationPath}。请按 [{ "text": "...", "at": "动作key", "lead": 0.1 }] 撰写（首句用 "t": 掐头+1.3）；每条字幕必须有配音。`)
  }
  let narration: NarrationEntry[]
  try {
    narration = JSON.parse(readFileSync(narrationPath, 'utf8')) as NarrationEntry[]
  } catch (error) {
    throw fail('DEMO_NARRATION_INVALID', `narration.json 解析失败：${(error as Error).message}`)
  }
  if (!Array.isArray(narration) || narration.length === 0) {
    throw fail('DEMO_NARRATION_INVALID', 'narration.json 必须是非空数组 [{text, at?, t?, lead?}]。')
  }
  for (const [i, e] of narration.entries()) {
    if (typeof e?.text !== 'string' || e.text.trim() === '') {
      throw fail('DEMO_NARRATION_INVALID', `第 ${i + 1} 条缺少 text。`)
    }
    if (e.t == null && !e.at) {
      throw fail('DEMO_NARRATION_INVALID', `第 ${i + 1} 条（${e.text.slice(0, 30)}…）缺 t/at：每条配音必须对位动作锚点或显式时间。`)
    }
  }

  const anchors = JSON.parse(readFileSync(anchorsPath, 'utf8')) as Record<string, number>
  const trim = (JSON.parse(readFileSync(trimPath, 'utf8')) as { trim: number }).trim
  const segsDir = join(workDir, 'segs')
  mkdirSync(segsDir, { recursive: true })
  const { plan, missingAnchors, droppedEarly } = buildPlan(narration, anchors, trim, segsDir)
  if (plan.length === 0) {
    throw fail('DEMO_PLAN_EMPTY', `旁白计划为空：全部条目的动作锚点都缺失或贴着掐头点。anchors.json 的键=${Object.keys(anchors).slice(0, 20).join(', ')}…`)
  }
  const planPath = join(workDir, 'narration-plan.json')
  writeFileSync(planPath, JSON.stringify(plan, null, 1))

  // TTS 合成（edge-tts）：失败给出精确出路（缺包/网络/ffmpeg）。
  const voice = args.voice?.trim() || tools.ttsVoice
  const rate = args.rate?.trim() || tools.ttsRate
  const synth = await runProc(
    tools.python,
    [
      join(tools.scriptsDir, 'synth-edge.py'),
      '--plan', planPath, '--segs', segsDir,
      '--voice', voice, '--rate', rate,
      '--ffmpeg', tools.ffmpeg,
    ],
    { cwd: workDir, timeoutMs: TTS_TIMEOUT_MS, signal: args.signal },
  )
  if (synth.code !== 0) {
    throw fail('DEMO_TTS_FAILED', `edge-tts 合成失败（退出码 ${synth.code}）。常见出路：python -m pip install edge-tts；检查网络（Edge 神经语音需联网）；ffmpeg 路径是否有效。stderr：${tail(synth.stderr, 400)}`)
  }

  // 成片总秒数：显式参数 > 视频时长 - 掐头。
  const timings = JSON.parse(readFileSync(timingsPath, 'utf8')) as { video?: string | null }
  let totalSec = args.totalSec
  if (totalSec == null || !(totalSec > 0)) {
    if (!timings.video || !existsSync(timings.video)) {
      throw fail('DEMO_TOTALSEC_REQUIRED', '无法从视频时长推导成片秒数（视频缺失），请显式传 totalSec（≈webm 时长 - 掐头）。')
    }
    const videoDur = await probeDuration(tools.ffmpeg, timings.video, { signal: args.signal })
    totalSec = Math.max(1, Math.round((videoDur - trim) * 100) / 100)
  }

  // 铺轨（44.1k/16bit/mono）：锚点倒挂或格式不符在 mixPlan 内 fail-fast。
  const mixed = mixPlan(plan.map(p => ({ idx: p.idx, anchor: p.anchor, file: p.file })), totalSec, 44100, f => readFileSync(f))
  if (mixed.result.narrationEnd > totalSec - 1) {
    throw fail('DEMO_NARRATION_OVERFLOW', `旁白结束 ${mixed.result.narrationEnd}s 超出成片 ${totalSec}s：精简 lag 最大段落的文案，或加大 totalSec（成片应留 ≥3s 尾）。`)
  }
  const wavPath = join(segsDir, 'narration.wav')
  writeFileSync(wavPath, buildWav(mixed.pcm))

  // 字幕：旁白段窗口 + 可选补充段（captions-extra.json）。
  const extrasPath = join(workDir, 'captions-extra.json')
  let extras: ExtraCaption[] = []
  if (existsSync(extrasPath)) {
    try {
      extras = JSON.parse(readFileSync(extrasPath, 'utf8')) as ExtraCaption[]
    } catch {
      extras = []
    }
  }
  const { entries, unknownExtraAnchors } = buildSrtEntries(
    plan, f => wavDurationSeconds(readFileSync(f)), extras, anchors, trim,
  )
  const srtPath = join(workDir, 'captions.srt')
  writeFileSync(srtPath, toSrt(entries))
  writeFileSync(join(workDir, 'narration-meta.json'), JSON.stringify({
    narrationEnd: mixed.result.narrationEnd, totalSec, trim, voice, rate, planCount: plan.length,
  }, null, 1))

  const lagWarnings = mixed.result.schedule.filter(s => s.lag > 1).map(s => ({ idx: s.idx, lag: s.lag }))
  const warnings: string[] = []
  if (missingAnchors.length) warnings.push(`无锚点的动作（对应旁白被跳过）: ${missingAnchors.join(', ')}`)
  if (droppedEarly) warnings.push(`${droppedEarly} 条旁白贴着掐头点被过滤（anchor<0.4s）`)
  if (unknownExtraAnchors.length) warnings.push(`captions-extra 引用未知动作: ${unknownExtraAnchors.join(', ')}`)
  for (const w of lagWarnings) {
    warnings.push(`第 ${w.idx} 段起播延迟 ${w.lag}s：精简该段文案，或确认其仍在对应画面窗口内`)
  }

  return {
    pass: true,
    planCount: plan.length,
    missingAnchors,
    droppedEarly,
    narrationEnd: mixed.result.narrationEnd,
    totalSec,
    lagWarnings,
    srtCount: entries.length,
    wavPath,
    srtPath,
    warnings,
  }
}

function assertAbsolutePath(p: string): string {
  if (!isAbsolute(p.trim())) throw fail('DEMO_NARRATION_INVALID', 'narrationPath 必须是绝对路径。')
  return p.trim()
}
