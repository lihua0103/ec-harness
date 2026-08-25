#!/usr/bin/env node
/**
 * Python 运行时环境准备脚本
 *
 * clinical-guard 插件的数据沙箱依赖 Python（pandas / pyreadstat / openpyxl）。
 * 本脚本在 pnpm install 后自动运行：
 *   1. 检测可用的 Python 解释器（>= 3.9）
 *   2. 在 python/.venv 创建虚拟环境
 *   3. 安装 requirements.txt
 *
 * 设计原则：不阻断安装。Python 缺失只警告，插件会在 headless/降级模式下运行。
 * 使用 `--check` 只做检测不安装。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON_DIR = join(ROOT, 'packages', 'enterprise', 'clinical-guard', 'python')
const REQUIREMENTS = join(PYTHON_DIR, 'requirements.txt')
const VENV_DIR = join(PYTHON_DIR, '.venv')
const IS_WINDOWS = process.platform === 'win32'
const VENV_PYTHON = IS_WINDOWS
  ? join(VENV_DIR, 'Scripts', 'python.exe')
  : join(VENV_DIR, 'bin', 'python')

const MIN_MAJOR = 3
const MIN_MINOR = 9
const CHECK_ONLY = process.argv.includes('--check')

function log(msg) {
  process.stdout.write(`[setup-python] ${msg}\n`)
}

function warn(msg) {
  process.stderr.write(`[setup-python] ⚠️  ${msg}\n`)
}

/** 运行命令并返回 { ok, stdout } —— 不抛异常 */
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    windowsHide: true,
    ...opts,
  })
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

/** 检测解释器版本是否满足最低要求 */
function versionOf(candidate) {
  const { ok, stdout } = run(candidate, [
    '-c',
    'import sys; print("%d.%d" % sys.version_info[:2])',
  ])
  if (!ok) return null
  const [major, minor] = stdout.split('.').map(Number)
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null
  if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) return null
  return `${major}.${minor}`
}

/** 按优先级查找系统 Python */
function findSystemPython() {
  const candidates = [
    process.env.PLUGIN_PYTHON,
    process.env.PYTHON,
    IS_WINDOWS ? 'python' : 'python3',
    IS_WINDOWS ? 'py' : 'python',
  ].filter(Boolean)

  for (const candidate of candidates) {
    const version = versionOf(candidate)
    if (version) return { path: candidate, version }
  }
  return null
}

function main() {
  if (!existsSync(REQUIREMENTS)) {
    log('未找到 requirements.txt，跳过 Python 环境准备')
    return
  }

  // 已有可用虚拟环境时直接复用
  if (existsSync(VENV_PYTHON)) {
    const version = versionOf(VENV_PYTHON)
    if (version) {
      log(`虚拟环境已就绪（Python ${version}）`)
      if (!CHECK_ONLY) installDeps(VENV_PYTHON)
      return
    }
    warn('已有虚拟环境不可用，将重新创建')
  }

  const system = findSystemPython()
  if (!system) {
    warn(
      `未找到 Python >= ${MIN_MAJOR}.${MIN_MINOR}。` +
        'clinical-guard 的数据沙箱、Listing 生成与表头检测将不可用。',
    )
    warn('安装 Python 后重新运行：pnpm run setup:python')
    return
  }

  log(`检测到 Python ${system.version}（${system.path}）`)

  if (CHECK_ONLY) {
    log('仅检测模式，跳过安装')
    return
  }

  log('创建虚拟环境…')
  const venv = run(system.path, ['-m', 'venv', VENV_DIR], { cwd: PYTHON_DIR })
  if (!venv.ok || !existsSync(VENV_PYTHON)) {
    warn(`创建虚拟环境失败：${venv.stderr || '未知错误'}`)
    warn('可手动执行：python -m venv packages/enterprise/clinical-guard/python/.venv')
    return
  }

  installDeps(VENV_PYTHON)
}

function installDeps(pythonPath) {
  log('安装 Python 依赖（pandas / pyreadstat / openpyxl …）…')
  const install = run(
    pythonPath,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', REQUIREMENTS],
    { cwd: PYTHON_DIR, stdio: 'inherit' },
  )
  if (!install.ok) {
    warn('Python 依赖安装失败，数据沙箱功能将不可用')
    warn(`可手动执行：${pythonPath} -m pip install -r ${REQUIREMENTS}`)
    return
  }
  log('✅ Python 环境准备完成')
}

main()
