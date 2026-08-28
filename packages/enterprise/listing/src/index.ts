/**
 * 企业临床 Listing 插件入口（ADR-0003 + ADR-0007 数据拦截口径）。
 * 每个 Agent 独占一个持久 Python Worker，三阶段共享会话且互不串扰。
 *
 * 数据拦截开关是**宿主侧**的（ui-settings DataSecurityService 设置页，
 * 修审计 P0-1：模型永远接触不到开关）。execute 每次调用读取
 * `dataSecurityService.isEnabled()` 与 `getDatasetExtensions()` 并随请求
 * 下发 worker（单源配置，修审计 B-3）；服务未装配 / 读取出错 → 一律按
 * "开 + 内置默认扩展名"处理（fail-closed）。
 *
 * 拦截只剩一种场景（ADR-0007，2026-08-28 第三版）：
 * **doc/ 零拦截**——需求文本与辅助 Excel 全量可读；数据集
 * （sas7bdat/xpt/csv）原始行值不出域（→ 元数据白名单）。
 * stdout/AI 产物/错误消息一律不碰。通用工具（shell/文件读写）触碰数据集
 * 文件由 tool-audit 的 dataset 护栏拒绝（同一开关，防 pwsh 绕过）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { PythonWorker, type WorkerResponse } from './worker.js'

export const name = 'enterprise-listing'
export const inject = ['tools', 'systemPrompt']

/** 部署参数（cordis.patch.yml row config 下发；不写死在代码，CODING_STANDARDS）。 */
export interface ListingConfig {
  /** report 场景 Cover Page 行标签（如申办方特定文案）。 */
  reportCoverLabels?: string[]
}

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
  /** 宿主侧数据安全开关（ui-settings 提供；未装配 = 拦截恒开，fail-closed） */
  dataSecurityService?: { isEnabled(): boolean; getDatasetExtensions?(): string[] }
  logger?: { info: (message: string) => void; warn?: (message: string) => void }
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

/** 读宿主开关：服务未装配 / 抛错 → true（fail-closed：读不到就拦着）。 */
function interceptionEnabled(ctx: ListingContext): boolean {
  try {
    return ctx.dataSecurityService?.isEnabled() ?? true
  } catch {
    return true
  }
}

/** 读宿主数据集扩展名表（单源配置，修审计 B-3）；读不到 → undefined（worker 回落内置默认）。 */
function datasetExtensionsOf(ctx: ListingContext): string[] | undefined {
  try {
    return ctx.dataSecurityService?.getDatasetExtensions?.()
  } catch {
    return undefined
  }
}

/** 每次调用下发的宿主旗标：开关 + 扩展名单。 */
function hostFlags(ctx: ListingContext): { dataInterception: boolean; datasetExtensions?: string[] } {
  return { dataInterception: interceptionEnabled(ctx), datasetExtensions: datasetExtensionsOf(ctx) }
}

export function apply(ctx: Context, config: ListingConfig = {}): void {
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
    text: `# 临床 Listing 工具契约

## 强制工作流
1. enterprise_listing_inspect：读 doc/ 需求全文与 ALS 结构 + 数据集元数据（列名/行数/dtype/null/unique）
2. enterprise_listing_run_code：生成 outputs 字典，每个键是工作表名，每个值是 pandas DataFrame
3. enterprise_listing_publish：唯一交付路径，生成单个规范化 Multi-Sheet Excel

**禁止**在 run_code 代码中调用 to_excel/to_csv 等写出 API，publish 会自动处理全部格式化和样式。

## 标准输出范例（推荐跟随，非强制）

### Manual/Medical 场景（RT01 标准）
- Content Sheet（自动生成）：Row 1 标题 "Comparison Summary"；Row 2 表头 ["Listing Seq.", "Form Name", "New/Modified ?", "Total", "New", "Modified", "Old"]；Row 3+ 每业务表变化统计
- 业务 Sheet：Row 1 返回链接 + Sheet 名；Row 2 字段 Label；Row 3+ 数据
- 默认补齐审核列：Flag1, __cmp_FLAG__, __cmp_UpdateDetail__, __cmp_RCcomment__, __cmp_Idate__

### Report 场景（DM Status Report 标准）
- Cover Page（自动生成）：申办方 / 方案编号 / 项目编号 / 报告日期（来自首个 DataFrame 的 attrs["report_metadata"]）
- 业务 Sheet：单层表头（Row 1 表头，Row 2+ 数据）

### RBQM 场景
- 无固定 Content/Cover Page；业务 Sheet 结构同 Manual；可自定义列结构，但需提供 attrs["labels"]

## DataFrame.attrs 必需字段
Manual/Medical/RBQM 每个表：attrs["labels"] = {"USUBJID": "Subject Identifier", ...}
Report 场景首个表另需 attrs["report_metadata"] = {"sponsor": ..., "protocol_no": ..., "project_id": ..., "report_date": ...}

## 自定义排版（可选）
默认模板可跳过、排版可接管：
\`\`\`python
df.attrs["_skip_default_template"] = True      # 跳过默认模板（不注入审核列）
df.attrs["_layout"] = {
    "header_rows": 3,                           # 多层表头行数
    "header_columns": [["组1","组1","组2"], ["组1","组2","组2"]],  # 逐行表头，同值相邻自动合并
    "anchor_cell": [4, 1],                      # 数据起始锚点（1 基）
    "freeze_panes": "A4",
    "back_link": {"cell": "A1", "formula": '=HYPERLINK("#\\'Content\\'!A1","Go back")'},  # null=不写
    "column_widths": [20, 30, 30],
}
\`\`\`
样式（字体/颜色/边框/行高）始终来自标准样式原子；layout 只接管排版。

## 数据可见性（部署方策略，非模型可控）
- **doc/ 需求材料**：文本与 Excel 辅助表（ALS/DVP 等）**全量可读**——单元格值直接在 inspect 回执里，无需另想办法读取
- **数据集（sas7bdat/xpt/csv）**：回执只含元数据（列名/行数/dtype/nullCount/uniqueCount），行值不出域；行数据在 sandbox 的 datasets 变量中供你计算
- **你自己的产物与 stdout**：原样回显
- **通用工具（shell/文件读写）触碰数据集文件会被部署方拒绝**：这是数据车道管控，请改用 enterprise_listing_inspect / enterprise_listing_run_code
数据拦截开关由部署方在设置页控制，与模型无关。

## Sandbox 约束（程序执行安全，恒生效）
- import 白名单：numpy/pandas（护栏内）与 re/json/datetime/statistics/collections/itertools/functools/decimal/fractions/random/operator/string/numbers/bisect/heapq/math/textwrap——os/sys/shutil/pathlib/socket 等不可用
- 可用命名空间：datasets（会话数据集）、pd、np、math、rng（采样 Generator）、datetime、json、list_files(subdir)、scan_excel_structures(relpath)
- 可用内建含 dir/repr/map/filter 与 Exception/ValueError 等异常类——请写标准 except，无需裸 except
- pd.to_datetime/to_numeric/to_list/to_numpy/to_dict 等纯转换函数照常可用；被阻断的是：读取器（read_*）、写出器（to_csv/to_excel/to_pickle 等）、双下划线属性、名字 query/eval/exec
- 程序函数 list_files(subdir) / scan_excel_structures(path) 限项目根内，../ 越界即错
- 执行失败回执附 environmentHint（环境自描述），一次读明无需试错

## 一次需求输出单个 Excel
一次需求的所有 Listing 表必须放入同一个 outputs 字典，publish 只调用一次。确认 run_code 回执列出全部工作表后再 publish。`,
  })

  registerTool(listing, {
    name: 'enterprise_listing_inspect',
    description: '读取 doc/ 需求全文与 ALS 结构，并扫描 SAS/XPT/CSV 数据集（元数据回执）。调用后数据集保留在当前 Listing 会话。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      scenario: { type: 'string', enum: SCENARIOS, description: 'Listing 场景类型（可选）' },
      credentialRef: { type: 'string', description: '加密归档凭据引用（可选）' },
    }, required: ['project'], additionalProperties: false },
    async execute(args, exec) {
      const { project, scenario, credentialRef } = args as {
        project: string; scenario?: string; credentialRef?: string
      }
      const result = await workerFor(exec).request(
        { operation: 'listing_inspect', project, scenario, credentialRef, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS, exec.signal)
      if (!result.ok) failure(result, 'inspect failed')
      return result.inspection
    },
  })

  registerTool(listing, {
    name: 'enterprise_listing_run_code',
    description: '在当前隔离 Python 会话执行受限 pandas 代码。代码必须定义 outputs: dict[str, DataFrame]；禁止自行写 Excel/CSV。stdout 原样回显。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      code: { type: 'string', description: '多行 Python/pandas 代码，必须定义 outputs' },
      credentialRef: { type: 'string', description: '加密归档凭据引用（可选）' },
    }, required: ['project', 'code'], additionalProperties: false },
    async execute(args, exec) {
      const { project, code, credentialRef } = args as {
        project: string; code: string; credentialRef?: string
      }
      const result = await workerFor(exec).request(
        { operation: 'listing_run_code', project, code, credentialRef, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS, exec.signal)
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
      const { project, scenario, trackChanges } = args as {
        project: string; scenario: string; trackChanges?: boolean
      }
      const result = await workerFor(exec).request(
        { operation: 'listing_publish', project, scenario, trackChanges,
          coverLabels: config.reportCoverLabels, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS, exec.signal)
      if (!result.ok) failure(result, 'publish failed')
      return result.receipt
    },
  })

  listing.effect(() => () => {
    for (const worker of workers.values()) worker.dispose()
    workers.clear()
  })
  listing.logger?.info('Enterprise Listing tools registered (host-side data interception switch)')
}
