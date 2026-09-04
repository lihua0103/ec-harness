import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ENTERPRISE_SETTINGS_HTML } from './settings-page.js'

declare module '@deepseek-ai/cordis' {
  interface Context { dataSecurityService: DataSecurityService }
  interface Events { 'data-security/changed': (enabled: boolean) => void }
}

/** 宿主可切换的拦截开关；拦截对象固定，不随配置增减。 */
export interface DataSecurityConfig {
  enabled: boolean
  policy: 'two-value-interception'
}

export const DEFAULT_DATA_SECURITY_CONFIG: DataSecurityConfig = Object.freeze({
  enabled: true,
  policy: 'two-value-interception',
})

/** 配置只接受 enabled；历史扩展名键忽略，非法或损坏配置回落默认开启。 */
export function sanitizeConfig(loaded: unknown): DataSecurityConfig {
  const enabled = (loaded as { enabled?: unknown } | null | undefined)?.enabled
  if (typeof enabled !== 'boolean') throw new Error('enabled 配置必须是 boolean')
  return { enabled, policy: 'two-value-interception' }
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(value))
}

/** 写操作必须携带的防 CSRF 头（V-6 口径恢复：纯浏览器表单/跨站请求带不了它）。 */
const SETTINGS_MUTATION_HEADER = 'x-dsh-settings'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
      if (body.length > 4096) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}
/** 宿主侧数据安全开关：默认开启；关闭后消费方零拦截。 */
export class DataSecurityService extends Service {
  static inject = ['webServer']
  private config: DataSecurityConfig = { ...DEFAULT_DATA_SECURITY_CONFIG }
  private configPath: string
  private auditPath: string
  private disposers: Array<() => void> = []

  constructor(ctx: Context) {
    super(ctx, 'dataSecurityService')
    const root = join(process.env.DSH_HOME || process.cwd(), 'profiles', 'enterprise')
    this.configPath = join(root, '.data-security.json')
    this.auditPath = join(root, '.data-audit.jsonl')
  }

  async start(): Promise<void> {
    await this.loadConfig()
    // 开关加载即审计（2026-09-03：模型代码可篡改明文配置文件，持久化关闭
    // 必须在下一次启动时留下可追溯记录；手工改动同样入审计）。
    this.writeAuditEvent('load', this.config.enabled).catch((error: unknown) => {
      this.ctx.logger?.warn('[data-security] 加载审计写入失败', error)
    })
    const webServer = this.ctx.get('webServer')
    if (!webServer) {
      this.ctx.logger?.warn('webServer not available, data security API will not be registered')
      return
    }
    this.disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/settings/data-security',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') return json(res, 200, this.snapshot())
        if (req.method === 'POST') {
          if (req.headers[SETTINGS_MUTATION_HEADER] !== '1') {
            return json(res, 403, { error: 'Forbidden' })
          }
          // 纵深防御：带 Origin 的请求必须同源（V-6 口径恢复；无 Origin
          // 的同机非浏览器调用不受影响）。
          const origin = req.headers.origin
          if (origin) {
            try {
              if (new URL(origin).host !== req.headers.host) {
                return json(res, 403, { error: 'Forbidden' })
              }
            } catch {
              return json(res, 403, { error: 'Forbidden' })
            }
          }
          try {
            const body = JSON.parse(await readBody(req) || '{}') as { enabled?: unknown }
            if (typeof body.enabled !== 'boolean') {
              return json(res, 400, { error: 'enabled 必须是 boolean' })
            }
            await this.setEnabled(body.enabled)
            return json(res, 200, this.snapshot())
          } catch (error) {
            return json(res, 400, { error: `请求无效: ${(error as Error).message}` })
          }
        }
        return json(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET, POST' })
      },
    }))
    this.disposers.push(webServer.register({
      kind: 'exact',
      path: '/settings/enterprise',
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ENTERPRISE_SETTINGS_HTML)
      },
    }))
    this.ctx.logger?.info(`Data security service started (${this.config.enabled ? 'enabled' : 'disabled'})`)
  }

  async stop(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch (error) { this.ctx.logger?.warn('route dispose failed', error) }
    }
  }

  isEnabled(): boolean { return this.config.enabled }
  snapshot(): DataSecurityConfig { return { ...this.config } }

  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled 必须是 boolean')
    const previous = this.config
    if (previous.enabled === enabled) return
    this.config = { enabled, policy: previous.policy }
    try { await this.saveConfig() }
    catch (error) {
      this.config = previous
      throw error
    }
    this.writeAuditEvent('toggle', enabled).catch((error: unknown) => {
      this.ctx.logger?.warn('[data-security] 审计写入失败', error)
    })
    this.ctx.emit('data-security/changed', enabled)
    this.ctx.logger?.info(`Data security ${enabled ? 'enabled' : 'disabled'}`)
  }

  private async writeAuditEvent(event: 'toggle' | 'load', enabled: boolean): Promise<void> {
    await mkdir(dirname(this.auditPath), { recursive: true })
    await appendFile(this.auditPath, `${JSON.stringify({
      time: new Date().toISOString(), event, enabled,
    })}\n`, 'utf8')
  }

  private async loadConfig(): Promise<void> {
    try {
      this.config = sanitizeConfig(JSON.parse(await readFile(this.configPath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.ctx.logger?.warn('Failed to load data security config', error)
      }
      this.config = { ...DEFAULT_DATA_SECURITY_CONFIG }
      await this.saveConfig()
    }
  }

  private async saveConfig(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, JSON.stringify({ enabled: this.config.enabled }, null, 2), 'utf8')
  }
}
