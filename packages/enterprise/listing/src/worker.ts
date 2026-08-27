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

function abortError(): Error {
  return Object.assign(new Error('Listing Worker 请求已取消'), { name: 'AbortError', code: 'ABORT_ERR' })
}

export class PythonWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private disposed = false
  private queue: Promise<void> = Promise.resolve()

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
    return new Promise((resolve, reject) => {
      const proc = spawn('python', [DEFAULT_WORKER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })
      const onError = (error: Error) => { this.proc = null; reject(new Error(`无法启动Python Worker: ${error.message}`)) }
      proc.once('error', onError)
      proc.once('spawn', () => { proc.off('error', onError); this.proc = proc; resolve(proc) })
    })
  }

  private kill(): void { this.proc?.kill(); this.proc = null }
  dispose(): void { this.disposed = true; this.kill() }
}
