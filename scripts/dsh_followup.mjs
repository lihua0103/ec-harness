// 给已有会话追加一条用户消息（反馈闭环）
import { readFileSync } from 'node:fs'
const BASE = 'http://127.0.0.1:3080/api'
const [sessionId, promptFile] = process.argv.slice(2)
if (!sessionId || !promptFile) { console.error('args: <sessionId> <promptFile>'); process.exit(1) }
const text = readFileSync(promptFile, 'utf8')
let rpc = 0
async function rpcCall(method, payload) {
  const body = { type: 'client-request', rpcId: String(++rpc), method, payload }
  const res = await fetch(BASE + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = JSON.parse(await res.text())
  return j.result?.value ?? j.result
}
await rpcCall('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
console.log('[drive] follow-up queued to', sessionId, 'at', new Date().toISOString())
