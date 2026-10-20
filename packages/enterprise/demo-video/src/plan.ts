import { join } from 'node:path'

/** narration.json 条目：每条字幕必须有配音（纯字幕层方案已被否）。 */
export interface NarrationEntry {
  text: string
  /** 显式成片秒（首句用「掐头+1.3」）；与 at 二选一。 */
  t?: number
  /** 动作锚点 key（S1 打点；S2 anchors.json 的键）。 */
  at?: string
  /** 提前量：配音在动作前起句的秒数（缺省 0.3）。 */
  lead?: number
}

export interface PlanSeg {
  idx: number
  text: string
  anchorRaw: number
  /** 成片内锚点秒（= anchorRaw - 掐头）。 */
  anchor: number
  file: string
}

export interface BuiltPlan {
  plan: PlanSeg[]
  /** 引用了未知动作 key 的条目（该 key 未出现在 anchors.json；段落被跳过）。 */
  missingAnchors: string[]
  /** anchor<0.4s 被过滤的条数（贴着掐头点，无画面意义）。 */
  droppedEarly: number
}

/**
 * 旁白计划（黑条锚点口径）：anchor = (e.t ?? anchors[e.at] - lead) - trim。
 * 与首例实现同源：idx 按原始顺序从 1 编号（含后续被过滤的条目），
 * wav 文件名按 idx 固定（nar_01.wav…），保证 synth/mix/captions 三方一致。
 */
export function buildPlan(
  entries: NarrationEntry[], anchors: Record<string, number>, trim: number, segsDir: string,
): BuiltPlan {
  const missingAnchors: string[] = []
  for (const e of entries) {
    if (e.at && anchors[e.at] == null && !missingAnchors.includes(e.at)) missingAnchors.push(e.at)
  }
  let droppedEarly = 0
  const plan: PlanSeg[] = []
  entries.forEach((e, i) => {
    if (e.at && anchors[e.at] == null) return
    // 显式 t 不减 lead；锚点路径 anchor_raw = anchors[at] - lead（与首例实现同源）
    let raw: number
    if (e.t != null) {
      raw = e.t
    } else if (e.at != null) {
      raw = +(anchors[e.at] - (e.lead ?? 0.3)).toFixed(2)
    } else {
      return
    }
    const anchor = +(raw - trim).toFixed(2)
    if (anchor < 0.4) {
      droppedEarly++
      return
    }
    plan.push({
      idx: i + 1,
      text: e.text,
      anchorRaw: raw,
      anchor,
      file: join(segsDir, `nar_${String(i + 1).padStart(2, '0')}.wav`),
    })
  })
  return { plan, missingAnchors, droppedEarly }
}

export interface ExtraCaption {
  text: string
  /** 动作锚点 key。 */
  at: string
  /** 显示时长秒（缺省 2.2）。 */
  dur?: number
  /** 相对动作时刻的偏移秒。 */
  offset?: number
}

export interface SrtEntry { start: number; end: number; text: string }

/**
 * 字幕条目：旁白段窗口 = anchor-0.15 ~ anchor+语音时长+0.5；补充段（无配音动作，
 * 留空数组即可——口径是每字幕必配音，extra 仅应急）按锚点+偏移展开。
 * 条目按 start 排序并去重叠（后条 start 不得早于前条 end-0.1）。
 */
export function buildSrtEntries(
  plan: PlanSeg[],
  wavDurOf: (file: string) => number,
  extras: ExtraCaption[],
  anchors: Record<string, number>,
  trim: number,
): { entries: SrtEntry[]; unknownExtraAnchors: string[] } {
  const entries: SrtEntry[] = []
  const unknownExtraAnchors: string[] = []
  for (const seg of plan) {
    const dur = wavDurOf(seg.file)
    entries.push({ start: Math.max(0, seg.anchor - 0.15), end: seg.anchor + dur + 0.5, text: seg.text })
  }
  for (const e of extras) {
    const t = anchors[e.at]
    if (t == null) {
      unknownExtraAnchors.push(e.at)
      continue
    }
    const start = t - trim + (e.offset || 0)
    entries.push({ start: Math.max(0.3, start), end: start + (e.dur || 2.2), text: e.text })
  }
  entries.sort((a, b) => a.start - b.start)
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].start < entries[i - 1].end - 0.1) entries[i].start = entries[i - 1].end + 0.05
    if (entries[i].end <= entries[i].start + 0.6) entries[i].end = entries[i].start + 0.6
  }
  return { entries, unknownExtraAnchors }
}

function fmtTs(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0')
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`
}

export function toSrt(entries: SrtEntry[]): string {
  return entries.map((e, i) => `${i + 1}\n${fmtTs(e.start)} --> ${fmtTs(e.end)}\n${e.text}\n`).join('\n')
}

function parseSrtTs(s: string): number {
  const m = /(\d+):(\d+):(\d+),(\d+)/.exec(s)
  if (!m) return NaN
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
}

/**
 * 字幕实证门的取帧点：最长一条字幕的中点秒（成片内时间轴）。
 * 取最长条是为了让字幕黑盒面积最大、带/不带字幕的帧亮度差最可测。
 */
export function longestSrtMidpoint(srt: string): number | null {
  let best: { start: number; end: number } | null = null
  for (const m of srt.matchAll(/(\d+:\d{2}:\d{2},\d{3}) --> (\d+:\d{2}:\d{2},\d{3})/g)) {
    const start = parseSrtTs(m[1] ?? '')
    const end = parseSrtTs(m[2] ?? '')
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue
    if (!best || end - start > best.end - best.start) best = { start, end }
  }
  if (!best) return null
  return +((best.start + best.end) / 2).toFixed(2)
}
