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

function dsh(args, options = {}) {
  return spawnSync(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    '--profile', 'enterprise', ...args,
  ], {
    cwd: upstream,
    env,
    ...options,
  })
}

if (command === 'dump') {
  // 交给官方 --dump-config：它与 boot 共用同一次 applyEntryPatches，
  // 因此 dump 结果不会与真正挂载的实体树漂移。
  const result = dsh(['--dump-config'], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} else if (command === 'verify') {
  // 使用官方 loader 的真实装配结果做门禁。官方对“替换不存在的 row”只发
  // warning 且仍返回 0，因此这里必须显式 fail-closed，并确认每个企业 Bundle
  // 都实际出现在最终实体树中。
  const result = dsh(['--dump-config'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const output = `${stdout}\n${stderr}`
  const errors = []

  if ((result.status ?? 1) !== 0) {
    errors.push(`官方 --dump-config 退出码为 ${result.status ?? 'unknown'}`)
  }
  if (/patch: entry .* not found/i.test(output)) {
    errors.push('官方 loader 报告 patch 目标不存在')
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
  const enterpriseBundles = (manifest.dsh?.profile?.bundles ?? [])
    .filter((name) => name.startsWith('@dsh-enterprise/'))
  for (const bundle of enterpriseBundles) {
    if (!stdout.includes(`name: '${bundle}'`) && !stdout.includes(`name: ${bundle}`)) {
      errors.push(`最终配置缺少企业 Bundle：${bundle}`)
    }
  }

  if (errors.length > 0) {
    console.error(errors.map((line) => `error: ${line}`).join('\n'))
    if (stdout) console.error(`\n--- dump stdout ---\n${stdout}`)
    if (stderr) console.error(`\n--- dump stderr ---\n${stderr}`)
    process.exitCode = 1
  } else {
    console.log(`profile verify passed (${enterpriseBundles.length} 个企业 Bundle 已装配)`)
  }
} else if (command === 'install') {
  const result = spawnSync(pnpm, ['install'], { cwd: profile, stdio: 'inherit', shell: isWindows, env })
  process.exitCode = result.status ?? 1
} else if (command === 'run') {
  const result = dsh(process.argv.slice(3), { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} else {
  console.error(`未知命令：${command}（可用：dump | verify | install | run）`)
  process.exit(1)
}
