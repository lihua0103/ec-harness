import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeDuration } from './ffmpeg.js'
import { resolveTools } from './paths.js'
import { runProc } from './proc.js'
import { runRecordStage } from './record.js'
import { runAnchorsStage } from './anchors-run.js'
import { runNarrateStage } from './narration.js'
import { runComposeStage } from './compose.js'
import { buildSrtEntries, toSrt } from './plan.js'
import { buildWav, mixPlan } from './wav.js'

/**
 * 四阶段真链路 E2E（门控：DV_E2E=1 且本机四件套齐备时才跑）。
 * 目标：无登录样例页（examples/demo-page，本机静态服务）→ smoke-walk 录制 →
 * 锚点 → 旁白（edge-tts；无网络时降级为本地正弦 wav，TTS 覆盖缺口如实标注）→
 * 合成 mp4 + 程序化验收。与工具 execute 完全同代码路径（绕过的只有宿主装配层）。
 */
const tools = resolveTools()
const e2eEnabled = process.env.DV_E2E === '1'
  && !!tools.chromePath && !!tools.playwrightCorePath
const d = e2eEnabled ? describe : describe.skip

function startStaticServer(): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const page = fileURLToPath(new URL('../examples/demo-page/index.html', import.meta.url))
    const html = readFileSync(page)
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        server,
        base: `http://127.0.0.1:${port}/`,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

d('四阶段 E2E（样例页全链路）', () => {
  it('S1 录制 → S2 锚点 → S3 旁白 → S4 合成，验收门全过', async () => {
    const { base, close } = await startStaticServer()
    const workDir = mkdtempSync(join(tmpdir(), 'dsh-demo-video-e2e-'))
    try {
      // ---- S1：smoke-walk 作为 walk.mjs（cursor.mjs 由录制阶段自动同步）----
      copyFileSync(join(tools.scriptsDir, 'smoke-walk.mjs'), join(workDir, 'walk.mjs'))
      const record = await runRecordStage(tools, { workDir, module: 'smoke', base, timeoutMs: 240_000 })
      expect(record.failedSteps).toEqual([])
      expect(record.pass, `S1 未过门：${record.reasons.join('；')}\n${record.logTail}`).toBe(true)
      expect(record.actionCount).toBeGreaterThanOrEqual(8)

      // ---- S2：锚点 ----
      const anchors = await runAnchorsStage(tools, { workDir })
      expect(anchors.pass, `S2 未过门：${anchors.warnings.join('；')}`).toBe(true)
      expect(anchors.actionCount).toBe(record.actionCount)

      // ---- S3：旁白（文案按 smoke-walk 的动作 key 对位）----
      const trim = (JSON.parse(readFileSync(join(workDir, 'trim.json'), 'utf8')) as { trim: number }).trim
      const lines: Array<Record<string, unknown>> = [
        { text: 'Welcome.', t: +(trim + 1.3).toFixed(2) },
        { text: 'Two exports.', at: 'export_menu', lead: 0.1 },
        { text: 'Audit trail.', at: 'dialog_open', lead: 0.1 },
        { text: 'Cancel closes it.', at: 'dialog_cancel', lead: 0.1 },
        { text: 'Data tab.', at: 'tab_data', lead: 0.1 },
        { text: 'Creates a draft.', at: 'record_created', lead: 0.1 },
        { text: 'Query runs.', at: 'query_done', lead: 0.1 },
        { text: 'Tour complete.', at: 'back_processes', lead: 0.2 },
      ]
      writeFileSync(join(workDir, 'narration.json'), JSON.stringify(lines, null, 1))
      let ttsSkipped = false
      let narrate: Awaited<ReturnType<typeof runNarrateStage>> | undefined
      try {
        narrate = await runNarrateStage(tools, { workDir })
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code !== 'DEMO_TTS_FAILED') throw error
        // 无网络/无 edge-tts：降级为本地正弦 wav 完成链路（TTS 覆盖缺口如实标注）。
        // 此时阶段已写 narration-plan.json，但 wav/srt/meta 未产出，按阶段同公式补齐。
        ttsSkipped = true
        const plan = JSON.parse(readFileSync(join(workDir, 'narration-plan.json'), 'utf8')) as
          Array<{ idx: number; text: string; anchor: number; file: string }>
        for (const seg of plan) {
          const r = await runProc(tools.ffmpeg, [
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
            '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', '-y', seg.file,
          ], { timeoutMs: 60_000 })
          if (r.code !== 0) throw new Error(`降级 wav 合成失败：${r.stderr.slice(-200)}`, { cause: error })
        }
        const timings = JSON.parse(readFileSync(join(workDir, 'timings.json'), 'utf8')) as { video: string }
        const videoDur = await probeDuration(tools.ffmpeg, timings.video)
        const totalSec = Math.max(1, Math.round((videoDur - trim) * 100) / 100)
        const anchorsMap = JSON.parse(readFileSync(join(workDir, 'anchors.json'), 'utf8')) as Record<string, number>
        const mixed = mixPlan(plan.map(p => ({ idx: p.idx, anchor: p.anchor, file: p.file })), totalSec, 44100, f => readFileSync(f))
        writeFileSync(join(workDir, 'segs', 'narration.wav'), buildWav(mixed.pcm))
        const { entries } = buildSrtEntries(plan, () => 1, [], anchorsMap, trim)
        writeFileSync(join(workDir, 'captions.srt'), toSrt(entries))
        writeFileSync(join(workDir, 'narration-meta.json'), JSON.stringify({ narrationEnd: mixed.result.narrationEnd, totalSec }))
      }
      if (!ttsSkipped) {
        expect(narrate?.planCount).toBe(8)
        expect(narrate?.lagWarnings ?? []).toHaveLength(0)
      }

      // ---- S4：合成 + 程序化验收 ----
      const composed = await runComposeStage(tools, { workDir, module: 'smoke' })
      expect(composed.pass, `S4 未过门：${composed.reasons.join('；')}`).toBe(true)
      expect(composed.gates.whiteFirstFrame).toBe(true)
      expect(composed.durationSec).toBeGreaterThan(10)
      expect(composed.tailSec ?? 0).toBeGreaterThan(2.5)
      console.log(`[e2e] ttsSkipped=${ttsSkipped} mp4=${composed.mp4} dur=${composed.durationSec}s ` +
        `yavg=${composed.yavg} maxDb=${composed.maxVolumeDb} tail=${composed.tailSec}s`)
    } finally {
      await close()
    }
  }, 420_000)
})
