import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import type { ResolvedTools } from './paths.js'
import { runProc, tail } from './proc.js'
import { assertWorkDir, maskHosts, sanitizeModule, scrubSecrets } from './util.js'
import type { TimingsFile } from './anchors.js'

export interface RecordStageArgs {
  workDir: string
  module?: string
  /** walk 脚本绝对路径；缺省 <workDir>/walk.mjs。 */
  walkScript?: string
  /** 目标系统地址（如 http://localhost:4173）。 */
  base: string
  user?: string
  /** 录制账号密码——经宿主凭据解析后仅注入子进程环境变量，不进回执。 */
  password?: string
  version?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface RecordReceipt {
  pass: boolean
  module: string
  video: string | null
  videoSizeMB: number | null
  durationSec: number | null
  stepTotal: number
  stepFailed: number
  failedSteps: string[]
  actionCount: number
  navigations: number | null
  flashWall: number | null
  logTail: string
  reasons: string[]
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.trim().split('\n')
  return lines.slice(-maxLines).join('\n')
}

/**
 * S1 录制：同步 cursor 运行时到工作目录 → 以 DV_* 环境变量驱动 walk 脚本子进程
 * → 解析 timings.json 契约 → 程序化验收门（0 FAIL / 打点>0 / 视频存在）。
 * 回执只含步骤名/计数/路径与脱敏日志尾（步骤日志与 UI 标签是许可输出；
 * 页面帧与数据值永不回流）。
 */
export async function runRecordStage(
  tools: ResolvedTools, args: RecordStageArgs,
): Promise<RecordReceipt> {
  const workDir = assertWorkDir(args.workDir)
  const module = sanitizeModule(args.module)
  const walkScript = args.walkScript
    ? resolvePath(args.walkScript.trim())
    : join(workDir, 'walk.mjs')
  if (!existsSync(walkScript)) {
    throw Object.assign(new Error(
      `未找到 walk 脚本：${walkScript}。请先把插件 assets 的 walk-template.mjs 复制为 walk.mjs 并按头部注释改三个【模块适配区】；无登录冒烟可直接用 scripts/smoke-walk.mjs。`,
    ), { code: 'DEMO_WALK_MISSING', expose: true })
  }
  if (typeof args.base !== 'string' || args.base.trim() === '') {
    throw Object.assign(new Error('base 必填：目标系统地址（如 http://localhost:4173）。'), { code: 'DEMO_BASE_REQUIRED', expose: true })
  }
  if (!existsSync(join(tools.scriptsDir, 'cursor.mjs'))) {
    throw Object.assign(new Error(`插件运行时资产缺失：cursor.mjs（部署不完整，scriptsDir=${tools.scriptsDir}）`), { code: 'DEMO_ASSET_MISSING', expose: true })
  }
  try {
    copyFileSync(join(tools.scriptsDir, 'cursor.mjs'), join(workDir, 'cursor.mjs'))
  } catch (error) {
    throw Object.assign(new Error(`cursor.mjs 同步到工作目录失败：${(error as Error).message}`), { code: 'DEMO_ASSET_COPY_FAILED', expose: true })
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DV_WORK: workDir,
    DV_BASE: args.base.trim(),
    DV_MODULE: module,
  }
  if (args.user) env.DV_USER = args.user
  if (args.password) env.DV_PASS = args.password
  if (args.version) env.DV_VERSION = args.version
  if (tools.playwrightCorePath) env.DV_PW = tools.playwrightCorePath
  if (tools.chromePath) env.DV_CHROME = tools.chromePath

  const childResult = await runProc(tools.node, [walkScript], {
    cwd: workDir,
    env,
    timeoutMs: args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : tools.recordTimeoutMs,
    signal: args.signal,
  })

  const timingsPath = join(workDir, 'timings.json')
  if (!existsSync(timingsPath)) {
    throw Object.assign(new Error(
      `walk 脚本未产出 timings.json（退出码 ${childResult.code}）。脚本可能中途崩溃，stderr 尾部：${tail(childResult.stderr, 500)}`,
    ), { code: 'DEMO_RECORD_FAILED', expose: true })
  }
  let timings: TimingsFile
  try {
    timings = JSON.parse(readFileSync(timingsPath, 'utf8')) as TimingsFile
  } catch (error) {
    throw Object.assign(new Error(`timings.json 解析失败（S1 输出契约被破坏）：${(error as Error).message}`), { code: 'DEMO_TIMINGS_INVALID', expose: true })
  }

  const steps = timings.steps ?? []
  const failedSteps = steps.filter(s => !s.ok).map(s => s.name)
  const video = timings.video && existsSync(timings.video) ? timings.video : null
  const sizeMB = video ? +(statSync(video).size / 1048576).toFixed(1) : null
  const reasons: string[] = []
  if (steps.length === 0) reasons.push('步骤清单为空（walk 脚本未走任何 step）')
  if (failedSteps.length > 0) reasons.push(`${failedSteps.length} 个步骤 FAIL，见 failedSteps 与 logTail`)
  if (!video) reasons.push('视频文件缺失（录制未产生 webm）')
  if (!(timings.actions?.length)) reasons.push('动作打点为 0：S3 旁白无法同步；检查主流程是否调用 act()')

  return {
    pass: reasons.length === 0,
    module,
    video,
    videoSizeMB: sizeMB,
    durationSec: timings.totalDuration ?? null,
    stepTotal: steps.length,
    stepFailed: failedSteps.length,
    failedSteps,
    actionCount: timings.actions?.length ?? 0,
    navigations: timings.navigations ?? null,
    flashWall: typeof timings.flashWall === 'number' ? timings.flashWall : null,
    logTail: tailLines(maskHosts(scrubSecrets(childResult.stdout, [args.password])), 80),
    reasons,
  }
}
