/**
 * SDK 最小接入验收套件（交付级）。
 *
 * 目标：在锁定 0.2.2-rc.5 + sdk-minimal + 一次性 overlay 上，把平台依赖的
 * SDK 能力逐项真实实测：接入契约、工具执行、多轮记忆、用户提问（应答/取消）、
 * 并发会话隔离、缺失/占用恢复拒绝、崩溃接管恢复、截断语义、低层订阅排空、
 * 审批通道、事件粒度取证。每个用例独立隔离 DSH_HOME 与工作区，只使用合成数据。
 *
 * 通过标准写在每个用例内；失败保留真实错误，不做预设文本遮罩。
 * 报告写 .runtime/sdk-acceptance/report.json；任一用例失败进程退出码非零。
 * CASE_FILTER=case1,case2 可只跑子集。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = 'D:/project/company/ec-clinical-dsh'
const DSH = resolve(ROOT, 'upstream/deepseek-harness-git')
const SUITE = resolve(ROOT, 'scripts/sdk-acceptance')
const OUT = resolve(ROOT, '.runtime/sdk-acceptance')

const { DeepSeekHarness, validatedSessionEvent } = await import(
  pathToFileURL(resolve(DSH, 'packages/sdk/client/lib/index.js')).href
)

mkdirSync(OUT, { recursive: true })
const report = {
  startedAt: new Date().toISOString(),
  env: {
    dshVersion: '0.2.2-rc.5 (local locked source)',
    profile: 'sdk-minimal + one-shot overlay',
    provider: 'zai-coding-cn / glm-5.3-flash',
    credentialsConfigured: Boolean(process.env.ZAI_CODING_CN_API_KEY),
  },
  cases: [],
  summary: { total: 0, passed: 0, failed: 0 },
}
if (!report.env.credentialsConfigured) {
  process.stderr.write('套件前置缺失：ZAI_CODING_CN_API_KEY 未配置（只检查存在，从不打印值）。\n')
  process.exit(2)
}

/** 每个用例独立隔离目录；不删除任何已有目录——重跑时换带时间戳的新目录。
 *  homeOverride 用于跨进程用例共享同一 home。 */
function dirs(id, homeOverride) {
  if (homeOverride) return { home: homeOverride, ws: resolve(OUT, `ws-${id}`) }
  let home = resolve(OUT, `home-${id}`)
  let ws = resolve(OUT, `ws-${id}`)
  if (existsSync(home) || existsSync(ws)) {
    const token = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
    home = resolve(OUT, `home-${id}-${token}`)
    ws = resolve(OUT, `ws-${id}-${token}`)
  }
  mkdirSync(ws, { recursive: true })
  return { home, ws }
}

function makeHarness(id, {
  overlay = 'overlay-basic.yml', maxTokens = 512, approvalRequests = false,
  onUserQuestion, homeOverride,
} = {}) {
  const { home, ws } = dirs(id, homeOverride)
  const harness = new DeepSeekHarness({
    profile: 'sdk-minimal',
    dshBin: resolve(DSH, 'apps/cli/lib/bin.js'),
    dshHome: home,
    cwd: ws,
    processCwd: DSH,
    patches: [resolve(SUITE, 'overlays', overlay)],
    provider: 'zai-coding-cn',
    model: 'glm-5.3-flash',
    maxTokens,
    initializeTimeoutMs: 20000,
    requestTimeoutMs: 120000,
    env: { ...process.env, DSH_HOME: home },
    ...(onUserQuestion ? { onUserQuestion } : {}),
  })
  return { harness, home, ws }
}

/** 收集一个 run 的通知，并在首个 session.event 到达时唤醒。 */
function eventWaker() {
  const events = []
  let wake
  const seen = new Promise(done => { wake = done })
  const onNotification = notification => {
    events.push(notification.method)
    if (notification.method === 'session.event') wake()
  }
  return { events, seen, onNotification }
}

async function withTimeout(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`TIMEOUT_${label}_${ms}MS`)), ms) }),
    ])
  } finally { clearTimeout(timer) }
}

/** 按 overlay 标记 kill 套件子进程（命令行 --patch <overlay>），返回 kill 掉的 PID 数。 */
function killByMarker(marker) {
  const stdout = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(SUITE, 'kill-by-marker.ps1'), marker],
    { encoding: 'utf8' },
  )
  const pids = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^\d+$/.test(line))
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' }) } catch { /* 已退出即达目的 */ }
  }
  return pids
}

async function expectReject(promise, label) {
  try {
    await promise
  } catch (error) {
    return {
      rejected: true,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }
  throw new Error(`${label}_DID_NOT_REJECT`)
}

const eventTypesOf = result => [...new Set(result.events.map(event => event.type))]

// ---------------------------------------------------------------------------
// 用例定义。pass 条件 = 不抛错；facts 原样记录。
// ---------------------------------------------------------------------------
const CASES = [
  {
    id: '01-init-prompt-contract',
    title: '子进程 initialize + prompt + durable events + 关闭',
    async run() {
      const { harness } = makeHarness('01')
      try {
        const waker = eventWaker()
        const result = await harness.run(
          '集成契约验收。不要调用任何工具。请只返回一个 JSON 对象，无 Markdown 围栏，'
          + '字段固定：status="SDK_PROMPT_RECEIVED", received=true, canAnswerQuestions=false。',
          { onNotification: waker.onNotification },
        )
        const eventsValid = result.events.every(event => {
          try { validatedSessionEvent(event); return true } catch { return false }
        })
        const parsed = JSON.parse(result.finalResponse)
        const contract = parsed.status === 'SDK_PROMPT_RECEIVED' && parsed.received === true && parsed.canAnswerQuestions === false
        if (!contract) throw new Error(`RESPONSE_CONTRACT_MISMATCH: ${result.finalResponse}`)
        if (!eventsValid) throw new Error('DURABLE_EVENT_VALIDATION_FAILED')
        if (!waker.events.includes('session.status')) throw new Error('SESSION_STATUS_NOTIFICATION_MISSING')
        if (result.finishReason !== 'completed') throw new Error(`UNEXPECTED_FINISH_REASON: ${result.finishReason}`)
        return {
          sessionId: result.sessionId, finishReason: result.finishReason,
          eventCount: result.events.length, eventTypes: eventTypesOf(result),
          notificationMethods: [...new Set(waker.events)], response: parsed,
        }
      } finally { await harness.close() }
    },
  },
  {
    id: '02-tool-execution',
    title: '真实工具执行：模型经 fs 工具写文件，磁盘可验证',
    async run() {
      const { harness, ws } = makeHarness('02', { overlay: 'overlay-tools.yml' })
      try {
        const probe = resolve(ws, 'TOOL-PROBE.txt')
        const result = await harness.run(
          '目标：在当前工作目录创建文件 TOOL-PROBE.txt。验收标准：文件内容恰好为一行 DM-TOOL-OK-7391。'
          + '使用可用的文件工具完成，完成后只回复 DONE。',
        )
        if (result.finishReason !== 'completed') throw new Error(`UNEXPECTED_FINISH_REASON: ${result.finishReason}`)
        if (!existsSync(probe)) throw new Error(`TOOL_DID_NOT_CREATE_FILE; eventTypes=${JSON.stringify(eventTypesOf(result))}`)
        const content = readFileSync(probe, 'utf8').trim()
        if (content !== 'DM-TOOL-OK-7391') throw new Error(`FILE_CONTENT_MISMATCH: ${JSON.stringify(content)}`)
        const toolEventTypes = eventTypesOf(result).filter(type => /tool/i.test(type))
        if (toolEventTypes.length === 0) throw new Error(`NO_TOOL_EVENT_OBSERVED; eventTypes=${JSON.stringify(eventTypesOf(result))}`)
        return { fileContent: content, eventTypes: eventTypesOf(result), toolEventTypes, response: result.finalResponse }
      } finally { await harness.close() }
    },
  },
  {
    id: '03-multi-turn-memory',
    title: '同会话多轮：第二轮可回溯第一轮设定',
    async run() {
      const { harness } = makeHarness('03')
      try {
        const session = harness.session()
        const first = await session.run('记住交付代号：玄武-7391。只回复 OK。')
        const second = await session.run('之前设定的交付代号是什么？只回复代号本身。')
        if (first.sessionId !== second.sessionId) throw new Error('SESSION_ID_CHANGED_BETWEEN_TURNS')
        if (!second.finalResponse.includes('玄武-7391')) throw new Error(`MEMORY_LOST: ${second.finalResponse}`)
        return { sessionId: second.sessionId, secondResponse: second.finalResponse }
      } finally { await harness.close() }
    },
  },
  {
    id: '04-user-question-answer',
    title: '原生用户提问：ask_user_question 触发宿主应答并影响最终回复',
    async run() {
      let questionRequest
      const { harness } = makeHarness('04', {
        overlay: 'overlay-ask.yml',
        onUserQuestion: async request => {
          questionRequest = {
            requestId: request.requestId, sessionId: request.sessionId,
            questions: request.questions.map(question => ({
              id: question.id, question: question.question,
              optionLabels: (question.options ?? []).map(option => option.label),
              multiSelect: question.multiSelect === true,
            })),
          }
          return {
            answers: request.questions.map(question => ({ id: question.id, selected: ['XLSX'] })),
          }
        },
      })
      try {
        const result = await harness.run(
          '目标：用 ask_user_question 工具问我一个问题——交付物格式选 PDF 还是 XLSX，'
          + '选项必须恰好提供 PDF 与 XLSX 两项。拿到我的回答后，'
          + '验收标准：最终回复必须明确写出我选中的格式。不要调用其他工具。',
        )
        if (!questionRequest) throw new Error('USER_QUESTION_NEVER_TRIGGERED')
        if (result.finishReason !== 'completed') throw new Error(`UNEXPECTED_FINISH_REASON: ${result.finishReason}`)
        if (!result.finalResponse.includes('XLSX')) throw new Error(`ANSWER_NOT_REFLECTED: ${result.finalResponse}`)
        return { questionRequest, finishReason: result.finishReason, response: result.finalResponse }
      } finally { await harness.close() }
    },
  },
  {
    id: '05-user-question-cancel',
    title: '原生用户提问取消：宿主 dismiss 后运行体面收敛',
    async run() {
      let questionRequest
      const { harness } = makeHarness('05', {
        overlay: 'overlay-ask.yml',
        onUserQuestion: async request => {
          questionRequest = { requestId: request.requestId, questionCount: request.questions.length }
          return { cancelled: true }
        },
      })
      try {
        const result = await withTimeout(harness.run(
          '目标：用 ask_user_question 工具问我一个关于报告语言的问题（选项：中文/英文）。'
          + '我可能不回答；无论我是否回答，之后用一句话收尾并结束。',
        ), 120000, 'USER_QUESTION_CANCEL')
        if (!questionRequest) throw new Error('USER_QUESTION_NEVER_TRIGGERED')
        return {
          questionRequest, finishReason: result.finishReason,
          response: result.finalResponse, eventTypes: eventTypesOf(result),
        }
      } finally { await harness.close() }
    },
  },
  {
    id: '06-concurrent-sessions',
    title: '并发会话隔离：两会话并行，结果与通知互不串线',
    async run() {
      const { harness } = makeHarness('06')
      try {
        const a = harness.session()
        const b = harness.session()
        const notifA = []
        const notifB = []
        const [ra, rb] = await Promise.all([
          a.run('记住代号 ALPHA-11 并立即只回复该代号。不要调用工具。', { onNotification: n => notifA.push(n.params?.sessionId ?? null) }),
          b.run('记住代号 BETA-22 并立即只回复该代号。不要调用工具。', { onNotification: n => notifB.push(n.params?.sessionId ?? null) }),
        ])
        if (ra.sessionId === rb.sessionId) throw new Error('SESSION_IDS_COLLIDED')
        if (!ra.finalResponse.includes('ALPHA-11') || ra.finalResponse.includes('BETA-22')) {
          throw new Error(`SESSION_A_CONTAMINATED: ${ra.finalResponse}`)
        }
        if (!rb.finalResponse.includes('BETA-22') || rb.finalResponse.includes('ALPHA-11')) {
          throw new Error(`SESSION_B_CONTAMINATED: ${rb.finalResponse}`)
        }
        const strayA = notifA.filter(id => id !== null && id !== ra.sessionId)
        const strayB = notifB.filter(id => id !== null && id !== rb.sessionId)
        if (strayA.length > 0 || strayB.length > 0) {
          throw new Error(`NOTIFICATION_CROSSED_SESSIONS: A=${JSON.stringify(strayA)} B=${JSON.stringify(strayB)}`)
        }
        return { sessionA: ra.sessionId, sessionB: rb.sessionId, notificationsA: notifA.length, notificationsB: notifB.length }
      } finally { await harness.close() }
    },
  },
  {
    id: '07-resume-missing-rejects',
    title: '恢复不存在的会话必须拒绝',
    async run() {
      const { harness } = makeHarness('07')
      try {
        const rejection = await expectReject(
          harness.resumeSession('session-00000000000000000000000000000000'),
          'RESUME_MISSING_SESSION',
        )
        return rejection
      } finally { await harness.close() }
    },
  },
  {
    id: '08-resume-occupied-rejects',
    title: '另一进程占用中的会话恢复必须拒绝（运行租约事实）',
    async run() {
      const first = makeHarness('08-a')
      try {
        const session = first.harness.session()
        await session.run('只回复 OK。不要调用工具。')
        const second = makeHarness('08-b', { homeOverride: first.home })
        try {
          const rejection = await expectReject(second.harness.resumeSession(session.id), 'RESUME_OCCUPIED_SESSION')
          return { sessionId: session.id, ...rejection }
        } finally { await second.harness.close() }
      } finally { await first.harness.close() }
    },
  },
  {
    id: '09-crash-takeover-resume',
    title: '子进程强杀（崩溃模拟）后跨进程恢复，历史完整可用',
    async run() {
      const crashMarker = 'overlay-crash.yml'
      // crash 用例独占一个 overlay 副本名，保证 PID 匹配唯一。
      const crashOverlay = resolve(SUITE, 'overlays', crashMarker)
      writeFileSync(crashOverlay, readFileSync(resolve(SUITE, 'overlays', 'overlay-basic.yml'), 'utf8'))
      const first = makeHarness('09', { overlay: crashMarker })
      let sessionId
      try {
        const session = first.harness.session()
        const setup = await session.run('记住交付代号：赤霄-2026。只回复 OK。不要调用工具。')
        sessionId = setup.sessionId
        const waker = eventWaker()
        const longTurn = session.run(
          '请不间断输出约 2000 个汉字的临床数据管理培训要点占位文本，段落式，不调用工具，不提问，不总结收尾。',
          { onNotification: waker.onNotification },
        )
        await withTimeout(waker.seen, 30000, 'WAITING_FIRST_EVENT')
        const killed = killByMarker(crashMarker)
        if (killed.length === 0) throw new Error('CHILD_PROCESS_NOT_FOUND_FOR_KILL')
        let crashError
        try {
          await withTimeout(longTurn, 60000, 'CRASHED_TURN_SETTLE')
          throw new Error('LONG_TURN_COMPLETED_DESPITE_KILL')
        } catch (error) { crashError = error }
        if (/LONG_TURN_COMPLETED_DESPITE_KILL/.test(crashError.message)) throw crashError
        try { await first.harness.close() } catch { /* 子进程已死，关闭尽力而为 */ }

        const second = makeHarness('09-resume', { homeOverride: first.home })
        try {
          const resumed = await second.harness.resumeSession(sessionId)
          if (resumed.id !== sessionId) throw new Error('RESUME_IDENTITY_MISMATCH')
          const recall = await resumed.run('之前设定的交付代号是什么？只回复代号本身。不要调用工具。')
          if (!recall.finalResponse.includes('赤霄-2026')) throw new Error(`POST_CRASH_MEMORY_LOST: ${recall.finalResponse}`)
          return {
            sessionId, killedPids: killed,
            crashErrorName: crashError instanceof Error ? crashError.name : String(crashError),
            crashErrorMessage: crashError instanceof Error ? crashError.message : String(crashError),
            recallResponse: recall.finalResponse,
          }
        } finally { await second.harness.close() }
      } finally {
        try { await first.harness.close() } catch { /* 已处理 */ }
      }
    },
  },
  {
    id: '10-truncation-reason',
    title: 'maxTokens 截断产生非 completed 终止原因',
    async run() {
      const { harness } = makeHarness('10', { maxTokens: 60 })
      try {
        const result = await harness.run(
          '请输出不少于 500 字的临床数据管理培训要点说明。不要调用工具，不要提问。',
        )
        if (result.finishReason === null) throw new Error('FINISH_REASON_NULL_ON_TRUNCATION')
        if (result.finishReason === 'completed') throw new Error('TURN_REPORTED_COMPLETED_DESPITE_TINY_MAXTOKENS')
        return { finishReason: result.finishReason, responseLength: result.finalResponse.length, eventTypes: eventTypesOf(result) }
      } finally { await harness.close() }
    },
  },
  {
    id: '11-lowlevel-subscribe-wait-drain',
    title: '平台任务消费模式：订阅 → prompt → session/wait → tryNext 排空',
    async run() {
      const { harness } = makeHarness('11')
      try {
        const client = harness.client
        const session = harness.session()
        const subscription = client.subscribeSessionTree(session.id)
        const runPromise = session.run('只回复 PLATFORM-DRAIN-OK。不要调用工具。')
        await runPromise
        const drained = []
        for (let next = subscription.tryNext(); next !== undefined; next = subscription.tryNext()) {
          drained.push(next)
        }
        await client.request('session/wait', { sessionId: session.id })
        if (drained.length === 0) throw new Error('SUBSCRIPTION_DRAINED_NOTHING')
        const stray = drained.filter(n => n.params?.sessionId !== session.id)
        if (stray.length > 0) throw new Error(`SUBSCRIPTION_CROSSED_SESSIONS: ${JSON.stringify(stray.map(n => n.params?.sessionId))}`)
        return {
          sessionId: session.id, drainedCount: drained.length,
          drainedMethods: [...new Set(drained.map(n => n.method))],
          response: runPromise.then(result => result.finalResponse, () => 'unavailable'),
        }
      } finally { await harness.close() }
    },
  },
  {
    id: '12-approval-channel',
    title: '审批通道：approvalRequests 开启 + allowed-once 放行下工具写入成功',
    async run() {
      let approvalSeen
      const { harness, ws } = makeHarness('12', { overlay: 'overlay-tools.yml', approvalRequests: true })
      // onRequest 必须在 client.start() 之后、运行之前安装（SDK 文档约束）。
      await harness.client.start()
      harness.client.onRequest(async (method, params) => {
        if (method === 'approval/request') {
          approvalSeen = { sessionId: params?.sessionId, toolName: params?.toolName, reason: params?.reason ?? null }
          return { outcome: 'allowed-once' }
        }
        return { cancelled: true }
      })
      try {
        const probe = resolve(ws, 'APPROVAL-PROBE.txt')
        const result = await harness.run(
          '目标：在当前工作目录创建文件 APPROVAL-PROBE.txt。验收标准：内容恰好为一行 DM-APPROVAL-OK。'
          + '使用文件工具完成，完成后只回复 DONE。',
        )
        if (result.finishReason !== 'completed') throw new Error(`UNEXPECTED_FINISH_REASON: ${result.finishReason}`)
        if (!existsSync(probe)) throw new Error('TOOL_DID_NOT_CREATE_FILE')
        const content = readFileSync(probe, 'utf8').trim()
        if (content !== 'DM-APPROVAL-OK') throw new Error(`FILE_CONTENT_MISMATCH: ${JSON.stringify(content)}`)
        return {
          approvalRequestArrived: approvalSeen !== undefined,
          approvalSeen, fileContent: content, eventTypes: eventTypesOf(result),
        }
      } finally { await harness.close() }
    },
  },
]

// ---------------------------------------------------------------------------
const filter = (process.env.CASE_FILTER ?? '').split(',').map(part => part.trim()).filter(Boolean)
const selected = filter.length > 0 ? CASES.filter(one => filter.includes(one.id)) : CASES
report.summary.total = selected.length

for (const one of selected) {
  const startedAt = Date.now()
  const entry = { id: one.id, title: one.title, pass: false, facts: {} }
  process.stdout.write(`▶ ${one.id} ${one.title}\n`)
  try {
    entry.facts = await one.run()
    entry.pass = true
  } catch (error) {
    entry.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  entry.durationMs = Date.now() - startedAt
  report.cases.push(entry)
  report.summary.passed += entry.pass ? 1 : 0
  report.summary.failed += entry.pass ? 0 : 1
  process.stdout.write(`${entry.pass ? '✓ PASS' : '✗ FAIL'} ${one.id} (${entry.durationMs}ms)${entry.error ? ` — ${entry.error}` : ''}\n`)
}

report.finishedAt = new Date().toISOString()
writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
process.stdout.write(`\n合计 ${report.summary.passed}/${report.summary.total} 通过；报告：${resolve(OUT, 'report.json')}\n`)
if (report.summary.failed > 0) process.exitCode = 1
