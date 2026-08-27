import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ENTERPRISE_SETTINGS_HTML } from './settings-page.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dataSecurityService: DataSecurityService
  }
  interface Events {
    'data-security/changed': (enabled: boolean) => void
  }
}

export interface DataSecurityConfig {
  /** 数据安全拦截是否启用，默认 true */
  enabled: boolean
  /** 受保护的文件模式（glob patterns） */
  protectedPatterns: string[]
}

export class DataSecurityService extends Service {
  static inject = ['webServer']

  private config: DataSecurityConfig = {
    enabled: true, // 默认启用
    protectedPatterns: [
      '**/*.sas7bdat',
      '**/*.xpt',
      '**/data/**/*.xlsx',
      '**/data/**/*.xls',
      '**/spec/**/*.xlsx',
      '**/spec/**/*.xls',
    ],
  }

  private configPath: string

  constructor(ctx: Context) {
    super(ctx, 'dataSecurityService')
    const dshHome = process.env.DSH_HOME || process.cwd()
    this.configPath = join(dshHome, 'profiles', 'enterprise', '.data-security.json')
  }

  async start(): Promise<void> {
    // 加载持久化配置
    await this.loadConfig()
    
    const webServer = this.ctx.get('webServer')
    if (!webServer) {
      this.ctx.logger?.warn('webServer not available, data security API will not be registered')
      return
    }

    // 注册 HTTP API 端点
    webServer.register({
      kind: 'exact',
      path: '/api/settings/data-security',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ enabled: this.config.enabled }))
        } else if (req.method === 'POST') {
          let body = ''
          for await (const chunk of req) body += chunk
          const { enabled } = JSON.parse(body)
          await this.setEnabled(enabled)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, enabled: this.config.enabled }))
        } else {
          res.writeHead(405)
          res.end()
        }
      },
    })

    // 注册企业设置页面
    webServer.register({
      kind: 'exact',
      path: '/settings/enterprise',
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ENTERPRISE_SETTINGS_HTML)
      },
    })

    this.ctx.logger?.info('Data security service started (enabled by default)')
    this.ctx.logger?.info('Enterprise settings page available at /settings/enterprise')
  }

  /** 检查数据安全拦截是否启用 */
  isEnabled(): boolean {
    return this.config.enabled
  }

  /** 获取受保护的文件模式 */
  getProtectedPatterns(): string[] {
    return [...this.config.protectedPatterns]
  }

  /** 设置启用状态并持久化 */
  async setEnabled(enabled: boolean): Promise<void> {
    const changed = this.config.enabled !== enabled
    this.config.enabled = enabled
    await this.saveConfig()
    if (changed) {
      this.ctx.emit('data-security/changed', enabled)
      this.ctx.logger?.info(`Data security ${enabled ? 'enabled' : 'disabled'}`)
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const content = await readFile(this.configPath, 'utf-8')
      const loaded = JSON.parse(content)
      this.config = { ...this.config, ...loaded }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.ctx.logger?.warn('Failed to load data security config', err)
      }
      // 首次运行或读取失败，使用默认配置并保存
      await this.saveConfig()
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      const dir = join(this.configPath, '..')
      await mkdir(dir, { recursive: true })
      await writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (err) {
      this.ctx.logger?.error('Failed to save data security config', err)
    }
  }
}
