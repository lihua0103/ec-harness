/**
 * 企业临床 Listing 插件入口（ADR-0003）。
 * 每个 Agent 独占一个持久 Python Worker，三阶段共享会话且互不串扰。
 */
import type { Context } from '@deepseek-ai/cordis'
import { PythonWorker, type WorkerResponse } from './worker.js'

export const name = 'enterprise-listing'
export const inject = ['tools', 'systemPrompt']

const HEAVY_TIMEOUT_MS = 900_000
const SCENARIOS = ['medical', 'rbqm', 'manual', 'report'] as const

interface ToolExecutionContext {
  agent: object
  signal: AbortSignal
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (_args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: unknown, exec: ToolExecutionContext) => Promise<unknown>
}

interface ListingContext {
  tools: { register: (definition: ToolDefinition) => () => void }
  systemPrompt: { section: (section: { name: string; order: number; text: string }) => () => void }
  logger?: { info: (message: string) => void }
  effect: (effect: () => () => void) => unknown
}

const output = {
  // Harness 只接受标准 JSON Schema；工具回执均为 JSON object。
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function failure(result: WorkerResponse, fallback: string): never {
  throw Object.assign(new Error(result.reason || fallback), {
    code: result.code || 'LISTING_ERROR', expose: true, retryable: result.retryable,
  })
}

function registerTool(ctx: ListingContext, definition: Omit<ToolDefinition, 'output'>): () => void {
  return ctx.tools.register({ ...definition, output })
}

export function apply(ctx: Context): void {
  const listing = ctx as unknown as ListingContext
  const workers = new Map<object, PythonWorker>()
  const workerFor = (exec: ToolExecutionContext): PythonWorker => {
    let worker = workers.get(exec.agent)
    if (!worker) {
      worker = new PythonWorker()
      workers.set(exec.agent, worker)
    }
    return worker
  }

  listing.systemPrompt.section({
    name: 'tool:enterprise-listing', order: 116,
    text: `处理临床 Listing 时必须使用 enterprise_listing_inspect → enterprise_listing_run_code → enterprise_listing_publish。run_code 必须定义 outputs 字典；每个键是一个业务 Listing 的工作表名，每个值必须是 pandas DataFrame。字段显示名通过 DataFrame.attrs["labels"] = {变量名: Label} 提供。不要在代码中调用 Excel/CSV 写出 API，也不要自行生成单 Sheet 文件。一次需求中的所有 Listing 必须放入同一个 outputs，确认 run_code 回执列出全部工作表后再调用 publish。publish 是唯一交付路径，只生成一个 Excel。manual/medical 使用 RT01 标准结构，包含固定 Content 并自动补齐比较审核列；report 使用 DM Status Report 标准，包含固定 Cover Page、单层表头业务页，且不补比较审核列，可通过首个 DataFrame.attrs["report_metadata"] 提供 sponsor、protocol_no、project_id、report_date；rbqm 可自定义业务列结构但复用 RT01 视觉样式。只有用户明确要求单个 Listing 时才可仅提供一个数据工作表。`,
  })

  registerTool(listing, {
    name: 'enterprise_listing_inspect',
    description: '识别项目 doc/ 下 spec/ALS，并扫描 SAS/XPT/CSV 数据集。调用后数据集保留在当前 Listing 会话。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      scenario: { type: 'string', enum: SCENARIOS, description: 'Listing 场景类型（可选）' },
      credentialRef: { type: 'string', description: '加密归档凭据引用（可选）' },
    }, required: ['project'], additionalProperties: false },
    async execute(args, exec) {
      const { project, scenario, credentialRef } = args as { project: string; scenario?: string; credentialRef?: string }
      const result = await workerFor(exec).request(
        { operation: 'listing_inspect', project, scenario, credentialRef }, HEAVY_TIMEOUT_MS, exec.signal)
      if (!result.ok) failure(result, 'inspect failed')
      return result.inspection
    },
  })

  registerTool(listing, {
    name: 'enterprise_listing_run_code',
    description: '在当前隔离 Python 会话执行受限 pandas 代码。代码必须定义 outputs: dict[str, DataFrame]；禁止自行写 Excel/CSV。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      code: { type: 'string', description: '多行 Python/pandas 代码，必须定义 outputs' },
      credentialRef: { type: 'string', description: '加密归档凭据引用（可选）' },
    }, required: ['project', 'code'], additionalProperties: false },
    async execute(args, exec) {
      const { project, code, credentialRef } = args as { project: string; code: string; credentialRef?: string }
      const result = await workerFor(exec).request(
        { operation: 'listing_run_code', project, code, credentialRef }, HEAVY_TIMEOUT_MS, exec.signal)
      if (!result.ok) failure(result, 'run_code failed')
      return result.receipt
    },
  })

  registerTool(listing, {
    name: 'enterprise_listing_publish',
    description: '把当前会话最后一次成功的全部 outputs 原子发布为唯一规范化 Multi-Sheet Excel。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      scenario: { type: 'string', enum: SCENARIOS, description: '输出规范场景' },
      trackChanges: { type: 'boolean', description: '是否与上一版进行机械变化计数，默认 true' },
    }, required: ['project', 'scenario'], additionalProperties: false },
    async execute(args, exec) {
      const { project, scenario, trackChanges } = args as { project: string; scenario: string; trackChanges?: boolean }
      const result = await workerFor(exec).request(
        { operation: 'listing_publish', project, scenario, trackChanges }, HEAVY_TIMEOUT_MS, exec.signal)
      if (!result.ok) failure(result, 'publish failed')
      return result.receipt
    },
  })

  listing.effect(() => () => {
    for (const worker of workers.values()) worker.dispose()
    workers.clear()
  })
  listing.logger?.info('Enterprise Listing tools registered (agent-isolated Python workers)')
}
