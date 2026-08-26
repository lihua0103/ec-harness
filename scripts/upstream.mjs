import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const upstream = path.join(root, 'upstream', 'deepseek-harness')
const command = process.argv[2] ?? 'status'
const isWindows = process.platform === 'win32'

/** 企业层承诺兼容的上游包管理器与 Node 主版本区间。 */
const EXPECTED_PACKAGE_MANAGER = 'pnpm'
const EXPECTED_PNPM_MAJOR = 11
const EXPECTED_ENGINES_NODE = '^22.19.0 || >=24.0.0'

function fail(message) {
  console.error(`[upstream] ${message}`)
  process.exit(1)
}

function git(args, options = {}) {
  return spawnSync('git', args, { cwd: upstream, shell: isWindows, ...options })
}

function gitInherit(args) {
  const result = git(args, { stdio: 'inherit' })
  if (result.status !== 0) fail(`git ${args.join(' ')} 失败，退出码 ${result.status ?? 'unknown'}`)
}

function gitOut(args) {
  const result = git(args, { encoding: 'utf8' })
  if (result.status !== 0) fail(`git ${args.join(' ')} 失败：${(result.stderr ?? '').trim()}`)
  return (result.stdout ?? '').trim()
}

if (!fs.existsSync(path.join(upstream, '.git'))) {
  fail('upstream/deepseek-harness 未初始化，请执行 git submodule update --init --depth 1')
}

if (command === 'status') {
  const sha = gitOut(['rev-parse', 'HEAD'])
  const described = gitOut(['describe', '--tags', '--always'])
  console.log(`[upstream] pin: ${described} (${sha})`)
  gitInherit(['status', '--short', '--branch'])
} else if (command === 'sync') {
  // 只做 fetch 是无效的同步：submodule 仍停在旧 SHA。这里显式把工作树推进到
  // 目标 ref，并让企业侧看见 pin 的变化，以便提交新的 submodule 指针。
  const ref = process.argv[3] ?? 'origin/main'
  const before = gitOut(['rev-parse', 'HEAD'])
  gitInherit(['fetch', '--tags', 'origin'])
  const target = gitOut(['rev-parse', ref])
  if (target === before) {
    console.log(`[upstream] 已是最新：${ref} == ${before}`)
  } else {
    // detach 到目标 SHA：submodule 的正确形态是游离 HEAD，由父仓库记录指针。
    gitInherit(['checkout', '--detach', target])
    console.log(`[upstream] ${before} -> ${target}`)
    console.log('[upstream] 请在父仓库提交新的 submodule 指针，并按 UPSTREAM_UPGRADE.md 跑回归。')
  }
} else if (command === 'verify') {
  const pkg = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json'), 'utf8'))
  const errors = []

  const declared = pkg.packageManager ?? ''
  const match = /^([a-z]+)@(\d+)\./.exec(declared)
  if (match === null) {
    errors.push(`无法解析上游 packageManager：${JSON.stringify(declared)}`)
  } else {
    const [, name, major] = match
    // 比主版本，而非字符串全等：上游打补丁版本不应让企业门禁误报。
    if (name !== EXPECTED_PACKAGE_MANAGER) errors.push(`上游包管理器变为 ${name}，企业基线假设 ${EXPECTED_PACKAGE_MANAGER}`)
    else if (Number(major) !== EXPECTED_PNPM_MAJOR) {
      errors.push(`上游 pnpm 主版本变为 ${major}（企业基线 ${EXPECTED_PNPM_MAJOR}）：需复核 lockfile 与 workspace 设置后更新本脚本`)
    }
  }

  const engines = pkg.engines?.node
  if (engines !== EXPECTED_ENGINES_NODE) {
    errors.push(`上游 engines.node 变为 ${JSON.stringify(engines)}（企业基线 ${JSON.stringify(EXPECTED_ENGINES_NODE)}）：需同步企业各包 engines`)
  }

  for (const key of ['workspaces', 'scripts']) {
    if (pkg[key] === undefined) errors.push(`官方基线缺少字段：${key}`)
  }

  if (errors.length > 0) {
    console.error(errors.map((line) => `[upstream] ${line}`).join('\n'))
    process.exit(1)
  }
  console.log(`[upstream] verified: ${pkg.name}@${pkg.version} (${declared}, node ${engines})`)
} else {
  fail(`未知命令：${command}（可用：status | sync [ref] | verify）`)
}
