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
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { deliverablePathArgumentHit, egressBlock } from '@dsh-enterprise/tool-audit/egress'
import { PythonWorker, type WorkerResponse } from './worker.js'
import { RManualRunner, RPKRunner, R_LANE_DIRS, PK_LANE_DIRS, DEFAULT_PROJECT_ROOT, type RLaneConfig } from './r-runner.js'

export const name = 'enterprise-listing'
export const inject = ['tools', 'systemPrompt', 'credentials']

/** 部署参数（cordis.patch.yml row config 下发；不写死在代码，CODING_STANDARDS）。 */
export interface ListingConfig {
  /** report 场景 Cover Page 行标签（如申办方特定文案）。 */
  reportCoverLabels?: string[]
  /** r_manual 车道：项目根（缺省 /mnt/project）、Rscript 路径、超时、模板路径。 */
  rListing?: RLaneConfig
}

const HEAVY_TIMEOUT_MS = 900_000
const SCAN_TIMEOUT_MS = 60_000
/** 程序执行工具：其结果是程序工作日志（生成 listing Excel 的管道），按用户口径不拦截。 */
const EXECUTION_TOOLS = new Set(['pwsh', 'bash', 'sh', 'shell', 'terminal'])
/** 扫描预热等待上限：大项目（99 数据集归档）预热实测数十秒，超时才 fail-closed。 */
const SCAN_WARMUP_WAIT_MS = 120_000
const SCENARIOS = ['medical', 'rbqm', 'manual', 'report', 'r_manual'] as const

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
  // P0（2026-10-20）：environmentHint/failures 必须进入模型可见消息——此前
  // 重新构造 Error 时被丢弃，模型只能盲猜环境与哪个输入失败（方案 §1.2）。
  const stage = typeof result.stage === 'string' ? result.stage : undefined
  const diagnostics = result.diagnostics
  let detail = result.reason || fallback
  if (diagnostics?.errorType !== undefined || diagnostics?.outputsDefined !== undefined || diagnostics?.stage !== undefined) {
    const parts: string[] = []
    if (typeof diagnostics?.errorType === 'string') parts.push(`errorType=${diagnostics.errorType}`)
    if (typeof diagnostics?.outputsDefined === 'boolean') parts.push(`outputsDefined=${diagnostics.outputsDefined}`)
    if (typeof diagnostics?.syntax === 'string') parts.push(`syntax=${diagnostics.syntax}`)
    if (typeof diagnostics?.stage === 'string') parts.push(`stage=${diagnostics.stage}`)
    if (parts.length > 0) detail = `${detail}（${parts.join('，')}）`
  }
  if (typeof result.environmentHint === 'string' && result.environmentHint.trim() !== '') {
    detail += `；环境提示：${result.environmentHint.trim().slice(0, 500)}`
  }
  if (Array.isArray(result.failures) && result.failures.length > 0) {
    const items = result.failures.slice(0, 20).map(item => {
      const subject = typeof item?.path === 'string' && item.path !== '' ? item.path
        : typeof item?.stage === 'string' ? item.stage : '输入'
      const cause = typeof item?.reason === 'string' && item.reason !== '' ? item.reason
        : typeof item?.code === 'string' ? item.code : '失败'
      return `${subject}: ${cause}`
    })
    detail += `；输入失败：${items.join('；')}`
  }
  throw Object.assign(new Error(stage ? `${detail}（阶段：${stage}）` : detail), {
    code: result.code || 'LISTING_ERROR', stage, expose: true, retryable: result.retryable,
    diagnostics,
    environmentHint: result.environmentHint,
    failures: result.failures,
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
    throw Object.assign(new Error('加密归档凭据引用格式无效；credentialRef 必须是宿主凭据名，不是密码。不要重试其他凭据名变体：若密码可由项目材料推导（项目名/归档名/doc 内 .txt 等文件名），直接省略 credentialRef，Worker 会自动推导。'), {
      code: 'ARCHIVE_CREDENTIAL_REF_INVALID', expose: true,
    })
  }
  try {
    const resolved = await ctx.credentials?.resolve(credentialRef)
    const value = resolved?.value
    if (typeof value !== 'string' || value.length === 0) {
      throw Object.assign(new Error(`宿主凭据 ${credentialRef} 未配置加密归档密码。省略 credentialRef 重试即可启用自动密码推导（项目名/归档名/doc 内文件名候选）。`), {
        code: 'ARCHIVE_CREDENTIAL_NOT_CONFIGURED', expose: true,
      })
    }
    return value
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('ARCHIVE_CREDENTIAL_')) throw error
    throw Object.assign(new Error(`宿主凭据 ${credentialRef} 解析失败。省略 credentialRef 重试即可启用自动密码推导（项目名/归档名/doc 内文件名候选）。`), {
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
  // 真实命中：结果携带受保护数据值（P0 起这是唯一使用"检测到数据"口径的分支）。
  const block = egressBlock('PROTECTED_CONTENT_WITHHELD')
  return { kind: 'block', feedback: block.feedback }
}

/** 扫描基础设施故障分类回执（P0/T03，方案 §4.4）：预热中/超时/失败/未就绪
 *  不再与真实命中共用"受保护数据"文案——那曾让模型把初始化状态当泄露，
 *  陷入无意义重试。 */
function scanUnavailableResult(code: 'SCAN_WARMING' | 'SCAN_TIMEOUT' | 'SCAN_FAILED' | 'SCAN_UNAVAILABLE',
  detail?: string): PostDecision {
  const block = egressBlock(code, detail)
  return { kind: 'block', feedback: block.feedback }
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
  // additionalContexts 是宿主可向模型注入的旁路面（审计 P3）。宿主接受结果时
  // 会把原结果与决策两侧的上下文**拼接**，所以两侧都必须扫描——此前只取
  // 一侧（??），另一侧存在时原结果上下文漏扫（2026-10-20 P0 修复）。
  const parts = [value, content]
  for (const source of [result, decision] as Array<{ additionalContexts?: unknown }>) {
    if (Array.isArray(source.additionalContexts)) parts.push(source.additionalContexts)
  }
  return parts.map(part => stringifyPostValue(part)).filter(Boolean).join('\n')
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
  /** 扫描预热的进行中 Promise（按 Agent）：post-execute 命中"未就绪"时等它
   *  完成再扫，而不是把 inspect 之后紧接着的普通工具调用整体封路——那是
   *  纯时序误伤，不是泄露。预热失败才 fail-closed。 */
  const scanReady = new Map<object, Promise<boolean>>()
  const bindProject = (exec: ToolExecutionContext, project: string): void => {
    activeProjects.set(exec.agent, project)
    try {
      const warmup = scanWorkerFor(exec).request(
        { operation: 'listing_scan_init', project, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS,
      ).then(result => result.ok === true, () => {
        listing.logger?.warn?.('[enterprise-listing] scan worker init failed; generic results stay blocked until ready')
        return false
      })
      scanReady.set(exec.agent, warmup)
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
2. enterprise_listing_read_document：按 documentId 和 chunkIndex 顺序读取需求分片（从 0 开始，按序拼接解析）。大型模板类需求（如通用 DVP）不必整本读入上下文：未读完的分片不阻塞 run_code——沙箱已注入完整 requirements/spec_documents 对象，可在 run_code 内按 sheet 名或关键字直接提取目标需求表；交付所依赖的需求表必须已确认理解，run_code 回执的 unreadRequirementChunkCount 提示未读覆盖
3. enterprise_listing_read_metadata：在企业车道分页读取完整数据集元数据和辅助文件结构；只返回结构，不返回数据集行值或辅助 Excel rows。数据集较多时先调用 compact=true（只含 name/path/columns/rowCount，全目录一页读完），再仅对关键数据集用普通分页取详细统计
4. enterprise_listing_analyze：需要键唯一性、关联覆盖、声明式规则命中、产物比较等**结论**时优先调用——宿主本地计算，只返回计数（不含行值/键值/样例）；只在确需个体值参与计算时才用 run_code
5. enterprise_listing_run_code：生成 outputs 字典，每个键是工作表名，每个值是 pandas DataFrame
6. enterprise_listing_publish：唯一交付路径，生成单个规范化 Multi-Sheet Excel

场景选择必须依据完整 doc/ 需求和表单结构，在 publish 时显式传入 manual、medical、rbqm 或 report 之一；禁止根据项目目录名、数据集名称或历史产物推断场景，无法确定时不得发布。

加密归档默认不传任何密码参数：省略 credentialRef 时 Worker 自动从项目名、归档名与项目内 .txt/.xlsx/.xls 文件名及归档同名 sidecar 内容推导密码。仅当自动推导失败且部署方已在宿主配置凭据时，才传宿主凭据引用名；不能把密码本身填进 credentialRef，也不要反复尝试凭据名变体。

**交付纪律**：交付一律走 enterprise_listing_publish（自动处理全部格式化和样式）；run_code 中不要用 to_excel/to_csv 写交付文件——中间/临时文件随意（执行面不受限，别绕过统一交付即可）。数据安全开关开启时，run_code 成功回执只含输出数量、行数、列数、dtype 与空值统计，不含输出名、列名或 stdout/stderr 内容；开关关闭时按原始回执返回。

## 标准输出范例（推荐跟随，非强制）

### Manual/Medical 场景（RT01 标准）
- Content Sheet（自动生成）：Row 1 标题 "Comparison Summary"；Row 2 表头 ["Listing Seq.", "Form Name", "New/Modified ?", "Total", "New", "Modified", "Old"]；Row 3+ 每业务表变化统计
- 业务 Sheet：Row 1 返回链接 + Sheet 名；Row 2 字段 Label；Row 3+ 数据
- 默认补齐审核列：__cmp_FLAG__, __cmp_UpdateDetail__, __cmp_RCcomment__, __cmp_Idate__（不注入空 Flag1；flag 列仅该表 Condition 明确要求时存在）

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
- **doc/ 外 spec 需求辅助 Excel**：结构、统计、ALS 语义可读（mappings 三元组、codelists 码表、designSheets 设计 sheet 清单；EDC 设计表按已知适配器或与数据集结构对照自动识别，新 EDC 首次识别后会被学习）；质疑日志/页面明细/编码结果等业务单元格值不出域
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
    description: '获取 doc/ 全量需求文件 manifest、doc 外辅助 Excel 结构与 ALS 语义映射，并扫描 SAS/XPT/CSV 数据集元数据。加密归档密码自动推导，credentialRef 可省略。调用后必须用 read_document 读完所有分片。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      scenario: { type: 'string', enum: SCENARIOS, description: 'Listing 场景类型（可选）' },
      credentialRef: { type: 'string', description: '宿主凭据引用名（可选）；仅在自动密码推导失败且宿主已配置时使用，不要填密码本身' },
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
    name: 'enterprise_listing_analyze',
    description: '受控分析（方案 §6）：对已登记数据集或最近一次 run_code 产物做结构/键唯一性/关联覆盖/声明式规则/产物比较检查，宿主本地计算、只返回计数结论（不含行值、键值或样例）。需要个体值时才用 run_code 本地计算。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: 'harness 项目绝对路径' },
      analyzeOperation: { type: 'string', enum: ['schema', 'key_check', 'join_check', 'rule_check', 'compare_artifacts', 'run_status'], description: '分析操作' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'schema：已登记数据集名列表' },
      input: { type: 'string', description: 'key_check/rule_check：已登记数据集名' },
      keys: { type: 'array', items: { type: 'string' }, description: 'key_check：键列名' },
      left: { type: 'string', description: 'join_check：左输入数据集名' },
      right: { type: 'string', description: 'join_check：右输入数据集名' },
      keyPairs: { type: 'array', items: { type: 'object', properties: {
        leftField: { type: 'string' }, rightField: { type: 'string' },
      }, required: ['leftField', 'rightField'], additionalProperties: false }, description: 'join_check：键对' },
      expectedCardinality: { type: 'string', enum: ['1:1', '1:n', 'n:1', 'n:n'], description: 'join_check：期望基数' },
      nullPolicy: { type: 'string', enum: ['never_match', 'match'], description: 'join_check：键空值策略，默认 never_match（NA 键永不匹配）' },
      rule: { type: 'object', properties: {
        op: { type: 'string', enum: ['not_null', 'unique', 'equal_columns', 'non_negative'] },
        column: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } },
        left: { type: 'string' }, right: { type: 'string' },
      }, required: ['op'], additionalProperties: false, description: 'rule_check：声明式规则（首批算子；不接受表达式）' },
      actualRef: { type: 'string', description: 'compare_artifacts：实际产物名（最近一次成功 run_code 的输出名）' },
      expectedRef: { type: 'string', description: 'compare_artifacts：期望产物名' },
      keyColumns: { type: 'array', items: { type: 'string' }, description: 'compare_artifacts：比较键列（须在两侧 schema 中且值唯一）' },
    }, required: ['project', 'analyzeOperation'], additionalProperties: false },
    async execute(args, exec) {
      const project = normalizeProjectPath((args as { project?: unknown }).project)
      checkProject(exec, project)
      const { project: _project, ...analyzeArgs } = args as Record<string, unknown>
      const result = await requestWorker(exec,
        { operation: 'listing_analyze', project, ...analyzeArgs, ...hostFlags(listing) },
        HEAVY_TIMEOUT_MS)
      if (!result.ok) failure(result, 'analyze failed')
      bindProject(exec, project)
      return result.receipt
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
      credentialRef: { type: 'string', description: '宿主凭据引用名（可选）；仅在自动密码推导失败且宿主已配置时使用，不要填密码本身' },
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

  // ---- 场景知识库（企业级 master，随插件部署、git 版本化）--------------------
  const KB_DOCS: Record<string, Record<string, string>> = {
    router: { overview: 'router.md' },
    manual: {
      overview: 'manual/listing-manual.md',
      'scenario-kb': 'manual/baiaozhi-scenario-kb.md',
      'edc-baiaozhi': 'manual/edc-baiaozhi.md',
      'export-template': 'manual/baiaozhi-export-template.md',
      'dvp-patterns': 'manual/dvp-patterns.md',
      pitfalls: 'manual/pitfalls.md',
      'output-spec': 'manual/output-spec.md',
      'password-rule': 'manual/password-rule.md',
    },
    'pk-mapping': {
      overview: 'pk-mapping/listing-pk-mapping.md',
      'style-exemplar': 'pk-mapping/assets/mainprog-style-exemplar.R',
    },
    medical: { overview: 'medical/listing-medical.md' },
    rbqm: { overview: 'rbqm/listing-rbqm.md' },
    report: { overview: 'report/listing-report.md' },
  }
  const KNOWLEDGE_DIR = fileURLToPath(new URL('../knowledge', import.meta.url))
  const kbContent = (scenario: string, topic: string): string => {
    const docs = KB_DOCS[scenario]
    if (!docs)
      throw Object.assign(new Error(`未知场景：${scenario}（可选 ${Object.keys(KB_DOCS).join('/')}）`), { code: 'KB_SCENARIO_INVALID', expose: true })
    const rel = docs[topic]
    if (!rel)
      throw Object.assign(
        new Error(`场景 ${scenario} 无该主题：${topic}（可选 ${Object.keys(docs).join('/')}）`),
        { code: 'KB_TOPIC_INVALID', expose: true })
    const p = join(KNOWLEDGE_DIR, rel)
    if (!existsSync(p))
      throw Object.assign(new Error(`场景库文件缺失：${rel}（部署不完整）`), { code: 'KB_FILE_MISSING', expose: true })
    return readFileSync(p, 'utf8')
  }
  listing.systemPrompt.section({
    name: 'knowledge:listing-scenarios', order: 116,
    text: `# Listing 场景知识库（五场景自动发现 + 写码前门禁）

企业级场景知识库随本插件部署（master，git 版本化）。**处理任何 listing 需求的第一步**：
按需求特征签名自动发现场景——manual（DVP/数据核查计划→单文件 R 程序）、pk-mapping
（PK 浓度×EDC 合并/双盲）、medical（医学核查）、rbqm（风险指标）、report（报表）——
先调 \`enterprise_listing_kb({scenario:"router"})\` 取路由表确认场景，再取对应场景库，
**声明本次适用的门禁（Gate）清单**；门禁未过不得渲染/编辑程序或写码。medical 与
manual 需求文本可能相似但**各自走库**，禁止互相代理口径。签名不命中→向用户澄清，
禁止猜场景。

经验沉淀（企业级"再训练"闭环）：项目收尾/新错误/新口径 → postmortem 提案写入项目
目录 \`.dsh/kb-capture/<场景>-<日期>.md\`（AI 不直写部署库）→ 人工评审合入
knowledge/<场景>/（Gate 强化/口径/坑三处落地）→ 跑 dsh-standard-verify eval →
随插件版本化发布。铁律：没有回填 Gate 的修复不算完成；没跑 eval 的知识库改动不算
完成；沉淀方法论不沉淀字段值。`,
  })
  registerTool(listing, {
    name: 'enterprise_listing_kb',
    description: '读取随插件部署的企业级 listing 场景知识库（五场景：manual/pk-mapping/medical/rbqm/report；scenario="router" 取总路由做场景自动发现与门禁清单）。manual 场景支持 topic 深库：scenario-kb（口径终案+编码方法论）/edc-baiaozhi（EDC 系统数据模式）/export-template/dvp-patterns（派生列模式）/pitfalls（坑库+预防索引）/output-spec/password-rule。知识内容为方法论与门禁，不含任何数据值。',
    parameters: { type: 'object', properties: {
      scenario: { type: 'string', enum: Object.keys(KB_DOCS), description: '场景名；router=总路由（五场景矩阵/沉淀闭环）' },
      topic: { type: 'string', description: '主题（可选，缺省 overview=场景总览含门禁清单；manual 场景可选深库主题见工具描述）' },
    }, required: ['scenario'], additionalProperties: false },
    async execute(args) {
      const { scenario, topic } = args as { scenario: string; topic?: string }
      return { scenario, topic: topic ?? 'overview', content: kbContent(scenario, topic ?? 'overview') }
    },
  })

  // ---- r_manual 车道：交付物 = 可独立 Rscript 运行的单文件 R 程序 ----------
  const rRunner = new RManualRunner(config.rListing, listing.logger)
  const rProjectRoot = config.rListing?.projectRoot || DEFAULT_PROJECT_ROOT
  listing.systemPrompt.section({
    name: 'tool:enterprise-listing-r', order: 117,
    text: `# 临床 Manual Listing R 车道（r_manual）

适用：DVP 已固化、项目目录按固定契约投递、交付物是**一份可直接在服务器 Rscript 运行的 R 程序**（TAISHAN 风格单文件）。此时不走 inspect → run_code → publish，改走 enterprise_listing_run_r。

## 目录契约（固定，只有项目目录名可变；项目根 ${rProjectRoot}）
- ${R_LANE_DIRS.data}/<dataDate>/：数据 zip（+ 可选密码 .txt）与 R 程序生成的 RData 缓存
- ${R_LANE_DIRS.program}/<studyKey>_Manual_Listing.R：渲染后的 R 程序（交付物）
- ${R_LANE_DIRS.output}/：<studyKey>_Manual Listing_<dataDate>.xlsx/.RDS（唯一交付目录）

## 工作流
1. 向用户确认三项输入并原样传入：project（项目目录名，如 "华睿医药_HXN6005-A1-201_HHSZCNDM01"，或绝对路径）、studyKey（方案号，如 HXN6005-A1-201）、dataDate（数据投递文件夹名，如 20260907）；可选 oldDate（旧版日期）、password（zip 密码）。不要猜测或从其他材料推断这些值。
2. **模板零业务逻辑（2026-09-17 用户定案，2026-09-19 manual 车道同型落地）**：首次调用
   enterprise_listing_run_r（render 缺省）先渲染程序骨架到项目目录——模板只含契约层
   （读数缓存/ALS/解码/PT+WHODrug 装载/展开原语/输出样式/运行摘要），业务区未生成即运行
   会 fail-fast 并给出生成契约出路（这是预期守卫，不是缺陷）。随后按程序头 DSH-BUSINESS-ZONE
   生成区契约生成三个业务区：B1 context（受试者上下文与项目参照表：A_* 活动表/CTX 跨表
   上下文列/add_ctx/CTX_DROP/AE_REF/MH_REF/PT_DUP——列集与聚合规则逐列对照本项目 DVP
   Column Heading 实证）、B2 listings（DVP Manual Review 每一需求行一节装配
   outlisting$<数据集>_<序号>，漏行=失败）、B3 titles（LISTING_TITLES 显示词表=ALS 官方
   词汇零自造）；生成后 render=false 执行。回执只含聚合计数（listing 数/行数/flag 数/
   sheet 数）、产物文件名与告警，不含任何数据行值。
3. 需要按项目 DVP 调整时：直接编辑项目目录中的 R 程序（对应业务生成区或各行节），再以
   render=false 重跑。render=true 会用模板覆盖已修改的程序，只在需要重置时使用。
   DVP Manual Review 各列的职责：Visits Applied To × Related Fields 定范围（ALL / All items
   即全量）；Condition 定行（Output if 筛选、flag=duplicated 重复标记）；Column Heading 定列
   （Raw data 原样红线 + 【表单】上下文列 + 派生列 + 匹配病史/AE/药物/非药物拆行）。
   Report Description / Discrepancy Text Message 是 DM 人工核查内容，程序不实现、不产出核查 flag。
4. 换数据日期重跑同一程序：只改 dataDate，render=false（运行时参数经环境变量覆盖，无需重新渲染）。
5. 执行失败回执带 R 的 stop 信息与程序路径；按提示核对数据目录、依赖包（haven/dplyr/tidyr/purrr/stringr/openxlsx）或修正程序后重跑。R_NOT_FOUND 表示部署机缺 Rscript，属部署问题，如实告知用户。

## 经验知识库与前置门禁（企业库 master，推式复用）
manual listing 场景的全部经验（真实项目收官验证，车道模板与其骨架同源同算法）沉淀在
**企业场景知识库**（随本插件部署）。**执行前第一步**：调 \`enterprise_listing_kb\`
（scenario="manual"）取场景总览，按 DVP/spec 特征签名**声明本次适用的门禁（Gate）**——
要点：G1 医学编码（PT术语类派生列→必探测 编码|coding 文件、页名键对 DataPageName
实际值域核对，勿从 spec 抄词）；G3 访视过滤（kw 必对 vlab 解码后实际访视值域核对，
合并表单是"X/Y"完整组合串，零命中即停）；G5 判定字段（按列自身 format.sas 绑定解码，
勿按列名猜）；G7 派生列（逐列识别来源，拿不准问用户不代理）。**门禁未过不得渲染/
编辑程序**——已知坑靠门禁前置拦截，不靠报错后修正。门禁对应的深库按需拉取：
topic=scenario-kb（口径终案+编码方法论）/ edc-baiaozhi（EDC 数据模式）/
dvp-patterns（派生列模式）/ pitfalls（坑库+预防索引）/ output-spec / password-rule。
门禁仍拦不住的新错误：修完回填 Gate（pitfalls 新 postmortem，经 .dsh/kb-capture
提案人工合入）并跑 dsh-standard-verify 回归，才算闭环（沉淀闭环全貌见
enterprise_listing_kb scenario="router"）。

## 边界
- 宿主不解析数据行值；R 程序内部读数、核查、样式化 xlsx 全程在项目目录完成。
- 一次运行的全部 listing 由同一份 R 程序产出、落同一个 xlsx，不要再用 publish 二次发布。`,
  })

  registerTool(listing, {
    name: 'enterprise_listing_run_r',
    description: 'r_manual 车道：按模板渲染（首次）并以 Rscript 执行项目目录中的单文件 Manual Listing R 程序，返回聚合回执（listing/行/flag 计数、产物文件名、告警）。project/studyKey/dataDate 必须由用户提供，不要推断。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: `用户提供的项目目录名（位于 ${rProjectRoot} 下）或项目目录绝对路径` },
      studyKey: { type: 'string', description: '用户提供的方案号/项目关键字，如 HXN6005-A1-201；构成程序文件名与交付文件名前缀' },
      dataDate: { type: 'string', description: '用户提供的数据投递文件夹名，如 20260907' },
      oldDate: { type: 'string', description: '旧版数据日期（新旧比对用，可选）' },
      password: { type: 'string', description: '数据 zip 密码（可选；经环境变量传给 R，不写入程序文件）' },
      outputPrefix: { type: 'string', description: '交付文件名前缀（可选；缺省 "<studyKey>_Manual Listing"）' },
      render: { type: 'boolean', description: '缺省=程序不存在时才渲染；true=用模板覆盖重生成；false=必须复用已有程序（修改过程序后重跑用）' },
    }, required: ['project', 'studyKey', 'dataDate'], additionalProperties: false },
    async execute(args, exec) {
      const { project, studyKey, dataDate, oldDate, password, outputPrefix, render } = args as {
        project: string; studyKey: string; dataDate: string; oldDate?: string
        password?: string; outputPrefix?: string; render?: boolean
      }
      return rRunner.run(
        { project, studyKey, dataDate, oldDate, password, outputPrefix, render, signal: exec.signal },
        interceptionEnabled(listing),
      )
    },
  })

  // ---- r_pk 车道：PK Mapping（双盲映射数据集）R 程序 --------------------
  const pkRunner = new RPKRunner(config.rListing, listing.logger)
  listing.systemPrompt.section({
    name: 'tool:enterprise-listing-pk', order: 118,
    text: `# PK Mapping R 车道（r_pk）

适用：PK/PD Mapping Spec（如双盲 BE 项目的 "PK (PD) Non-Compartmental Model" sheet）已固化、
目录按固定契约投递，交付物是**一份可直接在服务器 Rscript 运行的 R 程序**——把 PK 浓度数据
（csv/xls，只读）与 EDC sas（Rave 形态导出）按 受试者×周期×采样时点 合并成 spec 行序的映射
数据集（STUDYID/SUBJID/COHORT/FAST/SEQ/TRT/PERIOD/VISIT/ANALYTE/DOSE/NTPT/NT/RT/
Concentration/…，spec 行序）；输出=人工主编程三件套形态（unbinded/binded xlsx+rds），
QC 一致性检查只进 note() 运行日志。红线：原始 PK excel 与 EDC zip 只读不改，
产物只落 Output。设计记录见 docs/enterprise/LISTING_PK_MAPPING_DESIGN.md。

## 研究形态（form 参数，两型分模板；签名不命中向用户澄清禁止猜）
- be（默认）：双盲 BE 型——PK 传输件带 Period/Sampling Time(h) 列，COHORT=REGIME_NAME
  透传；BE 专属 [REPLACE P1-P8]。
- sad-mad：SAD/MAD I 期型——PK 传输件带 Matrix/Day Nominal/Hour Nominal 列；studyCode
  必填（完整方案号，可含期别后缀）；ANALYTE 母药名经程序 [REPLACE SA2] 或运行时
  DSH_R_PK_ANALYTE 提供；交付=血浆单表（CSF_OUTPUT 开关）；含编盲时间点隐藏规则。
  业务生成区 Z1-Z6（constants/bridge/intake/mapping/demog/assembly）由 AI 按
  spec/方案/ALS 解码串/EDC 结构逐区实证生成，模板零业务值。
- 判型证据=投递传输件表头（结构事实）+ spec Variable 全集；传输件缺列的报错即形态
  信号，先核对再换 form 重渲染，勿盲试。

## 目录契约（固定，只有项目目录名可变；项目根 ${rProjectRoot}）
- ${PK_LANE_DIRS.dataCsv}/<dataDate>/：PK 浓度 csv/xls（只读，程序不回写）
- ${PK_LANE_DIRS.dataSas}/<dataDate>/：EDC sas zip（+ R 程序生成的 RData 缓存）
- ${PK_LANE_DIRS.program}/<studyKey>_PK_Mapping.R：渲染后的 R 程序（交付物；spec xlsx 也放这里）
- ${PK_LANE_DIRS.output}/：PK_Mapping_unbinded_<dataDate>.xlsx / PK_Mapping_binded_<dataDate>.xlsx（有编盲表时）/ <studyKey>_PK Mapping_<dataDate>.rds（人工主编程三件套形态，唯一交付目录）

## 双盲口径（终案见场景库 pk-mapping L2；受试者显示口径项目级确认勿固化）
- 全 23 列输出（datasetQC 双编程比对需与主编程交付集一致）：SEQ/TRT 走随机化
  schedule（无文件空串占位）；SEX/AGE/HEIGHT/WEIGHT/BMI 常输出；SUBJ_MASK_MODE
  默认 none=号原样（随机号盲态安全），需掩码项目改 S001 型确定性掩码。
- blindMode=blinded（默认）/unblinded：不再影响文件名（输出形态=人工三件套，见上）；
  unblinded 揭盲真值仍须先配置随机化 schedule。
- blindMode=unblinded：必须先把随机化 schedule 文件放入项目目录并填进程序配置段
  RAND_SCHED_FILE（[REPLACE P6] 列契约：Subject+Period+Seq+Trt 长表）后重跑。
- 编盲双产物形态（投递编盲表的项目，参照场景库 L3 人写样本）：binded=编盲表
  SUBJID→BLINDID join 换号+剔敏感列；unbinded=全 23 列；RDS=未编盲全集。

## 工作流
1. 向用户确认 project（项目目录名或绝对路径）/ studyKey（方案号）/
   dataDate（数据投递文件夹名，csv 与 sas 同日期）；可选 password（EDC zip 密码）、
   form（研究形态，见上）、studyCode（sad-mad 形态必填）。
   不要猜测或从其他材料推断这些值。
2. 模板零业务逻辑（2026-09-17 用户定案）：业务逻辑一律由 AI 识别本项目 spec/方案/
   EDC 结构后生成——首次调用 enterprise_listing_run_pk（render 缺省）先渲染出程序骨架，
   按程序头 DSH-BUSINESS-ZONE 生成区契约（BE=Z1-Z4；SAD/MAD=Z1-Z6）与场景库 GP 门禁
   逐区生成业务段，再 render=false 执行；未生成业务区即运行会 fail-fast 并给出路
   （这是预期守卫，不是缺陷）。回执只含聚合计数与告警，不含数据行值。
3. 需要按项目口径调整时：直接编辑业务生成区或 [REPLACE] 常量（BE：盲化方案/随机化表
   路径等 P 项；SAD/MAD：ANALYTE/PDOSE/CSF_OUTPUT 等 SA 项），再 render=false 重跑；
   换数据日期同样 render=false（运行时参数经环境变量覆盖）。
4. 首个真实数据跑完必须向用户汇报业务生成区待确认清单（BE=[REPLACE P1-P8]；
   SAD/MAD=[REPLACE SA1-SA9]）。

## 边界
- 宿主不解析数据行值；读数/合并/QC/样式化 xlsx 全程在项目目录完成，不与 manual 车道共用输出。
- Rave 形态读数（Subject 内部名 ↔ SUBJID 筛选号经 SUBJ 表归一）；文件夹→周期与时点标签→小时
  解析失败的记录会进 note()/QC_Match，收到告警先核对 FOLDER_EXACT/FOLDER_KEYS 与标签拼写。`,
  })

  registerTool(listing, {
    name: 'enterprise_listing_run_pk',
    description: 'r_pk 车道：按模板渲染（首次）并以 Rscript 执行项目目录中的单文件 PK Mapping R 程序（PK 浓度 csv × EDC sas 合并成 spec 行序映射数据集，输出人工主编程三件套形态 unbinded/binded xlsx+rds，QC 只进运行日志），返回聚合回执。project/studyKey/dataDate 必须由用户提供，不要推断。',
    parameters: { type: 'object', properties: {
      project: { type: 'string', description: `用户提供的项目目录名（位于 ${rProjectRoot} 下）或项目目录绝对路径` },
      studyKey: { type: 'string', description: '用户提供的方案号/项目关键字；构成程序文件名与 QC rds 契约名前缀' },
      dataDate: { type: 'string', description: '用户提供的数据投递文件夹名（csv 与 sas 同日期），如 20260909' },
      form: { type: 'string', enum: ['be', 'sad-mad'], description: '研究形态（缺省 be=双盲 BE，Period/Sampling Time(h) 传输件）；sad-mad=SAD/MAD I 期（Matrix/Day Nominal/Hour Nominal 传输件，分模板渲染）。形态由 spec 与投递件表头实证决定，签名不命中向用户澄清，禁止猜' },
      studyCode: { type: 'string', description: '完整方案号（可选；缺省=studyKey）——sad-mad 形态必填（如含期别后缀），构成 STUDY_ID 预期常量与人工主编程 rds 名（双名共存）' },
      blindMode: { type: 'string', enum: ['blinded', 'unblinded'], description: '盲态（默认；输出形态=人工三件套 unbinded/binded xlsx+rds，blindMode 不再影响文件名）/ 揭盲（程序内须先配置随机化表 RAND_SCHED_FILE）' },
      oldDate: { type: 'string', description: '旧版数据日期（新旧比对用，可选，预留）' },
      password: { type: 'string', description: 'EDC sas zip 密码（可选；经环境变量传给 R，不写入程序文件）' },
      outputPrefix: { type: 'string', description: '交付文件名前缀（可选；缺省 "<studyKey>_PK Mapping"）' },
      render: { type: 'boolean', description: '缺省=程序不存在时才渲染；true=用模板覆盖重生成；false=必须复用已有程序（修改过程序后重跑用）' },
    }, required: ['project', 'studyKey', 'dataDate'], additionalProperties: false },
    async execute(args, exec) {
      const { project, studyKey, dataDate, form, studyCode, blindMode, oldDate, password, outputPrefix, render } = args as {
        project: string; studyKey: string; dataDate: string; form?: 'be' | 'sad-mad'; studyCode?: string
        blindMode?: 'blinded' | 'unblinded'; oldDate?: string
        password?: string; outputPrefix?: string; render?: boolean
      }
      return pkRunner.run(
        { project, studyKey, dataDate, form, studyCode, blindMode, oldDate, password, outputPrefix, render, signal: exec.signal },
        interceptionEnabled(listing),
      )
    },
  })

  if (listing.on) {
    const onPostExecute = listing.on
    listing.effect(() => onPostExecute('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      // 红线边界（用户口径 2026-09-15）：拦截的是"源数据值进入 AI 上下文"，
      // 不是程序执行本身——
      //  1) 程序执行工具（pwsh/bash 跑 R/编译器等）的结果是程序工作日志，
      //     listing Excel 的生成与运行日志一律放行；
      //  2) enterprise 车道工具是授权分析/发布通道（run_code 聚合、publish
      //     投影），放行；
      //  3) 其余通用工具（read/glob/grep 等）结果若携带源数据值（SAS 行值、
      //     辅助 Excel 业务值）才拦截。
      if (EXECUTION_TOOLS.has(exec.name)) return decision
      // 交付域放行（P0/T02 收紧 2026-10-20）：只认**路径型参数**命中
      // Output/04_Out 交付目录形态（读取已生成交付物不受影响）；旧逻辑
      // 对参数或结果文本任意位置出现该字样整体放行，结果内容自身可触发
      // 豁免，构成绕过面，已移除（方案 §14）。
      if (deliverablePathArgumentHit((exec as { arguments?: unknown }).arguments) !== undefined) {
        return decision
      }
      if (exec.name !== 'enterprise_listing_run_code'
        && (exec.name.startsWith('enterprise_') || isInternalControlTool(exec.name))) return decision
      if (decision.kind === 'block' || !interceptionEnabled(listing)) return decision

      // 专用扫描 Worker：受保护值哈希常驻、与主车道计算分进程，扫描不被
      // 长 run_code 阻塞。项目已绑定但扫描进程未就绪时按基础设施状态
      // fail-closed（分类回执，不与真实命中共用文案）。
      const project = activeProjects.get(exec.agent)
      if (project === undefined) return decision
      const scanWorker = scanWorkers.get(exec.agent)
      if (!scanWorker) {
        return scanUnavailableResult('SCAN_UNAVAILABLE')
      }
      try {
        // 预热未完成：等待预热（上限 SCAN_WARMUP_WAIT_MS），大项目 inspect 后
        // 紧接着的 ls/git 等普通调用不再被"未就绪"整体拦下。
        const warmup = scanReady.get(exec.agent)
        if (warmup !== undefined) {
          const ready = await Promise.race([
            warmup, new Promise<boolean>(resolve => setTimeout(() => resolve(false), SCAN_WARMUP_WAIT_MS)),
          ])
          if (!ready) return scanUnavailableResult('SCAN_WARMING')
        }
        const scan = await scanWorker.request({
          operation: 'listing_scan_text',
          project,
          text: postResultText(result, decision),
          ...hostFlags(listing),
        }, SCAN_TIMEOUT_MS)
        if (scan.ok !== true) {
          return scanUnavailableResult('SCAN_FAILED',
            typeof scan.code === 'string' ? `扫描错误码 ${scan.code}` : undefined)
        }
        if (scan.containsProtectedValue !== false) return blockedProtectedResult()
        return decision
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        listing.logger?.warn?.(`[enterprise-listing] post-execute scan failed: ${message}`)
        return scanUnavailableResult(message === 'Worker超时' ? 'SCAN_TIMEOUT' : 'SCAN_FAILED')
      }
    }))
  }

  listing.effect(() => () => {
    for (const worker of workers.values()) worker.dispose()
    workers.clear()
    activeProjects.clear()
    for (const scanWorker of scanWorkers.values()) scanWorker.dispose()
    scanWorkers.clear()
    scanReady.clear()
  })
  const swept = sweepStaleSpillDirs()
  listing.logger?.info(`Enterprise Listing tools registered (host-side data security switch; stale spill dirs removed: ${swept})`)
}
