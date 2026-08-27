import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { listEnterprisePlugins } from './enterprise-plugins.mjs'

const root = process.cwd()
const upstream = path.join(root, 'upstream', 'deepseek-harness')
const profile = path.join(root, 'profiles', 'enterprise')
// 官方按 $DSH_HOME/profiles/<name> 解析（app-boot resolveProfileDir），
// 所以 DSH_HOME 是仓库根；指到 profiles/ 会被解析成 profiles/profiles/enterprise。
const home = root
const isWindows = process.platform === 'win32'
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm'
const env = { ...process.env, DSH_HOME: home, CI: 'true', PNPM_CONFIG_CONFIRM_MODULES_PURGE: 'false' }
// 官方默认监听端口（packages/boot/cmdline：`port: ctx.webStartup.port ?? 3080`）。
const port = Number(process.env.DSH_PORT ?? 3080)

function fail(message) {
  console.error(`[DSH] ${message}`)
  process.exit(1)
}

function run(cwd, args, label) {
  console.log(`[DSH] ${label}`)
  const result = spawnSync(pnpm, args, { cwd, env, stdio: 'inherit', shell: isWindows })
  if (result.error) fail(`${label}失败：${result.error.message}`)
  if (result.status !== 0) fail(`${label}失败，退出码 ${result.status ?? 'unknown'}`)
}

function ensureDirectory(target, label) {
  if (!fs.existsSync(target)) fail(`${label}不存在：${target}`)
}

function tryExec(file, args) {
  // 工具不存在时 spawnSync 返回 error（ENOENT）而不是抛异常；统一折成 null，
  // 交给调用方走下一个探测器。
  const result = spawnSync(file, args, { encoding: 'utf8' })
  if (result.error || typeof result.stdout !== 'string') return null
  return result.stdout
}

/** 从一段输出里挑出合法 PID，顺带排除自己。 */
function collectPids(text, pick) {
  const pids = new Set()
  for (const line of (text ?? '').split('\n')) {
    const pid = Number(pick(line))
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid)
  }
  return pids
}

/**
 * 找出监听 port 的进程。Windows 用 netstat，类 Unix 依次尝试
 * ss / lsof / fuser——最小化的容器镜像往往只装其中一个，写死任何一个
 * 都会让"清理"在别的机器上静默变成空操作。
 */
function findListeners() {
  if (isWindows) {
    // 末列是 PID。不匹配 'LISTENING' 字面量：中文/德文等本地化 Windows 会把
    // 状态列翻译掉。改判「外部地址是通配」——监听态才会是 0.0.0.0:0 / [::]:0。
    const out = tryExec('netstat', ['-ano', '-p', 'TCP'])
    if (out === null) return { pids: new Set(), probed: false }
    return {
      probed: true,
      pids: collectPids(out, (line) => {
        const columns = line.trim().split(/\s+/)
        if (columns.length < 5) return NaN
        const [, local, foreign, state] = columns
        // 精确匹配 :<port> 结尾，否则 3080 会误匹配 13080/30800。
        if (!local.endsWith(`:${port}`)) return NaN
        const listening = /LISTEN/i.test(state) || foreign === '0.0.0.0:0' || foreign === '[::]:0'
        return listening ? columns[columns.length - 1] : NaN
      }),
    }
  }

  // ss：`users:(("node",pid=123,fd=20))`
  const ss = tryExec('ss', ['-ltnpH', `sport = :${port}`])
  if (ss !== null && ss.trim() !== '') {
    const pids = new Set()
    for (const match of ss.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1])
      if (pid > 0 && pid !== process.pid) pids.add(pid)
    }
    return { pids, probed: true }
  }
  // lsof -t：一行一个 PID
  const lsof = tryExec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  if (lsof !== null) return { pids: collectPids(lsof, (line) => line.trim()), probed: true }
  // fuser：PID 输出在 stderr 之外的 stdout 上，形如 " 1234"
  const fuser = tryExec('fuser', [`${port}/tcp`])
  if (fuser !== null) {
    const pids = new Set()
    for (const token of fuser.trim().split(/\s+/)) {
      const pid = Number(token)
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid)
    }
    return { pids, probed: true }
  }
  return { pids: new Set(), probed: ss !== null }
}

/** 端口是否可绑定。这是唯一可信的"已释放"判据——杀进程不是瞬时的。 */
function isPortFree() {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    // 绑 127.0.0.1 与官方默认监听地址一致，且不会触发 Windows 防火墙弹窗。
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  do {
    if (await isPortFree()) return true
    await sleep(150)
  } while (Date.now() < deadline)
  return false
}

/**
 * 清理上次残留的监听进程。只按端口定位，不按进程名批量杀 node——
 * 这台机器上通常还跑着别的 node 进程（编辑器、语言服务），误杀代价太高。
 */
async function freePort() {
  if (await isPortFree()) return

  const { pids, probed } = findListeners()
  if (pids.size === 0) {
    if (!probed) {
      fail(`端口 ${port} 已被占用，且本机没有可用的端口探测工具`
        + '（Windows: netstat；类 Unix: ss / lsof / fuser）。'
        + '请手动结束占用进程，或用 DSH_PORT 换一个端口。')
    }
    fail(`端口 ${port} 已被占用，但查不到持有它的进程（可能属于其他用户或容器）。`
      + '请手动处理，或用 DSH_PORT 换一个端口。')
  }

  console.log(`[DSH] 端口 ${port} 被 PID ${[...pids].join('、')} 占用，正在清理`)
  for (const pid of pids) {
    // Windows 上 dsh 是 pnpm 的孙进程，/T 连带整棵树；单杀 pnpm 留下真正的监听者。
    if (isWindows) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else {
      try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
    }
  }

  // taskkill /F 是强杀，无需升级；SIGTERM 可能被忽略，超时后补 SIGKILL。
  if (!isWindows && !(await waitForPort(5000))) {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
    }
  }

  if (!(await waitForPort(5000))) {
    fail(`端口 ${port} 清理后仍未释放。请手动检查占用进程，或用 DSH_PORT 换一个端口。`)
  }
  console.log(`[DSH] 端口 ${port} 已释放`)
}

/** 依赖树是否已就绪。只看目录存在不够——首次 link 尚未建成时目录可能已存在。 */
function needsInstall(cwd, probes) {
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) return true
  return probes.some((probe) => !fs.existsSync(path.join(cwd, 'node_modules', probe)))
}

function ensureInstall(cwd, label, probes = [], extraArgs = []) {
  if (needsInstall(cwd, probes)) {
    run(cwd, ['install', ...extraArgs], `${label}依赖未就绪，正在安装`)
  } else {
    console.log(`[DSH] ${label}依赖已就绪`)
  }
}

// 0) 工具链版本：engines 只在 pnpm install 时把关，直接 node scripts/start.mjs
//    进来的路径不过 engines，所以这里显式检查一次。
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
// 与根 package.json 的 engines 保持一致：^22.19.0 || >=24.0.0（22.19 以下、
// 以及 23.x 奇数线都不接受）。这里放宽会让失败点漂移到 pnpm engineStrict。
if (!((nodeMajor === 22 && nodeMinor >= 19) || nodeMajor >= 24)) {
  fail(`Node 版本不满足 engines（^22.19.0 || >=24.0.0）：当前 ${process.versions.node}`)
}
const pnpmVersion = spawnSync(pnpm, ['--version'], { encoding: 'utf8', shell: isWindows }).stdout?.trim()
if (!pnpmVersion) fail('未找到 pnpm，请先安装 pnpm 11')
if (Number(pnpmVersion.split('.')[0]) < 11) {
  fail(`pnpm 版本过低（需要 11+，workspace 设置已迁至 pnpm-workspace.yaml）：当前 ${pnpmVersion}`)
}

// 自动初始化 submodule（如果未初始化）
if (!fs.existsSync(path.join(upstream, '.git'))) {
  console.log('[DSH] 检测到 upstream/deepseek-harness 未初始化')
  console.log('[DSH] 正在自动初始化 Git Submodule...')
  const submoduleResult = spawnSync('git', ['submodule', 'update', '--init', '--depth', '1'], {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows
  })
  if (submoduleResult.error || submoduleResult.status !== 0) {
    fail('Submodule 初始化失败。请手动执行: git submodule update --init --depth 1')
  }
  console.log('[DSH] Submodule 初始化完成')
}

ensureDirectory(upstream, '官方 DeepSeek Harness')
ensureDirectory(path.join(upstream, 'apps', 'cli'), '官方 CLI')
ensureDirectory(profile, '企业 Profile')

// 顶层 await：本文件是 ESM（package.json "type": "module"），Node 22/24 原生支持。
await freePort()

// 1) 企业根 workspace：企业插件源码与构建工具链
ensureInstall(root, '企业根项目', ['typescript', 'vitest'], ['--frozen-lockfile'])

// 2) 官方 Harness：其自身 lockfile 由官方维护，不加 --frozen-lockfile 以免上游
//    lockfile 与本地平台产物差异导致硬失败。
ensureInstall(upstream, '官方 Harness', ['@deepseek-ai/cordis'])

// 3) 企业插件构建产物：profile 的 link: 目标必须先有 lib/ 才能被官方加载。
//    插件清单来自目录遍历，新增插件无需改本文件。
const plugins = listEnterprisePlugins(root)
if (plugins.length === 0) fail(`packages/enterprise 下没有找到任何企业插件：${root}`)
const missingArtifacts = () => plugins.filter((plugin) => !fs.existsSync(plugin.libEntry))

if (missingArtifacts().length > 0) {
  run(root, ['run', 'build'], '企业插件构建产物缺失，正在构建')

  // `tsc -b` 只比对 tsconfig.tsbuildinfo 与源文件时间戳，**不检查产物是否还在**。
  // 手动删过 lib/（或上次 clean 只删了一半）就会得到
  // "Project is up to date because newest input is older than output tsconfig.tsbuildinfo"
  // ——退出码 0、一个文件都不产出。清掉 tsbuildinfo 再来一次即可恢复。
  if (missingArtifacts().length > 0) {
    for (const plugin of plugins) fs.rmSync(plugin.buildInfo, { force: true })
    run(root, ['run', 'build'], '增量构建缓存已失效（tsbuildinfo 陈旧），正在全量重建')
  }

  // 构建命令退出码为 0 仍不等于产物存在，故障否则要等到 boot 期才以
  // ERR_MODULE_NOT_FOUND 暴露在官方 loader 里。这里改成当场失败。
  const stillMissing = missingArtifacts()
  if (stillMissing.length > 0) {
    fail(`构建未产出插件产物：${stillMissing.map((plugin) => plugin.name).join('、')}。`
      + '请执行 pnpm run clean && pnpm run build 查看真实构建报错。')
  }
} else {
  console.log('[DSH] 企业插件构建产物已就绪')
}

// Listing 运行期依赖：在 WebUI boot 前给出明确错误，不把缺包延迟到首次工具调用。
const pythonCheck = spawnSync('python', [path.join(root, 'packages', 'enterprise', 'listing', 'python', 'check_deps.py')], {
  cwd: root, stdio: 'inherit', shell: isWindows,
})
if (pythonCheck.error || pythonCheck.status !== 0) fail('Listing Python 依赖检查失败')
// 4) 官方 CLI 构建产物
if (!fs.existsSync(path.join(upstream, 'apps', 'cli', 'lib', 'bin.js'))) {
  run(upstream, ['run', 'build'], '官方 Harness 构建产物缺失，正在构建')
} else {
  console.log('[DSH] 官方 Harness 构建产物已就绪')
}

// 5) 企业 Profile：把 link: 声明真正落成 node_modules symlink。
//    官方 resolveBundleDir 的第二锚点就是这里，缺这一步会报
//    "cannot resolve profile bundle @dsh-enterprise/..."。
//    探针取自 profile 自己的 dependencies——它才是"该有哪些 symlink"的权威声明，
//    新增插件只需改 profile manifest，本文件不动。
const profileManifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
ensureInstall(profile, '企业 Profile', Object.keys(profileManifest.dependencies ?? {}))

console.log(`[DSH] 启动企业 WebUI：http://127.0.0.1:${port}`)
run(upstream, ['dsh', '--profile', 'enterprise'], '正在启动 DeepSeek Harness WebUI')

