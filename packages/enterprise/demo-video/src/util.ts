import { mkdirSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

/** 统一错误工厂：稳定错误码 + 模型可见的出路提示（expose=true 才回传模型）。 */
export function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, expose: true })
}

/** workDir 契约：绝对路径、存在（可创建）、单模块单目录（单目录输出红线）。 */
export function assertWorkDir(workDir: unknown, create = true): string {
  if (typeof workDir !== 'string' || workDir.trim() === '' || !isAbsolute(workDir)) {
    throw fail('DEMO_WORKDIR_INVALID', 'workDir 必须是工作目录的绝对路径（一个模块一个目录，产物全落该目录）。')
  }
  const dir = resolvePath(workDir.trim())
  if (create) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      throw fail('DEMO_WORKDIR_CREATE_FAILED', `工作目录创建失败：${dir}（${(error as Error).message}）`)
    }
  }
  return dir
}

/** 模块标识只允许安全文件名字符（用于录像/成片命名，防路径逃逸）。 */
export function sanitizeModule(module: unknown, fallback = 'demo'): string {
  const m = typeof module === 'string' ? module.replace(/[^\w.-]/g, '') : ''
  return m || fallback
}

/** 日志回执脱敏：主机信息与账号密码不出现在模型回执。 */
export function maskHosts(text: string): string {
  return text.replace(/\/\/[^/\s"']+/g, '//[host]')
}

export function scrubSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***')
  }
  return out
}
