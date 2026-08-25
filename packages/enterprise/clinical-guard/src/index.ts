import { Context } from '@deepseek-ai/cordis'
import { ClinicalGuardService, ClinicalGuardConfig, DEFAULT_CONFIG } from './service'
import { loadPythonRuntime } from './bridge/python-runtime'

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
 *
 * 桥接 TypeScript 层与 Python 运行时层：
 * 1. TypeScript 层：服务编排、拦截策略、模板管理
 * 2. Python 层：品牌注入、Listing 工具、数据沙箱
 *
 * Python 层加载失败不会阻断 TypeScript 核心服务；headless 模式下
 * （无 webServer）会主动跳过 Python 层挂载。
 */
export function apply(ctx: Context, config: ClinicalGuardConfig = DEFAULT_CONFIG) {
  // 1. TypeScript 核心服务（同步注册，必须成功）
  ctx.plugin(ClinicalGuardService, config)

  // 2. Python 运行时（异步加载，失败降级）
  void loadPythonRuntime(ctx, config)
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
