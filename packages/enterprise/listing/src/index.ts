/**
 * 企业临床 Listing 插件入口（ADR-0003）。
 *
 * 通过 Harness 官方 tools + systemPrompt 能力缝暴露 inspect、run_code、publish；
 * Python Worker 在插件生命周期内持久化，确保三阶段共享数据集与最后成功结果。
 */
import type { Context } from '@deepseek-ai/cordis'
import { PythonWorker, type WorkerResponse } from './worker.js'

export const name = 'enterprise-listing'
export const inject = ['tools', 'systemPrompt']

const FAST_TIMEOUT_MS = 30_000
const HEAVY_TIMEOUT_MS = 900_000
const SCENARIOS = ['medical', 'rbqm', 'manual', 'report'] as const

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: { type: 'json' }
    render: (_args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: unknown) => Promise<unknown>
}

interface ListingContext {
  tools: { register: (definition: ToolDefinition) => () => void }
  systemPrompt: {
    section: (section: { name: string; order: number; text: string }) => () => void
  }
  logger?: { info: (message: string) => void }
  acceptHmr?: (url: string, handler: (replacement: { apply: (ctx: Context) => Array<() => void> }) => void) => void
}

const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function failure(result: WorkerResponse, fallback: string): never {
  throw Object.assign(new Error(result.reason || fallback), {
    code: result.code || 'LISTING_ERROR',
    expose: true,
    retryable: result.retryable,
  })
}

function registerTool(ctx: ListingContext, definition: Omit<ToolDefinition, 'output'>): () => void {
  return ctx.tools.register({ ...definition, output })
}

export function apply(ctx: Context): void {
  const worker = new PythonWorker()
  const listing = ctx as unknown as ListingContext

  listing.systemPrompt.section({
    name: 'tool:enterprise-listing',
    order: 116,
    text: `处理临床 Listing 时必须使用 enterprise_listing_inspect → enterprise_listing_run_code → enterprise_listing_publish。run_code 必须定义 outputs 字典；每个键是一个业务 Listing 的工作表名，每个值必须是 pandas DataFrame。字段显示名通过 DataFrame.attrs["labels"] = {变量名: Label} 提供。不要在代码中调用 Excel/CSV 写出 API，也不要自行生成单 Sheet 文件。一次需求中的所有 Listing 必须放入同一个 outputs，确认 run_code 回执列出全部工作表后再调用 publish。publish 是唯一交付路径，只生成一个 Excel。manual/medical 使用 RT01 标准结构，包含固定 Content 并自动补齐比较审核列；report 使用 DM Status Report 标准，包含固定 Cover Page、单层表头业务页，且不补比较审核列，可通过首个 DataFrame.attrs["report_metadata"] 提供 sponsor、protocol_no、project_id、report_date；rbqm 可自定义业务列结构但复用 RT01 视觉样式。只有用户明确要求单个 Listing 时才可仅提供一个数据工作表。`,
  })

  registerTool(listing, {
    name: 'enterprise_listing_inspect',
    description: '识别项目 doc/ 下 spec/ALS，并扫描 SAS/XPT/CSV 数据集。调用后数据集保留在当前 Listing 会话。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'harness 项目绝对路径' },
        scenario: { type: 'string', enum: SCENARIOS, description: 'Listing 场景类型（可选）' },
        credentialRef: { type: 'string', description: '加密归档凭据引用（可选）' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    async execute(args: unknown) {
      const { project, scenario, credentialRef } = args as { project: string; scenario?: string; credentialRef?: string }
      const result = await worker.request({ operation: 'listing_inspect', project, scenario, credentialRef }, HEAVY_TIMEOUT_MS)
      if (!result.ok) failure(result, 'inspect failed')
      return result.inspection
    },
  })

  registerTool(listing, {
    name: 'enterprise_listing_run_code',
    description: '在当前持久 Python 会话执行 pandas 代码。代码必须定义 outputs: dict[str, DataFrame]；禁止自行写 Excel/CSV。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'harness 项目绝对路径' },
        code: { type: 'string', description: '多行 Python/pandas 代码，必须定义 outputs' },
        credentialRef: { type: 'string', description: '加密归档凭据引用（可选）' },
      },
      required: ['project', 'code'],
      additionalProperties: false,
    },
    async execute(args: unknown) {
      const { project, code, credentialRef } = args as { project: string; code: string; credentialRef?: string }
      const result = await worker.request({ operation: 'listing_run_code', project, code, credentialRef }, FAST_TIMEOUT_MS)
      if (!result.ok) failure(result, 'run_code failed')
      return result.receipt
    },
  })

  registerTool(listing, {
    name: 'enterprise_listing_publish',
    description: '将当前会话最后一次成功的 outputs 发布为一个场景规范化 Excel：manual/medical 使用 Content，report 使用 Cover Page，均包含范例样式、冻结窗格与自动筛选。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'harness 项目绝对路径' },
        scenario: { type: 'string', enum: SCENARIOS, description: 'Listing 场景类型' },
        trackChanges: { type: 'boolean', description: '是否与上一版比较，默认 true' },
      },
      required: ['project', 'scenario'],
      additionalProperties: false,
    },
    async execute(args: unknown) {
      const { project, scenario, trackChanges } = args as { project: string; scenario: string; trackChanges?: boolean }
      const result = await worker.request({
        operation: 'listing_publish', project, scenario, trackChanges: trackChanges !== false,
      }, HEAVY_TIMEOUT_MS)
      if (!result.ok) failure(result, 'publish failed')
      return result.receipt
    },
  })

  listing.logger?.info('[listing] Enterprise listing plugin loaded with normalized multi-sheet output')

  if (listing.acceptHmr) {
    listing.acceptHmr(import.meta.url, replacement => replacement.apply(ctx))
  }

  ctx.effect(() => () => worker.dispose())
}
