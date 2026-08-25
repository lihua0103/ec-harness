#!/usr/bin/env node
/**
 * 运行 clinical-guard 的 Python 测试套件
 *
 * tests/ 下有 40+ 个 pytest 测试（安全沙箱、Listing 工作流、插件契约等），
 * 这些测试无法由 vitest 执行。本脚本负责：
 *   1. 定位虚拟环境中的 Python（优先 python/.venv）
 *   2. 检测 pytest 是否已安装，缺失时给出明确的安装指引
 *   3. 以插件根目录为 rootdir 运行 pytest
 *
 * Python 或 pytest 缺失时以 0 退出（跳过而非失败），
 * 避免在没有 Python 的环境中阻断 `pnpm test`。测试真正失败时才返回非 0。
 *
 * 用法：
 *   node scripts/run-pytest.js                # 全部
 *   node scripts/run-pytest.js tests/unit     # 指定目录
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_DIR = join(ROOT, 'packages', 'enterprise', 'clinical-guard')
const PYTHON_DIR = join(PLUGIN_DIR, 'python')
const IS_WINDOWS = process.platform === 'win32'
const VENV_PYTHON = IS_WINDOWS
  ? join(PYTHON_DIR, '.venv', 'Scripts', 'python.exe')
  : join(PYTHON_DIR, '.venv', 'bin', 'python')

const targets = process.argv.slice(2)

function log(msg) {
  process.stdout.write(`[pytest] ${msg}\n`)
}

function skip(msg, hint) {
  process.stdout.write(`[pytest] ⏭️  跳过 Python 测试：${msg}\n`)
  if (hint) process.stdout.write(`[pytest]    ${hint}\n`)
  process.exit(0)
}

/** 选择可用的 Python 解释器 */
function resolvePython() {
  if (existsSync(VENV_PYTHON)) return VENV_PYTHON
  for (const candidate of [process.env.PLUGIN_PYTHON, process.env.PYTHON, 'python3', 'python']) {
    if (!candidate) continue
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf-8', windowsHide: true })
    if (probe.status === 0) return candidate
  }
  return null
}

const python = resolvePython()
if (!python) {
  skip('未找到 Python 解释器', '安装 Python 3.9+ 后运行：node scripts/setup-python.js')
}

// pytest 未安装时给出明确指引，而不是抛出难懂的模块错误
const hasPytest = spawnSync(python, ['-c', 'import pytest'], { windowsHide: true }).status === 0
if (!hasPytest) {
  skip(
    'pytest 未安装',
    `安装开发依赖：${python} -m pip install -r packages/enterprise/clinical-guard/python/requirements-dev.txt`,
  )
}

log(`使用解释器：${python}`)
log(`目标：${targets.length ? targets.join(' ') : 'tests（全部）'}`)

// PYTHONPATH 指向 python/ 目录，使 `import security.xxx` 可解析
const pythonPath = [PYTHON_DIR, process.env.PYTHONPATH].filter(Boolean).join(IS_WINDOWS ? ';' : ':')

const result = spawnSync(python, ['-m', 'pytest', '-q', ...(targets.length ? targets : ['tests'])], {
  cwd: PLUGIN_DIR,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    PYTHONPATH: pythonPath,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  },
})

// pytest 退出码 5 = 未收集到测试，不视为失败
if (result.status === 5) {
  log('未收集到测试用例')
  process.exit(0)
}

process.exit(result.status ?? 1)
