/**
 * Python 运行时桥接层的类型声明
 *
 * python/src/index.js 是手写的 JavaScript（不参与 tsc 编译），
 * 这里声明其对外契约，供 TypeScript 侧的动态 import 使用。
 */

import type { Context } from '@deepseek-ai/cordis'

/** Python 运行时接受的扁平配置 */
export interface ClinicalDataGuardRuntimeConfig {
  dataInterceptionEnabled?: boolean
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
 * 挂载 Python 安全运行时（品牌注入 / Listing 工具 / 数据沙箱）
 *
 * 需要 ctx.webServer 服务；缺失时抛错（品牌注入是部署契约的一部分）。
 */
export default function clinicalDataGuard(
  ctx: Context,
  config?: ClinicalDataGuardRuntimeConfig,
): void
