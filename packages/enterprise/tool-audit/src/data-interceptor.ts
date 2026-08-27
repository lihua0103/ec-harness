import type { Context } from '@deepseek-ai/cordis'
import { minimatch } from 'minimatch'
import type { DataSecurityService } from '@dsh-enterprise/ui-settings'

export const name = 'enterprise-data-interceptor'
export const inject = ['dataSecurityService']

interface ToolExecution { name: string }

declare module '@deepseek-ai/cordis' {
  interface Context { dataSecurityService: DataSecurityService }
  interface Events {
    'data-security/check-file': (filePath: string) => { allowed: boolean; reason?: string }
    'data-security/changed': (enabled: boolean) => void
    'tools/pre-execute': (exec: ToolExecution, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>
  }
}

const LISTING_TOOLS = new Set([
  'enterprise_listing_inspect', 'enterprise_listing_run_code', 'enterprise_listing_publish',
])

/** 数据安全开启时，在正式工具调度边界阻断会向模型暴露临床数据的 Listing 流程。 */
export function apply(ctx: Context): void {
  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<{ kind: string }>) => {
    if (ctx.dataSecurityService.isEnabled() && LISTING_TOOLS.has(exec.name)) {
      return Promise.resolve({
        kind: 'deny',
        reason: '数据安全策略已启用：临床 Listing 会话可能向模型暴露真实数据。仅在获授权的受信环境中关闭数据安全开关后执行。',
      })
    }
    return next()
  })

  ctx.on('data-security/check-file', (filePath: string) => {
    if (!ctx.dataSecurityService.isEnabled()) return { allowed: true }
    for (const pattern of ctx.dataSecurityService.getProtectedPatterns()) {
      if (minimatch(filePath, pattern, { nocase: true })) {
        ctx.logger?.warn(`Data security: blocked access to ${filePath}`)
        return { allowed: false, reason: `数据安全策略已阻止访问敏感文件: ${filePath}` }
      }
    }
    return { allowed: true }
  })

  ctx.on('data-security/changed', enabled => {
    ctx.logger?.info(`Data security interception ${enabled ? 'enabled' : 'disabled'}`)
  })
  ctx.logger?.info('Data security interceptor initialized')
}


