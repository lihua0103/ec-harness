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

export interface DataSecurityConfig {
  enabled: boolean
  /** 数据集文件扩展名（唯一拦截场景：原始行值不出域；listing 车道与 tool-audit 护栏共用单源）。 */
  datasetExtensions: string[]
}

/** 纯函数：校验并规范化磁盘配置（未知/非法键一律丢弃，回落默认）。 */
export function sanitizeConfig(loaded: unknown): DataSecurityConfig {
  const source = (loaded ?? {}) as Partial<Record<string, unknown>>
  if (typeof source.enabled !== 'boolean') throw new Error('enabled 配置必须是 boolean')
  let datasetExtensions: string[] | undefined
  if (source.datasetExtensions !== undefined) {
    if (!Array.isArray(source.datasetExtensions) || !source.datasetExtensions.every(item => typeof item === 'string')) {
      throw new Error('datasetExtensions 配置必须是 string[]')
    }
    datasetExtensions = source.datasetExtensions.map(item => item.trim().toLowerCase()).filter(Boolean)
  }
  return {
    enabled: source.enabled,
    datasetExtensions: datasetExtensions?.length ? datasetExtensions : DEFAULT_DATASET_EXTENSIONS,
  }
}

export const DEFAULT_DATASET_EXTENSIONS = ['.sas7bdat', '.xpt', '.csv']
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

/**
 * 宿主侧数据安全开关（ADR-0007 口径的唯一开关本体）。
 *
 * - 消费方：@dsh-enterprise/listing（三工具回执投影 + worker 扩展名单
 *   下发）与 @dsh-enterprise/tool-audit（通用车道 pre-execute 护栏）。
 * - 默认开 + fail-closed：配置读不到 / 出错一律按"开"处理。
 * - 拦截只剩一个场景：数据集（datasetExtensions）原始行值不出域；
 *   doc/ 零拦截（ADR-0007，2026-08-28 起 auxExcelExtensions 已废除）。
 * - toggle 事件写 JSONL 审计（无数据值，只有时间与开关态）；
 *   写失败记日志（不静默吞）。
 * - webServer 路由 disposer 被收集，stop() 时拆除（可卸载，修审计 B-4）。
 */
export class DataSecurityService extends Service {
  static inject = ['webServer']
  private config: DataSecurityConfig = {
    enabled: true,
    datasetExtensions: [...DEFAULT_DATASET_EXTENSIONS],
  }
  private configPath: string
  private auditPath: string
  private disposers: Array<() => void> = []

  constructor(ctx: Context) {
    super(ctx, 'dataSecurityService')
    this.configPath = join(process.env.DSH_HOME || process.cwd(), 'profiles', 'enterprise', '.data-security.json')
    this.auditPath = join(process.env.DSH_HOME || process.cwd(), 'profiles', 'enterprise', '.data-audit.jsonl')
  }

  async start(): Promise<void> {
    await this.loadConfig()
    const webServer = this.ctx.get('webServer')
    if (!webServer) { this.ctx.logger?.warn('webServer not available, data security API will not be registered'); return }
    // disposer 一律收集（修审计 B-4：注册必须可卸载）
    this.disposers.push(webServer.register({ kind: 'exact', path: '/api/settings/data-security', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') return json(res, 200, this.snapshot())
      if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET, POST' })
      if (!sameOrigin(req)) return json(res, 403, { error: '跨源请求被拒绝' })
      // V-6：自定义头 CSRF 防线——设置页 fetch 恒携带；浏览器表单/跨源页无法伪造。
      // 本地进程读取配置文件本就等价可达，此处只收口浏览器侧 CSRF 面。
      if (req.headers['x-dsh-settings'] !== '1') return json(res, 403, { error: '缺少 X-DSH-Settings 请求头' })
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
    } }))
    this.disposers.push(webServer.register({ kind: 'exact', path: '/settings/enterprise', handler: async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(ENTERPRISE_SETTINGS_HTML)
    } }))
    this.ctx.logger?.info('Data security service started (enabled by default)')
  }

  async stop(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch (error) { this.ctx.logger?.warn('route dispose failed', error) }
    }
  }

  isEnabled(): boolean { return this.config.enabled }
  getDatasetExtensions(): string[] { return [...this.config.datasetExtensions] }
  snapshot(): DataSecurityConfig { return { enabled: this.config.enabled, datasetExtensions: this.getDatasetExtensions() } }

  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled 必须是 boolean')
    const previous = this.config.enabled
    if (previous === enabled) return
    this.config.enabled = enabled
    try { await this.saveConfig() }
    catch (error) { this.config.enabled = previous; throw error }
    // 审计写失败必须留痕（修审计 B-5：不静默吞），但不阻断开关本身。
    this.writeAudit(enabled).catch((error: unknown) => {
      this.ctx.logger?.warn('[data-security] 审计写入失败', error)
    })
    this.ctx.emit('data-security/changed', enabled)
    this.ctx.logger?.info(`Data security ${enabled ? 'enabled' : 'disabled'}`)
  }

  private async writeAudit(enabled: boolean): Promise<void> {
    await mkdir(dirname(this.auditPath), { recursive: true })
    await appendFile(this.auditPath, JSON.stringify({
      time: new Date().toISOString(), event: 'toggle', enabled,
    }) + '\n', 'utf8')
  }

  private async loadConfig(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.configPath, 'utf-8'))
      this.config = sanitizeConfig(raw)                    // 旧 auxExcelExtensions 等未知键自动丢弃
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.ctx.logger?.warn('Failed to load data security config', error)
      await this.saveConfig()
    }
  }

  private async saveConfig(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8')
  }
}
