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
    text: `# 临床 Listing 工具使用规范

## 强制工作流
1. enterprise_listing_inspect：加载数据集元数据（列名、行数、文件路径）
2. enterprise_listing_run_code：生成 outputs 字典，每个键是工作表名，每个值是 pandas DataFrame
3. enterprise_listing_publish：唯一交付路径，生成单个规范化 Multi-Sheet Excel

**禁止**在 run_code 代码中调用 to_excel/to_csv 等写出 API，publish 会自动处理全部格式化和样式。

## 数据安全约束
inspect 只返回元数据（列名、路径、行数统计），不返回实际数据行。run_code 在沙箱内执行，数据集已预加载为 DataFrame，可通过变量名直接引用。

**严禁**在代码中尝试输出数据内容：
- 不要 print(df) / print(df.head()) / print(df.sample())
- 不要在 receipt 中返回 df.to_dict() / df.values
- 只基于 Spec/ALS 的列名和业务逻辑编写转换代码

模型只需关注：读取 Spec → 理解需求 → 编写 pandas 转换逻辑 → 定义 outputs 和 attrs。数据处理和输出由 Worker 沙箱安全执行。

## DataFrame.attrs 必需字段

### Manual/Medical/RBQM 场景
每个 DataFrame 必须设置：
\`\`\`python
df.attrs["labels"] = {
    "USUBJID": "Subject Identifier",
    "AGE": "Age (Years)",
    "SEX": "Sex"
}
\`\`\`

### Report 场景
首个 DataFrame 必须设置：
\`\`\`python
first_df.attrs["report_metadata"] = {
    "sponsor": "XX Pharma",
    "protocol_no": "ABC-001",
    "project_id": "WX12345",
    "report_date": "2026-08-27"
}
first_df.attrs["labels"] = {...}  # 业务字段仍需 labels
\`\`\`

## 输出结构规范

### Manual/Medical 场景（RT01 标准）
最终 Excel 包含：
- **Content Sheet（自动生成）**：
  - Row 1: "Comparison Summary" 标题
  - Row 2: 表头 ["Listing Seq.", "Form Name", "New/Modified ?", "Total", "New", "Modified", "Old"]
  - Row 3+: 每个业务表的变化统计
  
- **业务 Sheet**（如 LISTING_DM_01）：
  - Row 1: 返回链接 + Sheet 名称
  - Row 2: 变量名（英文）
  - Row 3: Label（中文或描述，来自 attrs["labels"]）
  - Row 4+: 数据行
  - 自动补齐比较审核列：Flag1, __cmp_FLAG__, __cmp_UpdateDetail__, __cmp_RCcomment__, __cmp_Idate__

### Report 场景（DM Status Report 标准）
最终 Excel 包含：
- **Cover Page（自动生成）**：
  - Row 1: "数据管理状态报告\nDM Status Report"
  - Row 2: 空行
  - Row 3: "申办方：\nSponsor:" + 值（来自 report_metadata.sponsor）
  - Row 4: "方案编号：\nProtocol No:" + 值
  - Row 5: "康德弘翼项目编号：\nWuXi Project ID:" + 值
  - Row 6: "最新报告生成日期：" + 值
  
- **业务 Sheet**（如 Matrix by Study）：
  - Row 1: 表头（单层，来自 DataFrame.columns）
  - Row 2+: 数据行
  - 不补齐比较审核列

### RBQM 场景
- 无固定 Content/Cover Page
- 业务 Sheet 结构同 Manual（3 行表头）
- 可自定义列结构，但必须提供 attrs["labels"]

## 一次需求输出单个 Excel
一次需求的所有 Listing 表必须放入同一个 outputs 字典，publish 只调用一次。确认 run_code 回执列出全部工作表后再 publish。`,
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


