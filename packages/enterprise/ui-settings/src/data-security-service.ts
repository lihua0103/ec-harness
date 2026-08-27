import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ENTERPRISE_SETTINGS_HTML } from './settings-page.js'

declare module '@deepseek-ai/cordis' {
  interface Context { dataSecurityService: DataSecurityService }
  interface Events { 'data-security/changed': (enabled: boolean) => void }
}

export interface DataSecurityConfig { enabled: boolean; protectedPatterns: string[] }
const MAX_BODY_BYTES = 4096

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(value))
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  try { return new URL(origin).host === host }
  catch { return false }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('请求体必须是合法 JSON'), { status: 400 }) }
}

export class DataSecurityService extends Service {
  static inject = ['webServer']
  private config: DataSecurityConfig = { enabled: true, protectedPatterns: [
    '**/*.sas7bdat', '**/*.xpt', '**/data/**/*.xlsx', '**/data/**/*.xls',
    '**/spec/**/*.xlsx', '**/spec/**/*.xls',
  ] }
  private configPath: string

  constructor(ctx: Context) {
    super(ctx, 'dataSecurityService')
    this.configPath = join(process.env.DSH_HOME || process.cwd(), 'profiles', 'enterprise', '.data-security.json')
  }

  async start(): Promise<void> {
    await this.loadConfig()
    const webServer = this.ctx.get('webServer')
    if (!webServer) { this.ctx.logger?.warn('webServer not available, data security API will not be registered'); return }
    webServer.register({ kind: 'exact', path: '/api/settings/data-security', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') return json(res, 200, { enabled: this.config.enabled })
      if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET, POST' })
      if (!sameOrigin(req)) return json(res, 403, { error: '跨源请求被拒绝' })
      try {
        const body = await readJsonBody(req) as { enabled?: unknown }
        if (typeof body?.enabled !== 'boolean') return json(res, 400, { error: 'enabled 必须是 boolean' })
        await this.setEnabled(body.enabled)
        return json(res, 200, { success: true, enabled: this.config.enabled })
      } catch (error) {
        const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500
        this.ctx.logger?.warn('Data security settings update failed', error)
        return json(res, status, { error: status === 500 ? '设置保存失败' : (error as Error).message })
      }
    } })
    webServer.register({ kind: 'exact', path: '/settings/enterprise', handler: async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(ENTERPRISE_SETTINGS_HTML)
    } })
    this.ctx.logger?.info('Data security service started (enabled by default)')
  }

  isEnabled(): boolean { return this.config.enabled }
  getProtectedPatterns(): string[] { return [...this.config.protectedPatterns] }

  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled 必须是 boolean')
    const previous = this.config.enabled
    if (previous === enabled) return
    this.config.enabled = enabled
    try { await this.saveConfig() }
    catch (error) { this.config.enabled = previous; throw error }
    this.ctx.emit('data-security/changed', enabled)
    this.ctx.logger?.info(`Data security ${enabled ? 'enabled' : 'disabled'}`)
  }

  private async loadConfig(): Promise<void> {
    try {
      const loaded = JSON.parse(await readFile(this.configPath, 'utf-8')) as Partial<DataSecurityConfig>
      if (typeof loaded.enabled !== 'boolean') throw new Error('enabled 配置必须是 boolean')
      if (loaded.protectedPatterns !== undefined && (!Array.isArray(loaded.protectedPatterns)
          || !loaded.protectedPatterns.every(item => typeof item === 'string'))) {
        throw new Error('protectedPatterns 配置必须是 string[]')
      }
      this.config = { ...this.config, ...loaded }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.ctx.logger?.warn('Failed to load data security config', error)
      await this.saveConfig()
    }
  }

  private async saveConfig(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
  }
}
