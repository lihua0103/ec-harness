/**
 * Python Worker 进程管理
 * 
 * 单进程、JSON over stdin/stdout、请求串行
 */
import { spawn, ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface WorkerRequest {
  operation: string
  project: string
  scenario?: string
  credentialRef?: string
  code?: string
  [key: string]: any
}

export interface WorkerResponse {
  ok: boolean
  action?: string
  inspection?: any
  receipt?: any
  code?: string
  reason?: string
  retryable?: boolean
}

const DEFAULT_WORKER_SCRIPT = fileURLToPath(
  new URL('../python/worker.py', import.meta.url)
)
const DEFAULT_TIMEOUT_MS = 600_000 // 10 minutes

export class PythonWorker {
  private proc: ChildProcess | null = null
  private disposed = false

  async request(
    request: WorkerRequest,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<WorkerResponse> {
    if (this.disposed) {
      throw new Error('Worker已释放')
    }

    // 启动进程（如果需要）
    if (!this.proc || this.proc.exitCode !== null) {
      await this.spawn()
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill()
        reject(new Error('Worker超时'))
      }, timeoutMs)

      let stdout = ''
      let stderr = ''

      const onData = (chunk: Buffer) => {
        stdout += chunk.toString()
      }

      const onError = (chunk: Buffer) => {
        stderr += chunk.toString()
      }

      const onExit = (code: number | null) => {
        clearTimeout(timer)
        this.proc?.stdout?.off('data', onData)
        this.proc?.stderr?.off('data', onError)
        this.proc?.off('exit', onExit)

        if (code !== 0) {
          reject(new Error(`Worker退出码: ${code}\nstderr: ${stderr}`))
          return
        }

        try {
          const response = JSON.parse(stdout)
          resolve(response)
        } catch (err) {
          reject(new Error(`无法解析Worker响应: ${stdout}`))
        }
      }

      this.proc!.stdout!.on('data', onData)
      this.proc!.stderr!.on('data', onError)
      this.proc!.once('exit', onExit)

      // 发送请求
      this.proc!.stdin!.write(JSON.stringify(request))
      this.proc!.stdin!.end()
    })
  }

  private async spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn('python', [DEFAULT_WORKER_SCRIPT], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        this.proc.on('error', (err) => {
          reject(new Error(`无法启动Python Worker: ${err.message}`))
        })

        // 给进程一点启动时间
        setTimeout(() => {
          if (this.proc && this.proc.exitCode === null) {
            resolve()
          } else {
            reject(new Error('Python Worker启动失败'))
          }
        }, 100)
      } catch (err) {
        reject(err)
      }
    })
  }

  private kill(): void {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }

  dispose(): void {
    this.disposed = true
    this.kill()
  }
}
