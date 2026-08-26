import type { Context } from '@deepseek-ai/cordis'

/** 工具审计扩展的生命周期入口。具体审计策略应在企业 ADR 中定义。 */
export default function toolAudit(ctx: Context): void {
  ctx.effect(() => {
    // TODO: 在 tools/* waterfall 上注册鉴权、脱敏、审计和拒绝策略。
    return () => undefined
  })
}
