import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const upstream = path.join(root, 'upstream', 'deepseek-harness')
const profile = path.join(root, 'profiles', 'enterprise')
// 官方按 $DSH_HOME/profiles/<name> 解析（app-boot resolveProfileDir），
// 所以 DSH_HOME 是仓库根；指到 profiles/ 会被解析成 profiles/profiles/enterprise。
const home = root
const isWindows = process.platform === 'win32'
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm'
const env = { ...process.env, DSH_HOME: home, CI: 'true', PNPM_CONFIG_CONFIRM_MODULES_PURGE: 'false' }

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

ensureDirectory(upstream, '官方 DeepSeek Harness（未初始化请执行 git submodule update --init --depth 1）')
ensureDirectory(path.join(upstream, 'apps', 'cli'), '官方 CLI')
ensureDirectory(profile, '企业 Profile')

// 1) 企业根 workspace：企业插件源码与构建工具链
ensureInstall(root, '企业根项目', ['typescript', 'vitest'], ['--frozen-lockfile'])

// 2) 官方 Harness：其自身 lockfile 由官方维护，不加 --frozen-lockfile 以免上游
//    lockfile 与本地平台产物差异导致硬失败。
ensureInstall(upstream, '官方 Harness', ['@deepseek-ai/cordis'])

// 3) 企业插件构建产物：profile 的 link: 目标必须先有 lib/ 才能被官方加载
const built = ['auth', 'tool-audit', 'ui-settings']
  .every((name) => fs.existsSync(path.join(root, 'packages', 'enterprise', name, 'lib', 'index.js')))
if (!built) run(root, ['run', 'build'], '企业插件构建产物缺失，正在构建')
else console.log('[DSH] 企业插件构建产物已就绪')

// 4) 官方 CLI 构建产物
if (!fs.existsSync(path.join(upstream, 'apps', 'cli', 'lib', 'bin.js'))) {
  run(upstream, ['run', 'build'], '官方 Harness 构建产物缺失，正在构建')
} else {
  console.log('[DSH] 官方 Harness 构建产物已就绪')
}

// 5) 企业 Profile：把 link: 声明真正落成 node_modules symlink。
//    官方 resolveBundleDir 的第二锚点就是这里，缺这一步会报
//    "cannot resolve profile bundle @dsh-enterprise/..."。
ensureInstall(profile, '企业 Profile', [
  '@dsh-enterprise/auth',
  '@dsh-enterprise/tool-audit',
  '@dsh-enterprise/ui-settings',
])

console.log('[DSH] 启动企业 WebUI：http://127.0.0.1:3080')
run(upstream, ['dsh', '--profile', 'enterprise'], '正在启动 DeepSeek Harness WebUI')
