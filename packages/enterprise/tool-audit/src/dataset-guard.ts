/**
 * 通用车道硬数据边界（宿主开关默认开启）。
 *
 * 判定只看文件角色，不读取、不扫描文件内容：doc/ 是需求域；系统输出是
 * 交付物；数据集、数据归档与 doc 外 spec 辅助 Excel 是受保护输入。
 * 宿主关闭数据安全开关时不做任何拦截；服务未装配或读取失败按开启处理。
 */
import { isAbsolute, relative, resolve } from 'node:path'
import {
  DELIVERABLE_PATH_PATTERN,
  DISCOVERY_TOOLS,
  PATH_ARGUMENT_KEYS,
  collectPathArgumentValues,
} from './egress.ts'

export const DEFAULT_DATASET_EXTENSIONS = ['.sas7bdat', '.xpt', '.csv']
export const AUXILIARY_EXCEL_EXTENSIONS = ['.xlsx', '.xls', '.xlsm']
export const ARCHIVE_EXTENSIONS = ['.zip']
export const UNSCANNABLE_ARGUMENTS = '[unscannable tool arguments]'

export type ProtectedPathClass =
  | 'dataset'
  | 'aux-excel'
  | 'protected-archive'

export type PathClass = ProtectedPathClass | 'spec-document' | 'generated-output' | 'ordinary'

/** 官方 ToolExecution 的结构子集；session.cwd 用于相对路径归类。 */
export interface ToolExecutionLike {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: {
    session?: { header?: { cwd?: string } }
  }
}

export interface GuardDecision {
  readonly code:
    | 'PROTECTED_INPUT'
    | 'UNSCANNABLE_ARGUMENTS'
  readonly reason: string
  readonly pathClass?: ProtectedPathClass
  readonly reference?: string
}

export type ToolGuard = (execution: Readonly<ToolExecutionLike>) => string | undefined

export interface GuardContext {
  tools: { guard: (guard: ToolGuard) => () => void }
  dataSecurityService?: { isEnabled(): boolean }
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  /** 测试注入用；生产实现只写无数据值 JSONL。 */
  audit?: (record: unknown) => void
}

const PROTECTED_EXTENSIONS = new Set([...DEFAULT_DATASET_EXTENSIONS, ...AUXILIARY_EXCEL_EXTENSIONS, ...ARCHIVE_EXTENSIONS])
function normalizeExtension(value: string): string {
  // Windows 边角（休眠逻辑前置加固）：NTFS ADS（AE.csv:stream / ::$DATA）
  // 与尾点/尾空格都会让朴素后缀正则失配，从而把受保护文件判成 ordinary。
  let name = value.split(/[\\/]/).pop() ?? value
  const adsColon = name.indexOf(':', 2)          // 跳过盘符冒号（位置 1）
  if (adsColon >= 0) name = name.slice(0, adsColon)
  name = name.replace(/[.\s]+$/, '')
  const match = /\.[A-Za-z0-9]+$/.exec(name)
  return match?.[0].toLowerCase() ?? ''
}

function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean)
}

function extensionClass(value: string): ProtectedPathClass | undefined {
  const extension = normalizeExtension(value)
  if (DEFAULT_DATASET_EXTENSIONS.includes(extension)) return 'dataset'
  if (AUXILIARY_EXCEL_EXTENSIONS.includes(extension)) return 'aux-excel'
  if (ARCHIVE_EXTENSIONS.includes(extension)) return 'protected-archive'
  return undefined
}

/** 只按路径角色分类；doc/ 优先，因此 doc 内同名扩展仍是需求材料。
 *  内容型参数键（write 的 content、edit 的 old/new_string 等）与路径型
 *  参数键（file_path/path 等，由 collectPathArgumentValues 原子判定）都
 *  不参与受保护引用切词扫描——前者写文件时提及数据集文件名不构成读取
 *  泄露；后者按完整路径判定，切词会把含空格/中文路径切碎（2026-10-20
 *  P0/T02 误拦修复）。 */
const CONTENT_ARGUMENT_KEYS = new Set([
  'content', 'new_string', 'old_string', 'text', 'body', 'value', 'prompt',
  'description', 'notes', 'message', 'answer', 'output',
])

function collectStrings(
  value: unknown, seen: WeakSet<object>, output: string[], skipContentKeys: boolean,
  skipPathKeys: boolean, depth = 0,
): boolean {
  if (depth > 24) return false
  if (typeof value === 'string') {
    output.push(value)
    return true
  }
  if (value === null || typeof value !== 'object') return true
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    return value.every(item => collectStrings(item, seen, output, skipContentKeys, skipPathKeys, depth + 1))
  }
  return Object.entries(value as Record<string, unknown>)
    .every(([key, item]) => {
      const normalizedKey = key.toLowerCase()
      if (skipContentKeys && CONTENT_ARGUMENT_KEYS.has(normalizedKey)) return true
      if (skipPathKeys && PATH_ARGUMENT_KEYS.has(normalizedKey)) return true
      return collectStrings(item, seen, output, skipContentKeys, skipPathKeys, depth + 1)
    })
}

function candidateReferences(
  arguments_: unknown, excludePathArgumentKeys: boolean,
): string[] | typeof UNSCANNABLE_ARGUMENTS {
  const strings: string[] = []
  if (!collectStrings(arguments_, new WeakSet(), strings, true, excludePathArgumentKeys)) {
    return UNSCANNABLE_ARGUMENTS
  }
  return strings
    .flatMap(value => value.split(/[\s"'`,;=()[\]{}<>|]+/))
    .map(value => value.trim())
    .filter(value => {
      const extension = normalizeExtension(value)
      return extension !== '' && PROTECTED_EXTENSIONS.has(extension)
    })
}

function resolveReference(reference: string, cwd: string | undefined): string {
  if (cwd === undefined || isAbsolute(reference)) return reference
  return resolve(cwd, reference)
}

function projectSegments(reference: string, cwd?: string): string[] | undefined {
  if (cwd === undefined) return undefined
  const root = resolve(cwd)
  const absolute = isAbsolute(reference) ? resolve(reference) : resolve(root, reference)
  const relativePath = relative(root, absolute)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined
  return pathSegments(relativePath)
}

/** doc/ 与系统输出必须锚定在当前项目根内，避免外部同名目录成为豁免通道。
 *  无 cwd 锚定时退化为路径形态启发（直接父级为 doc / .clinical-listing/output
 *  视为需求域/交付域）：误放行的方向还有 post-execute 保护值扫描兜底，
 *  误拒则会无意义打断模型。
 *  交付域补充（2026-09-15，RBQM 实测）：R 车道/RBQM 的交付目录是项目下
 *  Output/04_Out/**（跨项目根的绝对路径，cwd 锚定不到），按「output 段后跟
 *  04_out 段」的路径形态识别为交付物——生成与 QC 读取 listing Excel 不拦，
 *  拦的只是源数据（SAS/辅助 Excel）入上下文。形态常量自 2026-10-20 起由
 *  egress.ts 共享（listing post 只对路径型参数使用，文本豁免已移除）。 */

export function classifyReference(reference: string, cwd?: string): PathClass {
  if (DELIVERABLE_PATH_PATTERN.test(reference)) return 'generated-output'
  if (cwd === undefined) {
    const raw = pathSegments(reference).map(segment => segment.toLowerCase())
    if (raw.length >= 2 && raw[raw.length - 2] === 'doc') return 'spec-document'
    const marker = raw.indexOf('.clinical-listing')
    if (marker >= 0 && raw[marker + 1] === 'output' && marker === raw.length - 3) {
      return 'generated-output'
    }
    return extensionClass(reference) ?? 'ordinary'
  }
  const segments = projectSegments(reference, cwd)
  if (segments !== undefined) {
    if (segments[0]?.toLowerCase() === 'doc') return 'spec-document'
    if (segments[0]?.toLowerCase() === '.clinical-listing'
      && segments[1]?.toLowerCase() === 'output') return 'generated-output'
  }
  return extensionClass(reference) ?? 'ordinary'
}

export function findProtectedReference(
  arguments_: unknown, cwd?: string, excludePathArgumentKeys = false,
): { reference: string; pathClass: ProtectedPathClass } | typeof UNSCANNABLE_ARGUMENTS | undefined {
  const references = candidateReferences(arguments_, excludePathArgumentKeys)
  if (references === UNSCANNABLE_ARGUMENTS) return references
  for (const raw of references) {
    const reference = resolveReference(raw, cwd)
    const pathClass = extensionClass(reference)
    if (pathClass !== undefined && classifyReference(reference, cwd) === pathClass) {
      return { reference, pathClass }
    }
  }
  return undefined
}

function reasonFor(code: GuardDecision["code"], reference?: string): string {
  const detected = reference === undefined ? "参数无法安全检查" : `检测到 ${reference}`
  if (code === "UNSCANNABLE_ARGUMENTS") return "工具参数无法安全检查，已拒绝读取受保护输入。"
  return `受保护数据值不允许经通用工具读取（${detected}）。`
    + "请改用企业 listing 车道：enterprise_listing_inspect（数据集元数据/辅助 Excel 结构）、"
    + "enterprise_listing_read_document（doc/ 全量需求）、enterprise_listing_run_code（沙箱内计算）。"
    + "部署方如需放开，可在设置页关闭数据安全开关。"
}

export function datasetDenyReason(reference?: string): string {
  return reference === undefined ? reasonFor('UNSCANNABLE_ARGUMENTS') : reasonFor('PROTECTED_INPUT', reference)
}

export function interceptionEnabled(context: Pick<GuardContext, 'dataSecurityService'>): boolean {
  try {
    return context.dataSecurityService?.isEnabled() ?? true
  } catch {
    return true
  }
}

/** 路径型参数的原子判定（P0/T02）：整串按一个引用解析，不经空白切词。
 *  返回命中的保护引用；参数不可解析返回 UNSCANNABLE；否则 undefined。 */
export function findProtectedPathArgument(
  arguments_: unknown, cwd?: string,
): { reference: string; pathClass: ProtectedPathClass } | typeof UNSCANNABLE_ARGUMENTS | undefined {
  const values: string[] = []
  if (collectPathArgumentValues(arguments_, values) === 'unscannable') return UNSCANNABLE_ARGUMENTS
  for (const raw of values) {
    const reference = resolveReference(raw, cwd)
    const pathClass = extensionClass(reference)
    if (pathClass !== undefined && classifyReference(reference, cwd) === pathClass) {
      return { reference, pathClass }
    }
  }
  return undefined
}

/** 窄版 pre-execute 拒绝（2026-09-03 恢复；2026-10-20 P0/T02 按方案收敛）：
 *  - 发现型工具（glob/ls/stat 等）只做发现合同，不因模式串含受保护后缀拒绝；
 *    结果文本仍由 listing 宿主 post-execute 值扫描兜底。
 *  - 路径型参数（file_path/path 等）整串原子判定：含空格/中文/嵌套的
 *    doc 需求不再被切碎误拦，拒绝引用保留完整路径。
 *  - 其余字符串参数（命令文本等）保留切词兜底：执行通道引用受保护
 *    数据集仍拒绝（本地执行自由，但显式读取源数据仍须走 listing 车道）。
 *  参数不可解析、内容型参数、doc/与系统输出、enterprise_* 车道一律放行。 */
export function inspectToolExecution(
  execution: Readonly<ToolExecutionLike>,
  dataInterception = true,
): GuardDecision | string | undefined {
  if (!dataInterception) return undefined
  if (execution.name.startsWith('enterprise_')) return undefined
  if (DISCOVERY_TOOLS.has(execution.name.toLowerCase())) return undefined
  const cwd = execution.agent?.session?.header?.cwd
  const pathHit = findProtectedPathArgument(execution.arguments, cwd)
  if (pathHit !== undefined && pathHit !== UNSCANNABLE_ARGUMENTS) {
    return datasetDenyReason(pathHit.reference)
  }
  const found = findProtectedReference(execution.arguments, cwd, true)
  if (found === undefined || found === UNSCANNABLE_ARGUMENTS) return undefined
  return datasetDenyReason(found.reference)
}

/** 注册 monotonic guard；后续 pre-execute listener 不能把拒绝改回允许。
 *  guard 协议只接受 string|undefined：inspectToolExecution 的结构化
 *  判定对象仅供测试/宿主策略使用，此处仅把字符串拒绝上交。 */
export function registerDatasetGuard(context: GuardContext): () => void {
  return context.tools.guard(
    execution => {
      const decision = inspectToolExecution(execution, interceptionEnabled(context))
      return typeof decision === 'string' ? decision : undefined
    },
  )
}
