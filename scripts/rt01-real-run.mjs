// RT01 真实链路驱动（隔离目录，不写死项目业务映射）。
// 用法：node scripts/rt01-real-run.mjs <promptFile> [--cwd=<dir>]
// 流程：session.create → session.prompt → 轮询会话事件直到 turn 结束 → 导出摘要。
// 只输出事件类型/工具名/错误码与计数，不打印工具返回正文（避免数据值进日志）。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3080/api'
const isWindows = process.platform === 'win32'
const [promptFile, cwdArg] = process.argv.slice(2)
if (!promptFile) { console.error('usage: node rt01-real-run.mjs <promptFile> [--cwd=dir]'); process.exit(1) }
const cwd = cwdArg?.startsWith('--cwd=') ? cwdArg.slice(6) : 'D:/project/company/epro/Project/RT01'
const text = readFileSync(promptFile, 'utf8')

let rpc = 0
async function rpcCall(method, payload) {
  const body = { type: 'client-request', rpcId: String(++rpc), method, payload }
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const raw = await res.text()
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error(`bad rpc response: ${raw.slice(0, 300)}`) }
  if (parsed.type === 'server-response') {
    if (parsed.error) throw new Error(`rpc ${method} error: ${JSON.stringify(parsed.error).slice(0, 400)}`)
    return parsed.result?.value ?? parsed.result
  }
  return parsed
}

/** 拉取会话导出。session.export 返回的是 ZIP（内含 session.jsonl），
 *  不是 JSON——此前按 JSON 解析导致 events 恒为 0（实测）。这里用 Node
 *  内置 zlib 无法解 zip，故改用 tar 无关的最小 inflate 路径：
 *  直接读本地 zip 内的 jsonl 需要解压；为保持脚本无依赖，改为请求
 *  events.mux 的 SSE 不现实（长连接），最终采用 child_process 调
 *  PowerShell 解压（Windows）/ unzip（类 Unix）。 */
async function fetchEvents(sessionId) {
  const url = `${BASE}/session.export?sessionId=${encodeURIComponent(sessionId)}`
  const res = await fetch(url)
  if (!res.ok) return { ok: false, status: res.status }
  const buffer = Buffer.from(await res.arrayBuffer())
  const tmp = join(tmpdir(), `rt01-export-${sessionId}.zip`)
  writeFileSync(tmp, buffer)
  const text = isWindows
    ? execFileSync('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${tmp}'); $sr=New-Object System.IO.StreamReader($z.Entries[0].Open()); $sr.ReadToEnd(); $sr.Close(); $z.Dispose()`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : execFileSync('unzip', ['-p', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const events = text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
  return { ok: true, data: { events } }
}

function summarize(data) {
  const events = Array.isArray(data?.events) ? data.events : []
  const tools = []
  const errors = []
  const turns = []
  for (const event of events) {
    const type = event?.type
    if (type === 'tool/call') tools.push(event.data?.name)
    if (type === 'turn/start') turns.push(`start:${event.data?.turn ?? '?'}`)
    if (type === 'turn/end') turns.push(`end:${event.data?.turn ?? '?'}`)
    if (type === 'tool/result') {
      const content = event.data?.result?.content
      const serialized = JSON.stringify(content ?? '')
      if (/受保护临床数据值|errorCode=SCAN_|已阻止该结果/.test(serialized)) {
        errors.push({ type: 'guard-block', name: event.data?.name, match: serialized.match(/errorCode=[A-Z_]+|受保护临床数据值/g) })
      }
      if (event.data?.result?.isError) {
        errors.push({ type: 'tool-error', name: event.data?.name })
      }
    }
  }
  return { eventCount: events.length, tools, errors, turns }
}

console.log(`[rt01] cwd=${cwd}`)
const created = await rpcCall('session.create', { cwd })
const sessionId = created?.sessionId
console.log('[rt01] sessionId =', sessionId)
await rpcCall('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
console.log('[rt01] prompt queued at', new Date().toISOString())

const started = Date.now()
let lastCount = -1
let idleSince = Date.now()
for (;;) {
  await new Promise(resolve => setTimeout(resolve, 30000))
  const snapshot = await fetchEvents(sessionId)
  if (!snapshot.ok) {
    console.log(`[rt01] export not ready (status ${snapshot.status})`)
  } else {
    const summary = summarize(snapshot.data)
    const minutes = ((Date.now() - started) / 60000).toFixed(1)
    if (summary.eventCount !== lastCount) {
      lastCount = summary.eventCount
      idleSince = Date.now()
      console.log(`[rt01 ${minutes}m] events=${summary.eventCount} tools=${summary.tools.length} errors=${summary.errors.length} last=${summary.tools.at(-1) ?? '-'}`)
    }
    const finished = summary.turns.some(item => item.startsWith('end:'))
    if (finished && Date.now() - idleSince > 90000) {
      console.log('[rt01] turn ended; final summary:')
      console.log(JSON.stringify(summary, null, 2))
      break
    }
  }
  if (Date.now() - started > 75 * 60000) {
    console.log('[rt01] TIMEOUT 75m')
    if (snapshot.ok) console.log(JSON.stringify(summarize(snapshot.data), null, 2))
    break
  }
}
