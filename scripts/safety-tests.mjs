#!/usr/bin/env node
/**
 * P0 安全合成回归一键入口（方案 §12/§13，T00）。
 *
 * 只跑合成数据用例的显式白名单：
 *  - tool-audit / listing 的 vitest（pre-gate 能力合同 + post 扫描分类回执）
 *  - Python pytest 白名单（code_runner 阶段协议 + scan_init 指纹刷新）
 *
 * 不收集整个 Python tests 目录（真实项目 smoke 是显式 opt-in，不靠目录
 * 存在即执行）。真实用户路径 E2E（方案 §12.3）与本脚本无关——需要隔离
 * 环境与模型授权，单独执行，未授权时标 NOT RUN。
 *
 * 用法：node scripts/safety-tests.mjs [--fast]（--fast 跳过 pytest）
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fast = process.argv.includes('--fast')
const isWindows = process.platform === 'win32'
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm'
const python = process.env.DSH_PYTHON || 'python'

const PY_TESTS_DIR = join(repoRoot, 'packages', 'enterprise', 'listing', 'python', 'tests')
const PY_TEST_FILES = [
  'test_code_runner_stages.py',
  'test_scan_init_refresh.py',
  'test_controlled_analysis.py',
  'test_snapshot_binding.py',
  'test_real_project_false_positives.py',
  'test_scan_cache_stability.py',
  'test_data_guard.py',
  'test_doc_content_guard.py',
  'test_sandbox.py',
]

const steps = [
  { name: 'tool-audit vitest', command: pnpm, args: ['--dir', repoRoot, '--filter', '@dsh-enterprise/tool-audit', 'run', 'test'] },
  { name: 'listing vitest', command: pnpm, args: ['--dir', repoRoot, '--filter', '@dsh-enterprise/listing', 'run', 'test'] },
]
if (!fast) {
  steps.push({
    name: 'pytest 白名单（合成数据）',
    command: python,
    args: ['-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q',
      ...PY_TEST_FILES.map(file => join(PY_TESTS_DIR, file))],
  })
}

/** spawn 参数数组，不拼 shell 字符串；子进程失败即本脚本失败。
 *  Windows 注意：pnpm.cmd 是批处理转发器，Node ≥18.20 出于 CVE-2024-27980
 *  对 .cmd 直接 spawn 一律 EINVAL——须经 cmd.exe /d /s /c 中转（参数仍由
 *  Node 数组逐个传递，不经手工字符串拼接）。python.exe 是真实可执行文件，
 *  但统一走同一中转，避免两套启动路径。 */
function run(step) {
  return new Promise((resolveStep, rejectStep) => {
    console.log(`\n=== [safety-tests] ${step.name} ===`)
    const command = isWindows ? 'cmd.exe' : step.command
    const args = isWindows ? ['/d', '/s', '/c', step.command, ...step.args] : step.args
    const child = nodeSpawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
      windowsVerbatimArguments: false,
    })
    child.on('error', error => {
      rejectStep(new Error(`${step.name} 启动失败（${step.command}）: ${error.message}`))
    })
    child.on('exit', code => {
      if (code === 0) resolveStep()
      else rejectStep(new Error(`${step.name} 退出码 ${code ?? 'unknown'}`))
    })
  })
}

try {
  for (const step of steps) await run(step)
  console.log('\n[safety-tests] 全部合成安全回归通过（P0 面）。真实路径验收按方案 §12.3 单独执行。')
} catch (error) {
  console.error(`\n[safety-tests] 失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
