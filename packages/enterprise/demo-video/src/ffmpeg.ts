import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProc, tail, type RunOptions } from './proc.js'

export interface BlackEvent { start: number; end: number; dur: number }
export interface FlashPair { flashStart: number; trim: number }
export interface VolumeStats { maxDb: number; meanDb: number | null }

/** 解析 blackdetect stderr：`black_start:.. black_end:.. black_duration:..`（不是 picture_black_start）。 */
export function parseBlackdetect(stderr: string): BlackEvent[] {
  const events: BlackEvent[] = []
  for (const m of stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)) {
    events.push({ start: +m[1], end: +m[2], dur: +m[3] })
  }
  return events
}

/**
 * 动作黑条锚点：取每个事件的 black_start（黑条注入后首个黑帧的时刻——VFR 录像里
 * black_end 会被稀疏帧拉长，时长不可靠，时刻可靠），并按时钟窗口排除全屏闪光
 * （闪光在顶边条带同样表现为黑色事件；用 S2 场景检测的闪光入/出时刻排除，
 * 不能按时长——VFR 下打点黑条也可能被拉长到 >0.2s）。
 */
export function blipAnchors(events: BlackEvent[], flashIn: number, flashOut: number): number[] {
  const TOL = 0.15
  return events
    .filter(e => e.dur >= 0.02)
    .filter(e => !(e.start >= flashIn - TOL && e.start <= flashOut + TOL))
    .map(e => +e.start.toFixed(2))
}

/** 场景检测报告（metadata=print 输出）里的 pts_time 序列。 */
export function parseSceneTimes(report: string): number[] {
  const times: number[] = []
  for (const m of report.matchAll(/pts_time:([\d.]+)/g)) times.push(+m[1])
  return times
}

/**
 * 闪光帧在场景检测里成对出现（黑入/黑出，分值≈1）；掐头点=黑出+0.1s。
 * 取第一对间隔 (0, 1.2)s 的相邻帧；找不到返回 null（模板没注入闪光或分数不足）。
 */
export function flashPairFromScene(times: number[]): FlashPair | null {
  for (let i = 0; i + 1 < times.length; i++) {
    const span = times[i + 1] - times[i]
    if (span > 0 && span < 1.2) return { flashStart: times[i], trim: +(times[i + 1] + 0.1).toFixed(2) }
  }
  return null
}

export function parseDurationSeconds(text: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  if (!m) return null
  return +m[1] * 3600 + +m[2] * 60 + +m[3]
}

export function parseYavg(stderr: string): number | null {
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stderr)
  return m ? +m[1] : null
}

export function parseVolume(stderr: string): VolumeStats | null {
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)
  if (!max) return null
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)
  return { maxDb: +max[1], meanDb: mean ? +mean[1] : null }
}

/**
 * S2 闪光探测：场景分值 >0.6 的帧写 flash.txt（cwd 相对路径——ffmpeg 过滤器
 * 参数带盘符绝对路径会被冒号破坏解析，实测坑），掐头=黑出+0.1s。
 */
export async function detectFlashTrim(
  ffmpeg: string, webm: string, workDir: string, opts: RunOptions = {},
): Promise<FlashPair> {
  const r = await runProc(
    ffmpeg,
    ['-i', webm, '-vf', "select='gt(scene,0.6)',metadata=print:file=flash.txt", '-f', 'null', '-'],
    { cwd: workDir, ...opts },
  )
  const reportPath = join(workDir, 'flash.txt')
  let report = ''
  try {
    report = readFileSync(reportPath, 'utf8')
  } catch {
    report = r.stderr
  }
  const pair = flashPairFromScene(parseSceneTimes(report))
  if (!pair) {
    throw Object.assign(
      new Error('未检测到掐头闪光帧（场景分值>0.6 的成对黑入/黑出）。walk 脚本必须在片头注入 260ms 全屏黑场（模板已内置），否则无法精确定位掐头点。'),
      { code: 'DEMO_FLASH_NOT_FOUND', expose: true },
    )
  }
  return pair
}

/** S2 打点黑条提取：crop 顶边 120x6 条带 + blackdetect（黑条 110ms，肉眼不可见）。 */
export async function detectBlipEvents(
  ffmpeg: string, webm: string, opts: RunOptions = {},
): Promise<BlackEvent[]> {
  const r = await runProc(
    ffmpeg,
    ['-i', webm, '-vf', 'crop=120:6:0:0,blackdetect=d=0.02:pix_th=0.10', '-f', 'null', '-'],
    opts,
  )
  return parseBlackdetect(r.stderr)
}

/** 媒体总时长（秒）；解析失败抛错（后续 totalSec 推导依赖它）。 */
export async function probeDuration(ffmpeg: string, media: string, opts: RunOptions = {}): Promise<number> {
  const r = await runProc(ffmpeg, ['-i', media, '-f', 'null', '-'], opts)
  const d = parseDurationSeconds(r.stderr)
  if (d == null) {
    throw Object.assign(new Error(`无法从 ffmpeg 输出解析媒体时长：${media}`), { code: 'DEMO_PROBE_FAIL', expose: true })
  }
  return d
}

/** 取第 n 帧（0 基）的 signalstats YAVG 亮度（白底页面≈215，黑场≈16）。 */
export async function probeFrameYavg(ffmpeg: string, media: string, frameNo: number, opts: RunOptions = {}): Promise<number> {
  const r = await runProc(
    ffmpeg,
    ['-i', media, '-vf', `select='eq(n,${frameNo})',signalstats,metadata=print`, '-frames:v', '1', '-f', 'null', '-'],
    opts,
  )
  const yavg = parseYavg(r.stderr)
  if (yavg == null) {
    throw Object.assign(new Error(`无法解析 YAVG 亮度指标（frame ${frameNo}）：${tail(r.stderr, 200)}`), { code: 'DEMO_PROBE_FAIL', expose: true })
  }
  return yavg
}

export async function probeVolume(ffmpeg: string, media: string, opts: RunOptions = {}): Promise<VolumeStats> {
  const r = await runProc(ffmpeg, ['-i', media, '-af', 'volumedetect', '-f', 'null', '-'], opts)
  const vol = parseVolume(r.stderr)
  if (!vol) {
    throw Object.assign(new Error(`无法解析 volumedetect 电平指标：${tail(r.stderr, 200)}`), { code: 'DEMO_PROBE_FAIL', expose: true })
  }
  return vol
}
