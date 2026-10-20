import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProc, tail, type RunOptions } from './proc.js'

export interface BlackEvent { start: number; end: number; dur: number }
export interface FlashPair { flashStart: number; trim: number }
export interface VolumeStats { maxDb: number; meanDb: number | null }
/** 逐帧指标序列的一个点（signalstats metadata=print 输出）。 */
export interface SignalPoint { t: number; v: number }

// ---- 探测阈值（RBQM 首例全链路实测标定；改动必须重跑真实 webm 集成测试）----
/** 闪光：全帧 YAVG<40 的连续段（≥0.15s，取最长）。 */
export const FLASH_YAVG_MAX = 40
export const FLASH_MIN_DUR = 0.15
/** 打点黑条：顶边条带 YMIN<20 的帧簇（帧间断 ≤0.2s 归并，时长 0.03–0.35s）。
 * 20 而非 15：limited-range YUV 的纯黑 Y=16（ffmpeg drawbox 夹具），full-range 是 0
 * （Playwright 真实录像）——阈值须同时容纳两种，仍低于深色侧边栏的 luma（≈35+）。 */
export const BLIP_YMIN_MAX = 20
export const BLIP_MERGE_GAP = 0.2
export const BLIP_MIN_DUR = 0.03
export const BLIP_MAX_DUR = 0.35
/** 亮度剖面：5s 桶均值 <60 连续 ≥2 桶 = 弹层遮罩累积（成片作废重录）。 */
export const DARK_BUCKET_SEC = 5
export const DARK_YAVG = 60
export const DARK_MIN_BUCKETS = 2

/**
 * 解析 signalstats metadata=print 输出为 (pts_time, value) 序列。
 * ⚠️ 必须按 key 过滤：signalstats 每帧打印 YAVG/YMIN/YMAX/… 一堆指标行，
 * 不按 key 过滤会把别的指标混进来（实测坑）。
 */
export function parseSignalSeries(output: string, key: string): SignalPoint[] {
  const out: SignalPoint[] = []
  let t: number | null = null
  const re = new RegExp(`lavfi\\.signalstats\\.${key}=(-?[\\d.]+)`)
  for (const line of output.split('\n')) {
    const tp = /pts_time:([\d.]+)/.exec(line)
    if (tp) t = +tp[1]
    const m = re.exec(line)
    if (m && t != null) out.push({ t, v: +m[1] })
  }
  return out
}

/** 阈值下的连续段（相邻点间隔 >1s 视为断开；段时长按首尾点时刻差）。 */
export function thresholdRuns(series: SignalPoint[], threshold: number, minDur: number): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = []
  let s0: number | null = null
  for (let i = 0; i <= series.length; i++) {
    const cur = i < series.length ? series[i] : undefined
    const dark = cur != null && cur.v < threshold
    if (dark && s0 == null) s0 = i
    if (!dark && s0 != null) {
      const start = series[s0]
      const end = i > 0 ? series[i - 1] : undefined
      if (start && end && end.t - start.t >= minDur) runs.push({ start: start.t, end: end.t })
      s0 = null
    }
  }
  return runs
}

/**
 * 闪光定位：全帧 YAVG<40 的连续段里取最长一段。
 * 不用场景分值/靠时长区分的旧口径——闪光帧可能被虚拟光标压住几个像素、
 * 打点黑条在 VFR 下会被稀疏帧拉长，两者都实测失灵过（RBQM pitfall）。
 */
export function flashFromYavg(series: SignalPoint[]): { flashStart: number; blackEnd: number } | null {
  const runs = thresholdRuns(series, FLASH_YAVG_MAX, FLASH_MIN_DUR)
  let best: { start: number; end: number } | null = null
  for (const r of runs) {
    if (!best || r.end - r.start > best.end - best.start) best = r
  }
  return best ? { flashStart: +best.start.toFixed(2), blackEnd: +best.end.toFixed(2) } : null
}

/**
 * 打点黑条提取（纯函数）：YMIN<15 的时刻点 → 帧间断 ≤0.2s 归并成簇 →
 * 只保留时长 0.03–0.35s 的簇（VFR 拉长的杂散段、持续黑块都排除）。
 * 返回与旧 blackdetect 事件同构的 BlackEvent（锚点=start）。
 */
export function blipClustersFromYmin(series: SignalPoint[]): BlackEvent[] {
  const hits = series.filter(p => p.v < BLIP_YMIN_MAX).map(p => p.t)
  const clusters: Array<{ start: number; end: number }> = []
  for (const t of hits) {
    const last = clusters[clusters.length - 1]
    if (last && t - last.end <= BLIP_MERGE_GAP) last.end = t
    else clusters.push({ start: t, end: t })
  }
  return clusters
    .filter(c => c.end - c.start >= BLIP_MIN_DUR && c.end - c.start <= BLIP_MAX_DUR)
    .map(c => ({ start: +c.start.toFixed(2), end: +(c.end + 0.04).toFixed(2), dur: +(c.end + 0.04 - c.start).toFixed(2) }))
}

/**
 * 亮度剖面（纯函数）：把 fromT 之后的序列按 5s 桶求均值，找连续 ≥2 桶均值 <60 的区段。
 * 弹层遮罩累积（before-close 关不掉、每试一次叠一层 rgba(0,0,0,.5)）是唯一成片级
 * 亮度事故；正常弹层打开 ~150–165。<60 持续 = 成片作废重录（RBQM pitfall）。
 */
export function brightnessDarkRanges(
  series: SignalPoint[], fromT: number,
  opts: { bucketSec?: number; threshold?: number; minBuckets?: number } = {},
): Array<{ start: number; end: number; minYavg: number }> {
  const bucketSec = opts.bucketSec ?? DARK_BUCKET_SEC
  const threshold = opts.threshold ?? DARK_YAVG
  const minBuckets = opts.minBuckets ?? DARK_MIN_BUCKETS
  const pts = series.filter(p => p.t >= fromT)
  if (pts.length === 0) return []
  const buckets = new Map<number, { sum: number; n: number }>()
  for (const p of pts) {
    const b = Math.floor(p.t / bucketSec)
    const cur = buckets.get(b) ?? { sum: 0, n: 0 }
    cur.sum += p.v
    cur.n += 1
    buckets.set(b, cur)
  }
  // 序列按时间升序遍历，桶号天然升序（Map 保持插入序），无需排序
  const keys = [...buckets.keys()]
  const ranges: Array<{ start: number; end: number; minYavg: number }> = []
  let run: Array<{ k: number; mean: number }> = []
  const flush = () => {
    const first = run[0]
    const last = run[run.length - 1]
    if (run.length >= minBuckets && first && last) {
      ranges.push({
        start: +(first.k * bucketSec).toFixed(2),
        end: +((last.k + 1) * bucketSec).toFixed(2),
        minYavg: +Math.min(...run.map(r => r.mean)).toFixed(1),
      })
    }
    run = []
  }
  let prevKey: number | null = null
  for (const k of keys) {
    const b = buckets.get(k)
    if (!b) continue
    const mean = b.sum / b.n
    if (mean < threshold) {
      // 桶号不连续（中间有空档）视作两段，先把上一段收口
      if (run.length > 0 && prevKey != null && k !== prevKey + 1) flush()
      run.push({ k, mean })
    } else {
      flush()
    }
    prevKey = k
  }
  flush()
  return ranges
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
 * S2 逐帧亮度扫描：跑一路 signalstats 把指标写进 cwd 相对文件（ffmpeg 过滤器
 * 参数带盘符绝对路径会被冒号破坏解析——实测坑），返回序列文本。
 */
async function scanSignalStats(
  ffmpeg: string, webm: string, vf: string, outFile: string, workDir: string, opts: RunOptions = {},
): Promise<string> {
  const r = await runProc(
    ffmpeg,
    ['-hide_banner', '-i', webm, '-vf', `${vf},metadata=print:file=${outFile}`, '-f', 'null', '-'],
    { cwd: workDir, ...opts },
  )
  try {
    return readFileSync(join(workDir, outFile), 'utf8')
  } catch {
    return r.stderr
  }
}

/**
 * S2 闪光探测（逐帧全帧 YAVG）：最长暗段 <40 且 ≥0.15s = 闪光；
 * flashStart=黑入，掐头 trim=黑出+0.1s（成片首帧必须落在闪光出画后的白底帧上）。
 */
export async function detectFlashByYavg(
  ffmpeg: string, webm: string, workDir: string, opts: RunOptions = {},
): Promise<{ flashStart: number; trim: number; series: SignalPoint[] }> {
  const report = await scanSignalStats(ffmpeg, webm, 'signalstats', 'flash.txt', workDir, opts)
  const series = parseSignalSeries(report, 'YAVG')
  const flash = flashFromYavg(series)
  if (!flash) {
    throw Object.assign(
      new Error('未检测到片头黑场闪光（全帧 YAVG<40 且 ≥0.15s 的连续段）。walk 脚本必须在片头注入 260ms 全屏黑场（模板已内置），否则无法精确定位掐头点。'),
      { code: 'DEMO_FLASH_NOT_FOUND', expose: true },
    )
  }
  return { flashStart: flash.flashStart, trim: +(flash.blackEnd + 0.1).toFixed(2), series }
}

/** S2 打点黑条提取：crop 顶边 120x6 条带逐帧 YMIN（黑条 110ms，肉眼不可见）。 */
export async function detectBlipEvents(
  ffmpeg: string, webm: string, workDir: string, opts: RunOptions = {},
): Promise<BlackEvent[]> {
  const report = await scanSignalStats(ffmpeg, webm, 'crop=120:6:0:0,signalstats', 'blips.txt', workDir, opts)
  return blipClustersFromYmin(parseSignalSeries(report, 'YMIN'))
}

/**
 * 动作黑条锚点：取每个事件的 start（首个黑帧时刻，可靠），并按闪光入/出时刻窗口排除
 * （闪光在顶边条带同样表现为黑色事件；不能按时长排除——VFR 下打点黑条也可能被拉长）。
 */
export function blipAnchors(events: BlackEvent[], flashIn: number, flashOut: number): number[] {
  const TOL = 0.15
  return events
    .filter(e => e.dur >= 0.02)
    .filter(e => !(e.start >= flashIn - TOL && e.start <= flashOut + TOL))
    .map(e => +e.start.toFixed(2))
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

/**
 * 按时间点取单帧 YAVG（可叠加额外 vf，如 subtitles——字幕实证门用：
 * 同一帧带/不带字幕各探一次，带字幕应更暗）。
 * ⚠️ 必须 -copyts：-ss 输入寻址后时间戳默认归零，subtitles 滤镜按 pts 命中事件，
 * 归零后永远落在第一条字幕之前 → 实测差值恒 0（字幕疑似未烧录的假象）。
 */
export async function probeFrameYavgAtTime(
  ffmpeg: string, media: string, timeSec: number, extraVf: string | null, opts: RunOptions = {},
): Promise<number> {
  const vf = extraVf ? `${extraVf},signalstats,metadata=print` : 'signalstats,metadata=print'
  const r = await runProc(
    ffmpeg,
    ['-ss', timeSec.toFixed(2), '-copyts', '-i', media, '-vf', vf, '-frames:v', '1', '-f', 'null', '-'],
    opts,
  )
  const yavg = parseYavg(r.stderr)
  if (yavg == null) {
    throw Object.assign(new Error(`无法解析 YAVG 亮度指标（t=${timeSec}s）：${tail(r.stderr, 200)}`), { code: 'DEMO_PROBE_FAIL', expose: true })
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
