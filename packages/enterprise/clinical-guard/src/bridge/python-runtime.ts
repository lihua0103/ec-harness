import type { Context } from '@deepseek-ai/cordis'
import type { ClinicalGuardConfig } from '../config'

/**
 * Python 运行时桥接层
 *
 * TypeScript 层与 Python 运行时层使用不同的配置形状：
 * - TS 层：结构化的嵌套配置（dataEgressControl.enabled 等）
 * - Python 层：扁平配置（dataInterceptionEnabled、brandName 等）
 *
 * 本模块负责配置映射与运行时加载，并处理 webServer 缺失等降级场景。
 */

/**
 * Python 运行时配置（对应 python/src/index.js 的 validateConfig 契约）
 */
export interface PythonRuntimeConfig {
  dataInterceptionEnabled: boolean
  brandName?: string
  brandShortName?: string
  maxScanRows?: number
  python?: string
  credentialsDir?: string
  localDataAccess?: 'disabled' | 'uat-local'
  localDataRoot?: string
  listingTimeoutMs?: number | Record<string, number>
  hookTimeoutMs?: number
}

/**
 * 将 TypeScript 层配置映射为 Python 运行时配置
 *
 * 映射规则：
 * - dataEgressControl.enabled → dataInterceptionEnabled（主开关）
 * - branding.* → brandName / brandShortName
 * - pythonPath → python
 */
export function toPythonRuntimeConfig(config: ClinicalGuardConfig): PythonRuntimeConfig {
  const runtimeConfig: PythonRuntimeConfig = {
    dataInterceptionEnabled: config.dataEgressControl.enabled,
  }

  if (config.branding?.enabled !== false) {
    if (config.branding?.brandName) {
      runtimeConfig.brandName = config.branding.brandName
    }
    if (config.branding?.brandShortName) {
      runtimeConfig.brandShortName = config.branding.brandShortName
    }
  }

  if (config.pythonPath) runtimeConfig.python = config.pythonPath
  if (config.credentialsDir) runtimeConfig.credentialsDir = config.credentialsDir
  if (config.localDataAccess) runtimeConfig.localDataAccess = config.localDataAccess
  if (config.localDataRoot) runtimeConfig.localDataRoot = config.localDataRoot

  // ListingTimeoutConfig 是具名接口，需展开为索引签名兼容的普通对象
  if (config.listingTimeoutMs !== undefined) {
    runtimeConfig.listingTimeoutMs =
      typeof config.listingTimeoutMs === 'number'
        ? config.listingTimeoutMs
        : Object.fromEntries(
            Object.entries(config.listingTimeoutMs).filter(
              (entry): entry is [string, number] => typeof entry[1] === 'number',
            ),
          )
  }

  return runtimeConfig
}

/**
 * Python 桥接模块的运行时形状
 *
 * 类型声明见 python/src/index.d.ts
 */
interface PythonBridgeModule {
  default?: (ctx: Context, config: PythonRuntimeConfig) => unknown
}

/**
 * 加载并挂载 Python 运行时
 *
 * Python 层依赖两个宿主服务，缺任一即无法挂载：
 * - `ctx.webServer` —— 品牌注入与数据拦截开关 API（registerBranding 会 fail-fast）
 * - `ctx.tools` —— Listing 工具与本地元数据工具注册
 *
 * 这两者在 headless 模式下不一定可用。此处主动前置检测并降级，
 * 而不是让整个插件加载崩溃（TypeScript 核心服务仍应正常工作）。
 *
 * Python 桥接使用 default 导出（clinicalDataGuard），不是 apply。
 *
 * @returns 是否成功挂载
 */
export async function loadPythonRuntime(
  ctx: Context,
  config: ClinicalGuardConfig,
): Promise<boolean> {
  const host = ctx as unknown as {
    webServer?: { tapIndex?: unknown; register?: unknown }
    tools?: { register?: unknown }
  }

  const missing: string[] = []
  if (
    typeof host.webServer?.tapIndex !== 'function' ||
    typeof host.webServer?.register !== 'function'
  ) {
    missing.push('webServer')
  }
  if (typeof host.tools?.register !== 'function') {
    missing.push('tools')
  }

  if (missing.length > 0) {
    ctx.logger.warn(
      `⚠️ 缺少宿主服务 [${missing.join(', ')}]（headless 模式？），跳过 Python 运行时挂载。` +
        '品牌注入、Listing 工具与数据沙箱将不可用；核心拦截策略不受影响。',
    )
    return false
  }

  let bridge: PythonBridgeModule
  try {
    bridge = (await import('../../python/src/index.js')) as PythonBridgeModule
  } catch (err) {
    ctx.logger.error(
      '❌ 加载 Python 运行时桥接失败:',
      err instanceof Error ? err.message : String(err),
    )
    return false
  }

  if (typeof bridge.default !== 'function') {
    ctx.logger.error('❌ Python 运行时桥接缺少 default 导出，跳过挂载')
    return false
  }

  try {
    bridge.default(ctx, toPythonRuntimeConfig(config))
    ctx.logger.info('✅ Python 运行时已挂载（品牌注入 / Listing 工具 / 数据沙箱）')
    return true
  } catch (err) {
    ctx.logger.error(
      '❌ Python 运行时初始化失败:',
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}
