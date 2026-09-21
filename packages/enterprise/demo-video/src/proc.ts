import { spawn } from 'node:child_process'

export interface RunResult {
  /** 进程退出码；被信号杀死时为 null。 */
  code: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  /** stdout/stderr 各自的捕获上限（超出截断，防止大日志撑爆回执）。 */
  maxChars?: number
}

/**
 * 无 shell 子进程执行（argv 数组直传，杜绝注入面）。超时或宿主中止都会
 * kill 子进程；AbortError 原样上抛由宿主处理，超时抛 PROC_TIMEOUT。
 */
export function runProc(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxChars = opts.maxChars ?? 1_000_000
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        shell: false,
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          try { child.kill() } catch { /* 已退出 */ }
        }, opts.timeoutMs)
      : null
    const onAbort = () => {
      try { child.kill() } catch { /* 已退出 */ }
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { if (stdout.length < maxChars) stdout += chunk })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < maxChars) stderr += chunk })
    child.on('error', error => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) {
        reject(Object.assign(new Error('操作已中止'), { name: 'AbortError' }))
        return
      }
      if (timedOut) {
        reject(Object.assign(new Error(`子进程超时（${opts.timeoutMs}ms）已被终止`), { code: 'PROC_TIMEOUT' }))
        return
      }
      resolve({ code, stdout, stderr })
    })
  })
}

/** 取文本尾部若干字符（错误回执只带尾部现场，不携带全量日志）。 */
export function tail(text: string, maxChars: number): string {
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(-maxChars)
}
