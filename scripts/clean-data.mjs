/**
 * 临床数据保留清理（opt-in，绝不在没有 --yes 时删除任何东西）。
 *
 * 覆盖面（均为运行时落地、含业务值的目录/文件）：
 * - sessions/            会话转录（按 ADR-0010 含完整 doc/** 内容）
 * - storages/session_projcache.json、workspace.json   项目/会话缓存
 * - %TEMP%/dsh-spill-*   上游 spill 落盘（doc 全量业务值）
 * - %TEMP%/dsh-listing-* listing 临时目录（可能残留数据集 pickle）
 * - 各项目 .clinical-listing/output 与 audit（只在显式传 --projects 时清理）
 *
 * 用法：
 *   node scripts/clean-data.mjs --dry-run            预览将删除的内容
 *   node scripts/clean-data.mjs --days 14 --yes      删除 14 天前的会话/缓存/临时
 *   node scripts/clean-data.mjs --days 0 --yes --projects G:\a,G:\b
 *                                                    额外清理指定项目的 listing 产物
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const days = Number(args.find((arg, index) => args[index - 1] === '--days') ?? 30)
const yes = has('--yes')
const dryRun = has('--dry-run')
const projectsArg = args.find((arg, index) => args[index - 1] === '--projects')
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

if (Number.isNaN(days) || days < 0) {
  console.error('--days 必须是非负整数')
  process.exit(1)
}
if (!yes && !dryRun) {
  console.error('拒绝执行：请显式传入 --yes（确认删除）或 --dry-run（仅预览）。')
  process.exit(1)
}

const targets = []
function addTarget(target, label) {
  targets.push({ target, label })
}

// 1. 会话转录与项目缓存（仓库根下）
const root = process.cwd()
const sessionsDir = path.join(root, 'sessions')
if (fs.existsSync(sessionsDir)) {
  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    const full = path.join(sessionsDir, entry.name)
    const mtime = fs.statSync(full).mtimeMs
    if (mtime < cutoff) addTarget(full, 'session transcripts')
  }
}
for (const name of ['session_projcache.json', 'workspace.json']) {
  const full = path.join(root, 'storages', name)
  if (fs.existsSync(full) && fs.statSync(full).mtimeMs < cutoff) addTarget(full, 'project cache')
}

// 2. %TEMP% 下企业 listing 相关落地
const temp = os.tmpdir()
for (const prefix of ['dsh-spill-', 'dsh-listing-']) {
  for (const entry of fs.readdirSync(temp, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue
    const full = path.join(temp, entry.name)
    if (fs.statSync(full).mtimeMs < cutoff) addTarget(full, `${prefix}* temp`)
  }
}

// 3. 显式指定的项目 listing 产物（.clinical-listing 整目录）
if (projectsArg) {
  for (const project of projectsArg.split(/[;,]/).filter(Boolean)) {
    const listing = path.join(project.trim(), '.clinical-listing')
    if (fs.existsSync(listing)) addTarget(listing, 'project .clinical-listing')
  }
}

if (targets.length === 0) {
  console.log(`没有早于 ${days} 天的待清理项。`)
  process.exit(0)
}

console.log(`将删除 ${targets.length} 项（阈值：${days} 天）：`)
for (const { target, label } of targets) {
  console.log(`  [${label}] ${target}`)
}

if (dryRun) {
  console.log('dry-run：未删除任何内容。')
  process.exit(0)
}

let removed = 0
for (const { target } of targets) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
    removed++
  } catch (error) {
    console.warn(`warn: 删除失败（占用/权限）：${target} —— ${error}`)
  }
}
console.log(`已删除 ${removed}/${targets.length} 项。`)
// 提醒上游工具是否存在（仅提示，不算失败）。
spawnSync('git', ['status', '--porcelain'], { cwd: root, stdio: 'ignore' })
