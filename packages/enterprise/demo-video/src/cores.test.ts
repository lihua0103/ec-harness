import { describe, expect, it } from 'vitest'
import { parseWav, buildWav, mixPlan, wavDurationSeconds } from './wav.js'
import { buildPlan, buildSrtEntries, toSrt, type NarrationEntry } from './plan.js'
import { computeAnchors } from './anchors.js'
import {
  blipAnchors, flashPairFromScene, parseBlackdetect, parseDurationSeconds, parseSceneTimes, parseVolume, parseYavg,
} from './ffmpeg.js'

const mkSegWav = (sec: number) => buildWav(Buffer.alloc(sec * 44100 * 2))

describe('ffmpeg 输出解析', () => {
  it('blackdetect 行解析（black_start 而非 picture_black_start）', () => {
    const stderr = '[blackdetect @ 000] black_start:1.9 black_end:2.01 black_duration:0.11\n' +
      '[blackdetect @ 000] black_start:2.4 black_end:2.71 black_duration:0.31\n' +
      '其他行'
    const evs = parseBlackdetect(stderr)
    expect(evs).toEqual([
      { start: 1.9, end: 2.01, dur: 0.11 },
      { start: 2.4, end: 2.71, dur: 0.31 },
    ])
    // 锚点=black_start；落在闪光窗口 [flashIn-0.15, flashOut+0.15] 的事件排除
    // （VFR 录像里打点黑条可能被稀疏帧拉长到 >0.2s，时长不可靠，只能按时刻排除闪光）
    expect(blipAnchors(evs, 2.4, 2.61)).toEqual([1.9])
    expect(blipAnchors(evs, 10, 11)).toEqual([1.9, 2.4])
  })

  it('场景报告解析与闪光配对（掐头=黑出+0.1）', () => {
    const report = 'frame:12 pts:300 pts_time:1.00\nlavfi.scene_score=1.000000\nframe:32 pts:800 pts_time:1.28\nlavfi.scene_score=1.000000\n'
    const times = parseSceneTimes(report)
    expect(times).toEqual([1.0, 1.28])
    expect(flashPairFromScene(times)).toEqual({ flashStart: 1.0, trim: 1.38 })
    expect(flashPairFromScene([0.5])).toBeNull()
    expect(flashPairFromScene([0.5, 5])).toBeNull()
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
