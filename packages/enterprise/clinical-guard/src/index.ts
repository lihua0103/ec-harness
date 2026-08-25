import { Context } from '@deepseek-ai/cordis'
import { ClinicalGuardService, ClinicalGuardConfig, DEFAULT_CONFIG } from './service'

export { ClinicalGuardConfig, DEFAULT_CONFIG } from './service'
export { EgressType } from './core/egress-switch'
export { ListingTemplateType } from './core/listing-template'

/**
 * 插件名称
 */
export const name = '@dsh-guard/clinical-guard'

/**
 * 配置（使用默认配置）
 */
export const Config = DEFAULT_CONFIG

/**
 * 插件应用函数
 */
export function apply(ctx: Context, config: ClinicalGuardConfig) {
  ctx.plugin(ClinicalGuardService, config)
}

/**
 * 默认导出
 */
export default {
  name,
  Config,
  apply,
}

/**
 * TypeScript 模块扩展
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    clinicalGuard: ClinicalGuardService
  }
}
