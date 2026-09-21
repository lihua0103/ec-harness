// dsh 自进化多轮验证驱动（纯 HTTP RPC，Node 22 内置 fetch）
// 用法：node dsh_evo_round.mjs <PSTB100|400311|HXN6005> [--rounds N] [--timeout MIN]
// 每轮：清空生成产物 → 新建会话 → 发提示词 → 轮询产物稳定 → 对 golden 基准双跑 QC → 判定
// 三项目已交付 R 代码产物 = 常备 QC 基准（golden_gt / golden2），用户 2026-09-19 定案。
import { readFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3080/api'
const V = 'D:/project/company/epro/Project/dsh-standard-verify'
const HERE = dirname(fileURLToPath(import.meta.url))
const RTERM = process.env.DSH_RSCRIPT || 'D:/package/R-4.5.0/bin/x64/Rterm.exe'

const CFG = {
  PSTB100: {
    cwd: `${V}/PSTB100`,
    outDir: `${V}/PSTB100/Output`,
    program: `${V}/PSTB100/SAS_Program/SAS_program/PK Mapping/PSTB100_PK_Mapping.R`,
    promptFile: join(HERE, '_prompt_pstb.txt'),
    // 比对均在 verify 根目录执行；rds 用 [golden, gen] 交 Rterm
    cmp: { cmd: 'python', args: ['compare_one.py'] },
    rds: [`${V}/PSTB100/golden_gt/PSTB100_PK Mapping_20260916.rds`, `${V}/PSTB100/Output/04_Out/PK Mapping/PSTB100_PK Mapping_20260916.rds`],
    rdsScript: 'gt_rds_one.R', rdsTag: 'RDS_RESULT=',
  },
  400311: {
    cwd: `${V}/400311`,
    outDir: `${V}/400311/Output`,
    program: `${V}/400311/SAS_Program/SAS_program/PK Mapping/400311_PK_Mapping.R`,
    promptFile: join(HERE, '_prompt_400311.txt'),
    cmp: { cmd: 'python', args: ['compare_400311.py'] },
    rds: null, // compare_400311.py 内部已含 rds 比对
    rdsScript: null, rdsTag: null,
  },
  HXN6005: {
    cwd: `${V}/HXN6005`,
    outDir: `${V}/HXN6005/Output`,
    program: `${V}/HXN6005/SAS_Program/SAS_program/Manual Listing/HXN6005-A1-201_Manual_Listing.R`,
    promptFile: join(HERE, '_prompt_hxn6005.txt'),
    cmp: { cmd: 'python', args: ['compare_manual.py'] },
    rds: [`${V}/HXN6005/golden2/manual_listing/output/HXN6005-A1-201_Manual Listing_data.RDS`, `${V}/HXN6005/Output/04_Out/Manual listing/HXN6005-A1-201_Manual Listing_20260902.RDS`],
    rdsScript: 'gt_rds_manual.R', rdsTag: 'RDS_MANUAL_RESULT=',
  },
}

const [project] = process.argv.slice(2)
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d }
const ROUNDS = argOf('--rounds', 1)
const TIMEOUT_MIN = argOf('--timeout', 100)
const COMPARE_ONLY = process.argv.includes('--compare-only')
const cfg = CFG[project]
if (!cfg) { console.error('args: <PSTB100|400311|HXN6005> [--rounds N] [--timeout MIN] [--compare-only]'); process.exit(1) }

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

function cleanArtifacts() {
  rmSync(cfg.outDir, { recursive: true, force: true })
  rmSync(cfg.program, { force: true })
  // 清会话探针残留（项目根 _zone* / _diag* / .qc_*；不碰 golden 与数据）
  try {
    for (const f of readdirSync(cfg.cwd)) {
      if (/^(_zone|_diag|_qc)/i.test(f) || f.startsWith('.qc_')) rmSync(join(cfg.cwd, f), { recursive: true, force: true })
    }
  } catch {}
}

const dirState = () => {
  if (!existsSync(cfg.outDir)) return 'no-dir'
  const walk = d => readdirSync(d).flatMap(f => {
    const p = join(d, f); const s = statSync(p)
    return s.isDirectory() ? walk(p) : [`${f} ${s.size} ${s.mtime.toISOString().slice(11, 19)}`]
  })
  return walk(cfg.outDir).join(' | ') || 'empty'
}

function runCompare() {
  const out = { cmp: '', rds: '' }
  const r1 = execFileSync(cfg.cmp.cmd, cfg.cmp.args, { cwd: V, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] })
  out.cmp = r1.split(/\r?\n/).filter(l => /RESULT\s*=/.test(l)).join(' ; ')
  if (cfg.rds) {
    // --file=<path> 必须带等号：`--file <path>` 会被 R 当未知选项丢弃，
    // 脚本不执行却仍退出 0——静默跳过比对（2026-09-20 实案）。
    const r2 = execFileSync(RTERM, ['--vanilla', `--file=${join(V, cfg.rdsScript)}`, '--args', cfg.rds[0], cfg.rds[1]], { cwd: V, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] })
    // 只取脚本真实输出行（排除 Rterm echo 回显的源码行）
    out.rds = r2.split(/\r?\n/).filter(l => l.startsWith(cfg.rdsTag)).join(' ; ').trim()
    if (!out.rds) out.rds = `MISSING-${cfg.rdsTag}(R 脚本未产出结论：检查 --file 形式与脚本报错)`
  }
  return out
}

const allPass = (o) => {
  const cmpOk = /PASS/.test(o.cmp) && !/FAIL|MISMATCH|DIFF/.test(o.cmp)
  const rdsOk = !cfg.rds || /PASS/.test(o.rds)
  return cmpOk && rdsOk
}

let summary = []
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n===== ROUND ${round}/${ROUNDS} ${project} =====`)
  if (!COMPARE_ONLY) {
    cleanArtifacts()
    const created = await rpcCall('session.create', { cwd: cfg.cwd })
    const sessionId = created?.sessionId ?? created?.id ?? created
    const text = readFileSync(cfg.promptFile, 'utf8')
    await rpcCall('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
    console.log('[drive] session =', sessionId, '| prompt queued', new Date().toISOString())

    const stab = { list: '', since: Date.now() }
    const t0 = Date.now()
    let done = false
    while (!done) {
      await new Promise(r => setTimeout(r, 60000))
      const cur = dirState()
      if (cur !== stab.list) { stab.list = cur; stab.since = Date.now() }
      const mins = ((Date.now() - t0) / 60000).toFixed(1)
      console.log(`[poll ${mins}m] ${cur.slice(0, 220)}`)
      if (stab.list !== 'no-dir' && stab.list !== 'empty' && Date.now() - stab.since > 5 * 60000) done = true
      if (Date.now() - t0 > TIMEOUT_MIN * 60000) { console.log('[drive] TIMEOUT'); done = true }
    }
  } else {
    console.log('[drive] --compare-only：对当前产物直接复核，不新建会话')
  }

  let verdict
  try { verdict = runCompare() } catch (e) { verdict = { cmp: 'COMPARE-ERROR ' + String(e.message).slice(0, 200), rds: '' } }
  const pass = allPass(verdict)
  console.log(`[ROUND ${round} RESULT] ${pass ? 'PASS ✅ 100% 一致' : 'MISMATCH ❌'}`)
  console.log('  xlsx:', verdict.cmp || '(none)')
  if (cfg.rds) console.log('  rds :', verdict.rds || '(none)')
  summary.push({ round, pass, cmp: verdict.cmp, rds: verdict.rds })
}

console.log('\n===== SUMMARY =====')
for (const s of summary) console.log(`round ${s.round}: ${s.pass ? 'PASS' : 'MISMATCH'} | ${s.cmp} | ${s.rds || ''}`)
const np = summary.filter(s => s.pass).length
console.log(`TOTAL: ${np}/${summary.length} rounds PASS`)
