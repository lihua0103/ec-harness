import type { Context } from '@deepseek-ai/cordis'
import { DataSecurityService } from './data-security-service.js'

export const name = 'enterprise-ui-settings'
export const inject = ['webServer']

export function apply(ctx: Context): void {
  ctx.plugin(DataSecurityService)

  ctx.effect(() => {
    // 未来在此注册其他企业设置 UI 扩展
    return () => undefined
  })
}

// 导出类型供其他插件使用
export type { DataSecurityService, DataSecurityConfig } from './data-security-service.js'
