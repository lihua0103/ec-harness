import type { Context } from '@deepseek-ai/cordis'
import { apply as applyDataInterceptor } from './data-interceptor.js'

export const name = 'enterprise-tool-audit'

/** 企业工具策略入口。 */
export function apply(ctx: Context): void {
  ctx.plugin(applyDataInterceptor)
}
