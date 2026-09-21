/**
 * R 车道宿主执行器（LISTING_R_INTEGRATION_DESIGN.md §5 / LISTING_PK_MAPPING_DESIGN.md §4）。
 *
 * 交付物是一份可独立 `Rscript` 运行的单文件 R 程序：宿主只做三件事——
 * 把用户输入渲染进模板占位符并写入项目程序目录、以子进程执行
 * `Rscript`、读取 R 程序自己写出的运行摘要 json 组装聚合回执。读数、核查、
 * 样式化 xlsx 全部由 R 程序完成，宿主不解析任何数据行值。
 *
 * 运行时参数（数据日期/旧版日期/密码/摘要路径）经 DSH_R_* 环境变量传给 R，
 * 模板内 `cfg()` 环境变量优先、文件头渲染值兜底：已渲染（可能被按需求
 * 修改过的）程序换数据日期重跑不必重新渲染覆盖，zip 密码也不落进 R 文件。
 *
 * 车道由 RLaneSpec 参数化：r_manual（Manual Listing）与 r_pk（PK Mapping，
 * 双数据目录 02_Raw_csv + 02_Raw_sas、双盲开关）共用一套执行/回执骨架。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_TEMPLATE_PATH = fileURLToPath(new URL('../r-templates/manual_listing.R.tmpl', import.meta.url))
export const PK_TEMPLATE_PATH = fileURLToPath(new URL('../r-templates/pk_mapping.R.tmpl', import.meta.url))
export const PK_SADMAD_TEMPLATE_PATH = fileURLToPath(new URL('../r-templates/pk_mapping_sadmad.R.tmpl', import.meta.url))
export const DEFAULT_PROJECT_ROOT = '/mnt/project'
export const DEFAULT_R_TIMEOUT_MS = 900_000

/** r_manual 目录契约（固定格式，只有项目根可变）。 */
export const R_LANE_DIRS = {
  data: 'Project_Data/01_Raw_sas/Manual Listing',
  program: 'SAS_Program/SAS_program/Manual Listing',
  output: 'Output/04_Out/Manual listing',
} as const

/** r_pk 目录契约（与服务器初始代码实测路径一致）：PK csv 在 02_Raw_csv，
 * EDC sas zip 在 01_Raw_sas，程序与 spec 同目录。 */
export const PK_LANE_DIRS = {
  dataCsv: 'Project_Data/02_Raw_csv/PK Mapping',
  dataSas: 'Project_Data/01_Raw_sas/PK Mapping',
  program: 'SAS_Program/SAS_program/PK Mapping',
  output: 'Output/04_Out/PK Mapping',
} as const

export type RLaneName = 'r_manual' | 'r_pk'

/** 车道描述：目录契约 + 模板 + 交付物命名；执行/回执骨架共用。 */
export interface RLaneSpec {
  readonly name: RLaneName
  readonly templatePath: string
  /** 数据日期目录（相对项目根）；prepareProgram 按序校验存在。 */
  readonly dataDirs: readonly { path: string; label: string; code: string }[]
  readonly programDir: string
  readonly programFile: (studyKey: string) => string
  readonly outputDir: string
  readonly defaultOutputPrefix: (studyKey: string) => string
  /** 双盲开关（r_pk）：渲染 BLIND_MODE 占位符并经 DSH_R_BLIND_MODE 运行时覆盖。 */
  readonly blinded?: boolean
}

const MANUAL_LANE: RLaneSpec = {
  name: 'r_manual',
  templatePath: DEFAULT_TEMPLATE_PATH,
  dataDirs: [{ path: R_LANE_DIRS.data, label: '数据 zip', code: 'DATA_DATE_NOT_FOUND' }],
  programDir: R_LANE_DIRS.program,
  programFile: studyKey => `${studyKey}_Manual_Listing.R`,
  outputDir: R_LANE_DIRS.output,
  defaultOutputPrefix: studyKey => `${studyKey}_Manual Listing`,
}

const PK_LANE: RLaneSpec = {
  name: 'r_pk',
  templatePath: PK_TEMPLATE_PATH,
  dataDirs: [
    { path: PK_LANE_DIRS.dataCsv, label: 'PK 浓度 csv', code: 'PK_CSV_DATE_NOT_FOUND' },
    { path: PK_LANE_DIRS.dataSas, label: 'EDC sas zip', code: 'PK_SAS_DATE_NOT_FOUND' },
  ],
  programDir: PK_LANE_DIRS.program,
  programFile: studyKey => `${studyKey}_PK_Mapping.R`,
  outputDir: PK_LANE_DIRS.output,
  defaultOutputPrefix: studyKey => `${studyKey}_PK Mapping`,
  blinded: true,
}

export interface RLaneConfig {
  /** 项目目录集合根；用户输入的项目目录名拼接在其下。 */
  projectRoot?: string
  /** Rscript 可执行文件（缺省用 PATH 中的 Rscript，可经 DSH_RSCRIPT 覆盖）。 */
  rscript?: string
  timeoutMs?: number
  templatePath?: string
}

export interface RRunOptions {
  /** 用户输入的项目目录名（`/mnt/project/<项目名>`），或项目目录绝对路径。 */
  project: string
  /** 项目关键字/方案号，构成程序文件名与交付文件名前缀。 */
  studyKey: string
  dataDate: string
  oldDate?: string
  password?: string
  outputPrefix?: string
  /** r_pk 车道：盲态（默认，受限 7 列不出 + SUBJID 掩码）/揭盲（需随机化表）。 */
  blindMode?: 'blinded' | 'unblinded'
  /** r_pk 车道：研究形态——be=双盲 BE（Period/Sampling Time(h) 传输件，默认）；
   * sad-mad=SAD/MAD I 期（Matrix/Day Nominal/Hour Nominal 传输件）。形态由 spec
   * 实证决定，签名不命中向用户澄清，禁止猜（场景库 pk-mapping GP 门禁）。 */
  form?: 'be' | 'sad-mad'
  /** r_pk 车道：完整方案号（如含期别后缀，缺省=studyKey）；构成 STUDY_ID 预期常量
   * 与人工主编程 rds 名（GP7 双名共存）。 */
  studyCode?: string
  /** 运行时环境覆盖（键必须 DSH_R_ 前缀，如 DSH_R_PK_ANALYTE）；仅进 R 子进程环境，
   * 不写入程序文件。 */
  config?: Record<string, string>
  /** true=重新渲染覆盖已有程序；false=必须复用已有；缺省仅在程序不存在时渲染。 */
  render?: boolean
  signal?: AbortSignal
}

export interface RListingSummary {
  name: string
  sheet: string
  rowCount: number
  flagCount: number
}

export interface RRunReceipt {
  lane: RLaneName
  projectRoot: string
  studyKey: string
  dataDate: string
  oldDate: string
  blindMode?: string
  form?: string
  programPath: string
  rendered: boolean
  /** render=true 覆盖了内容不同的已有程序时的备份路径（.dsh/backups/ 下）。 */
  programBackup?: string
  listingCount: number
  rowCount: number
  flagCount: number
  sheetCount: number
  outputDir: string
  outputs: string[]
  warnings: string[]
  listings: RListingSummary[]
  durationMs: number
}

function laneError(message: string, code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, expose: true, ...extra })
}

const SAFE_SEGMENT = /^[^\\/:*?"<>|\u0000-\u001f]+$/
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 每个程序最多保留的备份份数（超出按时间名删最旧）。 */
const PROGRAM_BACKUP_KEEP = 10

/** 只保留最近 N 份备份：备份是事故恢复手段，不是版本库。 */
function pruneBackups(backupDir: string, programName: string): void {
  try {
    const prefix = `${programName}.`
    const entries = readdirSync(backupDir)
      .filter(name => name.startsWith(prefix) && name.endsWith('.bak'))
      .sort()
    for (const name of entries.slice(0, Math.max(0, entries.length - PROGRAM_BACKUP_KEEP))) {
      rmSync(join(backupDir, name), { force: true })
    }
  } catch { /* 清理失败不影响本次渲染 */ }
}

/** 用户输入的项目名只能是单层目录名；绝对路径直接使用。 */
export function resolveProjectRoot(project: unknown, projectRoot = DEFAULT_PROJECT_ROOT): string {
  if (typeof project !== 'string' || project.trim() === '') {
    throw laneError('project 必须是项目目录名（位于部署配置的项目根下）或项目目录绝对路径', 'PROJECT_PATH_INVALID')
  }
  const trimmed = project.trim()
  let root: string
  if (isAbsolute(trimmed)) {
    root = resolvePath(trimmed)
  } else {
    if (trimmed === '.' || trimmed === '..' || !SAFE_SEGMENT.test(trimmed)) {
      throw laneError(`项目名 "${trimmed}" 不是合法的单层目录名`, 'PROJECT_PATH_INVALID')
    }
    root = resolvePath(join(projectRoot, trimmed))
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw laneError(`项目目录不存在: ${root}。请确认项目名与部署配置的项目根（${projectRoot}）是否正确`, 'PROJECT_NOT_FOUND')
  }
  return root
}

export function validateStudyKey(studyKey: unknown): string {
  if (typeof studyKey !== 'string' || !SAFE_KEY.test(studyKey.trim())) {
    throw laneError('studyKey 必须是方案号/项目关键字（字母数字与 ._- 组成，如 HXN6005-A1-201）', 'STUDY_KEY_INVALID')
  }
  return studyKey.trim()
}

export function validateDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_KEY.test(value.trim())) {
    throw laneError(`${field} 必须是数据投递文件夹名（如 20260907）`, 'DATA_DATE_INVALID')
  }
  return value.trim()
}

export function validateBlindMode(value: unknown): string {
  if (value === undefined) return 'blinded'
  if (value !== 'blinded' && value !== 'unblinded') {
    throw laneError('blindMode 只能是 blinded（盲态，默认）或 unblinded（揭盲，需随机化表）', 'BLIND_MODE_INVALID')
  }
  return value
}

/** r_pk 研究形态：be=双盲 BE（默认）；sad-mad=SAD/MAD I 期（分模板）。 */
export function validatePkForm(value: unknown): 'be' | 'sad-mad' {
  if (value === undefined) return 'be'
  if (value !== 'be' && value !== 'sad-mad') {
    throw laneError(`form 只能是 be（双盲 BE，默认）或 sad-mad（SAD/MAD I 期）；形态由 spec 实证决定，签名不命中向用户澄清禁止猜`, 'PK_FORM_INVALID')
  }
  return value
}

function rString(value: string): string {
  return value.replace(/\\/g, '/').replace(/"/g, '\\"')
}

/** 双花括号占位符替换；值按 R 字面串转义，未知占位符保持原样以便发现遗漏。 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) =>
    key in values ? rString(values[key] ?? '') : whole)
}

export function programPathFor(projectRoot: string, studyKey: string): string {
  return join(projectRoot, R_LANE_DIRS.program, `${studyKey}_Manual_Listing.R`)
}

function rscriptCandidates(configured?: string): string[] {
  const explicit = process.env.DSH_RSCRIPT || configured
  if (explicit) return [explicit]
  return process.platform === 'win32' ? ['Rscript.exe', 'Rscript'] : ['Rscript']
}

/**
 * Rscript 环境：最小继承（同 PythonWorker 口径），Windows 上不透传 LC_*
 * ——`LC_CTYPE=C.UTF-8` 之类 shell 变量会让 R 起始 locale 失败、中文解析全崩
 * （r-runtime-env-quirks）。DSH_R_* 为运行时参数。
 */
function rscriptEnv(runtime: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // PROCESSOR_ARCHITECTURE 缺失时 Windows R 在加载包后以 0xC0000005 崩溃（实测二分定位）
  const keys = process.platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
       'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'PROGRAMFILES', 'PROGRAMDATA', 'ALLUSERSPROFILE']
    : ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'HOME', 'USER']
  for (const key of [...keys, 'R_HOME', 'R_LIBS', 'R_LIBS_USER', 'R_LIBS_SITE']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...runtime }
}

interface RscriptResult { exitCode: number | null; stderrTail: string }

/**
 * Rscript 调用形态：Rscript 直接接程序路径；Rterm（Rscript.exe 缺失的 R 重装现场，
 * DSH_RSCRIPT/配置指向 Rterm.exe 时）需 --vanilla --no-echo --file= 等价翻译——
 * 直传程序路径 Rterm 会按未知选项解析失败（2026-09-12 WebUI 真实路径实测）。
 */
export function rscriptInvocation(candidate: string, program: string): { command: string; args: string[] } {
  const base = candidate.split(/[\\/]/).pop() ?? candidate
  if (/^Rterm(\.exe)?$/i.test(base))
    return { command: candidate, args: ['--vanilla', '--no-echo', `--file=${program}`] }
  return { command: candidate, args: [program] }
}

function execRscript(
  candidates: string[], program: string, env: NodeJS.ProcessEnv, cwd: string,
  timeoutMs: number, signal?: AbortSignal,
): Promise<RscriptResult> {
  return new Promise((resolve, reject) => {
    const tryNext = (index: number, lastError?: Error) => {
      if (index >= candidates.length) {
        reject(laneError(
          `未找到 Rscript（尝试过 ${candidates.join(', ')}）：${lastError?.message ?? ''}。请在部署机安装 R ≥ 4.2 并确保 Rscript 在 PATH，或经 DSH_RSCRIPT / 插件配置 rListing.rscript 指定其路径（指向 Rterm.exe 亦可，车道自动加 --vanilla --no-echo --file= 参数）`,
          'R_NOT_FOUND',
        ))
        return
      }
      const invocation = rscriptInvocation(candidates[index]!, program)
      const proc = spawn(invocation.command, invocation.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stderr = ''
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const onAbort = () => { proc.kill(); finish(() => reject(Object.assign(new Error('R 程序执行已取消'), { name: 'AbortError', code: 'ABORT_ERR' }))) }
      const timer = setTimeout(() => {
        proc.kill()
        finish(() => reject(laneError(`R 程序执行超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已终止；可经插件配置 rListing.timeoutMs 放宽`, 'R_TIMEOUT', { retryable: true })))
      }, timeoutMs)
      proc.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') { finish(() => tryNext(index + 1, error)); return }
        finish(() => reject(laneError(`Rscript 启动失败：${error.message}`, 'R_SPAWN_FAILED')))
      })
      proc.stdout.on('data', () => undefined)
      proc.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8192) })
      proc.once('close', code => finish(() => resolve({ exitCode: code, stderrTail: stderr })))
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    if (signal?.aborted) { reject(Object.assign(new Error('R 程序执行已取消'), { name: 'AbortError', code: 'ABORT_ERR' })); return }
    tryNext(0)
  })
}

interface ParsedSummary {
  status?: string
  message?: string
  listingCount?: number
  rowCount?: number
  flagCount?: number
  sheetCount?: number
  outputs?: string[]
  warnings?: string[]
  listings?: RListingSummary[]
}

function readSummary(path: string): ParsedSummary | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ParsedSummary
  } catch {
    return undefined
  }
}

/** 按 RLaneSpec 执行的单文件 R 程序车道。 */
export class RLaneRunner {
  constructor(
    private readonly spec: RLaneSpec,
    private readonly config: RLaneConfig = {},
    private readonly logger?: { warn?: (message: string) => void; info?: (message: string) => void },
  ) {}

  get projectRoot(): string { return this.config.projectRoot || DEFAULT_PROJECT_ROOT }

  /** 渲染（按需）并返回程序路径；供 run 与“仅准备程序”两种用法复用。 */
  prepareProgram(options: Pick<RRunOptions, 'project' | 'studyKey' | 'dataDate' | 'oldDate' | 'outputPrefix' | 'render' | 'blindMode' | 'form' | 'studyCode'>): { projectRoot: string; programPath: string; rendered: boolean; backupPath?: string } {
    const projectRoot = resolveProjectRoot(options.project, this.projectRoot)
    const studyKey = validateStudyKey(options.studyKey)
    const dataDate = validateDate(options.dataDate, 'dataDate')
    const form = validatePkForm(options.form)
    const studyCode = validateStudyKey(options.studyCode ?? studyKey)
    for (const dir of this.spec.dataDirs) {
      const dataDir = join(projectRoot, dir.path, dataDate)
      if (!existsSync(dataDir)) {
        throw laneError(
          `${this.spec.name} 车道${dir.label}数据日期目录不存在：${dataDir}。请确认${dir.label}已投递到 ${dir.path}/${dataDate}/`,
          dir.code,
        )
      }
    }
    const programPath = join(projectRoot, this.spec.programDir, this.spec.programFile(studyKey))
    const exists = existsSync(programPath)
    if (options.render === false && !exists) {
      throw laneError(`程序文件不存在：${programPath}；render=false 要求复用已有程序，请先以 render 缺省或 true 生成`, 'R_PROGRAM_NOT_FOUND')
    }
    const shouldRender = options.render === true || (options.render === undefined && !exists)
    let backupPath: string | undefined
    if (shouldRender) {
      let templatePath = this.config.templatePath || this.spec.templatePath
      if (this.spec.name === 'r_pk' && form === 'sad-mad') templatePath = PK_SADMAD_TEMPLATE_PATH
      const template = readFileSync(templatePath, 'utf8')
      const values: Record<string, string> = {
        PROJECT_ROOT: projectRoot,
        STUDY_KEY: studyKey,
        STUDY_CODE: studyCode,
        DATA_DATE: dataDate,
        OLD_DATE: options.oldDate ? validateDate(options.oldDate, 'oldDate') : '',
        ZIP_PASSWORD: '',
        OUTPUT_PREFIX: options.outputPrefix || this.spec.defaultOutputPrefix(studyKey),
        SUMMARY_PATH: '',
      }
      if (this.spec.blinded) values.BLIND_MODE = validateBlindMode(options.blindMode)
      const rendered = renderTemplate(template, values)
      // 覆盖保护：已有程序与本次渲染不等（含 AI 已生成的业务区）→ 先备份再覆盖。
      // 历史事故=误用 render=true 把数小时生成的业务区整块冲掉且无恢复路径。
      if (exists) {
        try {
          const previous = readFileSync(programPath, 'utf8')
          if (previous !== rendered) {
            const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
            const backupDir = join(projectRoot, '.dsh', 'backups')
            mkdirSync(backupDir, { recursive: true })
            backupPath = join(backupDir, `${basename(programPath)}.${stamp}.bak`)
            writeFileSync(backupPath, previous, 'utf8')
            pruneBackups(backupDir, basename(programPath))
            this.logger?.info?.(`[enterprise-listing] render=true 覆盖已有程序，已备份：${backupPath}`)
          }
        } catch { /* 读取失败不阻断渲染：备份是加固，不是前置条件 */ }
      }
      mkdirSync(join(projectRoot, this.spec.programDir), { recursive: true })
      writeFileSync(programPath, rendered, 'utf8')
    }
    return { projectRoot, programPath, rendered: shouldRender, ...(backupPath ? { backupPath } : {}) }
  }

  async run(options: RRunOptions, hostDataInterception = true): Promise<RRunReceipt> {
    const started = Date.now()
    const { projectRoot, programPath, rendered, backupPath } = this.prepareProgram(options)
    const studyKey = validateStudyKey(options.studyKey)
    const dataDate = validateDate(options.dataDate, 'dataDate')
    const oldDate = options.oldDate ? validateDate(options.oldDate, 'oldDate') : ''
    const blindMode = this.spec.blinded ? validateBlindMode(options.blindMode) : undefined
    const form = validatePkForm(options.form)
    const outputDir = join(projectRoot, this.spec.outputDir)
    mkdirSync(outputDir, { recursive: true })

    const summaryDir = mkdtempSync(join(tmpdir(), 'dsh-r-summary-'))
    const summaryPath = join(summaryDir, 'summary.json')
    const runtime: Record<string, string> = {
      DSH_R_PROJECT_ROOT: projectRoot.replace(/\\/g, '/'),
      DSH_R_STUDY_KEY: studyKey,
      DSH_R_STUDY_CODE: validateStudyKey(options.studyCode ?? studyKey),
      DSH_R_DATA_DATE: dataDate,
      DSH_R_OLD_DATE: oldDate,
      DSH_R_ZIP_PASSWORD: options.password ?? '',
      DSH_R_OUTPUT_PREFIX: options.outputPrefix || this.spec.defaultOutputPrefix(studyKey),
      DSH_R_SUMMARY_PATH: summaryPath.replace(/\\/g, '/'),
    }
    if (blindMode !== undefined) runtime.DSH_R_BLIND_MODE = blindMode
    if (options.config) {
      for (const [k, v] of Object.entries(options.config)) {
        if (!/^DSH_R_[A-Z0-9_]+$/.test(k) || typeof v !== 'string')
          throw laneError(`config 仅接受 DSH_R_ 前缀大写键（收到：${k}）——运行时环境覆盖通道，不写入程序文件`, 'R_CONFIG_INVALID')
        runtime[k] = v
      }
    }
    try {
      const result = await execRscript(
        rscriptCandidates(this.config.rscript), programPath, rscriptEnv(runtime), outputDir,
        this.config.timeoutMs || DEFAULT_R_TIMEOUT_MS, options.signal,
      )
      const summary = readSummary(summaryPath)
      if (result.exitCode !== 0 || summary?.status !== 'ok') {
        if (result.stderrTail) this.logger?.warn?.(`[enterprise-listing] Rscript failed (exit ${result.exitCode}): ${result.stderrTail}`)
        const rMessage = summary?.status === 'error' && typeof summary.message === 'string' ? summary.message.trim() : ''
        const detail = rMessage
          || (hostDataInterception ? '（R 错误输出保留在宿主日志，未回流）' : result.stderrTail.trim().split('\n').slice(-12).join('\n'))
        throw laneError(
          `R 程序执行失败（退出码 ${result.exitCode ?? 'unknown'}）：${detail}\n程序文件：${programPath}。请核对数据目录/依赖包（haven/dplyr/tidyr/purrr/stringr/openxlsx）或修改程序后以 render=false 重跑。`,
          'R_EXECUTION_ERROR', { retryable: false },
        )
      }
      const outputs = Array.isArray(summary.outputs) ? summary.outputs.map(item => basename(String(item))) : []
      const warnings = Array.isArray(summary.warnings) ? summary.warnings.map(String) : []
      if (backupPath) {
        warnings.unshift(
          `[render=true] 已渲染模板覆盖内容不同的既有程序（AI 业务生成区会丢失）；原程序备份：${relative(projectRoot, backupPath).replace(/\\/g, '/')}。`
          + `若被覆盖的是已生成的业务区，请从备份恢复后再以 render=false 运行。`)
      }
      return {
        lane: this.spec.name,
        projectRoot,
        studyKey,
        dataDate,
        oldDate,
        ...(blindMode !== undefined ? { blindMode } : {}),
        ...(this.spec.name === 'r_pk' ? { form } : {}),
        programPath: relative(projectRoot, programPath).replace(/\\/g, '/'),
        rendered,
        ...(backupPath ? { programBackup: relative(projectRoot, backupPath).replace(/\\/g, '/') } : {}),
        listingCount: Number(summary.listingCount ?? 0),
        rowCount: Number(summary.rowCount ?? 0),
        flagCount: Number(summary.flagCount ?? 0),
        sheetCount: Number(summary.sheetCount ?? 0),
        outputDir: relative(projectRoot, outputDir).replace(/\\/g, '/'),
        outputs,
        warnings,
        listings: Array.isArray(summary.listings) ? summary.listings : [],
        durationMs: Date.now() - started,
      }
    } finally {
      rmSync(summaryDir, { recursive: true, force: true })
    }
  }
}

/** r_manual 车道：Manual Listing（DVP）单文件 R 程序。 */
export class RManualRunner extends RLaneRunner {
  constructor(config: RLaneConfig = {}, logger?: { warn?: (message: string) => void; info?: (message: string) => void }) {
    super(MANUAL_LANE, config, logger)
  }
}

/** r_pk 车道：PK Mapping（双盲映射数据集）单文件 R 程序。 */
export class RPKRunner extends RLaneRunner {
  constructor(config: RLaneConfig = {}, logger?: { warn?: (message: string) => void; info?: (message: string) => void }) {
    super(PK_LANE, config, logger)
  }
}
