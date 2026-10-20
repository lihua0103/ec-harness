import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { probeDuration, probeFrameYavg, probeFrameYavgAtTime, probeVolume } from './ffmpeg.js'
import type { ResolvedTools } from './paths.js'
import { runProc, tail } from './proc.js'
import { longestSrtMidpoint } from './plan.js'
import { assertWorkDir, fail, sanitizeModule } from './util.js'

export interface ComposeStageArgs {
  workDir: string
  module?: string
  /** 成片名（不含目录与扩展名）；缺省 <module>，已存在时自动 -v2/-v3 递增。 */
  outName?: string
  signal?: AbortSignal
}

export interface CaptionProbe {
  /** 取帧点（成片内秒；最长字幕条的中点）。 */
  atSec: number
  /** 同一源帧不带字幕的 YAVG。 */
  plainYavg: number
  /** 带字幕的 YAVG（应更低）。 */
  burnedYavg: number
  /** plain − burned；≥0.4 视为字幕真实烧录。 */
  diff: number
}

export interface ComposeReceipt {
  pass: boolean
  mp4: string
  versionLabel: string
  durationSec: number
  yavg: number
  maxVolumeDb: number
  meanVolumeDb: number | null
  narrationEnd: number | null
  tailSec: number | null
  /** 尾留白不足时用 tpad 克隆末帧补齐的秒数（0=未补）。 */
  tailPadSec: number
  captionProbe: CaptionProbe | null
  gates: {
    /** 首帧亮度：白底页面 ≈215；<150 说明掐头失败（黑场残留）。 */
    whiteFirstFrame: boolean
    /** 旁白可闻：max_volume 应在 (-20, 0] dB。 */
    audibleNarration: boolean
    /** 尾留白 ≥2.5s。 */
    tailOk: boolean
    /** 字幕实证：同一源帧带/不带字幕 YAVG 差 ≥0.4（字幕真实烧录在画面上）。 */
    captionBurned: boolean
  }
  reasons: string[]
}

/** 字幕烧录样式（首例交付口径：Arial 20 / 半透明底 / 底部居中）；drawbox 盖住顶边黑条。 */
const CAPTION_STYLE =
  "subtitles=captions.srt:force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,BackColour=&H96000000,BorderStyle=4,Outline=0,Shadow=0,Alignment=2,MarginV=30'"
const VIDEO_FILTER = 'drawbox=x=0:y=0:w=122:h=8:color=white@1:t=fill,' + CAPTION_STYLE

const WHITE_FRAME_MIN_YAVG = 150
const TAIL_MIN_SEC = 2.5
/** 尾留白目标（旁白结束 + ≥3s；门禁按 TAIL_MIN_SEC 判）。 */
const TAIL_TARGET_SEC = 3
/** 字幕实证门的同帧亮度差下限（实测 -1~-3；0.4 以下视为没烧上）。 */
const CAPTION_MIN_DIFF = 0.4

/**
 * S4 合成：掐头 webm + 旁白 wav + 烧字幕 → mp4（libx264+aac+faststart），
 * 然后程序化验收（YAVG / volumedetect / 时长 / 字幕实证），全部门禁 true 才算 pass。
 * 注意：subtitles 过滤器参数用 cwd 相对文件名——ffmpeg 过滤器带盘符绝对路径
 * 会被冒号破坏解析（实测坑），故 cwd=workDir、srt 写死相对名。
 * 尾留白不足（旁白结束+3s 超出视频长度）时用 tpad 克隆末帧自动补齐：
 * tpad 对 VFR webm 不生效，必须 fps=25 在链头先转恒定帧率（实测坑）。
 */
export async function runComposeStage(tools: ResolvedTools, args: ComposeStageArgs): Promise<ComposeReceipt> {
  const workDir = assertWorkDir(args.workDir)
  const module = sanitizeModule(args.module)
  const timingsPath = join(workDir, 'timings.json')
  const trimPath = join(workDir, 'trim.json')
  const wavPath = join(workDir, 'segs', 'narration.wav')
  const srtPath = join(workDir, 'captions.srt')
  if (!existsSync(timingsPath) || !existsSync(trimPath)) {
    throw fail('DEMO_STAGE_ORDER', '缺少 timings.json/trim.json：请先跑 S1（enterprise_demo_record）与 S2（enterprise_demo_anchors）。')
  }
  if (!existsSync(wavPath) || !existsSync(srtPath)) {
    throw fail('DEMO_STAGE_ORDER', '缺少 segs/narration.wav 或 captions.srt：请先跑 S3（enterprise_demo_narrate）。')
  }
  const timings = JSON.parse(readFileSync(timingsPath, 'utf8')) as { video?: string | null; module?: string }
  const trim = (JSON.parse(readFileSync(trimPath, 'utf8')) as { trim: number }).trim
  if (!timings.video || !existsSync(timings.video)) {
    throw fail('DEMO_VIDEO_MISSING', 'timings.json 里的视频文件不存在：S1 产物被移动或删除，请重跑录制。')
  }

  let narrationEnd: number | null = null
  const metaPath = join(workDir, 'narration-meta.json')
  if (existsSync(metaPath)) {
    try {
      narrationEnd = (JSON.parse(readFileSync(metaPath, 'utf8')) as { narrationEnd?: number }).narrationEnd ?? null
    } catch { narrationEnd = null }
  }

  // 尾留白自动补齐：tpad 克隆末帧 + apad 补静音（-shortest 按补齐后的视频收口）。
  const videoDur = await probeDuration(tools.ffmpeg, timings.video, { signal: args.signal })
  const tailPadSec = narrationEnd != null
    ? Math.max(0, +((narrationEnd + TAIL_TARGET_SEC) - (videoDur - trim)).toFixed(2))
    : 0
  const useTailPad = tailPadSec > 0.05

  const outDir = join(workDir, 'out')
  mkdirSync(outDir, { recursive: true })
  const base = args.outName != null && args.outName.trim() !== ''
    ? sanitizeModule(args.outName)
    : module
  const outAbs = nextVersionedPath(outDir, base)
  const versionLabel = outAbs.split(/[\\/]/).pop() as string

  const composed = await runProc(
    tools.ffmpeg,
    [
      '-y', '-ss', String(trim), '-i', timings.video, '-i', wavPath,
      '-vf', useTailPad
        ? `fps=25,tpad=stop_mode=clone:stop_duration=${tailPadSec.toFixed(2)},${VIDEO_FILTER}`
        : VIDEO_FILTER,
      ...(useTailPad ? ['-af', 'apad'] : []),
      '-c:v', 'libx264', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-shortest', outAbs,
    ],
    { cwd: workDir, timeoutMs: tools.composeTimeoutMs, signal: args.signal },
  )
  if (composed.code !== 0) {
    throw fail('DEMO_COMPOSE_FAILED', `ffmpeg 合成失败（退出码 ${composed.code}）。stderr：${tail(composed.stderr, 600)}`)
  }

  // ---- 程序化验收（勿目测勿读帧：全部走指标）----
  const durationSec = await probeDuration(tools.ffmpeg, outAbs, { signal: args.signal })
  const yavg = await probeFrameYavg(tools.ffmpeg, outAbs, 30, { signal: args.signal })
  const vol = await probeVolume(tools.ffmpeg, outAbs, { signal: args.signal })

  // 字幕实证：对源 webm 同一帧（最长字幕条中点）带/不带字幕各探一次 YAVG，
  // 带字幕应更暗（实测半透明黑盒拉低整帧 1~3）。两次探针同一 seek 路径，差值只来自字幕。
  let captionProbe: CaptionProbe | null = null
  const tMid = longestSrtMidpoint(readFileSync(srtPath, 'utf8'))
  if (tMid != null && trim + tMid < videoDur - 0.2) {
    const plainYavg = await probeFrameYavgAtTime(tools.ffmpeg, timings.video, trim + tMid, null, { signal: args.signal })
    const burnedYavg = await probeFrameYavgAtTime(tools.ffmpeg, timings.video, trim + tMid, CAPTION_STYLE, { cwd: workDir, signal: args.signal })
    captionProbe = { atSec: tMid, plainYavg: +plainYavg.toFixed(1), burnedYavg: +burnedYavg.toFixed(1), diff: +(plainYavg - burnedYavg).toFixed(2) }
  }

  const tailSec = narrationEnd != null ? +(durationSec - narrationEnd).toFixed(2) : null
  const gates = {
    whiteFirstFrame: yavg >= WHITE_FRAME_MIN_YAVG,
    audibleNarration: vol.maxDb > -20 && vol.maxDb <= 0.5,
    tailOk: tailSec == null ? false : tailSec >= TAIL_MIN_SEC,
    captionBurned: captionProbe != null && captionProbe.diff >= CAPTION_MIN_DIFF,
  }
  const reasons: string[] = []
  if (!gates.whiteFirstFrame) reasons.push(`首帧 YAVG=${yavg}（门槛 ≥${WHITE_FRAME_MIN_YAVG}）：掐头失败或首帧为黑场`)
  if (!gates.audibleNarration) reasons.push(`max_volume=${vol.maxDb}dB：旁白缺失或电平异常（预期 (-20, 0]dB）`)
  if (!gates.tailOk) reasons.push(`尾留白 ${tailSec}s 不足 ${TAIL_MIN_SEC}s（narrationEnd=${narrationEnd}）`)
  if (!gates.captionBurned) {
    reasons.push(captionProbe == null
      ? '字幕实证未执行：captions.srt 无可解析的时间轴（先重跑 S3）'
      : `字幕实证差值 ${captionProbe.diff}（门槛 ≥${CAPTION_MIN_DIFF}）：字幕疑似未烧录（plain=${captionProbe.plainYavg} burned=${captionProbe.burnedYavg}）`)
  }

  return {
    pass: reasons.length === 0,
    mp4: outAbs,
    versionLabel,
    durationSec: +durationSec.toFixed(2),
    yavg,
    maxVolumeDb: vol.maxDb,
    meanVolumeDb: vol.meanDb,
    narrationEnd,
    tailSec,
    tailPadSec: useTailPad ? tailPadSec : 0,
    captionProbe,
    gates,
    reasons,
  }
}

/** out/<base>.mp4、<base>-v2.mp4…取下一个可用版本（保留旧版成片）。 */
function nextVersionedPath(outDir: string, base: string): string {
  let files: string[] = []
  try {
    files = readdirSync(outDir)
  } catch {
    files = []
  }
  const exists = (name: string) => files.includes(name)
  if (!exists(`${base}.mp4`)) return join(outDir, `${base}.mp4`)
  for (let v = 2; v < 1000; v++) {
    if (!exists(`${base}-v${v}.mp4`)) return join(outDir, `${base}-v${v}.mp4`)
  }
  throw fail('DEMO_OUT_VERSION_EXHAUSTED', `成片版本号耗尽：out/${base}-v*.mp4 已有 999 个，请手动归档后重试。`)
}
