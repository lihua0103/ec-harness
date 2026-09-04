/**
 * 企业临床 Listing 插件入口（ADR-0003 + ADR-0007 数据拦截口径）。
 * 每个 Agent 独占一个持久 Python Worker，各阶段共享会话且互不串扰。
 *
 * 数据安全开关由宿主设置页控制：默认开启，关闭后不做任何拦截；模型
 * 请求字段不能伪造或修改该开关。开关关闭时不做任何拦截。
 *
 * 只有两类数据值被拦截：数据集原始行值与 doc/ 外 spec 辅助 Excel 单元格值。
 * doc/ 全目录全量读取；结构、统计、ALS 语义映射和代码执行能力保留；
 * 开关开启时，run_code 流输出与模型可控名称不回流，避免它们携带受保护值；
 * 通用工具结果经宿主保护值扫描，命中两类受保护值的结果被整体拦截
 * （2026-09-03 口径修订：通用车道防线 = 值级 post-execute 扫描，见 ADR-0010 修订记录）。
 */
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { PythonWorker, type WorkerResponse } from './worker.js'

export const name = 'enterprise-listing'
export const inject = ['tools', 'systemPrompt', 'credentials']

/** 部署参数（cordis.patch.yml row config 下发；不写死在代码，CODING_STANDARDS）。 */
export interface ListingConfig {
  /** report 场景 Cover Page 行标签（如申办方特定文案）。 */
  reportCoverLabels?: string[]
}

const HEAVY_TIMEOUT_MS = 900_000
const SCAN_TIMEOUT_MS = 60_000
const SCENARIOS = ['medical', 'rbqm', 'manual', 'report'] as const

interface ToolExecutionContext {
  agent: { ctx?: { effect: (effect: () => () => void) => unknown } }
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

interface PostResult { isError: boolean; value?: unknown; content: unknown[] }
interface PostDecision { kind: 'accept' | 'block'; value?: unknown; content?: unknown[]; feedback?: unknown[] }

interface ListingContext {
  tools: { register: (definition: ToolDefinition) => () => void }
  systemPrompt: { section: (section: { name: string; order: number; text: string }) => () => void }
  /** 宿主侧数据安全开关（ui-settings 提供；未装配或读取失败按开启处理）。 */
  dataSecurityService?: { isEnabled(): boolean }
  /** 宿主凭据服务；模型只提交引用，明文密码不出现在工具参数或回执。 */
  credentials?: { resolve(ref: string): Promise<{ value?: string } | undefined> }
  logger?: { info: (message: string) => void; warn?: (message: string) => void }
  effect: (effect: () => () => void) => unknown
  on?: (name: 'tools/post-execute', listener: (exec: { name: string; agent: object }, result: PostResult, next: () => Promise<PostDecision>) => Promise<PostDecision>) => () => void
}

const output = {
  // Harness 只接受标准 JSON Schema；工具回执均为 JSON object。
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function failure(result: WorkerResponse, fallback: string): never {
  // 将稳定阶段码带回 Harness，避免把底层异常或临床值暴露出来，也避免模型盲目重算。
  const stage = typeof result.stage === 'string' ? result.stage : undefined
  const diagnostics = result.diagnostics
  let detail = result.reason || fallback
  if (diagnostics?.errorType !== undefined || diagnostics?.outputsDefined !== undefined) {
    const parts: string[] = []
    if (typeof diagnostics?.errorType === 'string') parts.push(`errorType=${diagnostics.errorType}`)
    if (typeof diagnostics?.outputsDefined === 'boolean') parts.push(`outputsDefined=${diagnostics.outputsDefined}`)
    if (typeof diagnostics?.syntax === 'string') parts.push(`syntax=${diagnostics.syntax}`)
    if (parts.length > 0) detail = `${detail}（${parts.join('，')}）`
  }
  throw Object.assign(new Error(stage ? `${detail}（阶段：${stage}）` : detail), {
    code: result.code || 'LISTING_ERROR', stage, expose: true, retryable: result.retryable,
    diagnostics,
  })
}

function registerTool(ctx: ListingContext, definition: Omit<ToolDefinition, 'output'>): () => void {
  return ctx.tools.register({ ...definition, output })
}

function interceptionEnabled(ctx: ListingContext): boolean {
  try {
    return ctx.dataSecurityService?.isEnabled() ?? true
  } catch {
    return true
  }
}

function hostFlags(ctx: ListingContext): { hostDataInterception: boolean } {
  return { hostDataInterception: interceptionEnabled(ctx) }
}

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

async function resolveArchiveCredential(
  ctx: ListingContext, credentialRef: string | undefined,
): Promise<string | undefined> {
  if (credentialRef === undefined) return undefined
  if (!CREDENTIAL_REF_PATTERN.test(credentialRef)) {
    throw Object.assign(new Error('加密归档凭据引用格式无效；credentialRef 必须是宿主凭据名，不是密码。'), {
      code: 'ARCHIVE_CREDENTIAL_REF_INVALID', expose: true,
    })
  }
  try {
    const resolved = await ctx.credentials?.resolve(credentialRef)
    const value = resolved?.value
    if (typeof value !== 'string' || value.length === 0) {
      throw Object.assign(new Error(`宿主凭据 ${credentialRef} 未配置加密归档密码。`), {
        code: 'ARCHIVE_CREDENTIAL_NOT_CONFIGURED', expose: true,
      })
    }
    return value
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('ARCHIVE_CREDENTIAL_')) throw error
    throw Object.assign(new Error(`宿主凭据 ${credentialRef} 解析失败。`), {
      code: 'ARCHIVE_CREDENTIAL_RESOLVE_FAILED', expose: true,
    })
  }
}

/**
 * 内部控制工具精确白名单（2026-09-03 收紧：原子串匹配 task/todo/plan/progress
 * 会把任意同名 MCP 工具豁免出保护值扫描，形成绕过面）。只豁免 harness
 * 自身的规划/待办状态工具；其余一切工具（含子代理与 MCP）的结果都扫描。
 */
const INTERNAL_CONTROL_TOOLS = new Set(['plan', 'todo_write'])

function isInternalControlTool(toolName: string): boolean {
  return INTERNAL_CONTROL_TOOLS.has(toolName.toLowerCase())
}

/** project 参数模型可控：必须是存在目录的绝对路径（审计 P2：未锚定 project 可指向任意目录）。
 *  realpathSync 与 Python 侧 Path.resolve() 对齐：junction/符号链接项目
 *  首绑与后访解析为同一路径，避免 PROJECT_SWITCH_DENIED 误报。 */
function normalizeProjectPath(project: unknown): string {
  if (typeof project !== 'string' || project.trim() === '' || !isAbsolute(project)) {
    throw Object.assign(new Error('project 必须是项目目录的绝对路径'), {
      code: 'PROJECT_PATH_INVALID', expose: true,
    })
  }
  const resolved = resolvePath(project.trim())
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw Object.assign(new Error(`项目目录不存在: ${resolved}`), {
      code: 'PROJECT_NOT_FOUND', expose: true,
    })
  }
  return realpathSync(resolved)
}

function sameProject(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

/** spill/临时目录最长保留时间：spill 含 doc 全量业务值、dsh-listing-* 含
 *  数据集 pickle（ADR-0010 修订 R-7 + 实测孤儿进程残留），上游均不清理；
 *  按启动时点回收陈旧目录。 */
const STALE_TEMP_PREFIXES = ['dsh-spill-', 'dsh-listing-']
const TEMP_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** 清理 %TEMP% 中企业 listing 相关的陈旧临时目录；上游 spill policy 与
 *  sandbox 临时目录的企业层补偿控制（不修改上游）。只碰已知前缀，
 *  失败逐目录吞掉。 */
export function sweepStaleSpillDirs(now = Date.now()): number {
  let removed = 0
  let rootEntries: string[]
  try {
    rootEntries = readdirSync(tmpdir())
  } catch {
    return 0
  }
  for (const entry of rootEntries) {
    if (!STALE_TEMP_PREFIXES.some(prefix => entry.startsWith(prefix))) continue
    const dir = join(tmpdir(), entry)
    try {
      if (now - statSync(dir).mtimeMs < TEMP_MAX_AGE_MS) continue
      rmSync(dir, { recursive: true, force: true })
      removed++
    } catch {
      // 单个目录不可删（占用/权限）不阻断启动
    }
  }
  return removed
}

function blockedProtectedResult(): PostDecision {
  return {
    kind: 'block',
    feedback: [{
      type: 'text',
      text: '通用工具结果包含受保护临床数据值，已阻止该结果返回模型。请继续使用企业 listing 车道计算和发布。',
    }],
  }
}

function stringifyPostValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '[unserializable tool result]'
  }
}

function postResultText(result: PostResult, decision: PostDecision): string {
  const value = Object.prototype.hasOwnProperty.call(decision, 'value')
    ? decision.value
    : result.value
  const content = Object.prototype.hasOwnProperty.call(decision, 'content')
    ? decision.content
    : result.content
  // additionalContexts 是宿主可向模型注入的旁路面（审计 P3），一并扫描。
  const extra = (decision as { additionalContexts?: unknown }).additionalContexts
    ?? (result as { additionalContexts?: unknown }).additionalContexts
  return [stringifyPostValue(value), stringifyPostValue(content), stringifyPostValue(extra)]
    .filter(Boolean).join('\n')
}

export function apply(ctx: Context, config: ListingConfig = {}): void {
  const listing = ctx as unknown as ListingContext
  const workers = new Map<object, PythonWorker>()
  const activeProjects = new Map<object, string>()
  const scanWorkers = new Map<object, PythonWorker>()
  /** 换绑校验（请求前调用，廉价拒绝）：一个 Agent 会话只绑定一个项目，
   *  换绑会让保护值索引指向错误项目，也让任意目录的 doc/ 成为全量出域
   *  通道。换项目请新开会话。 */
  const checkProject = (exec: ToolExecutionContext, project: string): void => {
    const existing = activeProjects.get(exec.agent)
    if (existing !== undefined && !sameProject(existing, project)) {
      throw Object.assign(
        new Error(`当前会话已绑定项目 ${existing}，不能切换到 ${project}；请新建会话处理其他项目。`),
        { code: 'PROJECT_SWITCH_DENIED', expose: true },
      )
    }
  }
  /** 绑定提交（请求成功后调用）：inspect 失败/Worker 崩溃不留下
   *  "已绑定但会话未初始化"的粘滞态，避免通用工具结果被误拦到底。
   *  同时预热专用扫描 Worker（listing_scan_init）：只保留保护值哈希、
   *  释放数据，与主车道 Worker 分进程——通用工具结果扫描不再被
   *  900 秒 run_code 阻塞（实测暴露的批量误拦根因）。 */
  const bindProject = (exec: ToolExecutionContext, project: string): void => {
    activeProjects.set(exec.agent, project)
    try {
      void scanWorkerFor(exec).request(
        { operation: 'listing_scan_init', project, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS, exec.signal,
      ).catch(() => {
        listing.logger?.warn?.('[enterprise-listing] scan worker init failed; generic results stay blocked until ready')
      })
    } catch {
      // 预热启动失败不阻断主车道；后续扫描按未初始化 fail-closed。
    }
  }
  const scanWorkerFor = (exec: ToolExecutionContext): PythonWorker => {
    let scanWorker = scanWorkers.get(exec.agent)
    if (!scanWorker) {
      const created = new PythonWorker()
      scanWorkers.set(exec.agent, created)
      exec.agent.ctx?.effect(() => () => {
        if (scanWorkers.get(exec.agent) === created) {
          scanWorkers.delete(exec.agent)
          created.dispose()
        }
      })
      scanWorker = created
    }
    return scanWorker
  }
  /** Worker 崩溃/超时/协议损坏的原始异常（stderr 片段等）只进日志；
   * 模型侧一律替换为稳定错误码（failure() 投影口径的对外延伸）。 */
  const requestWorker = async (
    exec: ToolExecutionContext, request: Record<string, unknown>, timeoutMs: number,
  ): Promise<WorkerResponse> => {
    try {
      return await workerFor(exec).request(request as never, timeoutMs, exec.signal)
    } catch (error) {
      const err = error as Error & { code?: string; name?: string }
      if (err.name === 'AbortError') throw error
      listing.logger?.warn?.(`[enterprise-listing] worker request failed: ${String(error)}`)
      if (err.code === 'PYTHON_NOT_FOUND') throw error
      throw Object.assign(new Error('Listing Worker 暂不可用，请稍后重试'), {
        code: 'WORKER_UNAVAILABLE', expose: true, retryable: true,
      })
    }
  }
  const workerFor = (exec: ToolExecutionContext): PythonWorker => {
    let worker = workers.get(exec.agent)
    if (!worker) {
      const created = new PythonWorker()
      workers.set(exec.agent, created)
      exec.agent.ctx?.effect(() => () => {
        if (workers.get(exec.agent) === created) {
          workers.delete(exec.agent)
          activeProjects.delete(exec.agent)
          created.dispose()
        }
      })
      worker = created
    }
    return worker
  }

  listing.systemPrompt.section({
    name: 'tool:enterprise-listing', order: 116,
    text: `# 临床 Listing 工具契约

## 强制工作流
1. enterprise_listing_inspect：获取 doc/ 全量需求清单（requirementDocuments manifest）、doc 外辅助 Excel 结构与 ALS 语义映射、数据集元数据（列名/行数/dtype/null/unique）；大结果不得读取通用工具 spill，改用 enterprise_listing_read_metadata 分页
2. enterprise_listing_read_document：按 documentId 和 chunkIndex 顺序读取需求分片；每个文件必须从 0 读到最后一个 isFinal chunk，所有分片按顺序拼接后解析，未读完不得 run_code
3. enterprise_listing_read_metadata：在企业车道分页读取完整数据集元数据和辅助文件结构；只返回结构，不返回数据集行值或辅助 Excel rows。数据集较多时先调用 compact=true（只含 name/path/columns/rowCount，全目录一页读完），再仅对关键数据集用普通分页取详细统计
4. enterprise_listing_run_code：生成 outputs 字典，每个键是工作表名，每个值是 pandas DataFrame
5. enterprise_listing_publish：唯一交付路径，生成单个规范化 Multi-Sheet Excel

场景选择必须依据完整 doc/ 需求和表单结构，在 publish 时显式传入 manual、medical、rbqm 或 report 之一；禁止根据项目目录名、数据集名称或历史产物推断场景，无法确定时不得发布。

加密归档的 credentialRef 只能填宿主凭据引用名；宿主解析密码，密码值不会进入模型。

**交付纪律**：交付一律走 enterprise_listing_publish（自动处理全部格式化和样式）；run_code 中不要用 to_excel/to_csv 写交付文件——中间/临时文件随意（执行面不受限，别绕过统一交付即可）。数据安全开关开启时，run_code 成功回执只含输出数量、行数、列数、dtype 与空值统计，不含输出名、列名或 stdout/stderr 内容；开关关闭时按原始回执返回。

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
- **doc/ 全目录（含文本、Excel、模板、二进制文件）**：完整进入 requirementDocuments 分片；不截断、不摘要、不投影，所有业务单元格值可读
- **doc/ 外 spec 需求辅助 Excel**：结构、统计、ALS 三元组可读；业务单元格值不出域
- **数据集（sas7bdat/xpt/csv）**：只含元数据（列名/行数/dtype/nullCount/uniqueCount），行值不出域；行数据在 sandbox 的 datasets 变量中供你计算
- **执行快照**：sandbox 已注入 \`requirements\`/\`spec_documents\`（inspect 读取的 doc/ 全量对象）和 \`auxiliary_documents\`（同一次 inspect 读取的 doc 外辅助表内部对象）；优先使用这些对象，不要重新猜测或定位 Coding Results/ALS 文件路径
- **run_code 回执（开关开启）**：stdout/stderr 内容省略；输出名与列名留在 Worker 会话和最终 Excel，避免成为数据值通道
- **通用工具出口两层防护（部署方策略，非模型可控）**：调用参数中显式引用数据集/归档/doc 外辅助 Excel 文件的通用调用会被直接拒绝并给出改道指引（请改用本车道）；结果文本经保护值扫描，命中数据集行值或辅助 Excel 单元格值的结果整体拦截（精确值匹配，改写/编码后的派生值不在此列——请不要尝试变换数据值绕行，直接使用企业车道）
数据安全开关由部署方在设置页控制：默认开启；部署方显式关闭后不做任何拦截。

## Sandbox 环境（ADR-0009：执行面全开）
- 标准 Python 全量可用：标准内建（open/eval/exec 等）与 import（os/sys/shutil/pathlib 等）不受任何限制
- 预置命名空间：datasets（会话数据集）、pd、np、math、rng（采样 Generator）、datetime、json、list_files(subdir)、scan_excel_structures(relpath)
- list_files / scan_excel_structures 是限项目根的便利助手（../ 越界即错）；其他路径请用 open/os 自行处理
- 数据红线而非执行红线：开关开启时数据集行值与辅助 Excel 单元格值不出域，代码执行本身不设卡
- 开关开启时 stdout/stderr 不回流，执行失败回执只含稳定错误码并附 environmentHint（环境自描述）

## 一次需求输出单个 Excel
一次需求的所有 Listing 表必须放入同一个 outputs 字典，publish 只调用一次。run_code 的 outputCount 等于全部工作表数量后即可 publish。`,
  })

  registerTool(listing, {
    name: 'enterprise_listing_inspect',
    description: '获取 doc/ 全量需求文件 manifest、doc 外辅助 Excel 结构与 ALS 语义映射，并扫描 SAS/XPT/CSV 数据集元数据。credentialRef 是宿主凭据引用名。调用后必须用 read_document 读完所有分片。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      scenario: { type: 'string', enum: SCENARIOS, description: 'Listing 场景类型（可选）' },
      credentialRef: { type: 'string', description: '加密归档凭据引用（可选）' },
    }, required: ['project'], additionalProperties: false },
    async execute(args, exec) {
      const { scenario, credentialRef } = args as {
        project: string; scenario?: string; credentialRef?: string
      }
      const project = normalizeProjectPath((args as { project?: unknown }).project)
      checkProject(exec, project)
      const credential = await resolveArchiveCredential(listing, credentialRef)
      const result = await requestWorker(exec,
        { operation: 'listing_inspect', project, scenario, credential, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS)
      if (!result.ok) failure(result, 'inspect failed')
      bindProject(exec, project)
      return result.inspection
    },
  })

  registerTool(listing, {
    name: 'enterprise_listing_read_metadata',
    description: 'Page through complete inspect metadata in the enterprise listing lane. Returns only dataset structure/statistics and auxiliary structure/ALS mappings; never dataset rows or auxiliary Excel rows.',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness project absolute path' },
      pageIndex: { type: 'integer', minimum: 0, description: 'zero-based metadata page' },
      pageSize: { type: 'integer', minimum: 1, maximum: 100, description: 'datasets per page; default 20' },
      compact: { type: 'boolean', description: 'catalog overview: returns only name/path/columns/rowCount per dataset so the whole catalog fits one page; default false' },
    }, required: ['project'], additionalProperties: false },
    async execute(args, exec) {
      const { pageIndex, pageSize, compact } = args as {
        project: string; pageIndex?: number; pageSize?: number; compact?: boolean
      }
      const project = normalizeProjectPath((args as { project?: unknown }).project)
      checkProject(exec, project)
      const result = await requestWorker(exec,
        { operation: 'listing_read_metadata', project, pageIndex, pageSize, compact, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS)
      if (!result.ok) failure(result, 'read metadata failed')
      bindProject(exec, project)
      return result.metadata
    },
  })

  registerTool(listing, {
    name: 'enterprise_listing_read_document',
    description: '按 inspect manifest 读取一个 doc/ 需求文件的完整分片。分片按 chunkIndex 顺序拼接为 JSON 后解析；必须读完所有 chunk。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      documentId: { type: 'string', description: 'inspect 回执中的 requirementDocuments[].documentId' },
      chunkIndex: { type: 'integer', minimum: 0, description: '从 0 开始的分片序号' },
    }, required: ['project', 'documentId', 'chunkIndex'], additionalProperties: false },
    async execute(args, exec) {
      const { documentId, chunkIndex } = args as {
        project: string; documentId: string; chunkIndex: number
      }
      const project = normalizeProjectPath((args as { project?: unknown }).project)
      checkProject(exec, project)
      const result = await requestWorker(exec,
        { operation: 'listing_read_document', project, documentId, chunkIndex, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS)
      if (!result.ok) failure(result, 'read document failed')
      bindProject(exec, project)
      return result.document
    },
  })

  registerTool(listing, {
    name: 'enterprise_listing_run_code',
    description: '在当前 Python 会话执行 pandas 代码（标准 Python 全量可用，ADR-0009）。代码必须定义 outputs: dict[str, DataFrame]；交付经 publish。数据安全开关开启时 stdout/stderr 内容不回流。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      code: { type: 'string', description: '多行 Python/pandas 代码，必须定义 outputs' },
      credentialRef: { type: 'string', description: '加密归档凭据引用（可选）' },
    }, required: ['project', 'code'], additionalProperties: false },
    async execute(args, exec) {
      const { code, credentialRef } = args as {
        project: string; code: string; credentialRef?: string
      }
      const project = normalizeProjectPath((args as { project?: unknown }).project)
      checkProject(exec, project)
      const credential = await resolveArchiveCredential(listing, credentialRef)
      const result = await requestWorker(exec,
        { operation: 'listing_run_code', project, code, credential, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS)
      if (!result.ok) failure(result, 'run_code failed')
      bindProject(exec, project)
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
      const { scenario, trackChanges } = args as {
        project: string; scenario: string; trackChanges?: boolean
      }
      const project = normalizeProjectPath((args as { project?: unknown }).project)
      checkProject(exec, project)
      const result = await requestWorker(exec,
        { operation: 'listing_publish', project, scenario, trackChanges,
          coverLabels: config.reportCoverLabels, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS)
      if (!result.ok) failure(result, 'publish failed')
      bindProject(exec, project)
      return result.receipt
    },
  })

  if (listing.on) {
    const onPostExecute = listing.on
    listing.effect(() => onPostExecute('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name.startsWith('enterprise_') || isInternalControlTool(exec.name)) return decision
      if (decision.kind === 'block' || !interceptionEnabled(listing)) return decision

      // 专用扫描 Worker：受保护值哈希常驻、与主车道计算分进程，扫描不被
      // 长 run_code 阻塞。项目已绑定但扫描进程未就绪时 fail-closed。
      const project = activeProjects.get(exec.agent)
      if (project === undefined) return decision
      const scanWorker = scanWorkers.get(exec.agent)
      if (!scanWorker) return blockedProtectedResult()
      try {
        const scan = await scanWorker.request({
          operation: 'listing_scan_text',
          project,
          text: postResultText(result, decision),
          ...hostFlags(listing),
        }, SCAN_TIMEOUT_MS)
        if (scan.ok !== true || scan.containsProtectedValue !== false) return blockedProtectedResult()
        return decision
      } catch (error) {
        listing.logger?.warn?.(`[enterprise-listing] post-execute scan failed: ${String(error)}`)
        return blockedProtectedResult()
      }
    }))
  }

  listing.effect(() => () => {
    for (const worker of workers.values()) worker.dispose()
    workers.clear()
    activeProjects.clear()
    for (const scanWorker of scanWorkers.values()) scanWorker.dispose()
    scanWorkers.clear()
  })
  const swept = sweepStaleSpillDirs()
  listing.logger?.info(`Enterprise Listing tools registered (host-side data security switch; stale spill dirs removed: ${swept})`)
}
