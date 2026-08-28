/**
 * 通用车道数据集护栏（ADR-0007 决策 3：防 shell/pwsh 绕过 listing 车道）。
 *
 * 2026-08-28 实战证据：模型在 listing 车道拿不到所需内容时，会用通用
 * shell（pwsh + 系统 Python）直读数据集文件——零拦截、零审计。本护栏在
 * `tools/pre-execute` 处按**路径引用**拒绝（源头判定，不做内容模式扫描）：
 *
 * - 只拦"工具参数里引用了数据集扩展名文件"（.sas7bdat/.xpt/.csv 等，
 *   扩展名表来自 DataSecurityService 单源，缺省内置默认）；
 * - 开关关闭（宿主设置页）→ 零拦截；服务未装配/读取抛错 → 按开（fail-closed）；
 * - `enterprise_*` 自有工具豁免（listing 车道有自己的投影出口）；
 * - 拒绝理由引导模型回 listing 车道——防住真实泄露，不把 AI 变盲。
 *
 * 残余边界（显式接受，非对抗威胁模型）：参数中不出现数据集文件名的
 * 间接读取（如先写辅助脚本再执行）不在拦截面内；由系统提示纪律与
 * 部署层 shell 权限收窄兜底。见 ADR-0007 §残留风险。
 */

/** 与 DataSecurityService 默认 / listing python DATA_EXTENSIONS 对齐。 */
export const DEFAULT_DATASET_EXTENSIONS = ['.sas7bdat', '.xpt', '.csv']

/** 官方 tools/pre-execute 的结构子集（packages/core/tools types，按名镜像）。 */
export interface ToolExecutionLike {
  readonly name: string
  readonly arguments: unknown
}

/** 官方 PreToolDecision 的结构子集：allow 放行 / deny 拒绝（错误对模型可见）。 */
export type PreToolDecisionLike =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/** 本插件用到的 ctx 结构子集（不依赖 ui-settings 的运行时类型）。 */
export interface GuardContext {
  on: (event: 'tools/pre-execute', listener: (exec: ToolExecutionLike, next: () => Promise<PreToolDecisionLike>) => Promise<PreToolDecisionLike>) => () => void
  /** 宿主侧数据安全开关（ui-settings 提供；未装配 = 拦截恒开，fail-closed） */
  dataSecurityService?: { isEnabled(): boolean; getDatasetExtensions?(): string[] }
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 数据集扩展名表 → 匹配"路径状 token 且以该扩展名结尾"的正则。 */
export function buildDatasetPattern(extensions: string[] = DEFAULT_DATASET_EXTENSIONS): RegExp {
  const alternatives = extensions
    .map(extension => extension.trim().toLowerCase())
    .filter(extension => extension.length > 1)
    .map(escapeRegExp)
  if (alternatives.length === 0) return /$^/            // 空表 = 永不匹配（零拦截语义由上层决定）
  return new RegExp(`[\\w\\-./\\\\:]+(?:${alternatives.join('|')})(?![\\w.])`, 'i')
}

/** 在任意 JSON 可序列化参数里找数据集文件引用；找不到返回 undefined。 */
export function findDatasetReference(arguments_: unknown, pattern: RegExp): string | undefined {
  let text: string
  try {
    text = JSON.stringify(arguments_) ?? ''
  } catch {
    return undefined                                    // 序列化失败不拦截（fail-open 于解析、fail-closed 于开关）
  }
  const matched = text.match(pattern)
  return matched?.[0]
}

/** 拒绝理由：明确指出替代车道，防住但不把模型变盲。 */
export function datasetDenyReason(reference: string): string {
  return `数据集原始数据不允许经通用工具读取（检测到 ${reference}）。`
    + '请改用企业 listing 车道：enterprise_listing_inspect（数据集元数据）、'
    + 'enterprise_listing_run_code（沙箱内对行数据计算，doc/ 材料全量可读）。'
    + '部署方如需放开，可在设置页 /settings/enterprise 关闭数据安全开关。'
}

/** 读宿主开关：服务未装配 / 抛错 → 开 + 内置默认扩展名（fail-closed）。 */
export function guardFlags(ctx: GuardContext): { enabled: boolean; extensions: string[] } {
  try {
    return {
      enabled: ctx.dataSecurityService?.isEnabled() ?? true,
      extensions: ctx.dataSecurityService?.getDatasetExtensions?.() ?? DEFAULT_DATASET_EXTENSIONS,
    }
  } catch {
    return { enabled: true, extensions: DEFAULT_DATASET_EXTENSIONS }
  }
}

/**
 * 纯写出型工具豁免（2026-08-28 FP 收口）：这类工具的参数是模型→磁盘方向，
 * 不会把文件内容带回模型上下文——写文档/补丁里**提及**数据集文件名不构成
 * 泄露（文件名本就来自 inspect 元数据），拦了纯属误伤。未知名保持保守拦截。
 */
const WRITE_ONLY_TOOLS = new Set([
  'write', 'edit', 'multiedit', 'apply_patch', 'notebookedit',
  'write_file', 'create_file', 'str_replace', 'insert',
])

/** 注册 pre-execute 护栏；返回 disposer（经 ctx.effect 托管可卸载）。 */
export function registerDatasetGuard(ctx: GuardContext): () => void {
  return ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = exec.name.toLowerCase()
    if (!toolName.startsWith('enterprise_') && !WRITE_ONLY_TOOLS.has(toolName)) {
      const flags = guardFlags(ctx)
      if (flags.enabled) {
        const reference = findDatasetReference(exec.arguments, buildDatasetPattern(flags.extensions))
        if (reference) {
          ctx.logger?.warn?.(`[dataset-guard] deny ${exec.name}: ${reference}`)
          return { kind: 'deny', reason: datasetDenyReason(reference) }
        }
      }
    }
    return next()
  })
}
