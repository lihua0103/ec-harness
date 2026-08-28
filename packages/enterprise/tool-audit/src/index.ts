import type { Context } from '@deepseek-ai/cordis'
import { registerDatasetGuard, type GuardContext } from './dataset-guard.ts'

export const name = 'enterprise-tool-audit'
export const inject = ['tools']

/**
 * 企业工具护栏入口（ADR-0007：通用车道数据集护栏）。
 *
 * 职责：在 `tools/pre-execute` 拒绝通用工具（shell/文件读写等）对数据集
 * 文件（sas7bdat/xpt/csv，扩展名表来自 ui-settings DataSecurityService
 * 单源）的直接访问——防 2026-08-28 实战中"模型经 pwsh 系统 Python 绕过
 * listing 车道直读数据"的真实泄露路径。listing 车道自身（enterprise_*
 * 工具）豁免：其回执投影在 Python worker 的 data_guard 层完成。
 *
 * 旧 data-interceptor.ts（退役空壳）已由本实现取代；Windows 侧可删除该文件。
 */
export function apply(ctx: Context): void {
  const guard = ctx as unknown as GuardContext
  // 注册经 ctx.effect 托管：插件卸载时事件监听一并拆除（可卸载性）。
  ctx.effect(() => registerDatasetGuard(guard))
  guard.logger?.info?.('Enterprise dataset guard registered (tools/pre-execute, fail-closed)')
}
