import { describe, expect, it } from 'vitest'
import { parseWav, buildWav, mixPlan, wavDurationSeconds } from './wav.js'
import { buildPlan, buildSrtEntries, toSrt, longestSrtMidpoint, type NarrationEntry } from './plan.js'
import { computeAnchors } from './anchors.js'
import {
  blipAnchors, blipClustersFromYmin, brightnessDarkRanges, flashFromYavg,
  parseDurationSeconds, parseSignalSeries, parseVolume, parseYavg,
  type SignalPoint,
} from './ffmpeg.js'

const mkSegWav = (sec: number) => buildWav(Buffer.alloc(sec * 44100 * 2))

/** 构造等间隔逐帧序列（25fps），v 恒定。 */
const seriesOf = (pairs: Array<[number, number, number]>): SignalPoint[] => {
  const out: SignalPoint[] = []
  for (const [t0, t1, v] of pairs) {
    for (let t = t0; t < t1 - 1e-9; t += 0.04) out.push({ t: +t.toFixed(3), v })
  }
  return out
}

describe('ffmpeg 输出解析', () => {
  it('signalstats 序列解析按 key 过滤（YAVG 不混入 YMIN 等），pts_time 跨行跟踪', () => {
    const out = [
      'frame:0 pts:0 pts_time:0.00',
      'lavfi.signalstats.YAVG=215.03',
      'lavfi.signalstats.YMIN=16.0',
      'frame:1 pts:25 pts_time:0.04',
      'lavfi.signalstats.YAVG=214.88',
      'lavfi.signalstats.YMIN=15.0',
      '无关行',
    ].join('\n')
    expect(parseSignalSeries(out, 'YAVG')).toEqual([
      { t: 0, v: 215.03 }, { t: 0.04, v: 214.88 },
    ])
    expect(parseSignalSeries(out, 'YMIN')).toEqual([
      { t: 0, v: 16 }, { t: 0.04, v: 15 },
    ])
  })

  it('闪光定位：全帧 YAVG<40 最长连续段（≥0.15s）；黑条被拉长也不会误判为闪光之外', () => {
    // 1.0-1.24 暗场（7 帧 ≈0.24s），其余白底 215
    const series = seriesOf([[0, 1.0, 215], [1.0, 1.28, 12], [1.28, 3, 215]])
    const flash = flashFromYavg(series)
    expect(flash).toEqual({ flashStart: 1.0, blackEnd: 1.24 })
    // 暗段太短（<0.15s）不算闪光
    const short = seriesOf([[0, 1.0, 215], [1.0, 1.08, 12], [1.08, 3, 215]])
    expect(flashFromYavg(short)).toBeNull()
    // 不足 0.15s 的暗段被滤掉，取合格段里的最长
    const two = seriesOf([[0, 1, 215], [1, 1.16, 10], [1.16, 2, 215], [2, 2.28, 10], [2.28, 4, 215]])
    expect(flashFromYavg(two)).toEqual({ flashStart: 2, blackEnd: 2.24 })
  })

  it('黑条帧簇：YMIN<15 归并（间隔 ≤0.2s）、只留 0.03–0.35s 簇，锚点=start', () => {
    // 2.0-2.08 连续 3 帧黑条（110ms 打点）；2.5-2.58 第二条；99.9-100.9 长黑块被时长上限排除
    const series = [
      ...seriesOf([[0, 2.0, 200], [2.0, 2.12, 5], [2.12, 2.5, 200], [2.5, 2.62, 5], [2.62, 99.9, 200], [99.9, 100.9, 5], [100.9, 102, 200]]),
    ]
    const evs = blipClustersFromYmin(series)
    expect(evs.map(e => e.start)).toEqual([2.0, 2.5])
    for (const e of evs) {
      expect(e.dur).toBeGreaterThanOrEqual(0.03)
      expect(e.dur).toBeLessThanOrEqual(0.35)
    }
    // 单帧命中（≈0.04s < 0.03 阈值边界）会被最短时长过滤
    const single = seriesOf([[0, 1, 200], [1, 1.04, 5], [1.04, 2, 200]])
    expect(blipClustersFromYmin(single)).toEqual([])
    // 闪光窗口按时刻排除（不能按时长：VFR 会把黑条拉长）
    expect(blipAnchors(evs, 2.4, 2.61)).toEqual([2.0])
    expect(blipAnchors(evs, 10, 11)).toEqual([2.0, 2.5])
  })

  it('亮度剖面：5s 桶均值 <60 连续 ≥2 桶 = 遮罩累积区段；孤立暗桶不报', () => {
    // 10-25s 三桶全暗（遮罩累积）；其余白底
    const series = seriesOf([[0, 10, 215], [10, 25, 40], [25, 30, 215]])
    const ranges = brightnessDarkRanges(series, 0)
    expect(ranges).toEqual([{ start: 10, end: 25, minYavg: 40 }])
    // 孤立暗桶（5s）不构成持续段
    const single = seriesOf([[0, 10, 215], [10, 15, 40], [15, 30, 215]])
    expect(brightnessDarkRanges(single, 0)).toEqual([])
    // fromT 之前的登录/预热段不参与
    expect(brightnessDarkRanges(series, 26)).toEqual([])
    // 非连续暗桶（中间亮桶断开）分两段，各不足 2 桶不报
    const split = seriesOf([[0, 5, 40], [5, 10, 215], [10, 15, 40], [15, 20, 215]])
    expect(brightnessDarkRanges(split, 0)).toEqual([])
  })

  it('Duration/YAVG/volumedetect 指标解析', () => {
    expect(parseDurationSeconds('  Duration: 00:02:46.08, start: 0.000000')).toBeCloseTo(166.08)
    expect(parseDurationSeconds('没有时长')).toBeNull()
    expect(parseYavg('lavfi.signalstats.YAVG=215.03')).toBeCloseTo(215.03)
    expect(parseYavg('none')).toBeNull()
    const vol = parseVolume('[Parsed_volumedetect] max_volume: -2.1 dB\nmean_volume: -18.4 dB')
    expect(vol).toEqual({ maxDb: -2.1, meanDb: -18.4 })
    expect(parseVolume('no volume')).toBeNull()
  })

  it('字幕实证取帧点：最长字幕条的中点', () => {
    const srt = '1\n00:00:02,850 --> 00:00:04,500\nA\n\n2\n00:00:10,000 --> 00:00:14,000\nB\n'
    expect(longestSrtMidpoint(srt)).toBe(12)
    expect(longestSrtMidpoint('no srt here')).toBeNull()
  })
})

describe('wav 解析/构建/铺轨', () => {
  const pcm = Buffer.alloc(44100 * 2) // 1s 静音 16bit mono
  const wav = buildWav(pcm)

  it('构建后可回读且时长一致', () => {
    const parsed = parseWav(wav)
    expect(parsed).toMatchObject({ rate: 44100, bits: 16, channels: 1 })
    expect(wavDurationSeconds(wav)).toBeCloseTo(1.0)
    expect(() => parseWav(Buffer.from('not a wav'))).toThrow()
  })

  it('mixPlan 按锚点铺轨：顺延/锚点倒挂进 lag/格式不符抛错', () => {
    const { pcm: mixed, result } = mixPlan([
      { idx: 1, anchor: 0.5, file: 'a.wav' },
      { idx: 2, anchor: null, thenGap: 0.5, file: 'b.wav' },
    ], 10, 44100, file => (file === 'a.wav' ? mkSegWav(1) : mkSegWav(2)))
    expect(result.schedule).toEqual([
      { idx: 1, start: 0.5, dur: 1, end: 1.5, lag: 0 },
      { idx: 2, start: 2, dur: 2, end: 4, lag: 0 },
    ])
    expect(result.narrationEnd).toBeCloseTo(4)
    expect(mixed.length).toBe(10 * 44100 * 2)

    // 锚点倒挂不抛错（与首例同源）：顺延到前段结束+0.15，倒挂量进 lag 由回执点名
    const late = mixPlan([
      { idx: 1, anchor: 3, file: 'a.wav' },
      { idx: 2, anchor: 0.5, file: 'b.wav' },
    ], 10, 44100, () => mkSegWav(1))
    expect(late.result.schedule[1]).toMatchObject({ start: 4.15, lag: 3.65 })
    // 格式不符 fail-fast
    expect(() => mixPlan([{ idx: 1, anchor: 0, file: 'x.wav' }], 10, 22050, () => mkSegWav(1)))
      .toThrow(/format mismatch/)
  })
})

describe('旁白计划与字幕', () => {
  const anchors = { export_menu: 20.0, dialog_open: 26.5, tab_data: 31.2 }
  const entries: NarrationEntry[] = [
    { text: 'First line.', t: 8.0 },
    { text: 'Export menu opens here.', at: 'export_menu', lead: 0.1 },
    { text: 'Dialog opens.', at: 'dialog_open' },
    { text: 'Unknown anchor.', at: 'nope' },
    { text: 'Too early.', at: 'export_menu', lead: 30 },
  ]

  it('buildPlan：anchor=(t ?? anchors[at]-lead)-trim，未知锚点与过早段落处理', () => {
    const { plan, missingAnchors, droppedEarly } = buildPlan(entries, anchors, 5, 'C:/w/segs')
    expect(missingAnchors).toEqual(['nope'])
    expect(droppedEarly).toBe(1)
    expect(plan).toHaveLength(3)
    expect(plan[0]).toMatchObject({ idx: 1, anchor: 3 })          // 8 - 5
    expect(plan[1]).toMatchObject({ idx: 2, anchor: 14.9 })        // 20 - 0.1 - 5
    expect(plan[2]).toMatchObject({ idx: 3, anchor: 21.2 })        // 26.5 - 0.3(缺省lead) - 5
    expect(plan[1]?.file).toContain('nar_02.wav')
  })

  it('buildSrtEntries：窗口=anchor-0.15 ~ anchor+语音+0.5，排序去重叠；toSrt 格式', () => {
    const { entries: srt, unknownExtraAnchors } = buildSrtEntries(
      [
        { idx: 1, text: 'A', anchorRaw: 8, anchor: 3, file: 'a.wav' },
        { idx: 2, text: 'B', anchorRaw: 14.9, anchor: 9.9, file: 'b.wav' },
      ],
      file => (file === 'a.wav' ? 1 : 0.5),
      [{ text: 'extra', at: 'tab_data', dur: 2 }],
      anchors, 5,
    )
    expect(unknownExtraAnchors).toEqual([])
    expect(srt[0]).toMatchObject({ start: 2.85, end: 4.5 })
    expect(srt[1]).toMatchObject({ start: 9.75 })
    expect(srt[2]?.text).toBe('extra')
    // 去重叠：把 B 的锚点贴着 A 的结尾
    const overlap = buildSrtEntries(
      [
        { idx: 1, text: 'A', anchorRaw: 8, anchor: 3, file: 'a.wav' },
        { idx: 2, text: 'B', anchorRaw: 8.2, anchor: 3.6, file: 'a.wav' },
      ],
      () => 2, [], {}, 0,
    )
    expect(overlap.entries[1].start).toBeGreaterThanOrEqual(overlap.entries[0].end)
    const text = toSrt(srt)
    expect(text).toContain('1\n00:00:02,850 --> 00:00:04,500\nA\n')
    expect(text).toContain('-->')
  })
})

describe('S2 两指针锚点对齐', () => {
  it('黑条命中更新漂移，缺口动作推断，孤儿黑条丢弃', () => {
    const actions = [
      { key: 'a', t: 10 },
      { key: 'b', t: 12 },
      { key: 'c', t: 14 },
      { key: 'd', t: 16 },
    ]
    // 漂移从 -1 起：a 命中 9.0；b/c 无黑条（17.0 在窗口外）按漂移推断；
    // d 的 expect=15 命中 17.0（≤17.4），漂移更新为 +1；99 是孤儿。
    const blips = [9.0, 17.0, 99]
    const r = computeAnchors({ actions, flashWall: 11 }, 10, blips)
    expect(r.startDrift).toBe(-1)
    expect(r.anchors.a).toBeCloseTo(9.0)
    expect(r.matches.find(m => m.key === 'a')?.source).toBe('blip')
    expect(r.inferredKeys).toEqual(['b', 'c'])
    expect(r.anchors.b).toBeCloseTo(11)
    expect(r.anchors.c).toBeCloseTo(13)
    expect(r.anchors.d).toBeCloseTo(17.0)
    expect(r.matches.find(m => m.key === 'd')).toMatchObject({ source: 'blip', drift: 1 })
    expect(r.matches.every(m => m.videoT !== 99)).toBe(true)
  })

  it('flashWall 缺省回退旧版 ract_list-0.9 时序', () => {
    const actions = [{ key: 'ract_list', t: 20 }, { key: 'x', t: 30 }]
    const r = computeAnchors({ actions }, 10, [])
    expect(r.startDrift).toBeCloseTo(10 - (20 - 0.9))
  })
})
