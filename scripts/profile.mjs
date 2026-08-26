import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const profile = path.join(root, 'profiles', 'enterprise')
// 官方按 $DSH_HOME/profiles/<name> 解析 profile（app-boot/src/profile.ts
// resolveProfileDir），所以 DSH_HOME 必须是仓库根，不是 profiles/ 本身。
const home = root
const command = process.argv[2] ?? 'dump'
const upstream = path.join(root, 'upstream', 'deepseek-harness')
const isWindows = process.platform === 'win32'
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm'

if (!fs.existsSync(path.join(upstream, 'apps', 'cli'))) {
  console.error('官方 Harness 未初始化：git submodule update --init --depth 1')
  process.exit(1)
}

const env = { ...process.env, DSH_HOME: home }

function dsh(args, cwd = upstream) {
  const result = spawnSync(pnpm, ['dsh', '--profile', 'enterprise', ...args], {
    cwd, stdio: 'inherit', shell: isWindows, env,
  })
  process.exitCode = result.status ?? 1
}

if (command === 'dump') {
  // 交给官方 --dump-config：它与 boot 共用同一次 applyEntryPatches，
  // 因此 dump 结果不会与真正挂载的实体树漂移。
  dsh(['--dump-config'])
} else if (command === 'install') {
  const result = spawnSync(pnpm, ['install'], { cwd: profile, stdio: 'inherit', shell: isWindows, env })
  process.exitCode = result.status ?? 1
} else if (command === 'run') {
  dsh(process.argv.slice(3))
} else {
  console.error(`未知命令：${command}（可用：dump | install | run）`)
  process.exit(1)
}
