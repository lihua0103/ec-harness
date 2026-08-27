import type { Context } from '@deepseek-ai/cordis'
import { apply as applyDataInterceptor } from './data-interceptor.js'

export const name = 'enterprise-tool-audit'

/** 工具审计扩展的生命周期入口。具体审计策略应在企业 ADR 中定义。 */
export function apply(ctx: Context): void {
  ctx.plugin(applyDataInterceptor)

  ctx.effect(() => {
    // TODO: 在 tools/* waterfall 上注册其他鉴权、脱敏、审计和拒绝策略。
    return () => undefined
  })
}