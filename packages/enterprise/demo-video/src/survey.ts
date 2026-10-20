import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedTools } from './paths.js'
import { runProc, tail } from './proc.js'
import { assertWorkDir, fail, maskHosts, scrubSecrets } from './util.js'

export interface SurveyStageArgs {
  workDir: string
  /** 目标系统地址（如 http://localhost:4173）。 */
  base: string
  user?: string
  /** 录制账号密码——经宿主凭据解析后仅注入子进程环境变量，不进回执。 */
  password?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface SurveyReceipt {
  pass: boolean
  /** 菜单树文件（<workDir>/menu-tree.txt，覆盖清单与交付说明素材）。 */
  treeFile: string | null
  groups: number
  leaves: number
  /** 可见菜单标签里的中文字符数（只计数；>0 = 界面语言门禁不过，模块页只高亮或换数据源）。 */
  cjkMenuLabels: number | null
  /** 登录被拒（密码错误或账号被占用）：不重试，换不互踢账号或请用户释放。 */
  loginRejected: boolean
  /** 菜单树文本（UI 标签，回执口径允许）。 */
  tree: string
  warnings: string[]
  logTail: string
}

const SURVEY_TIMEOUT_MS = 300_000

interface SurveyProbeJson {
  ok?: boolean
  groups?: number
  leaves?: number
  cjkMenuLabels?: number
  file?: string
}

/**
 * S0 调研：跑随包 menu-tree-probe.mjs（递归展开侧边栏 → 菜单树 + 中文标签计数）。
 * 只读不改：不点业务按钮、不进弹窗、零写入。产出定 S1 覆盖清单——不同账号/权限
 * 可见叶子不同，先知道有多少页再定「打开/只高亮」策略（U-Gate 输入）。
 */
export async function runSurveyStage(tools: ResolvedTools, args: SurveyStageArgs): Promise<SurveyReceipt> {
  const workDir = assertWorkDir(args.workDir)
  const probe = join(tools.scriptsDir, 'menu-tree-probe.mjs')
  if (!existsSync(probe)) {
    throw fail('DEMO_ASSET_MISSING', `插件运行时资产缺失：menu-tree-probe.mjs（部署不完整，scriptsDir=${tools.scriptsDir}）`)
  }
  if (typeof args.base !== 'string' || args.base.trim() === '') {
    throw fail('DEMO_BASE_REQUIRED', 'base 必填：目标系统地址（如 http://localhost:4173）。')
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DV_WORK: workDir,
    DV_BASE: args.base.trim(),
  }
  if (args.user) env.DV_USER = args.user
  if (args.password) env.DV_PASS = args.password
  if (tools.playwrightCorePath) env.DV_PW = tools.playwrightCorePath
  if (tools.chromePath) env.DV_CHROME = tools.chromePath

  const r = await runProc(tools.node, [probe], {
    cwd: workDir,
    env,
    timeoutMs: args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : SURVEY_TIMEOUT_MS,
    signal: args.signal,
  })

  const stdout = r.stdout
  const loginRejected = r.code === 3 || stdout.includes('LOGIN_REJECTED')
  const jsonLine = stdout.split('\n').filter(l => l.trim().startsWith('[survey-json]')).pop()
  let parsed: SurveyProbeJson | null = null
  if (jsonLine) {
    try {
      parsed = JSON.parse(jsonLine.slice(jsonLine.indexOf('{'))) as SurveyProbeJson
    } catch { parsed = null }
  }
  const treeFile = parsed?.file && existsSync(parsed.file) ? parsed.file : null
  const tree = treeFile
    ? readFileSync(treeFile, 'utf8').split('\n').filter(l => !l.startsWith('[summary]')).join('\n').trim()
    : stdout.split('\n').filter(l => l.trim() && !l.trim().startsWith('[')).join('\n').trim()

  const groups = parsed?.groups ?? tree.split('\n').filter(l => l.includes('[G]')).length
  const leaves = parsed?.leaves ?? tree.split('\n').filter(l => /^\s*- /.test(l)).length
  const cjkMenuLabels = typeof parsed?.cjkMenuLabels === 'number' ? parsed.cjkMenuLabels : null

  const warnings: string[] = []
  if (loginRejected) warnings.push('登录被拒（密码错误或账号被占用，单点互踢）：不要循环重试——换不互踢的账号或请用户释放会话')
  if (!loginRejected && leaves === 0) warnings.push('菜单树为空：检查是否需要登录/进业务层级（probe 脚本【模块适配区】），或菜单非 Element Plus 结构')
  if (cjkMenuLabels != null && cjkMenuLabels > 0) warnings.push(`可见菜单标签含 ${cjkMenuLabels} 个中文字符：界面语言门禁不过——录制时该类页面只高亮不打开，或先换数据源（见 pitfalls）`)

  return {
    pass: !loginRejected && r.code === 0 && leaves > 0,
    treeFile,
    groups,
    leaves,
    cjkMenuLabels,
    loginRejected,
    tree,
    warnings,
    logTail: tail(maskHosts(scrubSecrets(stdout, [args.password])), 1200),
  }
}
