// dsh WebUI 冷启动会话驱动（纯 HTTP RPC，Node 22 内置 fetch）
// 用法：node dsh_coldstart.mjs <projectName> <promptFile>
//   创建会话（cwd=沙箱根）→ 发送提示词 → 轮询产物与导出直到产物稳定或超时
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3080/api'
const V = 'D:/project/company/epro/Project/dsh-standard-verify'
const LANE_OUT = {
  PSTB100: `${V}/PSTB100/Output/04_Out/PK Mapping`,
  400311: `${V}/400311/Output/04_Out/PK Mapping`,
  HXN6005: `${V}/HXN6005/Output/04_Out/Manual listing`,
}
const [project, promptFile] = process.argv.slice(2)
if (!project || !promptFile || !LANE_OUT[project]) { console.error('args: <PSTB100|400311|HXN6005> <promptFile>'); process.exit(1) }
const text = readFileSync(promptFile, 'utf8')

let rpc = 0
async function rpcCall(method, payload) {
  const body = { type: 'client-request', rpcId: String(++rpc), method, payload }
  const res = await fetch(BASE + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const txt = await res.text()
  try {
    const j = JSON.parse(txt)
    if (j.type === 'server-response') return j.result?.value ?? j.result
    return j
  } catch { throw new Error('bad rpc response: ' + txt.slice(0, 300)) }
}

const dirState = () => {
  const d = LANE_OUT[project]
  if (!existsSync(d)) return 'no-dir'
  return readdirSync(d).map(f => { const s = statSync(join(d, f)); return `${f} ${s.size} ${s.mtime.toISOString().slice(11, 19)}` }).join(' | ') || 'empty'
}
const stab = { list: '', since: Date.now() }

console.log('[drive] creating session…')
const created = await rpcCall('session.create', { cwd: `${V}/${project}` })
const sessionId = created?.sessionId ?? created?.id ?? created
console.log('[drive] sessionId =', sessionId)

console.log('[drive] sending prompt…')
await rpcCall('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
console.log('[drive] prompt queued at', new Date().toISOString())

// 轮询：产物目录状态 + 导出体积；产物稳定 5 分钟或超时(90 分钟)退出
const t0 = Date.now()
for (;;) {
  await new Promise(r => setTimeout(r, 60000))
  const cur = dirState()
  if (cur !== stab.list) { stab.list = cur; stab.since = Date.now() }
  const mins = ((Date.now() - t0) / 60000).toFixed(1)
  console.log(`[poll ${mins}m] ${cur}`)
  if (stab.list !== 'no-dir' && stab.list !== 'empty' && Date.now() - stab.since > 5 * 60000) {
    console.log('[drive] outputs stable 5m -> done')
    break
  }
  if (Date.now() - t0 > 90 * 60000) { console.log('[drive] TIMEOUT 90m'); break }
}
console.log('[drive] session.export =', `${BASE}/session.export?sessionId=${sessionId}`)
