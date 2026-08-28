/** 持久 Python Worker：NDJSON 串行协议、取消时终止进程。 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface WorkerRequest { operation: string; project: string; [key: string]: unknown }
export interface WorkerResponse {
  ok: boolean; action?: string; inspection?: unknown; receipt?: unknown
  code?: string; reason?: string; retryable?: boolean
}

const DEFAULT_WORKER_SCRIPT = fileURLToPath(new URL('../python/worker.py', import.meta.url))
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024

/**
 * Python 解释器候选链（审计 P1-4：不再写死单一 'python'）。
 * 可经 DSH_PYTHON 显式指定；否则按平台顺序探测：Windows 上 'python' 缺失时
 * 常见兜底是 py 启动器（py -3）；类 Unix 优先 python3。
 */
function pythonCandidates(): Array<{ command: string; preArgs: string[] }> {
  const explicit = process.env.DSH_PYTHON
  if (explicit) return [{ command: explicit, preArgs: [] }]
  return process.platform === 'win32'
    ? [{ command: 'python', preArgs: [] }, { command: 'py', preArgs: ['-3'] }]
    : [{ command: 'python3', preArgs: [] }, { command: 'python', preArgs: [] }]
}

/**
 * spawn 环境：**最小继承** + 强制 Python UTF-8。
 * 漏洞扫描 V-6：worker 进程曾继承宿主全部环境变量（含可能的凭据），
 * 配合沙箱逃逸面即 os.environ 可读。白名单只留解释器启动刚需：
 * Windows 缺 SYSTEMROOT/PATH 会导致 python/py 启动失败。
 */
function minimalSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const keys = process.platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']
    : ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'HOME']
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

function abortError(): Error {
  return Object.assign(new Error('Listing Worker 请求已取消'), { name: 'AbortError', code: 'ABORT_ERR' })
}

function pythonSpawnError(error: Error): Error {
  return Object.assign(
    new Error(`无法启动Python Worker（尝试过 ${pythonCandidates().map(c => c.command).join(', ')}）: ${error.message}`),
    { code: 'PYTHON_NOT_FOUND' },
  )
}

export class PythonWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private disposed = false
  private queue: Promise<void> = Promise.resolve()
  private spawnAttempt: Promise<ChildProcessWithoutNullStreams> | null = null

  request(request: WorkerRequest, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<WorkerResponse> {
    if (signal?.aborted) return Promise.reject(abortError())
    const operation = this.queue.then(() => this.send(request, timeoutMs, signal))
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async send(request: WorkerRequest, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResponse> {
    if (this.disposed) throw new Error('Worker已释放')
    if (signal?.aborted) throw abortError()
    const proc = await this.ensureProcess()
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        proc.stdout.off('data', onStdout); proc.stderr.off('data', onStderr); proc.off('exit', onExit)
        signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true; cleanup(); this.kill(); reject(error)
      }
      const onAbort = () => fail(abortError())
      const onStdout = (chunk: Buffer) => {
        stdout += chunk.toString()
        if (Buffer.byteLength(stdout) > MAX_PROTOCOL_LINE_BYTES) return fail(new Error('Worker响应超过协议上限'))
        const newline = stdout.indexOf('\n')
        if (newline < 0) return
        const line = stdout.slice(0, newline).trim()
        if (settled) return
        settled = true; cleanup()
        try { resolve(JSON.parse(line) as WorkerResponse) }
        catch { this.kill(); reject(new Error(`无法解析Worker响应: ${line.slice(0, 1000)}`)) }
      }
      const onStderr = (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384) }
      const onExit = (code: number | null) => fail(new Error(`Worker退出码: ${code ?? 'unknown'}\nstderr: ${stderr}`))
      const timer = setTimeout(() => fail(new Error('Worker超时')), timeoutMs)
      proc.stdout.on('data', onStdout); proc.stderr.on('data', onStderr); proc.once('exit', onExit)
      signal?.addEventListener('abort', onAbort, { once: true })
      proc.stdin.write(`${JSON.stringify(request)}\n`, error => { if (error) fail(error) })
    })
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.proc && this.proc.exitCode === null) return this.proc
    if (!this.spawnAttempt) {
      this.spawnAttempt = this.spawnPython().finally(() => { this.spawnAttempt = null })
    }
    return this.spawnAttempt
  }

  /** 依次尝试解释器候选；全部 ENOENT 才判 PYTHON_NOT_FOUND。 */
  private async spawnPython(): Promise<ChildProcessWithoutNullStreams> {
    let lastError: Error | null = null
    for (const candidate of pythonCandidates()) {
      try {
        return await this.trySpawn(candidate.command, candidate.preArgs)
      } catch (error) {
        lastError = error as Error
        // 非"命令不存在"类失败不换候选（如权限错），直接上抛。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    throw pythonSpawnError(lastError ?? new Error('no candidates'))
  }

  private trySpawn(command: string, preArgs: string[]): Promise<ChildProcessWithoutNullStreams> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, [...preArgs, DEFAULT_WORKER_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: minimalSpawnEnv(),
        windowsHide: true,
      })
      const onError = (error: Error) => { this.proc = null; reject(error) }
      proc.once('error', onError)
      proc.once('spawn', () => { proc.off('error', onError); this.proc = proc; resolve(proc) })
    })
  }

  private kill(): void { this.proc?.kill(); this.proc = null }
  dispose(): void { this.disposed = true; this.kill() }
}
