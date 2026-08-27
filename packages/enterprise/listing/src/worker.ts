/**
 * Python Worker 进程管理。
 *
 * 单进程、NDJSON over stdin/stdout、请求严格串行；同一插件实例内的
 * inspect/run_code/publish 共享 Python 会话状态。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface WorkerRequest {
  operation: string
  project: string
  scenario?: string
  credentialRef?: string
  code?: string
  [key: string]: unknown
}

export interface WorkerResponse {
  ok: boolean
  action?: string
  inspection?: unknown
  receipt?: unknown
  code?: string
  reason?: string
  retryable?: boolean
}

const DEFAULT_WORKER_SCRIPT = fileURLToPath(new URL('../python/worker.py', import.meta.url))
const DEFAULT_TIMEOUT_MS = 600_000

export class PythonWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private disposed = false
  private queue: Promise<void> = Promise.resolve()

  request(request: WorkerRequest, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<WorkerResponse> {
    const operation = this.queue.then(() => this.send(request, timeoutMs))
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async send(request: WorkerRequest, timeoutMs: number): Promise<WorkerResponse> {
    if (this.disposed) throw new Error('Worker已释放')
    const proc = await this.ensureProcess()

    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''

      const cleanup = () => {
        clearTimeout(timer)
        proc.stdout.off('data', onStdout)
        proc.stderr.off('data', onStderr)
        proc.off('exit', onExit)
      }
      const fail = (error: Error) => {
        cleanup()
        this.kill()
        reject(error)
      }
      const onStdout = (chunk: Buffer) => {
        stdout += chunk.toString()
        const newline = stdout.indexOf('\n')
        if (newline < 0) return
        const line = stdout.slice(0, newline).trim()
        cleanup()
        try {
          resolve(JSON.parse(line) as WorkerResponse)
        } catch {
          this.kill()
          reject(new Error(`无法解析Worker响应: ${line}`))
        }
      }
      const onStderr = (chunk: Buffer) => {
        stderr += chunk.toString()
      }
      const onExit = (code: number | null) => {
        fail(new Error(`Worker退出码: ${code ?? 'unknown'}\nstderr: ${stderr}`))
      }
      const timer = setTimeout(() => fail(new Error('Worker超时')), timeoutMs)

      proc.stdout.on('data', onStdout)
      proc.stderr.on('data', onStderr)
      proc.once('exit', onExit)
      proc.stdin.write(`${JSON.stringify(request)}\n`)
    })
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.proc && this.proc.exitCode === null) return this.proc

    return new Promise((resolve, reject) => {
      const proc = spawn('python', [DEFAULT_WORKER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })
      const onError = (error: Error) => {
        this.proc = null
        reject(new Error(`无法启动Python Worker: ${error.message}`))
      }
      proc.once('error', onError)
      proc.once('spawn', () => {
        proc.off('error', onError)
        this.proc = proc
        resolve(proc)
      })
    })
  }

  private kill(): void {
    this.proc?.kill()
    this.proc = null
  }

  dispose(): void {
    this.disposed = true
    this.kill()
  }
}
