import type { Context } from '@deepseek-ai/cordis'
import type { DataSecurityService } from '@dsh-enterprise/ui-settings'

export const name = 'enterprise-data-interceptor'
export const inject = ['dataSecurityService']

declare module '@deepseek-ai/cordis' {
  interface Context {
    dataSecurityService: DataSecurityService
  }
  
  interface Events {
    'data-security/check-file': (filePath: string) => { allowed: boolean; reason?: string }
    'data-security/changed': (enabled: boolean) => void
  }
}

/**
 * 数据安全拦截器
 * 
 * 功能：当数据安全开关启用时，监控并阻止敏感数据发送给 AI。
 * 
 * 拦截策略：
 * 1. SAS 数据集文件（*.sas7bdat, *.xpt）
 * 2. data/ 或 spec/ 目录下的 Excel 文件（*.xlsx, *.xls）
 * 
 * 实现机制：
 * - 通过自定义事件在工具层与模型层之间建立拦截点
 * - 当开关关闭时，所有检查直接旁路，零性能损耗
 */
export function apply(ctx: Context): void {
  const minimatch = require('minimatch').minimatch

  // 定义数据安全检查事件处理器
  ctx.on('data-security/check-file', (filePath: string) => {
    if (!ctx.dataSecurityService.isEnabled()) {
      return { allowed: true }
    }

    const patterns = ctx.dataSecurityService.getProtectedPatterns()

    for (const pattern of patterns) {
      if (minimatch(filePath, pattern, { nocase: true })) {
        ctx.logger?.warn(`Data security: blocked access to ${filePath}`)
        return {
          allowed: false,
          reason: `数据安全策略已阻止访问敏感文件: ${filePath}。此文件包含受保护的临床数据或 SAS 数据集，不允许发送给 AI 模型。`,
        }
      }
    }

    return { allowed: true }
  })

  // 监听状态变化
  ctx.on('data-security/changed', (enabled: boolean) => {
    ctx.logger?.info(`Data security interception ${enabled ? 'enabled' : 'disabled'}`)
  })

  ctx.logger?.info('Data security interceptor initialized')
}
