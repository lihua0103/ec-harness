import type { Context } from '@deepseek-ai/cordis'
import { registerBranding, type BrandingConfig } from './branding.ts'

export const name = 'enterprise-branding'
export const inject = ['webServer']

/**
 * 企业品牌插件入口（ADR-0002）：WebUI 白标——标题、manifest、favicon
 * 与正文品牌词替换。纯品牌层，不携带任何业务开关；业务设置项（如临床
 * 出域拦截）属于各自的业务插件，通过设置面板扩展点自行注册。
 */
export function apply(ctx: Context, config: BrandingConfig = {}): void {
  // registerBranding 缺 webServer 即抛错，经 ctx.effect 同步上抛为 fiber
  // 失败，boot 期可见；返回的 disposer 由 effect 在插件卸载时调用。
  ctx.effect(() => registerBranding(ctx, config))
}