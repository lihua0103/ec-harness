// 只读监控一个已存在的会话：node scripts/rt01-monitor.mjs <sessionId> [minutes]
// 只输出事件类型/工具名/错误码与计数，绝不打印工具返回正文或数据值。
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3080/api'
const isWindows = process.platform === 'win32'
const [sessionId, minutesArg] = process.argv.slice(2)
if (!sessionId) { console.error('usage: node rt01-monitor.mjs <sessionId> [minutes]'); process.exit(1) }
const maxMinutes = Number(minutesArg ?? 60)

async function readEvents() {
  const res = await fetch(`${BASE}/session.export?sessionId=${encodeURIComponent(sessionId)}`)
  if (!res.ok) return { ok: false, status: res.status, events: [] }
  const tmp = join(tmpdir(), `rt01-mon-${sessionId}.zip`)
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
  const text = isWindows
    ? execFileSync('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${tmp}'); $sr=New-Object System.IO.StreamReader($z.Entries[0].Open()); $sr.ReadToEnd(); $sr.Close(); $z.Dispose()`],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
    : execFileSync('unzip', ['-p', tmp], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  const events = text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
  return { ok: true, events }
}

function summarize(events) {
  const types = {}
  const tools = []
  const guardBlocks = []
  const toolErrors = []
  const turns = []
  for (const event of events) {
    const type = event.type ?? '?'
    types[type] = (types[type] ?? 0) + 1
    if (type === 'tool/call') tools.push(event.data?.name)
    if (type === 'turn/start') turns.push(`start#${event.data?.turn ?? '?'}`)
    if (type === 'turn/end') turns.push(`end#${event.data?.turn ?? '?'}`)
    if (type === 'tool/result') {
      const payload = JSON.stringify(event.data?.result?.content ?? '')
      const codes = payload.match(/errorCode=[A-Z_]+/g)
      if (codes || /受保护临床数据值|已阻止该结果/.test(payload)) {
        guardBlocks.push({ name: event.data?.name, codes: codes ?? ['PROTECTED_CONTENT_WITHHELD'] })
      }
      if (event.data?.result?.isError) toolErrors.push(event.data?.name)
    }
  }
  const assistantText = events.filter(event => event.type === 'assistant/message').length
  return { eventCount: events.length, types, tools, guardBlocks, toolErrors, turns, assistantMessages: assistantText }
}

const started = Date.now()
let last = ''
for (;;) {
  const snapshot = await readEvents()
  if (!snapshot.ok) {
    console.log(`[mon] export unavailable (status ${snapshot.status})`)
  } else {
    const summary = summarize(snapshot.events)
    const signature = `${summary.eventCount}|${summary.tools.length}|${summary.guardBlocks.length}|${summary.toolErrors.length}`
    const elapsed = ((Date.now() - started) / 60000).toFixed(1)
    if (signature !== last) {
      last = signature
      console.log(`[mon ${elapsed}m] events=${summary.eventCount} tools=${summary.tools.length} blocks=${summary.guardBlocks.length} errors=${summary.toolErrors.length} last=${summary.tools.at(-1) ?? '-'}`)
    }
    if (summary.turns.some(item => item.startsWith('end#'))) {
      console.log('[mon] turn ended. summary:')
      console.log(JSON.stringify(summary, null, 2))
      break
    }
  }
  if (Date.now() - started > maxMinutes * 60000) {
    console.log('[mon] TIMEOUT')
    if (snapshot.ok) console.log(JSON.stringify(summarize(snapshot.events), null, 2))
    break
  }
  await new Promise(resolve => setTimeout(resolve, 45000))
}
