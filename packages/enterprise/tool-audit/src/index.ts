import type { Context } from '@deepseek-ai/cordis'
import { registerDatasetGuard, type GuardContext } from './dataset-guard.ts'

export const name = 'enterprise-tool-audit'
export const inject = ['tools']

/**
 * 企业工具护栏入口（ADR-0010，2026-09-03 第二次修订）。
 *
 * 通用车道防线两层：
 * 1. 本插件的 monotonic guard 做窄版 pre-execute 拒绝——只在通用工具
 *    参数中正向命中数据集/归档/doc 外辅助 Excel 的文件引用时拒绝，并
 *    给出改道 listing 车道的指引；内容型参数（write content、edit
 *    old/new_string 等）与 enterprise_* 车道豁免，参数不可解析不拒绝。
 * 2. listing 宿主的 post-execute 保护值扫描（listing_scan_text，专用
 *    扫描 Worker 进程）拦截结果文本中的两类受保护数据值。
 * 宿主关闭数据安全开关时两道防线都零处理。
 */
export function apply(ctx: Context): void {
  const guard = ctx as unknown as GuardContext
  // 注册经 ctx.effect 托管：插件卸载时 monotonic guard 一并拆除（可卸载性）。
  ctx.effect(() => registerDatasetGuard(guard))
  guard.logger?.info?.('Enterprise dataset guard registered (narrow pre-execute deny + listing post-execute value scan)')
}
