import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTools } from './paths.js'
import { runProc } from './proc.js'
import { runAnchorsStage } from './anchors-run.js'
import { runComposeStage } from './compose.js'
import { buildSrtEntries, toSrt } from './plan.js'
import { buildWav, mixPlan } from './wav.js'

function readWav(f: string): Buffer {
  return readFileSync(f)
}

/**
 * S2/S4 真实 ffmpeg 集成链（CI 无 ffmpeg 时整组跳过）。
 * 夹具：12s 白底视频，1.0–1.26s 全屏闪光（掐头锚），2.0–2.11s 与 2.5–2.61s
 * 顶边 120x6 黑条（动作锚）——与 walk 模板的打点机制同构。
 */
const tools = resolveTools()
const ffmpegReady = await runProc(tools.ffmpeg, ['-version'], { timeoutMs: 15000 }).then(
  r => r.code === 0, () => false,
)
const d = ffmpegReady ? describe : describe.skip

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-demo-video-pipe-'))
}

async function synthFixtureWebm(webm: string): Promise<void> {
  const r = await runProc(tools.ffmpeg, [
    '-f', 'lavfi', '-i', 'color=white:size=320x240:rate=25:duration=12',
    '-vf', [
      "drawbox=x=0:y=0:w=320:h=240:color=black@1:t=fill:enable='between(t,1.0,1.26)'",
      "drawbox=x=0:y=0:w=120:h=6:color=black@1:t=fill:enable='between(t,2.0,2.11)'",
      "drawbox=x=0:y=0:w=120:h=6:color=black@1:t=fill:enable='between(t,2.5,2.61)'",
    ].join(','),
    '-c:v', 'libvpx', '-y', webm,
  ], { timeoutMs: 180_000 })
  if (r.code !== 0) throw new Error(`fixture webm 合成失败：${r.stderr.slice(-300)}`)
}

async function synthSegWav(wav: string, seconds: number): Promise<void> {
  const r = await runProc(tools.ffmpeg, [
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wav,
  ], { timeoutMs: 60_000 })
  if (r.code !== 0) throw new Error(`fixture wav 合成失败：${r.stderr.slice(-300)}`)
}

d('S2 锚点（真实 ffmpeg）', () => {
  it('闪光定掐头 + 黑条逐动作对齐（±2.4s 窗口、漂移更新）', async () => {
    const workDir = makeWorkDir()
    const webm = join(workDir, 'record-t_000.webm')
    await synthFixtureWebm(webm)
    // flashWall=3.0 ↔ 视频 1.0s → 初始漂移 -2；动作墙钟 4.0/4.5 → 视频期望 2.0/2.5
    writeFileSync(join(workDir, 'timings.json'), JSON.stringify({
      module: 't',
      steps: [{ name: '走查', ok: true, t: 5 }],
      actions: [{ key: 'a', t: 4.0 }, { key: 'b', t: 4.5 }],
      totalDuration: 12, video: webm, flashWall: 3.0, navigations: 1,
    }))

    const receipt = await runAnchorsStage(tools, { workDir })
    expect(receipt.pass).toBe(true)
    expect(receipt.trim).toBeGreaterThan(1.18)
    expect(receipt.trim).toBeLessThan(1.6)
    expect(receipt.blipCount).toBe(2)
    expect(receipt.orphanBlips).toBe(0)
    expect(receipt.inferredKeys).toEqual([])
    expect(receipt.matches.find(m => m.key === 'a')?.videoT).toBeGreaterThan(1.9)
    expect(receipt.matches.find(m => m.key === 'a')?.videoT).toBeLessThan(2.2)
    expect(receipt.matches.find(m => m.key === 'b')?.videoT).toBeGreaterThan(2.4)
    expect(receipt.matches.find(m => m.key === 'b')?.videoT).toBeLessThan(2.7)
  }, 180_000)
})

d('S4 合成（真实 ffmpeg）', () => {
  it('掐头+铺轨+烧字幕合成 mp4，程序化验收门全过', async () => {
    const workDir = makeWorkDir()
    const webm = join(workDir, 'record-t_000.webm')
    await synthFixtureWebm(webm)
    const trim = 1.38
    writeFileSync(join(workDir, 'timings.json'), JSON.stringify({
      module: 't', actions: [{ key: 'a', t: 4 }], video: webm, flashWall: 3,
    }))
    writeFileSync(join(workDir, 'trim.json'), JSON.stringify({ trim, flashStart: 1.0 }))

    const segsDir = join(workDir, 'segs')
    mkdirSync(segsDir, { recursive: true })
    const seg1 = join(segsDir, 'nar_01.wav')
    const seg2 = join(segsDir, 'nar_02.wav')
    await synthSegWav(seg1, 1)
    await synthSegWav(seg2, 0.8)
    const totalSec = 10.62 // 视频 12s - 掐头 1.38s
    const plan = [
      { idx: 1, text: 'First narrated action.', anchorRaw: 0, anchor: 0.6, file: seg1 },
      { idx: 2, text: 'Second narrated action.', anchorRaw: 0, anchor: 2.2, file: seg2 },
    ]
    const mixed = mixPlan(plan.map(p => ({ idx: p.idx, anchor: p.anchor, file: p.file })), totalSec, 44100, f => readWav(f))
    writeFileSync(join(segsDir, 'narration.wav'), buildWav(mixed.pcm))
    const { entries } = buildSrtEntries(plan, f => f === seg1 ? 1 : 0.8, [], {}, trim)
    writeFileSync(join(workDir, 'captions.srt'), toSrt(entries))
    writeFileSync(join(workDir, 'narration-meta.json'), JSON.stringify({ narrationEnd: mixed.result.narrationEnd, totalSec }))

    const receipt = await runComposeStage(tools, { workDir, module: 't' })
    expect(receipt.gates).toEqual({ whiteFirstFrame: true, audibleNarration: true, tailOk: true })
    expect(receipt.pass).toBe(true)
    expect(receipt.yavg).toBeGreaterThan(150)
    expect(receipt.maxVolumeDb).toBeGreaterThan(-20)
    expect(receipt.durationSec).toBeGreaterThan(10)
    expect(receipt.tailSec).toBeGreaterThan(2.5)
    expect(receipt.versionLabel).toBe('t.mp4')
    // 重复合成 → 版本自动递增（旧版保留）
    const again = await runComposeStage(tools, { workDir, module: 't' })
    expect(again.versionLabel).toBe('t-v2.mp4')
  }, 240_000)
})
