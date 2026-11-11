import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { DeepSeekHarness, validatedSessionEvent } = await import(pathToFileURL(resolve('D:/project/company/ec-clinical-dsh/upstream/deepseek-harness-git/packages/sdk/client/lib/index.js')).href)

const root = resolve('D:/project/company/ec-clinical-dsh')
const home = resolve(root, '.runtime', 'sdk-minimal-e2e-home')
const workspace = resolve(root, '.runtime', 'sdk-minimal-e2e-workspace')
const overlay = resolve(root, 'scripts', 'sdk-minimal-e2e.overlay.yml')
const reportPath = resolve(root, '.runtime', 'sdk-minimal-e2e-report.json')
mkdirSync(workspace, { recursive: true })
const report = { startedAt: new Date().toISOString(), checks: {}, facts: {}, limitations: [] }
const savedSessionId = process.env.DSH_E2E_RESUME_SESSION_ID
const strictPrompt = [
  '平台集成契约 smoke test。不要调用任何工具，不要读写文件，不要安装插件。',
  '请只返回一个 JSON 对象，无 Markdown 代码围栏。字段：status,received,canAnswerQuestions。',
  '固定值：status="SDK_PROMPT_RECEIVED", received=true, canAnswerQuestions=false。',
].join('\n')
let harness
try {
  if (!process.env.ZAI_CODING_CN_API_KEY) throw new Error('TEST_PREREQUISITE_MISSING_ZAI_CODING_CN_API_KEY')
  if (!existsSync(resolve(root, 'upstream/deepseek-harness-git/apps/cli/lib/bin.js'))) throw new Error('TEST_PREREQUISITE_MISSING_DSH_BIN')
  if (!existsSync(resolve(root, 'upstream/deepseek-harness-git/packages/sdk/protocol/lib/index.js'))) throw new Error('TEST_PREREQUISITE_MISSING_PROTOCOL_BUILD')
  report.facts.dshVersion = '0.2.2-rc.1 (local locked source)'
  report.facts.profile = 'sdk-minimal + one-shot overlay'
  report.facts.credentialsConfigured = true
  harness = new DeepSeekHarness({
    profile: 'sdk-minimal',
    dshBin: resolve(root, 'upstream/deepseek-harness-git/apps/cli/lib/bin.js'),
    dshHome: home,
    cwd: workspace,
    processCwd: resolve(root, 'upstream/deepseek-harness-git'),
    patches: [overlay],
    provider: 'zai-coding-cn',
    model: 'glm-5.3-flash',
    maxTokens: 512,
    initializeTimeoutMs: 20000,
    requestTimeoutMs: 90000,
    disposeEofGraceMs: 3000,
    disposeGraceMs: 3000,
    env: { ...process.env, DSH_HOME: home },
    onUserQuestion: async () => ({ cancelled: true }),
  })
  report.checks.constructed = true
  const ownedNotifications = []
  const first = await harness.run(strictPrompt, { onNotification: notification => ownedNotifications.push(notification.method) })
  report.facts.firstSessionId = first.sessionId
  report.facts.firstFinishReason = first.finishReason
  report.facts.firstEventCount = first.events.length
  report.facts.firstNotificationMethods = [...new Set(ownedNotifications)]
  report.checks.initializeAndPrompt = true
  report.checks.durableEventObserved = first.events.some(event => {
    try { validatedSessionEvent(event); return true } catch { return false }
  })
  report.checks.ownedStatusNotificationObserved = ownedNotifications.includes('session.status')
  report.facts.response = first.finalResponse
  report.checks.responseContract = /^\s*\{[\s\S]*\}\s*$/.test(first.finalResponse)
  report.checks.responseContractValid = false
  try {
    const parsed = JSON.parse(first.finalResponse)
    report.facts.responseFields = parsed
    report.checks.responseContractValid = parsed.status === 'SDK_PROMPT_RECEIVED' && parsed.received === true && parsed.canAnswerQuestions === false
  } catch { /* Report the actual model text above, without weakening the assertion. */ }
  if (!report.checks.responseContractValid) throw new Error('MODEL_OUTPUT_DID_NOT_MATCH_STRICT_TEST_CONTRACT')

  report.facts.firstSessionPersistedHome = existsSync(resolve(home, 'sessions'))
  if (savedSessionId) {
    const resumed = await harness.resumeSession(savedSessionId)
    report.facts.resumeSessionId = resumed.id
    report.checks.resumeExactSession = resumed.id === savedSessionId
    if (!report.checks.resumeExactSession) throw new Error('RESUME_RETURNED_DIFFERENT_SESSION')
    const resumedRun = await resumed.run('恢复验证。不要调用任何工具。请只返回一个 JSON 对象，无 Markdown 围栏，字段固定：status="RESUME_PROMPT_OK"。')
    report.facts.resumeFinishReason = resumedRun.finishReason
    report.facts.resumeResponse = resumedRun.finalResponse
    report.checks.resumeAcceptsNewPrompt = resumedRun.finishReason === 'completed'
    if (!report.checks.resumeAcceptsNewPrompt) throw new Error('RESUMED_SESSION_DID_NOT_COMPLETE_NEW_PROMPT')
    report.checks.resumeRanFollowUpPrompt = true
  } else {
    report.checks.resumeExactSession = 'SKIPPED_NO_PREEXISTING_SESSION_ID'
  }
  report.limitations.push('验证了同版本 SDK 子进程、initialize、一次真实 prompt、最终响应、Session durable events/status、隔离 home 和关闭。')
  report.limitations.push('本次没有调用任何 DSH 工具、业务插件工具、文件读取或模型可控的文件/插件操作。')
  report.limitations.push('user-question、approval、取消中途真实模型 turn、Worker 崩溃接管、成果登记未验证。')
  report.limitations.push(savedSessionId ? '执行了指定持久会话的精确恢复，并在恢复会话上完成了一次新 prompt。' : '未执行 session/resume：此次新建 Session 后关闭，未把新 Session 标成旧会话恢复。')
} catch (error) {
  report.checks.failed = true
  report.facts.error = error instanceof Error ? error.message : String(error)
  report.limitations.push('测试失败即保留实际错误，不把 SDK 启动或模型调用失败描述为平台接入通过。')
  process.exitCode = 1
} finally {
  try { await harness?.close() } catch (error) {
    report.checks.runtimeClosed = false
    report.facts.closeError = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  }
  if (harness && report.checks.runtimeClosed === undefined) report.checks.runtimeClosed = true
  report.finishedAt = new Date().toISOString()
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  process.stdout.write(JSON.stringify(report) + '\n')
}
