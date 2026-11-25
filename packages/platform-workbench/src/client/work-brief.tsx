/** The work brief: the read-only summary of the work selected in the index (方案 B/B3).
 *
 *  The brief reads facts, never narrates them: the Work's own labels come from the index row,
 *  pending items are the bootstrap todos filtered to this Work (missing todos are "unavailable",
 *  not zero), the run is the Work's most recent recorded run located via `workRuns(offset 0,
 *  limit 1)` and verified against `run.workId` — labelled 最近一次运行, never "the active run" —
 *  and files/activities are that run's `runArtifacts`/`runEvents`. Absent, loading and failed
 *  are three separate states everywhere. Files show a generic format cover; a download exists
 *  only for a sealed copy, disables itself while busy and reports failures in place. Nothing
 *  here creates, binds, reviews or sends: the only outputs are the parent's callbacks.
 *
 *  Request discipline (plan §2/§3): the parent keys this component by `workId`, so switching
 *  targets remounts it — an in-flight response of the previous target is discarded by its
 *  own `live` flag (A→B→A compares request generations, not just ids).
 */
import { useEffect, useState } from 'react'
import { WorkbenchApi, errorText, type ArtifactItem, type RunEventItem, type RunSummary, type WorkbenchItem } from '../api.js'
import { formatBytes, relativeTime, runTone, type WorkRow } from '../reports.js'
import { formatDateTime, getPreferences, runStateText, t, usePreferences } from './i18n.js'
import { UnifiedTodoList, type TodoItem } from './todo-rows.js'

/** Durable run-ledger event labels (shared with the console's event log). */
export const RUN_EVENT_LABELS: Record<string, string> = {
  cancel: '请求停止', dispatch: '派发', started: '已启动', barrier: '完成屏障', finish: '已完成',
  fail: '失败', unknown: '结果未知', 'cancel-settled': '停止已确认',
}

/** Honest format label from the file's own extension — an xlsx is a workbook, never a claim
 *  about its contents (plan §3: the platform exposes no summary, so none is invented). */
function formatLabel(name: string, locale: 'zh-CN' | 'en-US'): string {
  const extension = (name.split('.').pop() ?? '').toLowerCase()
  const key = ['xlsx', 'xls'].includes(extension) ? 'brief.format.workbook'
    : ['csv', 'tsv'].includes(extension) ? 'brief.format.table'
      : ['r', 'sql', 'py', 'js', 'sh'].includes(extension) ? 'brief.format.script'
        : ['doc', 'docx', 'md', 'txt', 'pdf'].includes(extension) ? 'brief.format.document'
          : 'brief.format.file'
  return t(key, locale)
}

function formatTime(value: unknown): string {
  const preferences = getPreferences()
  return formatDateTime(value, preferences, preferences.locale === 'en-US' ? 'Time not recorded' : '时间未记录')
}

type RunState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'error'; message: string }
  | { status: 'ready'; run: RunSummary }

export interface WorkBriefProps {
  api: WorkbenchApi
  row: WorkRow
  /** The full Work record (state included) as known by the index/parent. */
  work: WorkbenchItem | undefined
  /** Bootstrap todos already filtered to this Work by the parent. */
  todos: TodoItem[]
  /** False when the platform did not deliver todos at all — "unavailable", never "none". */
  todosKnown: boolean
  /** The workId an open/navigation is currently settling on ('' when none). */
  opening: string
  onEnter(workId: string): void
  onDetail(work: WorkbenchItem, runId?: string): void
  onOpenPending(workId: string, runId: string): void
  onDownload(runId: string, name: string): Promise<void> | void
}

export function WorkBrief({ api, row, work, todos, todosKnown, opening, onEnter, onDetail, onOpenPending, onDownload }: WorkBriefProps) {
  const { locale } = usePreferences()
  const [runState, setRunState] = useState<RunState>({ status: 'loading' })
  const [artifacts, setArtifacts] = useState<{ status: 'loading' | 'ready' | 'error'; items: ArtifactItem[]; error: string }>({ status: 'loading', items: [], error: '' })
  const [events, setEvents] = useState<{ status: 'loading' | 'ready' | 'error'; items: RunEventItem[]; error: string }>({ status: 'loading', items: [], error: '' })
  const [showAllArtifacts, setShowAllArtifacts] = useState(false)
  const [downloading, setDownloading] = useState('')
  const [downloadError, setDownloadError] = useState('')
  // Run locate retry: bumping the token re-runs the locate effect for the same Work.
  const [runRetry, setRunRetry] = useState(0)

  const workId = row.workId
  const run = runState.status === 'ready' ? runState.run : null

  // The Work's most recent recorded run. A run that does not name THIS Work is not displayed —
  // the verification is the point, not a formality (plan §3).
  useEffect(() => {
    let live = true
    setRunState({ status: 'loading' })
    const controller = new AbortController()
    api.workRuns(workId, { offset: 0, limit: 1 }, controller.signal)
      .then((page) => {
        if (!live) return
        const candidate = page.items[0]
        if (page.total === 0 || !candidate || candidate.workId !== workId) setRunState({ status: 'none' })
        else setRunState({ status: 'ready', run: candidate })
      })
      .catch((reason) => {
        if (!live || (reason as Error)?.name === 'AbortError') return
        setRunState({ status: 'error', message: errorText(reason) })
      })
    return () => { live = false; controller.abort() }
    // runRetry re-runs the locate after an in-place failure (same Work, new request generation).
  }, [api, workId, runRetry])

  // The located run's files and first-screen activity. Each area fails and retries alone.
  useEffect(() => {
    if (!run) {
      setArtifacts({ status: 'loading', items: [], error: '' })
      setEvents({ status: 'loading', items: [], error: '' })
      return undefined
    }
    let live = true
    setArtifacts({ status: 'loading', items: [], error: '' })
    setEvents({ status: 'loading', items: [], error: '' })
    const controller = new AbortController()
    api.runArtifacts(run.runId, controller.signal)
      .then((result) => {
        if (!live) return
        setArtifacts({ status: 'ready', items: result.items, error: '' })
      })
      .catch((reason) => {
        if (!live || (reason as Error)?.name === 'AbortError') return
        setArtifacts({ status: 'error', items: [], error: errorText(reason) })
      })
    api.runEvents(run.runId, { offset: 0, limit: 6 }, controller.signal)
      .then((page) => {
        if (!live) return
        setEvents({ status: 'ready', items: page.items, error: '' })
      })
      .catch((reason) => {
        if (!live || (reason as Error)?.name === 'AbortError') return
        setEvents({ status: 'error', items: [], error: errorText(reason) })
      })
    return () => { live = false; controller.abort() }
  }, [api, run?.runId])

  // A matched review todo is the only source of the amber 「待复核」 pill — a succeeded run is
  // not a business approval (plan §3).
  const reviewPending = todos.some((todo) => todo.kind === 'review'
    && todo.workId === workId
    && (!todo.runId || !run || todo.runId === run.runId))
  const archived = (work?.state ?? row.state) === 'ARCHIVED'
  const pill = reviewPending
    ? { label: t('brief.needsReview', locale), tone: 'warn' as const }
    : run
      ? { label: runStateText(run.snapshot?.state, locale), tone: runTone(run.snapshot?.state) }
      : archived
        ? { label: t('home.archived', locale), tone: 'muted' as const }
        : { label: t('home.noRun', locale), tone: 'muted' as const }
  const openingThis = opening === workId

  const download = (runId: string, name: string) => {
    if (downloading) return
    setDownloading(name)
    setDownloadError('')
    void Promise.resolve(onDownload(runId, name))
      .catch((reason: unknown) => setDownloadError(`${t('brief.downloadFailed', locale)}: ${errorText(reason)}`))
      .finally(() => setDownloading((current) => (current === name ? '' : current)))
  }

  return (
    <article className="ec-wb-brief-wrap" aria-labelledby="ec-wb-brief-title">
      <header className="ec-wb-brief-head">
        <div className="ec-wb-brief-status-row">
          <span className="ec-wb-pill" data-tone={pill.tone}>{pill.label}</span>
          <span className="ec-wb-brief-app">{row.appName}</span>
        </div>
        <h1 className="ec-wb-brief-title" id="ec-wb-brief-title">{row.title}</h1>
        {/* 目标句是员工创建工作时的录入（workbench 列表原样携带）；没有录入就显示项目/应用事实，
            绝不把图上的示例文案当成真实结论。 */}
        {work?.goal
          ? <p className="ec-wb-brief-goal">{work.goal}</p>
          : (
            <p className="ec-wb-brief-facts">
              <span>{t('brief.project', locale)} <b>{row.projectName}</b></span>
              <span aria-hidden="true">·</span>
              <span>{t('brief.application', locale)} <b>{row.appName}</b></span>
            </p>
          )}
        {archived ? <p className="ec-wb-muted" role="note">{t('brief.archived', locale)}</p> : null}
        <div className="ec-wb-brief-actions">
          {archived
            ? (
              <button type="button" className="ec-wb-brief-enter" onClick={() => onDetail(work ?? rowToWork(row))}>
                {t('action.viewDetail', locale)}
              </button>
            )
            : (
              <button type="button" className="ec-wb-brief-enter" disabled={openingThis} onClick={() => onEnter(workId)}>
                {openingThis ? t('home.opening', locale) : t('brief.enter', locale)}
              </button>
            )}
          {run
            ? (
              <button type="button" className="ec-wb-brief-link" disabled={openingThis} onClick={() => onDetail(work ?? rowToWork(row), run.runId)}>
                {t('brief.viewRuns', locale)} <span aria-hidden="true">→</span>
              </button>
            )
            : null}
        </div>
      </header>

      <section className="ec-wb-brief-section" aria-labelledby="ec-wb-brief-artifacts">
        <div className="ec-wb-brief-section-head">
          <h2 id="ec-wb-brief-artifacts">{t('brief.artifacts', locale)}</h2>
          {run && artifacts.status === 'ready'
            ? <small>{t('brief.artifactCount', locale).replace('{count}', String(artifacts.items.length))}</small>
            : null}
        </div>
        {!run
          ? (
            <div className="ec-wb-brief-empty">
              {runState.status === 'loading'
                ? <p role="status">{t('home.loading', locale)}</p>
                : runState.status === 'error'
                  ? (
                    <>
                      <p role="alert">{t('brief.runsError', locale)}: {runState.message}</p>
                      <button type="button" className="ec-wb-button" onClick={() => setRunRetry((value) => value + 1)}>
                        {t('action.retry', locale)}
                      </button>
                    </>
                  )
                  : (
                    <>
                      <p>{t('brief.noRuns', locale)}</p>
                      <p>{t('brief.noRunsHint', locale)}</p>
                    </>
                  )}
            </div>
          )
          : artifacts.status === 'error'
            ? (
              <div className="ec-wb-brief-empty" role="alert">
                <p>{t('brief.artifactsError', locale)}: {artifacts.error}</p>
              </div>
            )
            : artifacts.status === 'loading'
              ? <p className="ec-wb-muted" role="status">{t('home.loading', locale)}</p>
              : artifacts.items.length === 0
                ? <div className="ec-wb-brief-empty"><p>{t('brief.noArtifacts', locale)}</p></div>
                : artifacts.items.length === 1
                  ? <ArtifactCard item={artifacts.items[0]} runId={run.runId} locale={locale} downloading={downloading} onDownload={download} />
                  : (
                    <ArtifactList
                      items={artifacts.items}
                      runId={run.runId}
                      locale={locale}
                      downloading={downloading}
                      showAll={showAllArtifacts}
                      onToggleAll={() => setShowAllArtifacts((value) => !value)}
                      onDownload={download}
                    />
                  )}
        {downloadError ? <p className="ec-wb-error-text" role="alert">{downloadError}</p> : null}
      </section>

      <section className="ec-wb-brief-section" aria-labelledby="ec-wb-brief-activity">
        <div className="ec-wb-brief-section-head">
          <h2 id="ec-wb-brief-activity">{t('brief.latestActivity', locale)}</h2>
          {run ? <small>{t('brief.recentRun', locale)} · {runStateText(run.snapshot?.state, locale)}</small> : null}
        </div>
        {/* 三态分开：定位运行中才是加载；没有运行是空态（2026-11-24 修复：此前没有运行记录的工作
            在这里永远显示“正在加载…”）；定位失败的错误已在上方「工作底稿」就地报告并可重试，这里
            不重复第二份。 */}
        {runState.status === 'loading'
          ? <p className="ec-wb-muted" role="status">{t('home.loading', locale)}</p>
          : runState.status === 'none'
            ? <p className="ec-wb-muted">{t('brief.noActivity', locale)}</p>
            : runState.status === 'error'
              ? null
              : events.status === 'loading'
                ? <p className="ec-wb-muted" role="status">{t('home.loading', locale)}</p>
                : events.status === 'error'
                  ? (
                    <div className="ec-wb-brief-empty" role="alert">
                      <p>{t('brief.eventsError', locale)}: {events.error}</p>
                    </div>
                  )
                  : events.items.length === 0
                    ? <p className="ec-wb-muted">{t('brief.noEvents', locale)}</p>
                    : (
                      <div className="ec-wb-activity-list">
                        {events.items.map((item) => (
                          <div className="ec-wb-activity-row" key={item.sequence}>
                            <strong>{RUN_EVENT_LABELS[item.event?.type] ?? item.event?.type ?? '事件'}</strong>
                            <span>{typeof item.event?.reason === 'string' && item.event.reason ? item.event.reason : item.actor}</span>
                            <time>{relativeTime(item.createdAt, Date.now())}</time>
                          </div>
                        ))}
                      </div>
                    )}
      </section>

      <section className="ec-wb-brief-section" aria-labelledby="ec-wb-brief-pending">
        <div className="ec-wb-brief-section-head">
          <h2 id="ec-wb-brief-pending">{t('brief.pending', locale)}</h2>
          {todosKnown ? <small>{todos.length}</small> : null}
        </div>
        {!todosKnown
          ? <p className="ec-wb-muted">{t('home.todosUnavailable', locale)}</p>
          : todos.length === 0
            ? <p className="ec-wb-muted">{t('home.noTodos', locale)}</p>
            : <UnifiedTodoList items={todos} works={work ? [work] : []} onOpen={onOpenPending} />}
      </section>
    </article>
  )
}

/** Generic format cover: the extension is the only decoration a registered file earns — the
 *  platform exposes no summary, thumbnail or page count, so none is invented (plan §3). */
function ArtifactCard({ item, runId, locale, downloading, onDownload }: {
  item: ArtifactItem
  runId: string
  locale: 'zh-CN' | 'en-US'
  downloading: string
  onDownload(runId: string, name: string): void
}) {
  const sealed = typeof item.sealedAt === 'string' && item.sealedAt.length > 0
  const extension = (item.name.split('.').pop() ?? '').replace(/[^0-9a-z]/gi, '').slice(0, 4)
  const busy = downloading === item.name
  const now = Date.now()
  return (
    <div className="ec-wb-artifact-card">
      <span className="ec-wb-artifact-cover" aria-hidden="true"><b>{extension || (locale === 'en-US' ? 'FILE' : '文件')}</b></span>
      <div className="ec-wb-artifact-body">
        <span className="ec-wb-artifact-name">{item.name}</span>
        <span className="ec-wb-artifact-meta">
          <span>{formatLabel(item.name, locale)}</span>
          {item.createdAt ? <span>· {t('brief.generated', locale).replace('{time}', relativeTime(item.createdAt, now))}</span> : <i data-tone={sealed ? 'ok' : 'warn'}>{sealed ? t('brief.sealed', locale) : t('brief.unsealed', locale)}</i>}
          <span>· {formatBytes(item.bytes)}</span>
        </span>
        <div className="ec-wb-artifact-foot">
          <span className="ec-wb-artifact-hint">{runId.slice(0, 8)}</span>
          {sealed
            ? (
              <button type="button" className="ec-wb-artifact-download" disabled={Boolean(downloading)} onClick={() => onDownload(runId, item.name)}>
                <span aria-hidden="true">∨</span> {busy ? t('home.loading', locale) : t('brief.download', locale)}
              </button>
            )
            : null}
        </div>
      </div>
    </div>
  )
}

/** Several files stay one honest list; the first screen shows at most five before expanding. */
function ArtifactList({ items, runId, locale, downloading, showAll, onToggleAll, onDownload }: {
  items: ArtifactItem[]
  runId: string
  locale: 'zh-CN' | 'en-US'
  downloading: string
  showAll: boolean
  onToggleAll(): void
  onDownload(runId: string, name: string): void
}) {
  const visible = showAll ? items : items.slice(0, 5)
  return (
    <div>
      <div className="ec-wb-artifact-list">
        {visible.map((item) => {
          const sealed = typeof item.sealedAt === 'string' && item.sealedAt.length > 0
          return (
            <div className="ec-wb-artifact-line" key={item.name}>
              <span className="ec-wb-artifact-name">{item.name}</span>
              <span className="ec-wb-artifact-meta">
                <i data-tone={sealed ? 'ok' : 'warn'}>{sealed ? t('brief.sealed', locale) : t('brief.unsealed', locale)}</i>
                <span>{formatBytes(item.bytes)}</span>
              </span>
              {sealed
                ? (
                  <button type="button" className="ec-wb-artifact-download" disabled={Boolean(downloading)} onClick={() => onDownload(runId, item.name)}>
                    {downloading === item.name ? t('home.loading', locale) : t('brief.download', locale)}
                  </button>
                )
                : null}
            </div>
          )
        })}
      </div>
      {items.length > 5
        ? (
          <button type="button" className="ec-wb-text-link" aria-expanded={showAll} onClick={onToggleAll}>
            {showAll ? t('brief.collapse', locale) : t('brief.showAll', locale).replace('{count}', String(items.length))}
          </button>
        )
        : null}
    </div>
  )
}

/** A Work-shaped value for the parent's detail callback when only the row is known. */
function rowToWork(row: WorkRow): WorkbenchItem {
  return {
    workId: row.workId,
    title: row.title,
    projectId: row.projectId,
    appId: row.appId,
    appVersion: row.appVersion,
    state: row.state === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
  }
}
