/** Enterprise workbench shell for the native WebUI (T02/T06/T07/T09/T10/T12/T13).
 *
 *  Keyed pages form the enterprise shell — 我的工作 / 历史会话 / 项目空间 / 应用中心 / 待处理 / 平台设置 —
 *  and the plugin selects 我的工作 at boot so the first screen is an enterprise home, not a bare
 *  chat. Works are the business navigation unit. The 历史会话 page (2026-11-17 product decision)
 *  exposes the native session catalog directly — the same host list the upstream sidebar reads —
 *  so any conversation, bound to a Work or not, is reachable and resumable from the workbench;
 *  conversations stay conversation navigation and never masquerade as business entries.
 *
 *  The native conversation capability is embedded in this page (T13 single-page form): the page
 *  declares a `workbench.session` child with `scope: 'session-maybe'` and its entry hosts the
 *  upstream `conversation.content` factory with `variant: 'embedded'`. Opening a Work retains the
 *  bound Session under this plugin's own reference source and scopes the session view with the
 *  standard-kit `SessionProvider` target — the same explicit pattern as the upstream right Sidebar's
 *  session views, which never contends with the main view election. Leaving the view releases the
 *  reference. There is no page switch, no second chat and no copied session state — streaming,
 *  tools, queue, stop, questions and refresh recovery stay native.
 *
 *  Everything here reads and writes durable control-plane facts. An empty section explains why it
 *  is empty, an artifact is called sealed only when the control plane recorded a sealed copy, and a
 *  failed operation keeps the control plane's own code instead of a fabricated success.
 *
 *  Refresh survival (2026-11-17): the native WebUI keeps you in your conversation across F5; this
 *  page's view was component state, so a reload flashed the works list over an open chat. The view
 *  coordinate (page / open console / open session / focused run) now mirrors to sessionStorage —
 *  ids only — and re-applies at boot (`view-state.ts`); a stale coordinate falls back to the works
 *  page, and the plugin's boot guard keeps the shell unlit until the platform panel is active so
 *  the previous native view never paints over the restore.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  conversationPhase,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionListState, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  InjectFace,
  PropsRenderFactories,
  PropsRenderSlots,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  PlatformApiError,
  WorkbenchApi,
  type ArtifactItem,
  type AuditEntryItem,
  type DeliveryPackageItem,
  type EvaluationRunItem,
  type FindingItem,
  type FindingsDiff,
  type InputBaselineItem,
  type InputCommitItem,
  type InteractionItem,
  type ModelCatalog,
  type ModelPreference,
  type OpsPanel,
  type Page,
  type ReviewItem,
  type ResultViewDecl,
  type RunActivity,
  type RunDetail,
  type RunEventItem,
  type RunSummary,
  type WorkbenchBootstrap,
  type WorkbenchItem,
  type WorkspaceItem,
} from '../api.js'
import { artifactDownloadPath, formatBytes, monogram, pageWindow, relativeTime, runTone, selectWorkRows, summarizeArtifacts, type WorkRow } from '../reports.js'
import { buildAnswers, chosenModel, modelChoices, runInput, type NativeQuestion } from '../forms.js'
import type { WorkContext } from '../work-context.js'
import { bindingDraft, selectBindingDomain } from '../work-context.js'
import type { SubmissionWatchOptions } from './submission-observer.js'
import { workPointers } from './pointers.js'
import { clearPersistedView, hashToView, readPersistedView, viewKey, viewToHash, writePersistedView, type PersistedView } from './view-state.js'
import {
  availableTimeZones,
  formatDate,
  formatDateTime,
  getPreferences,
  navLabel,
  runStateText,
  setPreferences,
  subscribePreferences,
  t,
  LOCALES,
  type Locale,
} from './i18n.js'

export type { SubmissionWatchOptions } from './submission-observer.js'

export type WorkbenchView = 'works' | 'sessions' | 'projects' | 'apps' | 'pending' | 'settings'

/** Closed set used to validate a persisted view coordinate before it is applied at boot. */
const WORKBENCH_VIEWS: WorkbenchView[] = ['works', 'sessions', 'projects', 'apps', 'pending', 'settings']

/** Host session catalog exposed as an ObservableSnapshot (the uSES subscribe/getSnapshot pair). */
type SessionListSource = {
  getSnapshot(): SessionListState
  subscribe(fn: () => void): () => void
}

export interface WorkbenchPageInjected {
  /** Retain a Session for the embedded session view; returns the framework SessionProvider target. */
  retainSession(sessionId: string): SessionReference
  /** Release the view's retained reference (the embedded host returns to its session-less posture). */
  releaseSession(): void
  /** Begin enterprise correlation for a Work's bound Session (public event window only). */
  watchWorkSession(options: SubmissionWatchOptions): void
  /** Number of live submission observers (a diagnostic, never business state). */
  submissionObserverCount(): number
  /** Create a real native Session in the Work's own directory; returns the Host's session id. */
  createSession(options: { cwd?: string }): Promise<string>
  /** Observable Host session catalog (ids + summaries) backing the 历史会话 page. */
  sessionList: SessionListSource
  /** Pull the Host-authoritative session list. */
  refreshSessionList(): Promise<void>
}

export type WorkbenchPageProps =
  PropsRuntime<'main'>
  & PropsRenderSlots<'workbench.session'>
  & InjectFace<WorkbenchPageInjected>

/** Props of the embedded-session host entry: session-maybe standard seats plus the factory seat. */
type WorkbenchSessionHostProps = PropsRuntime<'workbench.session'> & PropsRenderFactories

/**
 * Host the upstream conversation factory inside the enterprise shell. The page scopes this entry
 * with the standard-kit `SessionProvider` bound to its retained reference, so these session-maybe
 * props resolve that exact Session — not the native main view, which belongs to the workspace
 * navigation and stays untouched. "No session" is the workbench landing posture, not an error. The
 * phase/hero computation mirrors upstream ConversationMainPanel: `settling` guards the blank+loading
 * replay of an already-open Session, and `hero` is the blank landing posture (no Session, freshly
 * opened, or summary-blank).
 */
export function EmbeddedSessionHost({
  sessionId, useSession, useSessions, useConversation, renderFactorySlot,
}: WorkbenchSessionHostProps) {
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : conversationPhase(session, conversation)
  const openState = session?.openState
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  const settling = sessionId !== undefined && shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true
  const hero = sessionId === undefined
    || (shellPhase === 'blank' && (openState === 'open' || summaryBlank === true))
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return (
    <div className="ec-wb-session-conversation" data-ec-embedded-session={sessionId ?? undefined}>
      {renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero })}
    </div>
  )
}

/** One native session row of the 历史会话 page, projected from the host catalog summary. */
interface SessionHistoryRow {
  sessionId: string
  title: string
  cwd?: string
  running: boolean
  updatedAt: number
}

/** 历史会话 page: the native session catalog (the host list the upstream sidebar reads), so any
 *  conversation is reachable and resumable from the workbench — bound to a Work or not
 *  (2026-11-17 product decision). Subagent-origin and blank (reusable new-session) rows are not
 *  conversations and stay out; an empty list says why it is empty instead of faking success.
 *  The catalogue is filtered, sorted and paged in the browser because the host owns the list;
 *  the page never pretends a search covered rows it did not load. */
const SESSION_PAGE = 20

function SessionsHistoryPage({ sessionList, refreshSessionList, onOpenSession }: {
  sessionList: SessionListSource
  refreshSessionList(): Promise<void>
  onOpenSession(sessionId: string, title: string): void
}) {
  const snapshot = useSyncExternalStore(sessionList.subscribe, sessionList.getSnapshot)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'running' | 'idle'>('all')
  const [sort, setSort] = useState<'recent' | 'title'>('recent')
  const [offset, setOffset] = useState(0)
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try { await refreshSessionList() } finally { setRefreshing(false) }
  }, [refreshSessionList])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { setOffset(0) }, [query, status, sort])

  const rows: SessionHistoryRow[] = useMemo(() => snapshot.ids
    .map((sessionId) => snapshot.byId[sessionId])
    .filter((summary) => summary && summary.origin !== 'subagent' && !summary.blank)
    .map((summary) => ({
      sessionId: summary.id,
      title: summary.displayTitle,
      ...(summary.cwd !== undefined ? { cwd: summary.cwd } : {}),
      running: summary.running,
      updatedAt: summary.updatedAt,
    })), [snapshot])
  const now = useMemo(() => Date.now(), [snapshot])

  const needle = query.trim().toLocaleLowerCase()
  const filtered = rows
    .filter((row) => status === 'all' || (status === 'running' ? row.running : !row.running))
    .filter((row) => needle.length === 0
      || row.title.toLocaleLowerCase().includes(needle)
      || (row.cwd ?? '').toLocaleLowerCase().includes(needle))
    .sort((left, right) => sort === 'title'
      ? left.title.localeCompare(right.title)
      : right.updatedAt - left.updatedAt)
  const range = pageWindow(filtered.length, offset, SESSION_PAGE)
  const visible = filtered.slice(range.offset, range.offset + SESSION_PAGE)

  return (
    <div className="ec-wb-page">
      <header className="ec-wb-page-head">
        <div>
          <h1>历史会话</h1>
          <p className="ec-wb-muted">全部 AI 对话目录，与平台原生界面同源。点击任意会话即可继续对话；运行记录与成果仍按工作归属平台。</p>
        </div>
        <div className="ec-wb-form-actions">
          <button type="button" className="ec-wb-button" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? '正在刷新…' : '刷新列表'}
          </button>
        </div>
      </header>
      <div className="ec-wb-session-tools">
        <div className="ec-wb-search">
          <span className="ec-wb-search-glyph" aria-hidden="true"><Glyph size={13}>{SEARCH_PATHS}</Glyph></span>
          <input className="ec-wb-input ec-wb-search-input" type="search" value={query}
            placeholder="搜索会话标题或目录" aria-label="搜索会话标题或目录"
            onChange={(event) => setQuery(event.target.value)} />
          {query ? <button type="button" className="ec-wb-search-clear" aria-label="清除搜索" onClick={() => setQuery('')}>×</button> : null}
        </div>
        <select className="ec-wb-select" aria-label="会话状态" value={status} onChange={(event) => setStatus(event.target.value as 'all' | 'running' | 'idle')}>
          <option value="all">全部状态</option>
          <option value="running">运行中</option>
          <option value="idle">空闲</option>
        </select>
        <select className="ec-wb-select" aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value as 'recent' | 'title')}>
          <option value="recent">最近活动</option>
          <option value="title">标题</option>
        </select>
        <span className="ec-wb-muted" role="status" aria-live="polite">
          {filtered.length === rows.length ? `${rows.length} 个会话` : `筛选出 ${filtered.length} / ${rows.length} 个会话`}
        </span>
      </div>
      {snapshot.phase === 'pending'
        ? <p className="ec-wb-muted" role="status">正在读取会话列表…</p>
        : rows.length === 0
          ? (
            <div className="ec-wb-queue-empty">
              <p className="ec-wb-empty">
                {snapshot.ids.length === 0
                  ? '还没有任何对话记录。在工作里发起对话后，这里会列出它们。'
                  : `已发现 ${snapshot.ids.length} 个会话条目，但还没有可继续的对话（其余为空白或子代理会话）。`}
              </p>
            </div>
          )
          : filtered.length === 0
            ? <p className="ec-wb-empty">没有匹配的会话；清除搜索或状态筛选后再看。</p>
            : (
              <div className="ec-wb-table" role="table" aria-label="历史会话">
                <div className="ec-wb-table-head" role="row">
                  <span role="columnheader">会话</span>
                  <span role="columnheader">状态</span>
                  <span role="columnheader">最近活动</span>
                  <span role="columnheader"><span className="ec-wb-sr">操作</span></span>
                </div>
                {visible.map((row) => (
                  <div className="ec-wb-work-row" role="row" key={row.sessionId}>
                    <span className="ec-wb-work-name" role="cell">
                      <span className="ec-wb-work-icon" aria-hidden="true">{monogram(row.title)}</span>
                      <button type="button" className="ec-wb-work-open"
                        onClick={() => onOpenSession(row.sessionId, row.title)}>
                        <strong>{row.title}</strong>
                        {row.cwd ? <small>{row.cwd}</small> : <small className="ec-wb-sr">（无工作目录）</small>}
                      </button>
                    </span>
                    <span role="cell">
                      <span className="ec-wb-state" data-tone={row.running ? 'ok' : 'muted'}>{row.running ? '运行中' : '空闲'}</span>
                    </span>
                    <span className="ec-wb-updated" role="cell">{relativeTime(row.updatedAt, now)}</span>
                    <span className="ec-wb-work-tail" role="cell">
                      <button type="button" className="ec-wb-button ec-wb-primary"
                        aria-label={`打开会话 ${row.title}`}
                        onClick={() => onOpenSession(row.sessionId, row.title)}>{t('action.openSession')}</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
      <Pager total={filtered.length} offset={range.offset} limit={SESSION_PAGE} busy={refreshing}
        onOffset={(next) => setOffset(next)} />
      <div className="ec-wb-queue-foot">
        <i aria-hidden="true" />
        <span aria-live="polite">{filtered.length} 个会话</span>
        <i aria-hidden="true" />
      </div>
    </div>
  )
}

/** Console chrome for a session opened from 历史会话 (no Work context: no run rail, no correlation —
 *  plain native Q&A; enterprise correlation only ever rides a Work's binding). */
function HistoryConsole({ title, onBack, children }: {
  title: string
  onBack(): void
  children: ReactNode
}) {
  return (
    <div className="ec-wb-console">
      <header className="ec-wb-console-head">
        <div>
          <div className="ec-wb-console-crumb">
            <button type="button" className="ec-wb-back-link" onClick={onBack}>← 返回</button>
            <span>历史会话</span>
            <span aria-hidden="true">·</span>
            <span>{title}</span>
          </div>
          <div className="ec-wb-console-title-row">
            <h2 className="ec-wb-console-title">{title}</h2>
            <span className="ec-wb-pill" data-tone="muted">未绑定工作</span>
          </div>
        </div>
        <div className="ec-wb-console-actions">
          <button type="button" className="ec-wb-button" onClick={onBack}>返回列表</button>
        </div>
      </header>
      <div className="ec-wb-console-body">
        <div className="ec-wb-console-thread">{children}</div>
      </div>
    </div>
  )
}

const API_BASE = '/platform-workbench'
const RUN_PAGE = 10
const ARTIFACT_PAGE = 10
const INPUT_PAGE = 10
const BASELINE_PAGE = 10
const COMPACT_KEY = 'emerald.workbench.compact'
const EXPERT_KEY = 'emerald.workbench.expert'

/** Control-plane label for one activity kind; unknown kinds render as themselves, never dropped. */
const activityKindLabel = (kind: RunActivity['kind']): string => {
  switch (kind) {
    case 'text': return '回复'
    case 'reasoning': return '思考'
    case 'tool-call': return '工具调用'
    case 'tool-result': return '工具结果'
    case 'status': return '状态'
    default: return kind
  }
}

/** Human label for a run-input commit state; an unknown value renders as itself, never dropped. */
const INPUT_STATE_LABELS: Record<string, string> = {
  PENDING: '待消费', CONSUMED: '已消费', UNKNOWN: '未知', NOT_SENT: '未发送', DEFERRED: '已推迟',
}
const inputStateLabel = (state: string): string => INPUT_STATE_LABELS[state] ?? state

/** The run transcript: what the model actually did while this run executed, as the control plane
 *  observed it through public SDK notifications. This is the run's history — a selected run shows
 *  this, not the (possibly blank) bound session. Activities are projections of the current
 *  attempt: a control-plane restart loses them, and the empty state says so. */
function RunTranscript({ api, runId, token, onRetryError }: {
  api: WorkbenchApi
  runId: string
  /** Console refresh token; re-reads the transcript so a live run's window grows. */
  token: number
  onRetryError(): void
}) {
  const [detail, setDetail] = useState<{ result: RunDetail['result']; activities: RunActivity[] } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    setLoading(true)
    void (async () => {
      try {
        const record = await api.runDetail(runId)
        if (!live) return
        setDetail({ result: record.result, activities: record.activities ?? [] })
        setLoadError('')
      } catch (reason) {
        if (!live) return
        setDetail(null)
        setLoadError(errorText(reason))
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [api, runId, token])

  const activities = detail?.activities ?? []
  const finalResponse = detail?.result?.finalResponse ?? ''
  // The final response usually repeats the last text activity; surface it only when it adds content.
  const lastText = [...activities].reverse().find((activity) => activity.kind === 'text')?.text ?? ''
  const showFinal = finalResponse !== '' && finalResponse !== lastText

  return (
    <div className="ec-wb-transcript" data-ec-run-transcript={runId}>
      <div className="ec-wb-transcript-body">
        {loadError
          ? <ErrorBox message={`无法读取运行记录：${loadError}`} onRetry={onRetryError} />
          : loading && detail === null
            ? <p className="ec-wb-muted" role="status">正在读取运行记录…</p>
            : activities.length === 0 && !showFinal
              ? (
                <p className="ec-wb-empty">
                  该运行没有已记录的活动或结果文本。活动仅采集运行期间控制面收到的公开模型通知；
                  控制面重启后历史窗口缺席，运行状态与封存成果不受影响。
                </p>
              )
              : (
                <>
                  {activities.map((activity, index) => (
                    <article className={`ec-wb-transcript-item is-${activity.kind}`} key={`${activity.createdAt}-${index}`}>
                      <header>
                        <span className="ec-wb-transcript-kind" data-kind={activity.kind}>{activityKindLabel(activity.kind)}</span>
                        <time>{formatTime(activity.createdAt)}</time>
                      </header>
                      <p>{activity.text}</p>
                      {activity.detail ? <pre>{activity.detail}</pre> : null}
                    </article>
                  ))}
                  {showFinal
                    ? (
                      <article className="ec-wb-transcript-item is-final">
                        <header>
                          <span className="ec-wb-transcript-kind" data-kind="text">最终回复</span>
                          {detail?.result?.at ? <time>{formatTime(detail.result.at)}</time> : null}
                        </header>
                        <p>{finalResponse}</p>
                      </article>
                    )
                    : null}
                </>
              )}
      </div>
    </div>
  )
}

const errorText = (reason: unknown): string => {
  if (reason instanceof PlatformApiError) return reason.message
  return reason instanceof Error ? reason.message : 'WORKBENCH_UNAVAILABLE'
}

const readCompact = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(COMPACT_KEY) === '1'
  } catch {
    return false
  }
}

const writeCompact = (value: boolean): void => {
  try {
    globalThis.localStorage?.setItem(COMPACT_KEY, value ? '1' : '0')
  } catch {
    // A storage-restricted shell keeps the in-memory choice only; no business data is written.
  }
}

/** Expert diagnostics mode: reveals raw infrastructure facts (paths, session ids, digests) that the
 *  business-facing view hides by default. A display preference only — never an authorization. */
const readExpert = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(EXPERT_KEY) === '1'
  } catch {
    return false
  }
}

const writeExpert = (value: boolean): void => {
  try {
    globalThis.localStorage?.setItem(EXPERT_KEY, value ? '1' : '0')
  } catch {
    // A storage-restricted shell keeps the in-memory choice only.
  }
}

/** One inline stroke icon, drawn on the 24 grid with round joins — the shell's own pictogram set,
 *  kept in-tree so the page carries no icon-font or webfont dependency. */
const Glyph = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
)

const GLYPH_REFRESH = <Glyph><path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" /></Glyph>
const GLYPH_DENSITY = <Glyph><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></Glyph>
const SETTINGS_PATHS = (
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6" />
  </>
)
const SEARCH_PATHS = (
  <>
    <circle cx="11" cy="11" r="6.5" />
    <line x1="16" y1="16" x2="21" y2="21" />
  </>
)
const GLYPH_SETTINGS = <Glyph>{SETTINGS_PATHS}</Glyph>
const GLYPH_CHECK = <Glyph size={11}><polyline points="4 12.5 9 17.5 20 6.5" /></Glyph>
const GLYPH_SEARCH_TOP = <Glyph size={16}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.2" y2="16.2" /></Glyph>
const GLYPH_SPARK = <Glyph size={19}><path d="M12 3.5 14.6 9.4 20.5 12 14.6 14.6 12 20.5 9.4 14.6 3.5 12 9.4 9.4Z" /></Glyph>

/** The brand mark: a faceted emerald, drawn — not a text glyph. */
const BRAND_MARK = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 2.5 19.5 9 12 21.5 4.5 9Z" />
    <path d="M4.5 9h15" />
    <path d="M12 2.5 9.2 9l2.8 12.5L14.8 9 12 2.5" />
  </svg>
)

/** Today's date as the home eyebrow; the platform records no "business day", so this is local time. */
function todayLabel(now: number): string {
  return formatDate(now)
}

/** Display name of the model a new run would use, or '' when the platform registered none. */
function defaultModelLabel(models: WorkbenchBootstrap['models']): string {
  const selected = chosenModel(models?.catalog, models?.preference)
  return modelChoices(models?.catalog, models?.preference).find((choice) => choice.selectionId === selected)?.label ?? ''
}

/** Newest activity first; Works without a recorded time keep the control plane's own order last. */
function byRecent(works: readonly WorkbenchItem[]): WorkbenchItem[] {
  return [...works].sort((left, right) => {
    const a = left.updatedAt ? new Date(left.updatedAt).getTime() : Number.NaN
    const b = right.updatedAt ? new Date(right.updatedAt).getTime() : Number.NaN
    if (Number.isFinite(a) && Number.isFinite(b)) return b - a
    if (Number.isFinite(a)) return -1
    if (Number.isFinite(b)) return 1
    return 0
  })
}

function Pager({ total, offset, limit, busy, onOffset }: {
  total: number
  offset: number
  limit: number
  busy: boolean
  onOffset(offset: number): void
}) {
  const range = pageWindow(total, offset, limit)
  if (range.total <= range.limit) return null
  return (
    <nav className="ec-wb-pager" aria-label="分页">
      <button type="button" className="ec-wb-button" disabled={!range.hasPrevious || busy}
        onClick={() => onOffset(Math.max(0, range.offset - range.limit))}>上一页</button>
      <span>第 {range.first}–{range.last} 项，共 {range.total} 项（第 {range.page}/{range.pages} 页）</span>
      <button type="button" className="ec-wb-button" disabled={!range.hasNext || busy}
        onClick={() => onOffset(range.offset + range.limit)}>下一页</button>
    </nav>
  )
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?(): void }) {
  return (
    <div className="ec-wb-error" role="alert">
      <p>{message}</p>
      {onRetry ? <button type="button" className="ec-wb-button" onClick={onRetry}>重试</button> : null}
    </div>
  )
}

function StateBadge({ state }: { state: unknown }) {
  return <span className="ec-wb-badge" data-tone={runTone(state)}>{runStateText(state)}</span>
}

function formatTime(value: unknown): string {
  return formatDateTime(value, getPreferences(), getPreferences().locale === 'en-US' ? 'Time not recorded' : '时间未记录')
}

/** Re-render the shell when the employee changes language or time zone. */
function usePreferences(): ReturnType<typeof getPreferences> {
  return useSyncExternalStore(subscribePreferences, getPreferences)
}

/** One verified artifact save shared by the detail page and the console rail: a failed fetch is
 *  reported as a failure and never saved under the artifact's name. */
async function saveArtifact(runId: string, name: string): Promise<void> {
  const res = await fetch(`${API_BASE}${artifactDownloadPath(runId, name)}`, { credentials: 'include' })
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { code?: string } | null
    throw new Error(detail?.code ?? `HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** Freshness line: the time the facts on screen were last read from the control plane. */
function Freshness({ at, busy, onRefresh }: { at: number | null; busy?: boolean; onRefresh(): void }) {
  return (
    <span className="ec-wb-freshness" role="status" aria-live="polite">
      {at ? `${t('label.lastUpdated')} ${formatTime(new Date(at).toISOString())}` : ''}
      {busy ? ' · 正在同步…' : ''}
      <button type="button" onClick={onRefresh}>{t('action.refresh')}</button>
    </span>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="ec-wb-field">
      <span className="ec-wb-field-label">{label}</span>
      {children}
      {hint ? <small className="ec-wb-muted">{hint}</small> : null}
    </label>
  )
}

function ModelSelect({ catalog, preference, value, onChange, disabled }: {
  catalog: ModelCatalog | null | undefined
  preference: ModelPreference | null | undefined
  value: string
  onChange(value: string): void
  disabled?: boolean
}) {
  const choices = modelChoices(catalog, preference)
  if (choices.length === 0) {
    return <p className="ec-wb-empty">平台尚未登记模型目录；创建运行前需要部署登记模型，工作台不会编造模型。</p>
  }
  return (
    <select className="ec-wb-select" aria-label="模型" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {!choices.some((choice) => choice.selectionId === value && choice.available)
        ? <option value="">请选择可用模型</option>
        : null}
      {choices.map((choice) => (
        <option key={choice.selectionId} value={choice.selectionId} disabled={!choice.available}>
          {choice.label}{choice.available ? '' : `（不可用${choice.unavailableReason ? `：${choice.unavailableReason}` : ''}）`}
        </option>
      ))}
    </select>
  )
}

// ── Shared data blocks ───────────────────────────────────────────────────────

function ModelDefaultPanel({ api, catalog, preference, onReload }: {
  api: WorkbenchApi
  catalog: ModelCatalog | null | undefined
  preference: ModelPreference | null | undefined
  onReload(): Promise<void>
}) {
  const [value, setValue] = useState(() => chosenModel(catalog, preference) ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => { setValue(chosenModel(catalog, preference) ?? '') }, [catalog, preference])

  const save = async () => {
    if (!value) { setMessage('请选择可用模型。'); return }
    setBusy(true)
    setMessage('')
    try {
      await api.setModelPreference(value)
      await onReload()
      setMessage('默认模型已保存；它只影响后续新运行，不改写已冻结的记录。')
    } catch (reason) {
      setMessage(`默认模型未保存：${errorText(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-model">
      <div className="ec-wb-card-head"><h2 id="ec-wb-model">执行模型</h2></div>
      <p className="ec-wb-muted">默认值只影响你自己的后续新运行；已创建的运行保留创建时冻结的模型。</p>
      <div className="ec-wb-form-actions">
        <ModelSelect catalog={catalog} preference={preference} value={value} onChange={setValue} disabled={busy} />
        <button type="button" className="ec-wb-button" disabled={busy || !value} onClick={() => void save()}>设为默认</button>
      </div>
      {preference?.reason ? <p className="ec-wb-muted">{preference.reason}</p> : null}
      {message ? <p className="ec-wb-muted" role="status">{message}</p> : null}
    </section>
  )
}

/** Titles of Works that are named by a pending item but sit outside the loaded page. One
 *  bounded context read per such Work, so the "需要你处理" list can name what it is asking about. */
function usePendingWorkTitles(
  api: WorkbenchApi,
  items: Array<{ workId: string | null }>,
  works: WorkbenchItem[],
): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({})
  const known = new Set(works.map((work) => work.workId))
  const missing = [...new Set(items
    .map((item) => item.workId)
    .filter((id): id is string => typeof id === 'string' && !known.has(id) && !(id in titles)))]
  const key = missing.join(',')
  useEffect(() => {
    if (!key) return undefined
    let live = true
    void Promise.all(key.split(',').map(async (id) => {
      try {
        return [id, (await api.workContext(id)).work.title] as const
      } catch {
        return null
      }
    })).then((pairs) => {
      if (!live) return
      const next: Record<string, string> = {}
      for (const pair of pairs) if (pair) next[pair[0]] = pair[1]
      if (Object.keys(next).length > 0) setTitles((previous) => ({ ...previous, ...next }))
    })
    return () => { live = false }
  }, [key, api])
  return titles
}

/** E3-4 unified todos keep their source kind and their own resolution verb — the list never
 *  blurs a review decision or a receipt into "a question to answer". */
const TODO_KINDS: Record<'question' | 'review' | 'delivery-receipt', { label: string; verb: string }> = {
  question: { label: '问题答复', verb: '回答' },
  review: { label: '交付复核', verb: '决定' },
  'delivery-receipt': { label: '交付接收', verb: '确认接收' },
}
type TodoItem = NonNullable<WorkbenchBootstrap['todos']>[number]

type SearchHit = Awaited<ReturnType<WorkbenchApi['search']>>[number]
const SEARCH_KIND_LABEL: Record<SearchHit['kind'], string> = { work: '工作', run: '运行', project: '项目', app: '应用' }

/** E4-6 command palette: one keyboard surface over the global search. Hits open by the same
 *  navigation they have elsewhere; the server owns matching, the palette only picks. */
function CommandPalette({ api, open, onClose, onOpenWork, onOpenRun, onNavigate }: {
  api: WorkbenchApi
  open: boolean
  onClose(): void
  onOpenWork(workId: string): void
  onOpenRun(workId: string, runId: string): void
  onNavigate(view: WorkbenchView): void
}) {
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    setTerm(''); setHits([]); setError(''); setActive(0)
    // E4-4 focus management: the palette takes focus when it opens and hands it back to the
    // trigger when it closes, so keyboard users are never stranded inside the overlay.
    const previous = document.activeElement as HTMLElement | null
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => {
      clearTimeout(timer)
      previous?.focus?.()
    }
  }, [open])

  useEffect(() => {
    const trimmed = term.trim()
    if (!open || !trimmed) { setHits([]); return undefined }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setBusy(true)
      api.search(trimmed, controller.signal)
        .then((items) => {
          if (controller.signal.aborted) return
          setHits(items); setActive(0); setError('')
        })
        .catch((reason) => {
          if (!controller.signal.aborted && (reason as Error)?.name !== 'AbortError') setError(errorText(reason))
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false)
        })
    }, 200)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [term, open, api])

  if (!open) return null
  const openHit = (hit: SearchHit) => {
    onClose()
    if (hit.kind === 'work' && hit.workId) onOpenWork(hit.workId)
    else if (hit.kind === 'run' && hit.workId && hit.runId) onOpenRun(hit.workId, hit.runId)
    else if (hit.kind === 'project') onNavigate('projects')
    else if (hit.kind === 'app') onNavigate('apps')
  }
  return (
    <div className="ec-wb-palette-backdrop" onClick={onClose}>
      <div className="ec-wb-palette" role="dialog" aria-modal="true" aria-label="全局搜索" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="ec-wb-input ec-wb-palette-input"
          type="search"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="ec-wb-palette-list"
          aria-activedescendant={hits[active] ? `ec-wb-palette-opt-${active}` : undefined}
          aria-label="搜索工作、运行、项目或应用"
          placeholder="搜索工作、运行、项目或应用"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(value + 1, hits.length - 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)) }
            else if (event.key === 'Enter' && hits[active]) { event.preventDefault(); openHit(hits[active]) }
            else if (event.key === 'Escape') onClose()
          }}
        />
        {error ? <p className="ec-wb-error-text ec-wb-palette-note" role="alert">{error}</p> : null}
        {term.trim() && !error && hits.length === 0
          ? <p className="ec-wb-muted ec-wb-palette-note">{busy ? '正在搜索…' : '没有匹配项。'}</p>
          : null}
        {hits.length > 0 ? (
          <ul className="ec-wb-palette-list" id="ec-wb-palette-list" role="listbox" aria-label="搜索结果">
            {hits.map((hit, index) => (
              <li
                key={`${hit.kind}:${hit.id}`}
                id={`ec-wb-palette-opt-${index}`}
                role="option"
                aria-selected={index === active}
                className={`ec-wb-palette-hit${index === active ? ' is-active' : ''}`}
                tabIndex={-1}
                onMouseEnter={() => setActive(index)}
                onClick={() => openHit(hit)}
              >
                <span className="ec-wb-badge">{SEARCH_KIND_LABEL[hit.kind]}</span>
                <span className="ec-wb-palette-hit-main"><strong>{hit.title}</strong><small className="ec-wb-muted">{hit.detail}</small></span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="ec-wb-muted ec-wb-palette-note">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
      </div>
    </div>
  )
}

/** Unified todo rows (E3-4). Each row names its kind, the concrete act that resolves it and when
 *  it started waiting; clicking opens the Work's run where that act happens. */
function UnifiedTodoList({ items, works, titles, onOpen }: {
  items: TodoItem[]
  works: WorkbenchItem[]
  titles?: Record<string, string>
  onOpen(workId: string, runId: string): void
}) {
  if (items.length === 0) return <p className="ec-wb-empty">当前没有待处理事项。</p>
  return (
    <div className="ec-wb-rows">
      {items.map((item) => {
        const work = works.find((candidate) => candidate.workId === item.workId)
        const title = work?.title ?? (item.workId ? titles?.[item.workId] : undefined) ?? `工作 ${String(item.workId ?? '').slice(0, 8)}`
        const kind = TODO_KINDS[item.kind]
        return (
          <button
            type="button"
            className="ec-wb-row-button"
            key={`${item.kind}:${item.id}`}
            disabled={!item.workId || !item.runId}
            onClick={() => { if (item.workId && item.runId) onOpen(item.workId, item.runId) }}
          >
            <span className="ec-wb-row-main">
              <strong><span className="ec-wb-badge" data-tone={item.kind === 'question' ? 'warn' : undefined}>{kind.label}</span> {title}</strong>
              <small className="ec-wb-muted">{item.summary} · {formatTime(item.createdAt)}</small>
            </span>
            <span className="ec-wb-muted">{work ? `${kind.verb} ›` : '打开 ›'}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── New work / project ───────────────────────────────────────────────────────

function NewWorkForm({ api, data, initialProjectId, initialAppKey, onCreated, onReload, onCancel }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  /** Project chosen on the home launch panel; falls back to the first visible project. */
  initialProjectId?: string
  /** Application chosen by a quick target (`appId|appVersion`); falls back to the first active one. */
  initialAppKey?: string
  onCreated(work: WorkbenchItem): void
  onReload(): Promise<void>
  onCancel(): void
}) {
  const projects = data.projects ?? []
  const apps = (data.apps ?? []).filter((app) => app.state === 'ACTIVE')
  const [projectId, setProjectId] = useState(() =>
    projects.some((project) => project.projectId === initialProjectId) ? initialProjectId ?? '' : projects[0]?.projectId ?? '')
  const [workspaceId, setWorkspaceId] = useState('')
  const [spaces, setSpaces] = useState<WorkspaceItem[] | null>(null)
  const [spacesError, setSpacesError] = useState('')
  const [appKey, setAppKey] = useState(() =>
    apps.some((app) => `${app.appId}|${app.appVersion}` === initialAppKey)
      ? initialAppKey ?? ''
      : apps[0] ? `${apps[0].appId}|${apps[0].appVersion}` : '')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [spaceName, setSpaceName] = useState('')
  const [spaceDirectory, setSpaceDirectory] = useState('')
  const [step, setStep] = useState(0)
  const [newProjectName, setNewProjectName] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)
  const [createdProjects, setCreatedProjects] = useState<Array<{ projectId: string; name: string }>>([])
  const [spaceFormOpen, setSpaceFormOpen] = useState(false)

  const loadSpaces = useCallback(async (id: string) => {
    if (!id) { setSpaces([]); return }
    setSpacesError('')
    try {
      const result = await api.projectWorkspaces(id)
      setSpaces(result.items)
      setWorkspaceId((previous) => result.items.some((item) => item.workspaceId === previous)
        ? previous
        : result.items[0]?.workspaceId ?? '')
    } catch (reason) {
      setSpaces(null)
      setSpacesError(errorText(reason))
    }
  }, [api])

  // The launch panel above stays usable while the form is open: changing its project or a quick
  // target retargets this form without discarding what the employee already typed.
  useEffect(() => { if (initialProjectId) setProjectId(initialProjectId) }, [initialProjectId])
  useEffect(() => { if (initialAppKey) setAppKey(initialAppKey) }, [initialAppKey])

  useEffect(() => { void loadSpaces(projectId) }, [projectId, loadSpaces])
  // A project with no directory cannot proceed, so its registration form opens by itself; the
  // employee can still close it once the project actually has one.
  useEffect(() => { if (spaces && spaces.length === 0) setSpaceFormOpen(true) }, [spaces])

  const selectedApp = apps.find((app) => `${app.appId}|${app.appVersion}` === appKey)
  const canSubmit = !!projectId && !!workspaceId && !!selectedApp && title.trim().length > 0 && !busy
  const projectOptions = [
    ...projects,
    ...createdProjects.filter((created) => !projects.some((project) => project.projectId === created.projectId)),
  ]

  /** Keep typed content from vanishing on a reload: the wizard warns before leaving unfinished work. */
  const dirty = Boolean(title.trim() || goal.trim() || spaceName.trim() || spaceDirectory.trim() || newProjectName.trim())
  useEffect(() => {
    if (!dirty) return undefined
    const handler = (event: Event): void => {
      event.preventDefault()
      ;(event as unknown as { returnValue?: string }).returnValue = ''
    }
    globalThis.addEventListener?.('beforeunload', handler)
    return () => globalThis.removeEventListener?.('beforeunload', handler)
  }, [dirty])

  const registerSpace = async () => {
    if (!projectId) { setError('请先选择项目。'); return }
    if (!spaceName.trim() || !spaceDirectory.trim()) { setError('登记工作空间需要名称和目录。'); return }
    setBusy(true)
    setError('')
    try {
      const created = await api.createWorkspace(projectId, { name: spaceName.trim(), directory: spaceDirectory.trim() })
      setSpaceName('')
      setSpaceDirectory('')
      await loadSpaces(projectId)
      setWorkspaceId(created.workspaceId)
      setNotice('工作空间已登记。目录由部署侧校验，工作台只记录路径。')
    } catch (reason) {
      setError(`登记工作空间失败：${errorText(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const createInlineProject = async () => {
    const name = newProjectName.trim()
    if (!name) { setError('请填写项目名称。'); return }
    setCreatingProject(true)
    setError('')
    setNotice('')
    try {
      const created = await api.createProject({ name })
      setCreatedProjects((previous) => [...previous, { projectId: created.projectId, name: created.name }])
      setProjectId(created.projectId)
      setNewProjectName('')
      await loadSpaces(created.projectId)
      await onReload()
      setNotice('项目已创建。下一步选择工作目录。')
    } catch (reason) {
      setError(`创建项目失败：${errorText(reason)}`)
    } finally {
      setCreatingProject(false)
    }
  }

  const stepValid = (index: number): boolean =>
    index === 0 ? !!projectId
      : index === 1 ? !!selectedApp
        : index === 2 ? !!workspaceId
          : index === 3 ? title.trim().length > 0
            : canSubmit
  const goNext = () => {
    if (!stepValid(step)) {
      setError(step === 0 ? '请先选择或创建项目。'
        : step === 1 ? '请选择一个应用。'
          : step === 2 ? '请选择或登记一个工作目录。'
            : '请填写工作标题。')
      return
    }
    setError('')
    setStep((value) => Math.min(value + 1, 4))
  }
  // Steps are clickable: a step is reachable once every prior step is valid, so an employee can jump
  // back to fix an earlier choice or skip ahead when ready, instead of only Next/Previous.
  const reachable = (index: number): boolean => {
    for (let i = 0; i < index; i += 1) if (!stepValid(i)) return false
    return true
  }
  const goToStep = (index: number): void => { if (reachable(index)) { setError(''); setStep(index) } }

  const submit = async () => {
    if (!selectedApp) { setError('请选择应用。'); return }
    if (!workspaceId) { setError('请选择或登记工作空间。'); return }
    if (!title.trim()) { setError('请填写工作标题。'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const created = await api.createWork({
        projectId,
        workspaceId,
        appId: selectedApp.appId,
        appVersion: selectedApp.appVersion,
        title: title.trim(),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      })
      setTitle('')
      setGoal('')
      setStep(0)
      await onReload()
      onCreated(created)
      setNotice('工作已创建，正在准备对话；也可以打开详情发起运行。')
    } catch (reason) {
      setError(`创建工作失败：${errorText(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ec-wb-card ec-wb-form" aria-labelledby="ec-wb-new">
      <div className="ec-wb-card-head">
        <h2 id="ec-wb-new">新建工作</h2>
        <span className="ec-wb-badge">{step + 1} / 5</span>
      </div>
      <p className="ec-wb-muted">按步骤选择项目、应用和工作目录，再写清目标。创建只记录企业意图；打开工作后即可对话。</p>
      <ol className="ec-wb-stepbar" aria-label="新建工作步骤">
        {['项目', '应用', '工作目录', '目标', '确认'].map((label, index) => (
          <li key={label} aria-current={index === step ? 'step' : undefined} data-done={index < step ? 'true' : undefined}>
            <button type="button" className="ec-wb-step-button" disabled={!reachable(index)}
              onClick={() => goToStep(index)}>{index + 1}. {label}</button>
          </li>
        ))}
      </ol>
      <div className="ec-wb-wizard">
        {step === 0
          ? (
            <>
              {projectOptions.length === 0
                ? <p className="ec-wb-empty">还没有项目；可以先在下方创建一个。</p>
                : (
                  <Field label="项目">
                    <select className="ec-wb-select" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                      {projectOptions.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
                    </select>
                  </Field>
                )}
              <div className="ec-wb-subform">
                <h3>新建项目</h3>
                <div className="ec-wb-grid">
                  <Field label="项目名称">
                    <input className="ec-wb-input" value={newProjectName} maxLength={200}
                      onChange={(event) => setNewProjectName(event.target.value)} />
                  </Field>
                </div>
                <button type="button" className="ec-wb-button" disabled={creatingProject || !newProjectName.trim()}
                  onClick={() => void createInlineProject()}>
                  {creatingProject ? '创建中…' : '创建项目'}
                </button>
              </div>
            </>
          )
          : null}
        {step === 1
          ? (
            <Field label="应用" hint={selectedApp?.descriptor?.listingTypes?.length ? `该应用声明场景：${selectedApp.descriptor.listingTypes.join(' / ')}；场景在发起运行时选择` : '应用来自平台已发布目录；员工的日常问答不使用应用也可以进行。'}>
              {apps.length === 0
                ? <p className="ec-wb-empty">当前没有可用的应用发布；请联系平台管理员登记。</p>
                : (
                  <select className="ec-wb-select" value={appKey} onChange={(event) => setAppKey(event.target.value)}>
                    {apps.map((app) => (
                      <option key={`${app.appId}@${app.appVersion}`} value={`${app.appId}|${app.appVersion}`}>
                        {app.descriptor?.displayName ?? app.displayName ?? app.appId} @{app.appVersion}
                      </option>
                    ))}
                  </select>
                )}
            </Field>
          )
          : null}
        {step === 2
          ? (
            <>
              <Field label="工作目录" hint="目录是执行主机上的真实位置；工作台只记录路径，不读取内容。">
                {spacesError
                  ? <ErrorBox message={`无法读取工作目录：${spacesError}`} onRetry={() => void loadSpaces(projectId)} />
                  : spaces === null
                    ? <p className="ec-wb-muted">正在读取工作目录…</p>
                    : spaces.length === 0
                      ? <p className="ec-wb-empty">该项目还没有工作目录；请在下方登记一个。</p>
                      : (
                        <select className="ec-wb-select" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
                          {spaces.map((space) => <option key={space.workspaceId} value={space.workspaceId}>{space.name} — {space.directory}</option>)}
                        </select>
                      )}
              </Field>
              <details className="ec-wb-subform" open={spaceFormOpen}
                onToggle={(event) => setSpaceFormOpen((event.currentTarget as HTMLDetailsElement).open)}>
                <summary>登记新的工作目录（需要执行主机上的绝对路径）</summary>
                <div className="ec-wb-grid">
                  <Field label="目录名称">
                    <input className="ec-wb-input" value={spaceName} maxLength={200} onChange={(event) => setSpaceName(event.target.value)} />
                  </Field>
                  <Field label="绝对路径">
                    <input className="ec-wb-input" value={spaceDirectory} maxLength={500} onChange={(event) => setSpaceDirectory(event.target.value)} />
                  </Field>
                </div>
                <button type="button" className="ec-wb-button" disabled={busy} onClick={() => void registerSpace()}>
                  {busy ? '登记中…' : '登记目录'}
                </button>
              </details>
            </>
          )
          : null}
        {step === 3
          ? (
            <div className="ec-wb-grid">
              <Field label="工作标题" hint="用于工作列表和对话标题，简短即可。">
                <input className="ec-wb-input" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
              </Field>
              <Field label="完整工作目标" hint="可以写多段背景、资料位置和验收要求；AI 会按目标自主规划。">
                <textarea className="ec-wb-textarea" rows={5} value={goal} maxLength={10_000} onChange={(event) => setGoal(event.target.value)} />
              </Field>
            </div>
          )
          : null}
        {step === 4
          ? (
            <dl className="ec-wb-facts">
              <dt>项目</dt><dd>{projectOptions.find((project) => project.projectId === projectId)?.name ?? '未选择'}</dd>
              <dt>应用</dt><dd>{selectedApp ? `${selectedApp.descriptor?.displayName ?? selectedApp.displayName ?? selectedApp.appId} @${selectedApp.appVersion}` : '未选择'}</dd>
              <dt>工作目录</dt><dd>{spaces?.find((space) => space.workspaceId === workspaceId)?.directory ?? '未选择'}</dd>
              <dt>标题</dt><dd>{title.trim() || '未填写'}</dd>
              <dt>目标</dt><dd>{goal.trim() || '未填写（可在对话中补充）'}</dd>
            </dl>
          )
          : null}
      </div>
      {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
      <div className="ec-wb-wizard-actions">
        <button type="button" className="ec-wb-button" disabled={busy} onClick={onCancel}>
          {t('action.cancel')}
        </button>
        <button type="button" className="ec-wb-button" disabled={step === 0 || busy}
          onClick={() => { setError(''); setStep((value) => Math.max(0, value - 1)) }}>
          {t('action.previous')}
        </button>
        {step < 4
          ? (
            <button type="button" className="ec-wb-button ec-wb-primary" disabled={busy} onClick={goNext}>
              {t('action.next')}
            </button>
          )
          : (
            <button type="button" className="ec-wb-button ec-wb-primary" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? '提交中…' : t('action.create')}
            </button>
          )}
      </div>
    </section>
  )
}

function CreateProjectForm({ api, onCreated }: {
  api: WorkbenchApi
  onCreated(projectId: string): Promise<void>
}) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const submit = async () => {
    if (!name.trim()) { setError('请填写项目名称。'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const created = await api.createProject({ name: name.trim(), ...(code.trim() ? { code: code.trim() } : {}) })
      setName('')
      setCode('')
      await onCreated(created.projectId)
      setNotice('项目已创建。接下来登记执行主机上的工作空间。')
    } catch (reason) {
      setError(`创建项目失败：${errorText(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ec-wb-card ec-wb-form" aria-labelledby="ec-wb-new-project">
      <div className="ec-wb-card-head"><h2 id="ec-wb-new-project">新建项目</h2></div>
      <p className="ec-wb-muted">项目组织工作与空间；创建后需要登记执行主机上的目录才能发起运行。</p>
      <div className="ec-wb-grid">
        <Field label="项目名称">
          <input className="ec-wb-input" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="项目编号（可选）">
          <input className="ec-wb-input" value={code} maxLength={200} onChange={(event) => setCode(event.target.value)} />
        </Field>
      </div>
      {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
      <div className="ec-wb-form-actions">
        <button type="button" className="ec-wb-button ec-wb-primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
          {busy ? '提交中…' : '创建项目'}
        </button>
      </div>
    </section>
  )
}

// ── Work detail ──────────────────────────────────────────────────────────────

function DraftPanel({ api, workId, onUseDraft }: {
  api: WorkbenchApi
  workId: string
  onUseDraft(text: string): void
}) {
  const [text, setText] = useState('')
  const [revision, setRevision] = useState(0)
  const [savedText, setSavedText] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'conflict' | 'error'>('loading')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    setState('loading')
    setMessage('')
    try {
      const draft = await api.workDraft(workId)
      setText(draft.text ?? '')
      setSavedText(draft.text ?? '')
      setRevision(draft.revision ?? 0)
      setState('ready')
    } catch (reason) {
      setState('error')
      setMessage(errorText(reason))
    }
  }, [api, workId])

  useEffect(() => { void load() }, [load])

  const dirty = text !== savedText

  const save = async () => {
    if (!dirty) return
    setState('saving')
    setMessage('')
    const current = text
    try {
      const saved = await api.saveWorkDraft(workId, current, revision)
      setRevision(saved.revision)
      setSavedText(current)
      setState('ready')
    } catch (reason) {
      if (reason instanceof PlatformApiError && (reason.status === 409 || /REVISION_STALE/.test(reason.code))) {
        setState('conflict')
        setMessage('草稿已在另一窗口更新。本地文字保留，请复制后重新载入。')
      } else {
        setState('error')
        setMessage(`草稿未保存：${errorText(reason)}`)
      }
    }
  }

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-draft">
      <div className="ec-wb-card-head"><h2 id="ec-wb-draft">工作草稿</h2></div>
      <p className="ec-wb-muted">草稿按员工和工作分别保存，带版本检查；它不会自动发起运行。</p>
      {state === 'loading'
        ? <p className="ec-wb-muted">正在读取草稿…</p>
        : state === 'error' && savedText === '' && text === ''
          ? <ErrorBox message={`无法读取草稿：${message}`} onRetry={() => void load()} />
          : (
            <>
              <textarea className="ec-wb-textarea" rows={4} aria-label="工作草稿" value={text} maxLength={100_000}
                onChange={(event) => { setText(event.target.value); if (state !== 'conflict') setState('ready') }} />
              <div className="ec-wb-form-actions">
                <span className="ec-wb-muted" role="status">
                  {state === 'saving' ? '正在保存草稿' : state === 'conflict' ? '草稿冲突，本地内容保留' : dirty ? '草稿未保存' : '草稿已保存'}
                </span>
                <button type="button" className="ec-wb-button" disabled={!dirty || state === 'saving' || state === 'conflict'} onClick={() => void save()}>保存草稿</button>
                <button type="button" className="ec-wb-button" disabled={!text.trim()} onClick={() => onUseDraft(text)}>用于发起运行</button>
              </div>
              {message ? <p className={state === 'conflict' || state === 'error' ? 'ec-wb-error-text' : 'ec-wb-muted'} role="alert">{message}</p> : null}
            </>
          )}
    </section>
  )
}

/** Human labels for the binding/domain enums the detail rail shows; raw enum text is dev-facing. */
const domainKindLabel = (kind: 'local' | 'hosted'): string => (kind === 'hosted' ? '平台托管' : '本机')
const domainStateLabel = (state: 'HEALTHY' | 'DEGRADED' | 'UNKNOWN'): string => (state === 'HEALTHY' ? '正常' : state === 'DEGRADED' ? '降级' : '未核对')
const relationLabel = (relation: 'primary' | 'fork' | 'reopened'): string => (relation === 'primary' ? '当前' : relation === 'fork' ? '分支' : '历史')

function RunLauncher({ api, workId, catalog, preference, hasWorkspace, listingTypes, activeRunId, initialText, onCreated }: {
  api: WorkbenchApi
  workId: string
  catalog: ModelCatalog | null | undefined
  preference: ModelPreference | null | undefined
  hasWorkspace: boolean
  /** Scenarios the released application declares (Listing: Manual / Medical / PK / Report). */
  listingTypes?: string[]
  /** The Work's current QUEUED/STARTING/RUNNING run; the platform allows one at a time. */
  activeRunId?: string | null
  initialText: string
  onCreated(runId: string): void
}) {
  const [text, setText] = useState(initialText)
  const [model, setModel] = useState(() => chosenModel(catalog, preference) ?? '')
  const [listingType, setListingType] = useState(() => listingTypes?.[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => { if (initialText) setText(initialText) }, [initialText])
  useEffect(() => { if (!model) setModel(chosenModel(catalog, preference) ?? '') }, [catalog, preference, model])
  useEffect(() => {
    if (!listingTypes?.length) { setListingType(''); return }
    setListingType((previous) => (listingTypes.includes(previous) ? previous : listingTypes[0]))
  }, [listingTypes])

  const launch = async () => {
    if (!hasWorkspace) { setError('请先为这项工作选择工作空间。'); return }
    if (!text.trim()) { setError('请填写本次运行的目标。'); return }
    if (!model) { setError('请选择可用模型，或先由部署登记模型目录。'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const run = await api.createRun(workId, {
        input: runInput(text, listingType || undefined),
        modelSelectionId: model,
      })
      setNotice('运行已创建。执行记录与成果会由平台登记；工作台不显示推定的进度。')
      onCreated(run.runId)
    } catch (reason) {
      setError(`发起运行失败：${errorText(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-launch">
      <div className="ec-wb-card-head"><h2 id="ec-wb-launch">发起运行</h2></div>
      <p className="ec-wb-muted">运行使用平台控制的执行器；模型在创建时冻结。日常问答请点右上角「进入对话」，无需发起运行。</p>
      <textarea className="ec-wb-textarea" rows={3} aria-label="本次运行目标" value={text} maxLength={10_000}
        onChange={(event) => setText(event.target.value)} />
      {listingTypes && listingTypes.length > 0
        ? (
          <label className="ec-wb-field">
            <span className="ec-wb-field-label">Listing 场景</span>
            <select className="ec-wb-select" aria-label="Listing 场景" value={listingType} disabled={busy}
              onChange={(event) => setListingType(event.target.value)}>
              {listingTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <small className="ec-wb-muted">场景来自已发布应用的类型声明，随本次运行输入一起交给 Worker。</small>
          </label>
        )
        : null}
      <div className="ec-wb-form-actions">
        <ModelSelect catalog={catalog} preference={preference} value={model} onChange={setModel} disabled={busy} />
        <button type="button" className="ec-wb-button ec-wb-primary" disabled={busy || !hasWorkspace || !!activeRunId} onClick={() => void launch()}>
          {busy ? '提交中…' : '发起运行'}
        </button>
      </div>
      {activeRunId ? <p className="ec-wb-empty">此工作已有进行中的运行（{activeRunId.slice(0, 8)}）。平台同一工作只允许一个活动运行；它结束后可发起下一场景。</p> : null}
      {!hasWorkspace ? <p className="ec-wb-empty">此工作尚未选择工作空间，不能发起运行。</p> : null}
      {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
    </section>
  )
}

function interactionQuestions(item: InteractionItem): NativeQuestion[] {
  const questions = item.body?.questions
  return Array.isArray(questions) ? (questions as NativeQuestion[]) : []
}

function InteractionPanel({ api, runId, refreshToken, onChanged }: {
  api: WorkbenchApi
  runId: string
  refreshToken: number
  onChanged(): void
}) {
  const [items, setItems] = useState<InteractionItem[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [values, setValues] = useState<Record<string, { selected: string[]; custom: string }>>({})

  const load = useCallback(async () => {
    if (!runId) { setItems([]); return }
    setError('')
    try {
      const page = await api.runInteractions(runId)
      setItems(page.items)
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [api, runId])

  useEffect(() => { void load() }, [load, refreshToken])

  const pending = items.filter((item) => item.state === 'PENDING')
  const update = (qid: string, patch: Partial<{ selected: string[]; custom: string }>) => {
    setValues((previous) => ({
      ...previous,
      [qid]: { selected: previous[qid]?.selected ?? [], custom: previous[qid]?.custom ?? '', ...patch },
    }))
  }

  const answer = async (item: InteractionItem) => {
    const questions = interactionQuestions(item)
    setBusy(item.interactionId)
    setError('')
    setNotice('')
    try {
      const answers = buildAnswers(questions, values)
      await api.answerInteraction(item.interactionId, answers)
      setNotice('答复已提交。')
      setValues({})
      await load()
      onChanged()
    } catch (reason) {
      setError(`答复未提交：${errorText(reason)}`)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-interactions">
      <div className="ec-wb-card-head"><h2 id="ec-wb-interactions">问答回复</h2><span className="ec-wb-badge">{pending.length} 项待处理</span></div>
      <p className="ec-wb-muted">这里只回答平台执行器提出的问题；已回答或已取消的问题不能重复回答。</p>
      {!runId ? <p className="ec-wb-empty">选择一个运行后可查看并回答它的问题。</p> : null}
      {error ? <ErrorBox message={`无法读取问答：${error}`} onRetry={() => void load()} /> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
      {runId && pending.length === 0 ? <p className="ec-wb-empty">当前运行没有等待答复的问题。</p> : pending.map((item) => {
        const questions = interactionQuestions(item)
        if (questions.length === 0) {
          return <p className="ec-wb-empty" key={item.interactionId}>有一项待处理请求，当前页面无法识别其问题结构，未提交任何答复。</p>
        }
        return (
          <div className="ec-wb-interaction" key={item.interactionId}>
            <h4 className="ec-wb-question-title"><span className="ec-wb-pending-dot" aria-hidden="true" />需要你的答复</h4>
            {questions.map((question) => {
              const current = values[question.id] ?? { selected: [], custom: '' }
              const options = (question.options ?? [])
                .map((option) => (typeof option === 'string' ? option : option?.label))
                .filter((label): label is string => typeof label === 'string' && label.length > 0)
              return (
                <fieldset className="ec-wb-fieldset" key={question.id}>
                  <legend>{question.question ?? '需要你的答复'}</legend>
                  {options.length > 0
                    ? (
                      <div className="ec-wb-options">
                        {options.map((label) => (
                          <label className="ec-wb-option" key={label}>
                            <input
                              type={question.multiSelect ? 'checkbox' : 'radio'}
                              name={`ec-wb-${item.interactionId}-${question.id}`}
                              checked={current.selected.includes(label)}
                              onChange={(event) => update(question.id, {
                                selected: question.multiSelect
                                  ? event.target.checked
                                    ? [...current.selected, label]
                                    : current.selected.filter((itemLabel) => itemLabel !== label)
                                  : [label],
                              })}
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    )
                    : null}
                  <input className="ec-wb-input" aria-label={`${question.question ?? question.id} 的自定义回答`}
                    placeholder="自定义回答（可选）" value={current.custom} maxLength={2000}
                    onChange={(event) => update(question.id, { custom: event.target.value })} />
                </fieldset>
              )
            })}
            <div className="ec-wb-interaction-actions">
              <button type="button" className="ec-wb-button ec-wb-primary" disabled={busy === item.interactionId}
                onClick={() => void answer(item)}>{busy === item.interactionId ? '提交中…' : '提交答复'}</button>
            </div>
          </div>
        )
      })}
    </section>
  )
}

/** Run control shared by the Work detail page and the work console: one busy/error/notice state
 *  per selected run, so a stop requested from the console head and the retry offered in its rail
 *  report the same outcome instead of two independent statuses. */
function useRunControl(api: WorkbenchApi, run: RunSummary | null, onChanged: () => void) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const act = async (kind: 'cancel' | 'retry' | 'reconcile') => {
    if (!run) return
    if (kind === 'cancel' && !globalThis.confirm?.('请求停止这次运行？已产生的内容会按原生结算保留。')) return
    if (kind === 'reconcile' && !globalThis.confirm?.('请确认执行进程已停止、外部副作用已核对。确认后只释放工作空间，不改写历史结果。')) return
    setBusy(kind)
    setError('')
    setNotice('')
    try {
      if (kind === 'cancel') {
        const revision = run.snapshot?.revision
        if (typeof revision !== 'number') throw new Error('RUN_REVISION_MISSING')
        const result = await api.cancelRun(run.runId, revision)
        setNotice(result.cancelSettled ? '运行已停止。' : '停止请求已记录，等待执行器结算。')
      } else if (kind === 'retry') {
        await api.retryRun(run.runId)
        setNotice('重试运行已创建。')
      } else {
        await api.reconcileRun(run.runId)
        setNotice('已按确认释放工作空间；历史结果未改写。')
      }
      onChanged()
    } catch (reason) {
      setError(`操作未完成：${errorText(reason)}`)
    } finally {
      setBusy('')
    }
  }

  return { busy, error, notice, act }
}

function RunActions({ api, run, onChanged }: {
  api: WorkbenchApi
  run: RunSummary
  onChanged(): void
}) {
  const { busy, error, notice, act } = useRunControl(api, run, onChanged)
  const state = run.snapshot?.state
  const terminal = state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED'
  const unknown = state === 'UNKNOWN'

  return (
    <div className="ec-wb-run-actions">
      <button type="button" className="ec-wb-button ec-wb-stop" disabled={!!busy || terminal || unknown}
        onClick={() => void act('cancel')}>{busy === 'cancel' ? '请求中…' : t('action.stop')}</button>
      <button type="button" className="ec-wb-button" disabled={!!busy || !terminal}
        onClick={() => void act('retry')}>{busy === 'retry' ? '提交中…' : '重试运行'}</button>
      <button type="button" className="ec-wb-button" disabled={!!busy || !unknown}
        onClick={() => void act('reconcile')}>{busy === 'reconcile' ? '确认中…' : '确认已停止并释放空间'}</button>
      {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
    </div>
  )
}

/** Business review of the selected run. Three facts stay separate on purpose: the run's technical
 *  state, the sealed artifacts shown beside it, and whether a person approved the result. */
function ReviewPanel({ api, run, onChanged }: {
  api: WorkbenchApi
  run: RunSummary
  onChanged(): void
}) {
  const [items, setItems] = useState<ReviewItem[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      setItems((await api.runReviews(run.runId)).items)
      setError('')
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [api, run.runId])
  useEffect(() => { void load() }, [load])

  const open = items.find((item) => item.state === 'REQUESTED')
  const latestDecision = [...items].reverse().find((item) => item.state === 'APPROVED' || item.state === 'REJECTED')
  const state = run.snapshot?.state
  const canRequest = state === 'SUCCEEDED' && !open

  const request = async () => {
    setBusy('request')
    setError('')
    setNotice('')
    try {
      await api.requestReview(run.runId, note.trim() || undefined)
      setNote('')
      setNotice('复核已发起，等待复核人给出结论。')
      await load()
      onChanged()
    } catch (reason) {
      setError(`复核未发起：${errorText(reason)}`)
    } finally {
      setBusy('')
    }
  }

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    if (!open) return
    setBusy(decision)
    setError('')
    setNotice('')
    try {
      await api.decideReview(open.reviewId, decision, open.revision, note.trim() || undefined)
      setNote('')
      setNotice(decision === 'APPROVED' ? '复核已通过。' : '复核已驳回。')
      await load()
      onChanged()
    } catch (reason) {
      setError(`复核未记录：${errorText(reason)}`)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-review">
      <div className="ec-wb-card-head">
        <h2 id="ec-wb-review">{t('review.title')}</h2>
        <span className="ec-wb-badge" data-tone={latestDecision?.state === 'APPROVED' ? 'ok' : latestDecision?.state === 'REJECTED' ? 'error' : open ? 'warn' : 'muted'}>
          {latestDecision?.state === 'APPROVED' ? '已通过' : latestDecision?.state === 'REJECTED' ? '已驳回' : open ? '待复核' : '未发起'}
        </span>
      </div>
      <dl className="ec-wb-facts">
        <dt>运行状态</dt><dd>{runStateText(state)}</dd>
        <dt>复核状态</dt>
        <dd>{open ? '待复核' : latestDecision ? (latestDecision.state === 'APPROVED' ? `已通过 · ${latestDecision.reviewer ?? ''}` : `已驳回 · ${latestDecision.reviewer ?? ''}`) : '未发起'}</dd>
      </dl>
      <p className="ec-wb-muted">运行成功、成果封存与业务复核是三件不同的事；复核记录绑定本次运行，不改变运行状态，也不代替交付批准。</p>
      {state !== 'SUCCEEDED' && !open
        ? <p className="ec-wb-empty">只有成功的运行可以发起复核。</p>
        : null}
      {open
        ? (
          <>
            {open.note ? <p className="ec-wb-muted">复核说明：{open.note}</p> : null}
            <input className="ec-wb-input" value={note} maxLength={4000} placeholder="复核意见（驳回时必填）"
              aria-label="复核意见" onChange={(event) => setNote(event.target.value)} />
            <div className="ec-wb-row-actions">
              <button type="button" className="ec-wb-button ec-wb-primary" disabled={!!busy}
                onClick={() => void decide('APPROVED')}>{busy === 'APPROVED' ? '提交中…' : t('review.approve')}</button>
              <button type="button" className="ec-wb-button" disabled={!!busy}
                onClick={() => void decide('REJECTED')}>{busy === 'REJECTED' ? '提交中…' : t('review.reject')}</button>
            </div>
          </>
        )
        : canRequest
          ? (
            <>
              <input className="ec-wb-input" value={note} maxLength={4000} placeholder="复核说明（可选）"
                aria-label="复核说明" onChange={(event) => setNote(event.target.value)} />
              <div className="ec-wb-row-actions">
                <button type="button" className="ec-wb-button" disabled={!!busy}
                  onClick={() => void request()}>{busy === 'request' ? '提交中…' : t('review.request')}</button>
              </div>
            </>
          )
          : null}
      {latestDecision?.note ? <p className="ec-wb-muted">最近意见：{latestDecision.note}</p> : null}
      {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
    </section>
  )
}

const CHECK_KIND_LABEL: Record<string, string> = {
  'artifact-present': '产物存在',
  'artifact-digest': '产物摘要',
  'artifact-bytes-max': '大小上限',
  'goal-contains': '目标锚点',
}

/** E2-1 deterministic verification (expert gold sets deferred): recomputable checks against the
 *  run's own records — artifact presence, sealed digests, byte ceilings, goal anchors. Nothing
 *  here claims expert equivalence; the card says so explicitly instead of dressing itself up
 *  as a business review. */
function EvaluationCard({ api, run }: { api: WorkbenchApi; run: RunSummary | null }) {
  const [sets, setSets] = useState<Awaited<ReturnType<WorkbenchApi['listEvaluationSets']>>>([])
  const [selectedSetId, setSelectedSetId] = useState('')
  const [evaluation, setEvaluation] = useState<EvaluationRunItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [setsError, setSetsError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setSetsError('')
    setError('')
    setEvaluation(null)
    setSelectedSetId('')
    setSets([])
    api.listEvaluationSets(run?.appId, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return
        const active = items.filter((item) => item.state === 'ACTIVE')
        setSets(active)
        setSelectedSetId(active[0]?.evaluationSetId ?? '')
      })
      .catch((reason) => {
        if (!controller.signal.aborted && (reason as Error)?.name !== 'AbortError') setSetsError(errorText(reason))
      })
    return () => controller.abort()
  }, [api, run?.appId])

  if (!run) {
    return (
      <section className="ec-wb-card" aria-labelledby="ec-wb-eval">
        <div className="ec-wb-card-head"><h2 id="ec-wb-eval">确定性验证</h2></div>
        <p className="ec-wb-empty">选择一个运行后可对其执行确定性检查。</p>
      </section>
    )
  }

  const evaluate = async () => {
    if (!selectedSetId) return
    setBusy(true)
    setError('')
    setEvaluation(null)
    try {
      setEvaluation(await api.evaluateSet(selectedSetId, run.runId))
    } catch (reason) {
      setError(`确定性检查未执行：${errorText(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-eval">
      <div className="ec-wb-card-head">
        <h2 id="ec-wb-eval">确定性验证</h2>
        {evaluation
          ? (
            <span className="ec-wb-badge" data-tone={evaluation.failed === 0 ? 'ok' : 'error'}>
              {evaluation.failed === 0 ? `全部通过（${evaluation.passed}）` : `未通过 ${evaluation.failed} / ${evaluation.passed + evaluation.failed}`}
            </span>
          )
          : null}
      </div>
      <p className="ec-wb-muted">
        确定性检查只核对可复算的事实（产物封存、摘要、大小、目标锚点），不调用模型、不做业务判断；
        专家金标评测尚未建立，本卡不代替业务复核。
      </p>
      {setsError
        ? <ErrorBox message={`无法读取检查集：${setsError}`} />
        : sets.length === 0
          ? <p className="ec-wb-empty">此应用还没有确定性检查集。</p>
          : (
            <>
              <div className="ec-wb-row-actions">
                <label className="ec-wb-muted" htmlFor="ec-wb-eval-set">检查集</label>
                <select
                  id="ec-wb-eval-set"
                  className="ec-wb-select"
                  value={selectedSetId}
                  onChange={(event) => { setSelectedSetId(event.target.value); setEvaluation(null) }}
                >
                  {sets.map((item) => (
                    <option key={item.evaluationSetId} value={item.evaluationSetId}>
                      {item.name}（{item.entries.reduce((count, entry) => count + entry.checks.length, 0)} 项检查）
                    </option>
                  ))}
                </select>
                <button type="button" className="ec-wb-button" disabled={busy || !selectedSetId} onClick={() => void evaluate()}>
                  {busy ? '检查中…' : '运行检查'}
                </button>
              </div>
              {evaluation
                ? (
                  <div role="list">
                    {evaluation.results.map((result, index) => (
                      <div role="listitem" key={`${result.entryId}-${index}`} className="ec-wb-artifact-row">
                        <span className="ec-wb-row-main">
                          <strong>{result.label} · {CHECK_KIND_LABEL[result.check.kind] ?? result.check.kind}</strong>
                          <small className="ec-wb-muted">{result.detail}</small>
                        </span>
                        <span className="ec-wb-badge" data-tone={result.pass ? 'ok' : 'error'}>{result.pass ? '通过' : '未通过'}</span>
                      </div>
                    ))}
                  </div>
                )
                : null}
            </>
          )}
      {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
    </section>
  )
}

/** The three Work pointers (SC-03) as one honest card: the baseline being edited, the most recent
 *  run, and the current recognition — three separate lines, never collapsed into "最新". The
 *  recognition line reads the newest succeeded run's reviews and refuses to show approval that
 *  has not actually been read from the control plane. */
function DeliveryPointerCard({ api, baselines, runs, reviewsError }: {
  api: WorkbenchApi
  baselines: Page<InputBaselineItem>
  runs: Page<RunSummary>
  reviewsError?: string
}) {
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null)
  const candidateRunId = runs.items.find((run) => run.snapshot?.state === 'SUCCEEDED')?.runId ?? null

  useEffect(() => {
    if (!candidateRunId) { setReviews(null); return undefined }
    let live = true
    setReviews(null)
    void (async () => {
      try {
        const result = await api.runReviews(candidateRunId)
        if (live) setReviews(result.items)
      } catch {
        // 读取失败不冒充"未复核"：reviews 保持 null，由 reviewsError 呈现真实原因。
        if (live) setReviews(null)
      }
    })()
    return () => { live = false }
  }, [api, candidateRunId])

  const pointers = workPointers(baselines.items, runs.items, reviews)
  const delivery = pointers.delivery
  const deliveryDetail = reviewsError
    ? `复核结论读取失败：${reviewsError}。在读取到结论之前不显示认可。`
    : delivery.detail
  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-pointers">
      <div className="ec-wb-card-head"><h2 id="ec-wb-pointers">工作指针</h2></div>
      <p className="ec-wb-muted">正在编辑的基线、最近运行、当前认可三件事分开看，不统称「最新」。</p>
      <dl className="ec-wb-facts">
        <dt>输入基线</dt>
        <dd>
          {pointers.baseline
            ? <>第 {pointers.baseline.revision} 批 · {pointers.baseline.sourceRef}
              {pointers.baseline.digestChanged === true ? '（与上一批不同）' : ''}
              {pointers.baseline.digestChanged === false ? '（与上一批摘要相同）' : ''}
              <small className="ec-wb-muted"> · {formatTime(pointers.baseline.createdAt)}</small>
            </>
            : '尚未登记输入批次'}
        </dd>
        <dt>最近运行</dt>
        <dd>
          {pointers.run
            ? <>{pointers.run.runId.slice(0, 8)} · {runStateText(pointers.run.state)}<small className="ec-wb-muted"> · {formatTime(pointers.run.createdAt)}</small></>            : '还没有运行'}
        </dd>
        <dt>当前认可</dt>
        <dd>
          {delivery.runId && reviewsError === undefined ? <>{delivery.label}<small className="ec-wb-muted">（运行 {delivery.runId.slice(0, 8)}）</small></> : delivery.label}
          <small className="ec-wb-muted"> · {deliveryDetail}</small>
        </dd>
      </dl>
    </section>
  )
}

/** 换批重跑（SC-03 核心）：登记新输入批次（追加，不覆盖旧批次），并以新批次发起一次新运行。
 *  新批次身份随运行输入一起冻结，旧运行和旧批次原样保留；同一工作一次只有一个活动运行。 */
function RerunForm({ api, workId, catalog, preference, hasWorkspace, activeRunId, onCreated }: {
  api: WorkbenchApi
  workId: string
  catalog: ModelCatalog | null | undefined
  preference: ModelPreference | null | undefined
  hasWorkspace: boolean
  activeRunId?: string | null
  onCreated(runId: string): void
}) {
  const [sourceRef, setSourceRef] = useState('')
  const [digest, setDigest] = useState('')
  const [note, setNote] = useState('')
  const [model, setModel] = useState(() => chosenModel(catalog, preference) ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { if (!model) setModel(chosenModel(catalog, preference) ?? '') }, [catalog, preference, model])

  const digestOk = /^[0-9a-f]{64}$/i.test(digest.trim())

  const submit = async () => {
    if (!hasWorkspace) { setError('此工作尚未选择工作空间，不能发起重跑。'); return }
    if (activeRunId) { setError('此工作已有进行中的运行；平台同一工作只允许一个活动运行，它结束后可换批重跑。'); return }
    if (!sourceRef.trim()) { setError('请填写新资料的引用（目录或文件集标识，由资料治理流程给出）。'); return }
    if (!digestOk) { setError('请填写新资料的 SHA-256 摘要（64 位十六进制）。平台不代算摘要，摘要由资料治理流程提供。'); return }
    if (!model) { setError('请选择可用模型，或先由部署登记模型目录。'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const baseline = await api.appendInputBaseline(workId, { sourceRef: sourceRef.trim(), digest: digest.trim().toLowerCase() })
      const run = await api.createRun(workId, {
        input: runInput(
          note.trim() ? `换批重跑（第 ${baseline.revision} 批）：${note.trim()}` : `换批重跑：使用第 ${baseline.revision} 批资料再次执行`,
          undefined,
          { baselineId: baseline.baselineId, revision: baseline.revision, sourceRef: baseline.sourceRef, digest: baseline.digest },
        ),
        modelSelectionId: model,
      })
      setNotice(`已登记第 ${baseline.revision} 批（旧批次原样保留），并以它发起新运行 ${run.runId.slice(0, 8)}。`)
      setSourceRef('')
      setDigest('')
      setNote('')
      onCreated(run.runId)
    } catch (reason) {
      setError(`换批重跑未完成：${errorText(reason)}。如果批次已登记，输入批次列表里可以看到它；不会重复登记。`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ec-wb-rerun-form">
      <p className="ec-wb-muted">使用新资料再次运行：登记一个新输入批次并立即用它发起运行。旧批次、旧运行和已认可的结论原样保留，不覆盖。</p>
      {!hasWorkspace ? <p className="ec-wb-empty">此工作尚未选择工作空间，不能发起重跑。</p> : null}
      {activeRunId ? <p className="ec-wb-empty">此工作已有进行中的运行（{activeRunId.slice(0, 8)}）；它结束后才能换批重跑。</p> : null}
      <label className="ec-wb-field">
        <span className="ec-wb-field-label">新资料引用</span>
        <input className="ec-wb-input" value={sourceRef} maxLength={500} disabled={busy || !hasWorkspace || !!activeRunId}
          placeholder="如 D:\data\studyX\batch2 或资料集编号" aria-label="新资料引用"
          onChange={(event) => setSourceRef(event.target.value)} />
      </label>
      <label className="ec-wb-field">
        <span className="ec-wb-field-label">新资料 SHA-256 摘要</span>
        <input className="ec-wb-input" value={digest} maxLength={64} disabled={busy || !hasWorkspace || !!activeRunId}
          placeholder="64 位十六进制，由资料治理流程提供" aria-label="新资料 SHA-256 摘要"
          onChange={(event) => setDigest(event.target.value)} />
      </label>
      <label className="ec-wb-field">
        <span className="ec-wb-field-label">本次重跑说明（可选）</span>
        <input className="ec-wb-input" value={note} maxLength={2000} disabled={busy || !hasWorkspace || !!activeRunId}
          placeholder="如：数据库锁定后新批次" aria-label="本次重跑说明"
          onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="ec-wb-form-actions">
        <ModelSelect catalog={catalog} preference={preference} value={model} onChange={setModel} disabled={busy || !hasWorkspace || !!activeRunId} />
        <button type="button" className="ec-wb-button ec-wb-primary" disabled={busy || !hasWorkspace || !!activeRunId} onClick={() => void submit()}>
          {busy ? '正在登记并发起…' : '登记新批次并重跑'}
        </button>
      </div>
      {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
    </div>
  )
}

function WorkDetail({ api, data, workId, initialRunId, projectName, onBack, onOpenSession, onBindSession, onReload }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  workId: string
  initialRunId?: string
  projectName(projectId: string): string
  onBack(): void
  onOpenSession(workId: string, sessionId: string, domainId: string, since?: string): void
  /** Create and bind a native Session for a Work that has none; resolves the real binding facts. */
  onBindSession(context: WorkContext): Promise<{ sessionId: string; domainId: string }>
  onReload(): Promise<void>
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [notice, setNotice] = useState('')
  const [context, setContext] = useState<WorkContext | null>(null)
  const [contextError, setContextError] = useState('')
  const [runs, setRuns] = useState<Page<RunSummary>>({ total: 0, items: [] })
  const [runsOffset, setRunsOffset] = useState(0)
  const [runsError, setRunsError] = useState('')
  const [runsLoading, setRunsLoading] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [draftSeed, setDraftSeed] = useState('')
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([])
  const [artifactsError, setArtifactsError] = useState('')
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [artifactsOffset, setArtifactsOffset] = useState(0)
  const [inputs, setInputs] = useState<Page<InputCommitItem>>({ total: 0, items: [] })
  const [inputsOffset, setInputsOffset] = useState(0)
  const [inputsError, setInputsError] = useState('')
  const [baselines, setBaselines] = useState<Page<InputBaselineItem>>({ total: 0, items: [] })
  const [baselinesOffset, setBaselinesOffset] = useState(0)
  const [baselinesError, setBaselinesError] = useState('')
  const [interactionToken, setInteractionToken] = useState(0)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveNotice, setArchiveNotice] = useState('')
  const [bindBusy, setBindBusy] = useState(false)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)
  const [bindingError, setBindingError] = useState('')

  const loadContext = useCallback(async () => {
    try {
      setContextError('')
      setContext(await api.workContext(workId))
      setLastLoadedAt(Date.now())
    } catch (reason) {
      setContextError(errorText(reason))
    }
  }, [api, workId])

  const loadRuns = useCallback(async (offset: number) => {
    setRunsLoading(true)
    setRunsError('')
    try {
      const page = await api.workRuns(workId, { offset, limit: RUN_PAGE })
      setRuns(page)
      setRunsOffset(offset)
      setSelectedRunId((previous) => {
        if (previous && page.items.some((run) => run.runId === previous)) return previous
        if (initialRunId && page.items.some((run) => run.runId === initialRunId)) return initialRunId
        return page.items[0]?.runId ?? null
      })
    } catch (reason) {
      setRunsError(errorText(reason))
    } finally {
      setRunsLoading(false)
    }
  }, [api, workId, initialRunId])

  const loadBaselines = useCallback(async (offset: number) => {
    setBaselinesError('')
    try {
      const page = await api.workInputBaselines(workId, { offset, limit: BASELINE_PAGE })
      setBaselines(page)
      setBaselinesOffset(offset)
    } catch (reason) {
      setBaselinesError(errorText(reason))
    }
  }, [api, workId])

  const loadArtifacts = useCallback(async (runId: string) => {
    setArtifactsError('')
    setArtifactsLoading(true)
    try {
      const result = await api.runArtifacts(runId)
      setArtifacts(result.items)
      setArtifactsOffset(0)
    } catch (reason) {
      setArtifacts([])
      setArtifactsError(errorText(reason))
    } finally {
      setArtifactsLoading(false)
    }
  }, [api])

  /** Download one sealed artifact with verification: fetch first, refuse to save anything that is
   *  not the artifact itself (a stale page after a control-plane restart would otherwise hand the
   *  employee a JSON error body named like the artifact — a file no editor can make sense of), then
   *  hand the blob to the browser's own save flow. */
  const downloadArtifact = useCallback(async (runId: string, name: string) => {
    setNotice('')
    try {
      await saveArtifact(runId, name)
    } catch (reason) {
      setNotice(`下载失败：${errorText(reason)}`)
    }
  }, [])

  const loadInputs = useCallback(async (runId: string, offset: number) => {
    setInputsError('')
    try {
      const page = await api.runInputs(runId, { offset, limit: INPUT_PAGE })
      setInputs(page)
      setInputsOffset(offset)
    } catch (reason) {
      setInputs({ total: 0, items: [] })
      setInputsError(errorText(reason))
    }
  }, [api])

  useEffect(() => { void loadContext() }, [loadContext])
  useEffect(() => { void loadRuns(0) }, [loadRuns])
  useEffect(() => { void loadBaselines(0) }, [loadBaselines])
  useEffect(() => {
    if (selectedRunId) {
      void loadArtifacts(selectedRunId)
      void loadInputs(selectedRunId, 0)
    } else {
      setArtifacts([])
      setInputs({ total: 0, items: [] })
      setInputsOffset(0)
    }
  }, [selectedRunId, loadArtifacts, loadInputs])
  useEffect(() => { heading.current?.focus() }, [])

  const selectedRun = runs.items.find((run) => run.runId === selectedRunId) ?? null
  const artifactWindow = pageWindow(artifacts.length, artifactsOffset, ARTIFACT_PAGE)
  const visibleArtifacts = artifacts.slice(artifactWindow.offset, artifactWindow.offset + ARTIFACT_PAGE)
  const artifactSummary = summarizeArtifacts(artifacts)
  const boundSessionId = context?.binding?.sessionId ?? context?.sessionId ?? null
  const appDescriptor = context
    ? data.apps.find((app) => app.appId === context.app.appId && app.appVersion === context.app.appVersion)?.descriptor
    : undefined
  const listingTypes = Array.isArray(appDescriptor?.listingTypes) ? appDescriptor.listingTypes : []
  const activeRun = runs.items.find((run) => {
    const state = run.snapshot?.state
    return state === 'QUEUED' || state === 'STARTING' || state === 'RUNNING'
  }) ?? null

  const openBound = () => {
    const sessionId = boundSessionId
    const domainId = context?.binding?.domainId
    if (!sessionId || !domainId) {
      setNotice('对话正在创建，请稍候；创建完成后即可进入。')
      return
    }
    setNotice('')
    onOpenSession(workId, sessionId, domainId, context?.binding?.createdAt)
  }

  /** Create the Work's native Session and bind it; the session id is the Host's own id.
   *  navigate=false 用于打开详情时的自动关联（后台完成，不切换视图）。 */
  const bindSession = async (navigate = true) => {
    if (!context || bindBusy) return
    if (boundSessionId) {
      const confirm = (globalThis as { confirm?: (message: string) => boolean }).confirm
      if (confirm && !confirm('将新建一个对话并设为这项工作的当前对话；现有对话保留为历史，可随时从「历史会话」页继续。继续？')) return
    }
    setBindBusy(true)
    setNotice('')
    setBindingError('')
    try {
      const bound = await onBindSession(context)
      await loadContext()
      setNotice('')
      if (navigate) onOpenSession(workId, bound.sessionId, bound.domainId)
    } catch (reason) {
      setBindingError(errorText(reason))
      setNotice(`绑定未完成：${errorText(reason)}`)
    } finally {
      setBindBusy(false)
    }
  }

  /** 未绑定的工作打开详情时自动关联原生会话（每工作只尝试一次；失败保留提示，不循环重试）。
   *  自动关联会在工作目录创建一个专属对话，因此界面先说明再执行，失败也保留可重试的事实。 */
  const autoBindTried = useRef<string | null>(null)
  useEffect(() => {
    if (!context || boundSessionId || bindBusy) return
    if (context.work.state === 'ARCHIVED') return
    if (autoBindTried.current === workId) return
    autoBindTried.current = workId
    setNotice(t('hint.creatingConversation'))
    void bindSession(false)
  }, [context, boundSessionId, bindBusy, workId])

  /** The four facts an employee must be able to see before their first question: project/app,
   *  working directory, conversation, and whether it is ready to type into. */
  const bindingStage: 'loading' | 'archived' | 'workspace' | 'binding' | 'ready' | 'unbound' =
    !context ? 'loading'
      : context.work.state === 'ARCHIVED' ? 'archived'
        : !context.workspace ? 'workspace'
          : bindBusy ? 'binding'
            : boundSessionId ? 'ready'
              : 'unbound'
  const bindingSteps: Array<{ label: string; state: 'done' | 'active' | 'blocked' | 'pending' }> = [
    { label: '项目与应用', state: context ? 'done' : 'pending' },
    { label: '工作目录', state: context?.workspace ? 'done' : 'blocked' },
    { label: '专属对话', state: boundSessionId ? 'done' : bindBusy ? 'active' : bindingError ? 'blocked' : 'pending' },
    { label: '可以开始', state: boundSessionId ? 'done' : 'pending' },
  ]

  const onRunCreated = async (runId: string) => {
    setSelectedRunId(runId)
    await loadRuns(0)
    await loadBaselines(0)
    setInteractionToken((value) => value + 1)
  }

  const archive = async () => {
    if (!globalThis.confirm?.('归档这项工作？归档后记录和成果仍可查看，但不能再发起运行。')) return
    setArchiveBusy(true)
    setArchiveNotice('')
    try {
      await api.archiveWork(workId)
      setArchiveNotice('工作已归档；记录和成果仍可查看。')
      await loadContext()
      await onReload()
    } catch (reason) {
      setArchiveNotice(`归档未完成：${errorText(reason)}`)
    } finally {
      setArchiveBusy(false)
    }
  }

  return (
    <div className="ec-wb-view">
      <div className="ec-wb-page">
        <header className="ec-wb-page-head">
          <div>
            <button type="button" className="ec-wb-back-link" onClick={onBack}>← 返回工作列表</button>
            <h1 ref={heading} tabIndex={-1}>{context?.work.title ?? '工作详情'}</h1>
            {context
              ? <p className="ec-wb-muted">{projectName(context.work.projectId)} · {context.app.displayName} · {context.app.appVersion}</p>
              : null}
          </div>
          <div className="ec-wb-page-actions">
            <span className="ec-wb-badge" data-tone={context?.work.state === 'ARCHIVED' ? 'muted' : 'ok'}>
              {context?.work.state === 'ARCHIVED' ? '已归档' : '使用中'}
            </span>
            <Freshness at={lastLoadedAt} busy={runsLoading} onRefresh={() => { void loadContext(); void loadRuns(runsOffset); void loadBaselines(baselinesOffset) }} />
            <button type="button" className="ec-wb-button ec-wb-primary" onClick={openBound} disabled={!boundSessionId}>{bindBusy ? '正在创建对话…' : t('action.enterChat')}</button>
            <button type="button" className="ec-wb-button" onClick={() => void onReload()}>{t('action.refresh')}</button>
            <button type="button" className="ec-wb-button" disabled={archiveBusy || context?.work.state === 'ARCHIVED'} onClick={() => void archive()}>
              {archiveBusy ? '归档中…' : t('action.archive')}
            </button>
          </div>
        </header>
        <p className="ec-wb-status" role="status" aria-live="polite">{notice}{archiveNotice ? ` ${archiveNotice}` : ''}</p>

        {contextError ? <ErrorBox message={`无法读取工作上下文：${contextError}`} onRetry={() => void loadContext()} /> : null}

        <div className="ec-wb-detail">
          <div className="ec-wb-stack">
            <DeliveryPointerCard api={api} baselines={baselines} runs={runs} />
            {context && context.work.state !== 'ARCHIVED'
              ? (
                <section className="ec-wb-card" aria-labelledby="ec-wb-bind">
                  <div className="ec-wb-card-head">
                    <h2 id="ec-wb-bind">对话工作区</h2>
                    <span className="ec-wb-badge" data-tone={boundSessionId ? 'ok' : bindBusy ? 'warn' : 'warn'}>
                      {boundSessionId ? '已就绪' : bindBusy ? '正在创建…' : bindingStage === 'workspace' ? '缺少工作目录' : '未创建'}
                    </span>
                  </div>
                  <ol className="ec-wb-bind-steps" aria-label="对话准备状态">
                    {bindingSteps.map((step) => (
                      <li key={step.label} data-state={step.state === 'pending' ? undefined : step.state} aria-current={step.state === 'active' ? 'step' : undefined}>
                        <span aria-hidden="true">{step.state === 'done' ? GLYPH_CHECK : step.state === 'blocked' ? '!' : '·'}</span>
                        {step.label}
                      </li>
                    ))}
                  </ol>
                  <p className="ec-wb-muted">
                    {boundSessionId
                      ? '这项工作已有一个专属 AI 对话，与平台原生流式问答是同一能力；日常问答不会自动产生运行记录，需要按场景产出时使用下方「发起运行」。'
                      : bindBusy
                        ? t('hint.creatingConversation')
                        : bindingError
                          ? `对话创建失败：${bindingError}。可以稍后重试，已填写的内容不会丢失。`
                          : bindingStage === 'workspace'
                            ? '这项工作还没有工作目录，平台不会替你猜测路径。请先在「项目空间」为项目登记执行目录，再创建对话。'
                            : '打开本工作时会自动创建并绑定一个专属对话；也可以现在手动创建。'}
                  </p>
                  {listingTypes.length > 0
                    ? <p className="ec-wb-muted">需要按场景产出（{listingTypes.join(' / ')}）时，用下方「发起运行」选择场景执行；日常问答直接聊即可。</p>
                    : null}
                  <p className="ec-wb-muted">
                    {context.workspace
                      ? <>对话与运行使用工作空间「{context.workspace.name}」<span className="ec-wb-expert-only">（<span className="ec-wb-digest">{context.workspace.directory}</span>）</span>；重新绑定会新建对话，当前对话保留为历史。</>
                      : '登记目录由部署侧校验；工作台只记录路径，不读取目录内容。'}
                  </p>
                  <div className="ec-wb-row-actions">
                    {boundSessionId
                      ? <button type="button" className="ec-wb-button ec-wb-primary" onClick={openBound}>{t('action.enterChat')}</button>
                      : null}
                    <button type="button" className={boundSessionId ? 'ec-wb-button' : 'ec-wb-button ec-wb-primary'}
                      disabled={bindBusy || !context.workspace} onClick={() => void bindSession()}>
                      {bindBusy ? '正在创建对话…' : boundSessionId ? '重新绑定（当前对话转为历史）' : bindingError ? '重试创建对话' : '创建对话'}
                    </button>
                    {!context.workspace
                      ? <span className="ec-wb-muted">请先在「项目空间」为该工作登记目录。</span>
                      : null}
                  </div>
                </section>
              )
              : null}
            <DraftPanel api={api} workId={workId} onUseDraft={setDraftSeed} />
            <RunLauncher
              api={api}
              workId={workId}
              catalog={data.models?.catalog}
              preference={data.models?.preference}
              hasWorkspace={!!context?.workspace && context?.work.state !== 'ARCHIVED'}
              listingTypes={listingTypes}
              activeRunId={activeRun?.runId ?? null}
              initialText={draftSeed}
              onCreated={(runId) => void onRunCreated(runId)}
            />

            <section className="ec-wb-card" aria-labelledby="ec-wb-runs">
              <div className="ec-wb-card-head"><h2 id="ec-wb-runs">运行历史</h2><span className="ec-wb-badge">{runs.total}</span></div>
              {runsError ? <ErrorBox message={`无法读取运行历史：${runsError}`} onRetry={() => void loadRuns(runsOffset)} /> : null}
              {!runsError && runs.items.length === 0
                ? <p className="ec-wb-empty">此工作还没有执行记录。执行记录由平台运行产生，普通问答可以没有成果。</p>
                : (
                  <div role="list" aria-busy={runsLoading}>
                    {runs.items.map((run) => (
                      <div role="listitem" key={run.runId}>
                        <button type="button" className="ec-wb-run-button" aria-current={run.runId === selectedRunId}
                          onClick={() => setSelectedRunId(run.runId)}>
                          <span className="ec-wb-row-main">
                            <strong>{formatTime(run.createdAt)}</strong>
                            <small className="ec-wb-muted">{run.appId}@{run.appVersion} · {run.runId.slice(0, 8)}</small>
                          </span>
                          <StateBadge state={run.snapshot?.state} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              <Pager total={runs.total} offset={runsOffset} limit={RUN_PAGE} busy={runsLoading} onOffset={(offset) => void loadRuns(offset)} />
              {selectedRun
                ? (
                  <RunActions
                    api={api}
                    run={selectedRun}
                    onChanged={() => { void loadRuns(runsOffset); setInteractionToken((v) => v + 1); void onReload() }}
                  />
                )
                : null}
            </section>

            {selectedRun
              ? <ReviewPanel api={api} run={selectedRun} onChanged={() => { void loadRuns(runsOffset); void onReload() }} />
              : null}

            {selectedRun
              ? (
                <ResultViewsCard
                  api={api}
                  run={selectedRun}
                  resultViews={Array.isArray(appDescriptor?.resultViews) ? appDescriptor.resultViews : []}
                  comparableRunIds={runs.items
                    .filter((candidate) => candidate.runId !== selectedRun.runId && candidate.snapshot?.state === 'SUCCEEDED')
                    .map((candidate) => ({ runId: candidate.runId, label: `运行 ${candidate.runId.slice(0, 8)} · ${formatTime(candidate.createdAt)}` }))}
                />
              )
              : null}

            <EvaluationCard api={api} run={selectedRun ?? null} />

            <InteractionPanel
              api={api}
              runId={selectedRun?.runId ?? ''}
              refreshToken={interactionToken}
              onChanged={() => { setInteractionToken((value) => value + 1); void loadRuns(runsOffset); void onReload() }}
            />
          </div>

          <aside className="ec-wb-rail" aria-label="工作上下文与成果">
            <section className="ec-wb-card" aria-labelledby="ec-wb-context">
              <div className="ec-wb-card-head"><h2 id="ec-wb-context">工作上下文</h2></div>
              {context
                ? (
                  <dl className="ec-wb-facts">
                    <dt>项目</dt><dd>{projectName(context.work.projectId)}</dd>
                    <dt>应用</dt>
                    <dd>
                      {context.app.displayName} · {context.app.appVersion}
                      <small className="ec-wb-muted ec-wb-expert-only">插件 {context.app.appId}</small>
                    </dd>
                    <dt>对话</dt>
                    <dd>
                      {context.binding
                        ? <>已绑定（{relationLabel(context.binding.relation)}）<span className="ec-wb-digest ec-wb-expert-only">{context.binding.sessionId}</span></>
                        : bindBusy ? '正在创建…' : '未绑定'}
                    </dd>
                    <dt>执行域</dt>
                    <dd>{context.domain ? `${domainKindLabel(context.domain.kind)}${context.domain.state === 'UNKNOWN' ? '' : ` · ${domainStateLabel(context.domain.state)}`}` : '尚未登记执行域'}</dd>
                    <dt>工作空间</dt>
                    <dd>{context.workspace ? <>{context.workspace.name}<small className="ec-wb-muted ec-wb-expert-only">{context.workspace.directory}</small></> : '未选择工作空间'}</dd>
                  </dl>
                )
                : <p className="ec-wb-muted">正在读取工作上下文…</p>}
            </section>

            <section className="ec-wb-card" aria-labelledby="ec-wb-artifacts">
              <div className="ec-wb-card-head"><h2 id="ec-wb-artifacts">成果版本</h2><span className="ec-wb-badge">{artifactSummary.total}</span></div>
              {!selectedRun
                ? <p className="ec-wb-empty">选择一个运行后可查看该次执行的成果。</p>
                : (
                  <>
                    <p className="ec-wb-muted">已封存 {artifactSummary.sealed} 项，未封存 {artifactSummary.unsealed} 项，共 {formatBytes(artifactSummary.bytes)}。</p>
                    {artifactsError ? <ErrorBox message={`无法读取成果：${artifactsError}`} onRetry={() => void loadArtifacts(selectedRun.runId)} /> : null}
                    {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
                    {!artifactsError && artifactsLoading && artifacts.length === 0
                      ? <p className="ec-wb-muted" role="status">正在读取成果…</p>
                      : !artifactsError && artifacts.length === 0
                        ? <p className="ec-wb-empty">该运行没有登记成果。这不代表执行失败，也不代表业务审核通过。</p>
                        : (
                        <div>
                          {visibleArtifacts.map((artifact) => (
                            <div className="ec-wb-artifact-row" key={artifact.name}>
                              <span className="ec-wb-file-dot" aria-hidden="true">{(artifact.name.split('.').pop() ?? 'f').slice(0, 1)}</span>
                              <span className="ec-wb-row-main">
                                <strong>{artifact.name}</strong>
                                <small>{formatBytes(artifact.bytes)} · {artifact.mediaType ?? '类型未记录'}</small>
                              </span>
                              <span className="ec-wb-row-actions">
                                {artifact.sealedAt ? <span className="ec-wb-badge">已封存</span> : <span className="ec-wb-badge" data-tone="warn">未封存</span>}
                                {artifact.sealedAt
                                  ? <button type="button" className="ec-wb-link" onClick={() => void downloadArtifact(selectedRun.runId, artifact.name)}>下载</button>
                                  : null}
                              </span>
                            </div>
                          ))}
                          <Pager total={artifactSummary.total} offset={artifactsOffset} limit={ARTIFACT_PAGE} busy={false} onOffset={setArtifactsOffset} />
                        </div>
                      )}
                  </>
                )}
            </section>

            <DeliveryPackagesCard api={api} workId={workId} runs={runs} workArchived={context?.work.state === 'ARCHIVED'} />

            <section className="ec-wb-card" aria-labelledby="ec-wb-baselines">
              <div className="ec-wb-card-head"><h2 id="ec-wb-baselines">输入批次</h2><span className="ec-wb-badge">{baselines.total}</span></div>
              <p className="ec-wb-muted">批次只追加，不覆盖旧基线；旧执行始终对应它当时的输入摘要。</p>
              {baselinesError
                ? <ErrorBox message={`无法读取输入批次：${baselinesError}`} onRetry={() => void loadBaselines(baselinesOffset)} />
                : baselines.items.length === 0
                  ? <p className="ec-wb-empty">尚未登记输入批次。</p>
                  : (
                    <div>
                      {baselines.items.map((baseline, index) => (
                        <div className="ec-wb-row" key={baseline.baselineId}>
                          <span className="ec-wb-row-main">
                            <strong>第 {baseline.revision} 批 · {baseline.sourceRef}</strong>
                            <small className="ec-wb-muted">{formatTime(baseline.createdAt)}
                              {index > 0 && baseline.digest !== baselines.items[index - 1]?.digest ? ' · 与上一批不同' : ''}
                              {index > 0 && baseline.digest === baselines.items[index - 1]?.digest ? ' · 与上一批摘要相同' : ''}
                              <span className="ec-wb-expert-only"> · <span className="ec-wb-digest">{baseline.digest.slice(0, 12)}…</span></span>
                            </small>
                          </span>
                        </div>
                      ))}
                      <Pager total={baselines.total} offset={baselinesOffset} limit={BASELINE_PAGE} busy={false} onOffset={(offset) => void loadBaselines(offset)} />
                    </div>
                  )}
              {context && context.work.state !== 'ARCHIVED'
                ? (
                  <RerunForm
                    api={api}
                    workId={workId}
                    catalog={data.models?.catalog}
                    preference={data.models?.preference}
                    hasWorkspace={!!context.workspace}
                    activeRunId={activeRun?.runId ?? null}
                    onCreated={(runId) => void onRunCreated(runId)}
                  />
                )
                : null}
            </section>

            <section className="ec-wb-card" aria-labelledby="ec-wb-run-inputs">
              <div className="ec-wb-card-head"><h2 id="ec-wb-run-inputs">本次执行输入</h2><span className="ec-wb-badge">{inputs.total}</span></div>
              {!selectedRun
                ? <p className="ec-wb-empty">选择一个运行后可查看该次执行接收的输入。</p>
                : inputsError
                  ? <ErrorBox message={`无法读取执行输入：${inputsError}`} onRetry={() => void loadInputs(selectedRun.runId, inputsOffset)} />
                  : inputs.items.length === 0
                    ? <p className="ec-wb-empty">该运行没有输入记录。</p>
                    : (
                      <div>
                        {inputs.items.map((commit) => (
                          <div className="ec-wb-row" key={commit.commitId}>
                            <span className="ec-wb-row-main">
                              <strong>#{commit.sequence}</strong>
                              <small className="ec-wb-muted">{inputStateLabel(commit.state)}<span className="ec-wb-expert-only"> · <span className="ec-wb-digest">{commit.contentDigest.slice(0, 12)}…</span></span></small>
                            </span>
                          </div>
                        ))}
                        <Pager total={inputs.total} offset={inputsOffset} limit={INPUT_PAGE} busy={false} onOffset={(offset) => void loadInputs(selectedRun.runId, offset)} />
                      </div>
                    )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}

// ── Delivery packages (E1-3) ────────────────────────────────────────────────

/** 封存(SEAL) ≠ 交付(DELIVER) ≠ 接收(RECEIVED)：三个独立的事实，各自留痕。 */
const DELIVERY_STATE_LABELS: Record<DeliveryPackageItem['state'], string> = {
  SEALED: '已封存 · 待交付',
  DELIVERED: '已交付',
  RECEIVED: '已接收',
  WITHDRAWN: '已撤回',
  SUPERSEDED: '已被替代',
}
const DELIVERY_STATE_TONES: Record<DeliveryPackageItem['state'], string | undefined> = {
  SEALED: 'warn',
  DELIVERED: 'ok',
  RECEIVED: 'ok',
  WITHDRAWN: 'muted',
  SUPERSEDED: 'muted',
}
const REVIEW_STATE_LABELS: Record<DeliveryPackageItem['manifest']['review'] extends null ? never : NonNullable<DeliveryPackageItem['manifest']['review']>['state'], string> = {
  REQUESTED: '待审核',
  APPROVED: '已通过',
  REJECTED: '已拒绝',
  SUPERSEDED: '已废弃',
}

/**
 * One Work's delivery packages, newest first, with the lifecycle the control plane enforces:
 * sealing freezes the manifest (artifact digests + the review snapshot at seal time), delivery
 * and reception are recorded separately, withdrawal demands a reason and supersession is an
 * explicit choice of the replacing package — the UI never merges those facts for the operator.
 */
function DeliveryPackagesCard({ api, workId, runs, workArchived }: {
  api: WorkbenchApi
  workId: string
  runs: Page<RunSummary>
  workArchived: boolean
}) {
  const [packages, setPackages] = useState<Page<DeliveryPackageItem>>({ total: 0, items: [] })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState(0)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [action, setAction] = useState<{ packageId: string; kind: 'deliver' | 'acknowledge' | 'withdraw' | 'supersede' } | null>(null)
  const [actionText, setActionText] = useState('')
  const [actionTarget, setActionTarget] = useState('')
  const [sealRunId, setSealRunId] = useState('')
  const [sealNote, setSealNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPackages(await api.workDeliveryPackages(workId, { offset: 0, limit: 50 }))
      setError('')
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }, [api, workId])
  useEffect(() => { void load() }, [load, token])

  const refresh = () => setToken((value) => value + 1)
  const succeededRuns = runs.items.filter((run) => run.snapshot?.state === 'SUCCEEDED')

  const seal = async () => {
    if (!sealRunId || busy) return
    setBusy(true)
    try {
      const pkg = await api.sealDeliveryPackage(workId, { runId: sealRunId, note: sealNote.trim() || undefined })
      setNotice(`已封存交付包（${pkg.manifest.artifacts.length} 项成果${pkg.manifest.review ? '，审核快照已随包冻结' : '，封存时该运行未审核'}）。`)
      setSealRunId('')
      setSealNote('')
      refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const runAction = async () => {
    if (!action || busy) return
    const target = packages.items.find((pkg) => pkg.packageId === action.packageId)
    if (!target) return
    if (action.kind === 'withdraw' && !actionText.trim()) {
      setError('撤回必须填写原因——这是包历史上留下的唯一解释。')
      return
    }
    if (action.kind === 'supersede' && !actionTarget) {
      setError('替代必须明确指向另一个未终结的交付包。')
      return
    }
    setBusy(true)
    try {
      if (action.kind === 'deliver') {
        await api.deliverDeliveryPackage(action.packageId, { note: actionText.trim() || undefined, expectedRevision: target.revision })
        setNotice('已记录交付事实（对方是否接收是另一个独立事实）。')
      } else if (action.kind === 'acknowledge') {
        await api.acknowledgeDeliveryPackage(action.packageId, { note: actionText.trim() || undefined, expectedRevision: target.revision })
        setNotice('已记录接收事实。平台不验证实物接收，这条记录就是全部凭据。')
      } else if (action.kind === 'withdraw') {
        await api.withdrawDeliveryPackage(action.packageId, { reason: actionText.trim(), expectedRevision: target.revision })
        setNotice('交付包已撤回，历史记录原样保留。')
      } else {
        await api.supersedeDeliveryPackage(action.packageId, { supersededBy: actionTarget, expectedRevision: target.revision })
        setNotice('已记录显式替代；旧包的审核快照不会迁移到新包。')
      }
      setAction(null)
      setActionText('')
      setActionTarget('')
      refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const actionable = (pkg: DeliveryPackageItem) =>
    pkg.state === 'SEALED' || pkg.state === 'DELIVERED'

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-deliveries">
      <div className="ec-wb-card-head"><h2 id="ec-wb-deliveries">交付包</h2><span className="ec-wb-badge">{packages.total}</span></div>
      <p className="ec-wb-muted">封存≠交付≠接收，各自留痕；撤回要写原因，替代要指明替代者，旧审核不自动迁移。</p>
      {error ? <ErrorBox message={error} onRetry={() => { setError(''); refresh() }} /> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
      {loading && packages.items.length === 0
        ? <p className="ec-wb-muted" role="status">正在读取交付包…</p>
        : !error && packages.items.length === 0
          ? <p className="ec-wb-empty">尚无交付包。运行成功并封存成果后可在此封存为交付包。</p>
          : (
            <div>
              {packages.items.map((pkg) => (
                <div className="ec-wb-row" key={pkg.packageId}>
                  <span className="ec-wb-row-main">
                    <strong>
                      <span className="ec-wb-badge" data-tone={DELIVERY_STATE_TONES[pkg.state]}>{DELIVERY_STATE_LABELS[pkg.state]}</span>
                      {' '}运行 {pkg.runId.slice(0, 8)} · {pkg.manifest.artifacts.length} 项成果
                    </strong>
                    <small className="ec-wb-muted">
                      {formatTime(pkg.createdAt)}
                      {pkg.manifest.review
                        ? ` · 封存时审核：${REVIEW_STATE_LABELS[pkg.manifest.review.state]}`
                        : ' · 封存时该运行未审核'}
                      {pkg.deliveredAt ? ` · 交付于 ${formatTime(pkg.deliveredAt)}` : ''}
                      {pkg.receivedAt ? ` · 接收于 ${formatTime(pkg.receivedAt)}` : ''}
                      {pkg.withdrawReason ? ` · 撤回原因：${pkg.withdrawReason}` : ''}
                      {pkg.supersededBy ? ' · 已指向替代包' : ''}
                      <span className="ec-wb-expert-only"> · <span className="ec-wb-digest">{pkg.packageDigest.slice(0, 12)}…</span></span>
                    </small>
                  </span>
                  <span className="ec-wb-row-actions">
                    {actionable(pkg)
                      ? (
                        <>
                          {pkg.state === 'SEALED'
                            ? <button type="button" className="ec-wb-link" onClick={() => { setAction({ packageId: pkg.packageId, kind: 'deliver' }); setActionText('') }}>记录交付</button>
                            : <button type="button" className="ec-wb-link" onClick={() => { setAction({ packageId: pkg.packageId, kind: 'acknowledge' }); setActionText('') }}>确认接收</button>}
                          <button type="button" className="ec-wb-link" onClick={() => { setAction({ packageId: pkg.packageId, kind: 'withdraw' }); setActionText('') }}>撤回</button>
                          {packages.items.some((other) => other.packageId !== pkg.packageId && actionable(other))
                            ? <button type="button" className="ec-wb-link" onClick={() => { setAction({ packageId: pkg.packageId, kind: 'supersede' }); setActionText(''); setActionTarget('') }}>被替代</button>
                            : null}
                        </>
                      )
                      : null}
                  </span>
                  {action?.packageId === pkg.packageId
                    ? (
                      <div className="ec-wb-action-form" role="group" aria-label="交付包操作">
                        {action.kind === 'supersede'
                          ? (
                            <label>
                              替代者
                              <select value={actionTarget} onChange={(event) => setActionTarget(event.target.value)}>
                                <option value="">选择替代包…</option>
                                {packages.items.filter((other) => other.packageId !== pkg.packageId && actionable(other)).map((other) => (
                                  <option key={other.packageId} value={other.packageId}>
                                    {DELIVERY_STATE_LABELS[other.state]} · 运行 {other.runId.slice(0, 8)} · {formatTime(other.createdAt)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )
                          : (
                            <label>
                              {action.kind === 'withdraw' ? '撤回原因（必填）' : '备注（可空）'}
                              <input value={actionText} onChange={(event) => setActionText(event.target.value)} placeholder={action.kind === 'withdraw' ? '例如：交付对象变更' : ''} />
                            </label>
                          )}
                        <span className="ec-wb-row-actions">
                          <button type="button" className="ec-wb-link" disabled={busy} onClick={() => void runAction()}>确认</button>
                          <button type="button" className="ec-wb-link" onClick={() => setAction(null)}>取消</button>
                        </span>
                      </div>
                    )
                    : null}
                </div>
              ))}
            </div>
          )}
      {!workArchived && succeededRuns.length > 0
        ? (
          <div className="ec-wb-action-form" role="group" aria-label="封存交付包">
            <label>
              封存运行
              <select value={sealRunId} onChange={(event) => setSealRunId(event.target.value)}>
                <option value="">选择已成功的运行…</option>
                {succeededRuns.map((run) => (
                  <option key={run.runId} value={run.runId}>运行 {run.runId.slice(0, 8)} · {formatTime(run.createdAt)}</option>
                ))}
              </select>
            </label>
            <label>
              封存备注（可空）
              <input value={sealNote} onChange={(event) => setSealNote(event.target.value)} placeholder="为什么封存这一批" />
            </label>
            <span className="ec-wb-row-actions">
              <button type="button" className="ec-wb-link" disabled={busy || !sealRunId} onClick={() => void seal()}>封存为交付包</button>
            </span>
          </div>
        )
        : null}
    </section>
  )
}

// ── Declarative result views + key-aligned diffs (E1-4/E1-5) ────────────────

const DIFF_STATE_LABELS: Record<'added' | 'resolved' | 'changed' | 'unchanged', string> = {
  added: '新增', resolved: '已消除', changed: '已变化', unchanged: '未变化',
}
const DIFF_STATE_TONES: Record<'added' | 'resolved' | 'changed' | 'unchanged', string> = {
  added: 'warn', resolved: 'ok', changed: 'warn', unchanged: 'muted',
}
const SEVERITY_LABELS: Record<string, string> = { info: '提示', warning: '警示', error: '错误' }

/** Renders the app's declared result views from its contributed findings. The platform reads the
 *  descriptor and the data — it never branches on which application produced the numbers, and a
 *  field a finding does not carry renders as empty, never as an invented value. */
function ResultViewsCard({ api, run, resultViews, comparableRunIds }: {
  api: WorkbenchApi
  run: RunSummary
  resultViews: ResultViewDecl[]
  comparableRunIds: Array<{ runId: string; label: string }>
}) {
  const [findings, setFindings] = useState<FindingItem[] | null>(null)
  const [error, setError] = useState('')
  const [against, setAgainst] = useState('')
  const [diff, setDiff] = useState<FindingsDiff | null>(null)
  const [diffError, setDiffError] = useState('')

  useEffect(() => {
    let live = true
    setFindings(null)
    setError('')
    void (async () => {
      try {
        const page = await api.runFindings(run.runId)
        if (live) setFindings(page.items)
      } catch (reason) {
        if (live) setError(errorText(reason))
      }
    })()
    return () => { live = false }
  }, [api, run.runId])

  useEffect(() => {
    if (!against) { setDiff(null); setDiffError(''); return }
    let live = true
    setDiffError('')
    void (async () => {
      try {
        // from = the earlier run, to = the selected run: "added" means new in the selected run.
        const result = await api.runFindingsDiff(against, run.runId)
        if (live) setDiff(result)
      } catch (reason) {
        if (live) { setDiff(null); setDiffError(errorText(reason)) }
      }
    })()
    return () => { live = false }
  }, [api, against, run.runId])

  const metricStat = (stat: 'count' | 'sum' | 'avg', values: number[]): string => {
    if (stat === 'count') return String(values.length)
    if (values.length === 0) return '—'
    if (stat === 'sum') return String(values.reduce((sum, value) => sum + value, 0))
    return String(Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000)
  }

  if (!resultViews.length && (findings === null || findings.length === 0)) return null

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-result-views">
      <div className="ec-wb-card-head"><h2 id="ec-wb-result-views">结果视图</h2><span className="ec-wb-badge">{findings?.length ?? '…'}</span></div>
      <p className="ec-wb-muted">视图由应用声明、平台按声明渲染；发现按稳定业务键对齐，不按行号或顺序。</p>
      {error ? <ErrorBox message={`无法读取结果发现：${error}`} onRetry={() => setAgainst((value) => value)} /> : null}
      {comparableRunIds.length > 0
        ? (
          <label className="ec-wb-inline-field">
            与更早的运行按业务键比较
            <select value={against} onChange={(event) => setAgainst(event.target.value)}>
              <option value="">选择比较对象…</option>
              {comparableRunIds.map((candidate) => (
                <option key={candidate.runId} value={candidate.runId}>{candidate.label} → 本运行</option>
              ))}
            </select>
          </label>
        )
        : null}
      {diffError ? <p className="ec-wb-error-text" role="alert">无法比较：{diffError}</p> : null}
      {diff && !diff.comparable
        ? <p className="ec-wb-empty">这两次运行不可比较（{diff.reason === 'APP_MISMATCH' ? '不同应用' : '应用版本不同'}）——键的含义可能已变，平台不猜测对齐。</p>
        : null}
      {diff?.comparable
        ? diff.kinds!.map((kind) => (
          <div key={kind.kind} className="ec-wb-diff-block">
            <strong className="ec-wb-diff-kind">{kind.kind}：新增 {kind.added} · 已消除 {kind.resolved} · 已变化 {kind.changed} · 未变化 {kind.unchanged}</strong>
            {kind.items.filter((item) => item.state !== 'unchanged').map((item) => (
              <div className="ec-wb-row" key={item.key}>
                <span className="ec-wb-row-main">
                  <strong>{item.key}</strong>
                  <small className="ec-wb-muted">{item.after?.summary ?? item.before?.summary ?? ''}</small>
                </span>
                <span className="ec-wb-badge" data-tone={DIFF_STATE_TONES[item.state]}>{DIFF_STATE_LABELS[item.state]}</span>
              </div>
            ))}
          </div>
        ))
        : null}
      {(resultViews.length > 0 && findings !== null)
        ? resultViews.map((view) => {
          const rows = findings.filter((finding) => finding.kind === view.findingKind)
          return (
            <div key={view.viewId} className="ec-wb-view-block">
              <strong className="ec-wb-diff-kind">{view.title}（{rows.length}）</strong>
              {rows.length === 0
                ? <p className="ec-wb-empty">该视图暂无数据。</p>
                : view.kind === 'table'
                  ? (
                    <table className="ec-wb-finding-table">
                      <thead><tr>{view.columns!.map((column) => <th key={column.field}>{column.label}</th>)}</tr></thead>
                      <tbody>
                        {rows.map((finding) => (
                          <tr key={finding.key}>
                            {view.columns!.map((column) => {
                              const value = finding.fields?.[column.field]
                              return <td key={column.field}>{value === undefined ? '' : String(value)}</td>
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                  : (
                    <ul className="ec-wb-metric-list">
                      {view.metrics!.map((metric) => {
                        const values = rows
                          .map((finding) => finding.fields?.[metric.field])
                          .filter((value): value is number => typeof value === 'number')
                        return (
                          <li key={metric.field}>
                            {metric.label}：{metricStat(metric.stat, values)}{metric.unit ?? ''}
                          </li>
                        )
                      })}
                    </ul>
                  )}
            </div>
          )
        })
        : null}
      {resultViews.length === 0 && findings !== null && findings.length > 0
        ? (
          <div>
            {findings.map((finding) => (
              <div className="ec-wb-row" key={finding.key}>
                <span className="ec-wb-row-main">
                  <strong>{finding.key}</strong>
                  <small className="ec-wb-muted">{finding.summary ?? ''}{finding.severity ? ` · ${SEVERITY_LABELS[finding.severity] ?? finding.severity}` : ''}</small>
                </span>
              </div>
            ))}
          </div>
        )
        : null}
    </section>
  )
}

// ── Work console ─────────────────────────────────────────────────────────────

/** How often the console re-reads durable run records while it is on screen. The conversation
 *  itself streams natively; this only keeps the enterprise rail's facts current. */
const CONSOLE_REFRESH_MS = 15_000

/**
 * The work console: an enterprise head and a run rail around the *native* conversation. The
 * thread column is the upstream factory unchanged — no second message list, tool renderer or
 * composer is created here. The rail reads durable control-plane facts (runs, sealed artifacts)
 * and says so when a Work has no execution record yet.
 */
/** Durable run-ledger events (E0b): the state transitions the control plane persisted, newest
 *  first. Unlike the live activity window, these survive a control-plane restart. */
const RUN_EVENT_LABELS: Record<string, string> = {
  cancel: '请求停止', dispatch: '派发', started: '已启动', barrier: '完成屏障', finish: '已完成',
  fail: '失败', unknown: '结果未知', 'cancel-settled': '停止已确认',
}
function RunEvents({ api, runId, token }: { api: WorkbenchApi; runId: string; token: number }) {
  const [events, setEvents] = useState<RunEventItem[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    setLoading(true)
    void (async () => {
      try {
        const page = await api.runEvents(runId, { offset: 0, limit: 50 })
        if (!live) return
        setEvents(page.items)
        setError('')
      } catch (reason) {
        if (!live) return
        setEvents([])
        setError(errorText(reason))
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [api, runId, token])
  return (
    <section className="ec-wb-card ec-wb-run-events" aria-label="运行事件历史">
      <div className="ec-wb-card-head"><h3>运行事件</h3><span className="ec-wb-badge">{events.length}</span></div>
      <p className="ec-wb-muted">控制面持久化的状态转移，重启不丢；与上方实时活动窗口不同。</p>
      {error ? <p className="ec-wb-error-text" role="alert">无法读取运行事件：{error}</p>
        : loading && events.length === 0 ? <p className="ec-wb-muted" role="status">正在读取运行事件…</p>
        : events.length === 0 ? <p className="ec-wb-empty">该运行没有已记录的事件。</p>
        : events.map((item) => (
          <div className="ec-wb-row" key={item.sequence}>
            <span className="ec-wb-row-main">
              <strong>{RUN_EVENT_LABELS[item.event?.type] ?? item.event?.type ?? '事件'}</strong>
              <small className="ec-wb-muted">{formatTime(item.createdAt)} · {item.actor}{typeof item.event?.reason === 'string' ? ` · ${item.event.reason}` : ''}</small>
            </span>
            <span className="ec-wb-badge">#{item.sequence}</span>
          </div>
        ))}
    </section>
  )
}

function WorkConsole({ api, workId, title, modelLabel, models, onBack, onDetail, onReload, initialRunId, onFocusRun, children }: {
  api: WorkbenchApi
  workId: string
  title: string
  modelLabel: string
  models?: WorkbenchBootstrap['models']
  onBack(): void
  onDetail(): void
  /** Refresh the shell bootstrap so the home counters reflect a run this console just changed. */
  onReload(): Promise<void>
  /** Run to focus on open — a refresh restore re-enters the run the employee had selected. */
  initialRunId?: string
  /** The employee's focused run, mirrored to the persisted view coordinate for refresh survival. */
  onFocusRun?(runId: string | null): void
  children: ReactNode
}) {
  const [context, setContext] = useState<WorkContext | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [runsTotal, setRunsTotal] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null)
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([])
  const [error, setError] = useState('')
  const [artifactsError, setArtifactsError] = useState('')
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [token, setToken] = useState(0)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)
  const [downloadNotice, setDownloadNotice] = useState('')
  // SSE drives live run updates when connected; the 15s poll is the fallback. A ref lets the
  // mount-time interval read the latest liveness without re-subscribing.
  const sseLiveRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const [resolved, page] = await Promise.all([
        api.workContext(workId),
        api.workRuns(workId, { offset: 0, limit: 5 }),
      ])
      setContext(resolved)
      setRuns(page.items)
      setRunsTotal(page.total)
      setError('')
      setLastLoadedAt(Date.now())
      // Preserve the employee's content choice across auto-refresh: null means live chat and must
      // not be yanked into a run record just because runs exist. A focused run that still exists is
      // kept; one that vanished falls back to live chat, never an arbitrary auto-selected run.
      setSelectedRunId((previous) => previous && page.items.some((run) => run.runId === previous)
        ? previous
        : null)
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [api, workId])

  useEffect(() => { void load() }, [load, token])
  useEffect(() => {
    const timer = setInterval(() => {
      // SSE drives live updates when connected; polling is the fallback when it is unavailable.
      if (globalThis.document?.visibilityState === 'visible' && !sseLiveRef.current) setToken((value) => value + 1)
    }, CONSOLE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  // Live run events via SSE (E0b): a durable event notifies the rail to refresh, replacing blind
  // polling. On any error the stream closes and the poll fallback resumes — never a fake live state.
  useEffect(() => {
    const EventSourceCtor = globalThis.EventSource
    if (!selectedRunId || typeof EventSourceCtor !== 'function') { sseLiveRef.current = false; return undefined }
    const source = new EventSourceCtor(`${API_BASE}/api/runs/${encodeURIComponent(selectedRunId)}/events/stream?after=0`)
    const onOpen = (): void => { sseLiveRef.current = true }
    const onMessage = (): void => { setToken((value) => value + 1) }
    const onError = (): void => { sseLiveRef.current = false; source.close() }
    source.addEventListener('open', onOpen)
    source.addEventListener('message', onMessage)
    source.addEventListener('error', onError)
    return () => {
      source.removeEventListener('open', onOpen)
      source.removeEventListener('message', onMessage)
      source.removeEventListener('error', onError)
      source.close()
      sseLiveRef.current = false
    }
  }, [selectedRunId])

  useEffect(() => {
    if (!selectedRunId) { setArtifacts([]); setArtifactsError(''); return undefined }
    let live = true
    setArtifactsLoading(true)
    void (async () => {
      try {
        const result = await api.runArtifacts(selectedRunId)
        if (!live) return
        setArtifacts(result.items)
        setArtifactsError('')
      } catch (reason) {
        if (!live) return
        setArtifacts([])
        setArtifactsError(errorText(reason))
      } finally {
        if (live) setArtifactsLoading(false)
      }
    })()
    return () => { live = false }
  }, [api, selectedRunId, token])

  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null
  // Inspecting a run record shows that run's own frozen model, resolved to its catalog display name
  // — not the shell default, which only describes future live chat.
  const runModelLabel = selectedRun?.model
    ? (models?.catalog?.entries.find((entry) => entry.selectionId === selectedRun.model?.selectionId)?.displayName
      || selectedRun.model.selectionId)
    : '未记录'
  const control = useRunControl(api, selectedRun, () => { setToken((value) => value + 1); void onReload() })
  const state = selectedRun?.snapshot?.state
  const terminal = state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED'
  const archived = context?.work.state === 'ARCHIVED'
  const pill = selectedRun
    ? { label: runStateText(state), tone: runTone(state) }
    : archived
      ? { label: '已归档', tone: 'muted' }
      : runs.length > 0
        ? { label: 'AI 对话', tone: 'muted' }
        : { label: '尚无运行记录', tone: 'muted' }
  const summary = summarizeArtifacts(artifacts)

  return (
    <div className="ec-wb-console">
      <header className="ec-wb-console-head">
        <div>
          <div className="ec-wb-console-crumb">
            <button type="button" className="ec-wb-back-link" onClick={onBack}>← 返回</button>
            <span>{context ? context.project.name : '正在读取项目'}</span>
            <span aria-hidden="true">·</span>
            <span>{context ? context.app.displayName : '正在读取应用'}</span>
            <span aria-hidden="true">·</span>
            <span>{selectedRun ? `运行 ${selectedRun.runId.slice(0, 8)}` : '对话'}</span>
          </div>
          <div className="ec-wb-console-title-row">
            <h2 className="ec-wb-console-title">{context?.work.title ?? title}</h2>
            <span className="ec-wb-pill" data-tone={pill.tone}>{pill.label}</span>
          </div>
        </div>
        <div className="ec-wb-console-actions">
          <Freshness at={lastLoadedAt} onRefresh={() => setToken((value) => value + 1)} />
          <div className="ec-wb-segmented" role="group" aria-label="中心内容">
            <button type="button" aria-pressed={!selectedRun}
              onClick={() => { setSelectedRunId(null); onFocusRun?.(null) }}>{t('label.liveChat')}</button>
            <button type="button" aria-pressed={!!selectedRun} disabled={runs.length === 0}
              title={runs.length === 0 ? '这项工作还没有运行记录' : undefined}
              onClick={() => {
                const target = selectedRunId ?? runs[0]?.runId ?? null
                if (target) { setSelectedRunId(target); onFocusRun?.(target) }
              }}>{t('label.runRecord')}</button>
          </div>
          <button type="button" className="ec-wb-button" onClick={onDetail}>{t('action.viewDetail')}</button>
          <button type="button" className="ec-wb-button ec-wb-stop"
            disabled={!selectedRun || !!control.busy || terminal || state === 'UNKNOWN'}
            onClick={() => void control.act('cancel')}>
            {control.busy === 'cancel' ? '请求中…' : t('action.stop')}
          </button>
        </div>
      </header>

      <div className="ec-wb-console-body">
        {/* The center shows exactly one thing, and says which. A selected run shows its record;
            with none selected the bound native conversation streams as usual. The switch above is
            the explicit control — clicking a rail row is a shortcut, never the only way back. */}
        <div className="ec-wb-console-center">
          {selectedRun
            ? (
              <>
                <div className="ec-wb-mode-banner" role="status">
                  <span>{t('hint.viewingRunRecord')} · 运行 {selectedRun.runId.slice(0, 8)} · {runStateText(selectedRun.snapshot?.state)}</span>
                  <button type="button" onClick={() => { setSelectedRunId(null); onFocusRun?.(null) }}>{t('hint.returnToChat')}</button>
                </div>
                <RunTranscript api={api} runId={selectedRun.runId} token={token} onRetryError={() => setToken((value) => value + 1)} />
                <RunEvents api={api} runId={selectedRun.runId} token={token} />
              </>
            )
            : <div className="ec-wb-console-thread">{children}</div>}
        </div>
        <aside className="ec-wb-console-rail" aria-label="运行信息">
          {error ? <ErrorBox message={`无法读取运行信息：${error}`} onRetry={() => setToken((value) => value + 1)} /> : null}

          <section className="ec-wb-card" aria-labelledby="ec-wb-console-state">
            <div className="ec-wb-card-head">
              <h3 id="ec-wb-console-state">运行状态</h3>
            </div>
            <div>
              <div className="ec-wb-fact-line"><span>当前状态</span><span>{pill.label}</span></div>
              <div className="ec-wb-fact-line"><span>运行编号</span><span>{selectedRun ? selectedRun.runId.slice(0, 8) : '暂无'}</span></div>
              <div className="ec-wb-fact-line"><span>开始时间</span><span>{selectedRun ? formatTime(selectedRun.createdAt) : '暂无'}</span></div>
              <div className="ec-wb-fact-line"><span>{selectedRun ? '运行模型' : '默认模型'}</span><span>{selectedRun ? runModelLabel : (modelLabel || '尚未登记')}</span></div>
              <div className="ec-wb-fact-line"><span>工作空间</span><span>{context?.workspace ? <>{context.workspace.name}<span className="ec-wb-expert-only"> · {context.workspace.directory}</span></> : '未选择'}</span></div>
            </div>
            {selectedRun && (terminal || state === 'UNKNOWN')
              ? (
                <div className="ec-wb-form-actions">
                  <button type="button" className="ec-wb-button" disabled={!!control.busy || !terminal}
                    onClick={() => void control.act('retry')}>{control.busy === 'retry' ? '提交中…' : '重试运行'}</button>
                  {state === 'UNKNOWN'
                    ? (
                      <button type="button" className="ec-wb-button" disabled={!!control.busy}
                        onClick={() => void control.act('reconcile')}>{control.busy === 'reconcile' ? '确认中…' : '确认已停止'}</button>
                    )
                    : null}
                </div>
              )
              : null}
            {control.error ? <p className="ec-wb-error-text" role="alert">{control.error}</p> : null}
            {control.notice ? <p className="ec-wb-muted" role="status">{control.notice}</p> : null}
          </section>

          <section className="ec-wb-card" aria-labelledby="ec-wb-console-artifacts">
            <div className="ec-wb-card-head">
              <h3 id="ec-wb-console-artifacts">文件成果</h3>
              <span className="ec-wb-badge">{summary.total}</span>
            </div>
            {!selectedRun
              ? <p className="ec-wb-empty">此工作还没有执行记录。普通问答可以没有成果。</p>
              : artifactsError
                ? <ErrorBox message={`无法读取成果：${artifactsError}`} onRetry={() => setToken((value) => value + 1)} />
                : artifactsLoading && artifacts.length === 0
                  ? <p className="ec-wb-muted" role="status">正在读取成果…</p>
                  : artifacts.length === 0
                    ? <p className="ec-wb-empty">该运行没有登记成果。这不代表执行失败，也不代表业务审核通过。</p>
                    : (
                    <>
                      <p className="ec-wb-muted">已封存 {summary.sealed} 项，共 {formatBytes(summary.bytes)}。</p>
                      <div>
                        {artifacts.slice(0, 5).map((artifact) => (
                          <div className="ec-wb-artifact-row" key={artifact.name}>
                            <span className="ec-wb-file-dot" aria-hidden="true">{(artifact.name.split('.').pop() ?? 'f').slice(0, 1)}</span>
                            <span className="ec-wb-row-main">
                              <strong>{artifact.name}</strong>
                              <small>{formatBytes(artifact.bytes)} · {artifact.sealedAt ? '已封存' : '待封存'}</small>
                            </span>
                            {artifact.sealedAt
                              ? <button type="button" className="ec-wb-link" onClick={() => {
                                setDownloadNotice('')
                                void saveArtifact(selectedRun.runId, artifact.name)
                                  .catch((reason: unknown) => setDownloadNotice(`下载失败：${errorText(reason)}`))
                              }}>下载</button>
                              : null}
                          </div>
                        ))}
                      </div>
                      {artifacts.length > 5 ? <button type="button" className="ec-wb-text-link" onClick={onDetail}>查看全部 {artifacts.length} 项</button> : null}
                    </>
                  )}
            {downloadNotice ? <p className="ec-wb-error-text" role="alert">{downloadNotice}</p> : null}
          </section>

          <section className="ec-wb-card" aria-labelledby="ec-wb-console-runs">
            <div className="ec-wb-card-head">
              <h3 id="ec-wb-console-runs">运行历史</h3>
              <span className="ec-wb-badge">{runsTotal}</span>
            </div>
            <button type="button" className="ec-wb-run-row" aria-current={selectedRunId === null}
              onClick={() => { setSelectedRunId(null); onFocusRun?.(null) }}>
              <span className="ec-wb-run-dot" data-tone={selectedRunId === null ? 'ok' : 'muted'} aria-hidden="true" />
              <span className="ec-wb-row-main">
                <strong>会话对话</strong>
                <small>绑定会话的实时问答</small>
              </span>
            </button>
            {runs.length === 0
              ? <p className="ec-wb-empty">此工作还没有执行记录。</p>
              : runs.map((run) => (
                <button type="button" className="ec-wb-run-row" key={run.runId}
                  aria-current={run.runId === selectedRunId}
                  onClick={() => { setSelectedRunId(run.runId); onFocusRun?.(run.runId) }}>
                  <span className="ec-wb-run-dot" data-tone={runTone(run.snapshot?.state)} aria-hidden="true" />
                  <span className="ec-wb-row-main">
                    <strong>运行 {run.runId.slice(0, 8)}</strong>
                    <small>{relativeTime(run.createdAt, Date.now())} · {runStateText(run.snapshot?.state)}</small>
                  </span>
                </button>
              ))}
            {runsTotal > runs.length ? <button type="button" className="ec-wb-text-link" onClick={onDetail}>查看全部 {runsTotal} 次运行</button> : null}
          </section>
        </aside>
      </div>
    </div>
  )
}

// ── Enterprise pages ─────────────────────────────────────────────────────────

/** The home launch entry. Quick targets are the applications this employee actually used most
 *  recently (falling back to the published catalogue), never a hard-coded product list. */
function LaunchPanel({ data, projectId, onProjectChange, onStart }: {
  data: WorkbenchBootstrap
  projectId: string
  onProjectChange(projectId: string): void
  onStart(appKey?: string): void
}) {
  const projects = data.projects ?? []
  const apps = (data.apps ?? []).filter((app) => app.state === 'ACTIVE')
  const labelOf = (appId: string, appVersion: string) => {
    const app = apps.find((candidate) => candidate.appId === appId && candidate.appVersion === appVersion)
    return app?.descriptor?.displayName ?? app?.displayName ?? appId
  }
  const used: string[] = []
  for (const work of byRecent(data.works?.items ?? [])) {
    const key = `${work.appId}|${work.appVersion}`
    if (!used.includes(key) && apps.some((app) => `${app.appId}|${app.appVersion}` === key)) used.push(key)
  }
  const quick = (used.length > 0 ? used : apps.map((app) => `${app.appId}|${app.appVersion}`)).slice(0, 3)
  const modelLabel = defaultModelLabel(data.models)

  return (
    <section className="ec-wb-card ec-wb-launch" aria-labelledby="ec-wb-launch-entry">
      <div className="ec-wb-launch-intro">
        <div className="ec-wb-launch-title">
          <span className="ec-wb-orb" aria-hidden="true">{GLYPH_SPARK}</span>
          <div>
            <div className="ec-wb-launch-label">AI 工作入口</div>
            <h2 id="ec-wb-launch-entry">你现在想完成什么？</h2>
            <p className="ec-wb-launch-desc">说明目标即可，AI 会使用已发布的专业应用与工具。</p>
          </div>
        </div>
        {quick.length > 0
          ? (
            <div className="ec-wb-quick">
              <span>{used.length > 0 ? '最近使用' : '可用应用'}</span>
              {quick.map((key) => {
                const [appId, appVersion] = key.split('|')
                return (
                  <button type="button" className="ec-wb-quick-target" key={key} onClick={() => onStart(key)}>
                    <b aria-hidden="true">↗</b>{labelOf(appId, appVersion)}
                  </button>
                )
              })}
            </div>
          )
          : <p className="ec-wb-muted">当前没有可用的应用发布；应用中心会显示平台已登记的应用。</p>}
      </div>
      <div className="ec-wb-launch-controls">
        <span className="ec-wb-field-label">选择工作项目</span>
        {projects.length === 0
          ? <p className="ec-wb-empty">尚未创建项目。请先在「项目空间」登记。</p>
          : (
            <select className="ec-wb-select" aria-label="选择工作项目" value={projectId}
              onChange={(event) => onProjectChange(event.target.value)}>
              {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
            </select>
          )}
        <div className="ec-wb-model-row"><span>默认模型</span><strong>{modelLabel ?? '尚未登记'}</strong></div>
        <button type="button" className="ec-wb-launch-go" disabled={projects.length === 0} onClick={() => onStart()}>
          新建工作 <span aria-hidden="true">↗</span>
        </button>
      </div>
    </section>
  )
}

/** What the platform can actually do right now. Every line is a recorded fact: an unpublished
 *  catalogue or an unconfigured executor is shown as pending, never as ready. */
function ReadinessPanel({ data, onOpenSettings }: { data: WorkbenchBootstrap; onOpenSettings(): void }) {
  const apps = (data.apps ?? []).filter((app) => app.state === 'ACTIVE').length
  const models = modelChoices(data.models?.catalog, data.models?.preference).filter((choice) => choice.available).length
  const executor = data.status?.executor
  const executorReady = typeof executor === 'string' && executor.length > 0 && executor !== 'not-configured'
  const ready = apps > 0 && models > 0 && executorReady
  const lines: Array<{ tone: 'ok' | 'pending'; text: string }> = [
    { tone: apps > 0 ? 'ok' : 'pending', text: apps > 0 ? `应用目录已加载 · ${apps} 个可用` : '尚无可用的应用发布' },
    { tone: models > 0 ? 'ok' : 'pending', text: models > 0 ? `模型目录可选择 · ${models} 个可用` : '模型目录尚未登记' },
    { tone: executorReady ? 'ok' : 'pending', text: executorReady ? `Worker 执行器 ${executor}` : 'Worker 执行器尚未配置' },
  ]
  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-readiness">
      <div className="ec-wb-readiness-top">
        <h3 id="ec-wb-readiness">运行就绪</h3>
        <span className="ec-wb-state-tag" data-tone={ready ? 'ok' : 'warn'}>{ready ? '可以发起运行' : '执行器待配置'}</span>
      </div>
      <p className="ec-wb-muted">开始运行前，平台将确认当前环境能力。</p>
      <div className="ec-wb-checks">
        {lines.map((line) => (
          <div className="ec-wb-checkline" key={line.text}>
            <span className="ec-wb-tick" data-tone={line.tone} aria-hidden="true">{line.tone === 'ok' ? GLYPH_CHECK : '…'}</span>
            {line.text}
          </div>
        ))}
      </div>
      <button type="button" className="ec-wb-readiness-link" onClick={onOpenSettings}>
        <span>查看平台状态</span><span aria-hidden="true">›</span>
      </button>
    </section>
  )
}

/** One page of the full Works list. The control plane caps a page, so "load all" keeps asking
 *  until it has every record instead of searching a silently truncated set. */
const WORKS_PAGE = 100
const WORKS_LOAD_CAP = 5000

/** The Works queue: live search over title/project/application, a state filter and three orders,
 *  one row per Work with its latest recorded run state. A Work with no run record says so instead
 *  of implying progress, and a partially loaded catalogue is labelled as partial. */
function WorksQueue({ api, data, onOpenWork, onDetail, opening }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  onOpenWork(workId: string): void
  onDetail(work: WorkbenchItem): void
  opening: string
}) {
  const [query, setQuery] = useState('')
  const [stateFilter, setStateFilter] = useState<'active' | 'archived' | 'all'>('active')
  const [sort, setSort] = useState<'recent' | 'title' | 'project'>('recent')
  const [extra, setExtra] = useState<WorkbenchItem[]>([])
  const [loadingAll, setLoadingAll] = useState(false)
  const [loadError, setLoadError] = useState('')

  const projects = data.projects ?? []
  const runs = data.runs?.items ?? []
  const now = Date.now()
  const projectName = (id: string) => projects.find((project) => project.projectId === id)?.name ?? id
  const appLabel = (appId: string, appVersion: string) => {
    const app = (data.apps ?? []).find((candidate) => candidate.appId === appId && candidate.appVersion === appVersion)
    return app?.descriptor?.displayName ?? app?.displayName ?? appId
  }

  // Bootstrap records are fresher than anything loaded earlier, so they win on id; records only
  // present in the extended load are kept so a refresh never shrinks the list back to one page.
  const merged = new Map<string, WorkbenchItem>()
  for (const work of extra) merged.set(work.workId, work)
  for (const work of data.works?.items ?? []) merged.set(work.workId, work)
  const all = [...merged.values()]
  const total = Math.max(data.works?.total ?? 0, all.length)
  const complete = all.length >= total

  const toRow = (work: WorkbenchItem): WorkRow => ({
    workId: work.workId,
    title: work.title,
    state: work.state,
    ...(work.updatedAt ? { updatedAt: work.updatedAt } : {}),
    projectId: work.projectId,
    projectName: projectName(work.projectId),
    appId: work.appId,
    appVersion: work.appVersion,
    appName: appLabel(work.appId, work.appVersion),
  })
  const rows: WorkRow[] = all.map(toRow)
  // E4-3: a search is a server-side query over the whole catalogue, cursor-paginated — it never
  // depends on which bootstrap page happened to be loaded.
  const serverQuery = query.trim()
  const [server, setServer] = useState<{ rows: WorkRow[]; items: WorkbenchItem[]; cursor: string | null } | null>(null)
  const [serverBusy, setServerBusy] = useState(false)
  const [serverError, setServerError] = useState('')
  const serverState = stateFilter === 'active' ? 'ACTIVE' : stateFilter === 'archived' ? 'ARCHIVED' : undefined
  useEffect(() => {
    if (!serverQuery) { setServer(null); setServerError(''); return undefined }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setServerBusy(true)
      api.queryWorks(
        { q: serverQuery, ...(serverState ? { state: serverState } : {}) },
        controller.signal,
      )
        .then((page) => {
          if (controller.signal.aborted) return
          setServer({ rows: page.items.map(toRow), items: page.items, cursor: page.nextCursor })
          setServerError('')
        })
        .catch((reason) => {
          if (controller.signal.aborted || (reason as Error)?.name === 'AbortError') return
          setServer(null)
          setServerError(`服务器搜索失败：${errorText(reason)}`)
        })
        .finally(() => {
          if (!controller.signal.aborted) setServerBusy(false)
        })
    }, 250)
    return () => { controller.abort(); clearTimeout(timer) }
    // toRow/serverState derive from data and stateFilter; the query string is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverQuery, stateFilter])
  const loadMore = async () => {
    if (!server?.cursor || !serverQuery) return
    setServerBusy(true)
    try {
      const page = await api.queryWorks({
        q: serverQuery,
        ...(serverState ? { state: serverState } : {}),
        cursor: server.cursor,
      })
      setServer((prev) => (prev
        ? { rows: [...prev.rows, ...page.items.map(toRow)], items: [...prev.items, ...page.items], cursor: page.nextCursor }
        : prev))
    } catch (reason) {
      setServerError(`未能加载更多结果：${errorText(reason)}`)
    } finally {
      setServerBusy(false)
    }
  }
  const serverMode = serverQuery.length > 0
  const visible = serverMode && server ? server.rows : selectWorkRows(rows, { query, state: stateFilter, sort })
  // Server hits may sit outside the bootstrap page; they must still open, so they join byId.
  const byId = new Map([...all, ...(server?.items ?? [])].map((work) => [work.workId, work]))
  const archivedCount = all.filter((work) => work.state === 'ARCHIVED').length
  const filtering = query.trim().length > 0 || stateFilter !== 'active' || sort !== 'recent'

  const loadAll = async () => {
    setLoadingAll(true)
    setLoadError('')
    const collected = new Map<string, WorkbenchItem>()
    try {
      let offset = 0
      for (;;) {
        const page = await api.listWorks(undefined, { offset, limit: WORKS_PAGE })
        for (const work of page.items) collected.set(work.workId, work)
        offset += page.items.length
        if (page.items.length < WORKS_PAGE || offset >= page.total || offset >= WORKS_LOAD_CAP) break
      }
      setExtra([...collected.values()])
      if (offset >= WORKS_LOAD_CAP && offset < total) {
        setLoadError(`工作数量超过单次加载上限 ${WORKS_LOAD_CAP} 项，已加载前 ${offset} 项；请用搜索缩小范围。`)
      }
    } catch (reason) {
      setLoadError(`未能加载全部工作：${errorText(reason)}`)
    } finally {
      setLoadingAll(false)
    }
  }

  const stateOf = (work: WorkbenchItem): { label: string; tone: string } => {
    const run = runs.find((candidate) => candidate.workId === work.workId)
    if (run) return { label: runStateText(run.snapshot?.state), tone: runTone(run.snapshot?.state) }
    return work.state === 'ARCHIVED' ? { label: '已归档', tone: 'muted' } : { label: '未发起运行', tone: 'muted' }
  }

  const resetFilters = () => { setQuery(''); setStateFilter('active'); setSort('recent') }
  const missing = Math.max(0, total - all.length)

  return (
    <section className="ec-wb-card ec-wb-queue" aria-labelledby="ec-wb-queue">
      <div className="ec-wb-queue-head">
        <div>
          <h2 id="ec-wb-queue">继续最近的工作</h2>
          <p className="ec-wb-muted">所有运行进度与工作成果都留在项目空间中。</p>
        </div>
        <div className="ec-wb-queue-tools">
          <div className="ec-wb-search">
            <span className="ec-wb-search-glyph" aria-hidden="true"><Glyph size={13}>{SEARCH_PATHS}</Glyph></span>
            <input
              className="ec-wb-input ec-wb-search-input"
              type="search"
              aria-label="搜索工作、项目或应用"
              placeholder="搜索工作、项目或应用"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query
              ? <button type="button" className="ec-wb-search-clear" aria-label="清除搜索" onClick={() => setQuery('')}>×</button>
              : null}
          </div>
          <select className="ec-wb-select ec-wb-queue-select" aria-label="按状态筛选"
            value={stateFilter} onChange={(event) => setStateFilter(event.target.value as 'active' | 'archived' | 'all')}>
            <option value="active">进行中</option>
            <option value="archived">已归档{archivedCount > 0 ? ` (${archivedCount})` : ''}</option>
            <option value="all">全部状态</option>
          </select>
          <select className="ec-wb-select ec-wb-queue-select" aria-label="排序方式"
            value={sort} disabled={serverMode}
            title={serverMode ? '搜索结果由服务器按最近活动排序' : undefined}
            onChange={(event) => setSort(event.target.value as 'recent' | 'title' | 'project')}>
            <option value="recent">最近活动</option>
            <option value="title">工作名称</option>
            <option value="project">按项目</option>
          </select>
        </div>
      </div>
      {visible.length === 0
        ? (
          <div className="ec-wb-queue-empty">
            <p className="ec-wb-empty">
              {serverMode
                ? (server
                  ? '服务器全库搜索没有匹配的工作。换个关键词，或放宽状态筛选。'
                  : serverError || '正在服务器上搜索…')
                : all.length === 0
                  ? '还没有工作。用上方入口新建一项；打开工作即可直接对话。'
                  : filtering && missing > 0
                    ? `已加载的 ${all.length} 项里没有匹配；其余 ${missing} 项尚未加载，可能就在其中。`
                    : filtering
                      ? '没有匹配的工作。换个关键词，或放宽状态筛选。'
                      : `没有进行中的工作。已归档的 ${archivedCount} 项记录与成果仍可查阅。`}
            </p>
            {all.length > 0
              ? (
                <div className="ec-wb-form-actions">
                  {!serverMode && filtering && missing > 0
                    ? (
                      <button type="button" className="ec-wb-button ec-wb-primary" disabled={loadingAll}
                        onClick={() => void loadAll()}>
                        {loadingAll ? '正在加载…' : `加载其余 ${missing} 项后再搜索`}
                      </button>
                    )
                    : null}
                  {filtering ? <button type="button" className="ec-wb-button" onClick={resetFilters}>清除筛选</button> : null}
                  {stateFilter === 'active' && archivedCount > 0
                    ? <button type="button" className="ec-wb-button" onClick={() => setStateFilter('archived')}>查看已归档 {archivedCount} 项</button>
                    : null}
                </div>
              )
              : null}
          </div>
        )
        : (
          <div className="ec-wb-table" role="table" aria-label="最近工作" aria-busy={opening !== '' || serverBusy}>
            <div className="ec-wb-table-head" role="row">
              <span role="columnheader">工作</span>
              <span role="columnheader">专业应用</span>
              <span role="columnheader">运行状态</span>
              <span role="columnheader">最近活动</span>
              <span role="columnheader"><span className="ec-wb-sr">操作</span></span>
            </div>
            {visible.map((row) => {
              const work = byId.get(row.workId)
              if (!work) return null
              const state = stateOf(work)
              return (
                <div className="ec-wb-work-row" role="row" key={row.workId}>
                  <span className="ec-wb-work-name" role="cell">
                    <span className="ec-wb-work-icon" aria-hidden="true">{monogram(row.title)}</span>
                    <button type="button" className="ec-wb-work-open" onClick={() => onOpenWork(row.workId)}>
                      <strong>{row.title}</strong>
                      <small>{row.projectName}</small>
                    </button>
                  </span>
                  <span className="ec-wb-app-cell" role="cell">{row.appName}</span>
                  <span role="cell"><span className="ec-wb-state" data-tone={state.tone}>{state.label}</span></span>
                  <span className="ec-wb-updated" role="cell">{relativeTime(row.updatedAt, now)}</span>
                  <span className="ec-wb-work-tail" role="cell">
                    <button type="button" className="ec-wb-button" onClick={() => onDetail(work)}>详情</button>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      {serverError ? <p className="ec-wb-error-text ec-wb-queue-note" role="alert">{serverError}</p> : null}
      {loadError ? <p className="ec-wb-error-text ec-wb-queue-note" role="alert">{loadError}</p> : null}
      <div className="ec-wb-queue-foot">
        <i aria-hidden="true" />
        <span aria-live="polite">
          {filtering ? `筛选出 ${visible.length} 项` : `${visible.length} 项工作`}
          {serverMode || complete ? '' : ` · 已加载 ${all.length}/${total}`}
        </span>
        {serverMode
          ? (server?.cursor
            ? (
              <button type="button" className="ec-wb-text-link ec-wb-foot-right" disabled={serverBusy} onClick={() => void loadMore()}>
                {serverBusy ? '正在加载…' : '加载更多结果'}
              </button>
            )
            : <span className="ec-wb-foot-right">服务器搜索：没有更多结果</span>)
          : !complete
            ? (
              <button type="button" className="ec-wb-text-link ec-wb-foot-right" disabled={loadingAll} onClick={() => void loadAll()}>
                {loadingAll ? '正在加载全部工作…' : `加载全部 ${total} 项后再搜索`}
              </button>
            )
            : <span className="ec-wb-foot-right">运行记录由平台持续更新</span>}
      </div>
    </section>
  )
}

function WorksPage({ api, data, onOpenWork, onDetail, onOpenPending, onCreate, onReload, creating, opening, projectId, onProjectChange, initialAppKey, onCreated, onCancelCreate, onNavigate }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  onOpenWork(workId: string): void
  onDetail(work: WorkbenchItem, runId?: string): void
  onOpenPending(workId: string, runId: string): void
  onCreate(appKey?: string): void
  onReload(): Promise<void>
  creating: boolean
  opening: string
  projectId: string
  onProjectChange(projectId: string): void
  initialAppKey: string
  onCreated(work: WorkbenchItem): void
  onCancelCreate(): void
  onNavigate(view: WorkbenchView): void
}) {
  const projects = data.projects ?? []
  const works = data.works?.items ?? []
  const todos = data.todos ?? []
  const pendingTitles = usePendingWorkTitles(api, todos, works)
  const activeProject = projects.find((project) => project.projectId === projectId) ?? projects[0]

  return (
    <div className="ec-wb-page ec-wb-page-home">
      <header className="ec-wb-hero">
        <div>
          <div className="ec-wb-eyebrow">{todayLabel(Date.now())}</div>
          <h1>今天，研究工作进展如何？</h1>
          <p>从手头的项目继续，或让 AI 从一个清晰目标开始协作。</p>
        </div>
        <div className="ec-wb-hero-actions">
          {activeProject ? <span className="ec-wb-chip">工作区 · {activeProject.name}</span> : null}
          <button type="button" className="ec-wb-button" onClick={() => onNavigate('projects')}>项目空间</button>
          <button type="button" className="ec-wb-button ec-wb-primary ec-wb-hero-cta" onClick={() => onCreate()}>＋ 新建工作</button>
        </div>
      </header>

      <div className="ec-wb-home-grid">
        <div className="ec-wb-stack">
          {creating
            ? (
              <NewWorkForm
                api={api}
                data={data}
                initialProjectId={activeProject?.projectId ?? ''}
                initialAppKey={initialAppKey}
                onCreated={onCreated}
                onReload={onReload}
                onCancel={onCancelCreate}
              />
            )
            : null}
          {opening ? <p className="ec-wb-muted" role="status">正在打开工作…</p> : null}
          {/* Continue-first: returning employees see their works before the new-work launcher. */}
          <WorksQueue api={api} data={data} onOpenWork={onOpenWork} onDetail={onDetail} opening={opening} />
          <LaunchPanel data={data} projectId={activeProject?.projectId ?? ''} onProjectChange={onProjectChange} onStart={onCreate} />
        </div>

        <aside className="ec-wb-rail" aria-label="待处理、运行就绪与项目">
          <section className="ec-wb-card" aria-labelledby="ec-wb-pending-home">
            <div className="ec-wb-card-head">
              <h3 id="ec-wb-pending-home">需要你处理</h3>
              <span className="ec-wb-badge" data-tone={todos.length > 0 ? 'warn' : undefined}>{todos.length}</span>
            </div>
            {todos.length === 0
              ? (
                <div className="ec-wb-pending-empty">
                  <span className="ec-wb-empty-icon" aria-hidden="true">{GLYPH_CHECK}</span>
                  <p>目前没有等待处理的事项。<small>AI 需要你参与时，会在这里提醒。</small></p>
                </div>
              )
              : <UnifiedTodoList items={todos} works={works} titles={pendingTitles} onOpen={onOpenPending} />}
          </section>

          <ReadinessPanel data={data} onOpenSettings={() => onNavigate('settings')} />

          <section className="ec-wb-card" aria-labelledby="ec-wb-projects-home">
            <div className="ec-wb-card-head">
              <h3 id="ec-wb-projects-home">我的项目</h3>
              <button type="button" className="ec-wb-text-link" onClick={() => onNavigate('projects')}>查看全部</button>
            </div>
            {projects.length === 0
              ? <p className="ec-wb-empty">尚未创建项目。登记项目后即可组织工作与空间。</p>
              : projects.slice(0, 4).map((project) => (
                <button type="button" className="ec-wb-project-row" key={project.projectId}
                  onClick={() => { onProjectChange(project.projectId); onNavigate('projects') }}>
                  <span className="ec-wb-monogram" aria-hidden="true">{monogram(project.name)}</span>
                  <span className="ec-wb-row-main">
                    <strong>{project.name}</strong>
                    <small>{works.filter((work) => work.projectId === project.projectId && work.state !== 'ARCHIVED').length} 项工作{project.code ? ` · ${project.code}` : ''}</small>
                  </span>
                  <span className="ec-wb-row-tail" aria-hidden="true">›</span>
                </button>
              ))}
            <button type="button" className="ec-wb-project-link" onClick={() => onNavigate('projects')}>＋　创建项目空间</button>
          </section>
        </aside>
      </div>

      <footer className="ec-wb-canvas-foot">
        <span>{data.status?.executor ? '平台连接正常' : '平台状态未记录'}</span>
        <span className="ec-wb-sep" aria-hidden="true" />
        <span>专业应用 {(data.apps ?? []).filter((app) => app.state === 'ACTIVE').length}</span>
        <span className="ec-wb-sep" aria-hidden="true" />
        <span>项目空间 {projects.length}</span>
        <button type="button" className="ec-wb-foot-link" onClick={() => onNavigate('settings')}>模型与平台设置　›</button>
      </footer>
    </div>
  )
}

function ProjectsPage({ api, data, onReload, selectedProjectId, onSelect }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  onReload(): Promise<void>
  selectedProjectId: string
  onSelect(projectId: string): void
}) {
  const projects = data.projects ?? []
  const [spaces, setSpaces] = useState<WorkspaceItem[] | null>(null)
  const [spacesError, setSpacesError] = useState('')
  const [creating, setCreating] = useState(false)
  const [spaceName, setSpaceName] = useState('')
  const [spaceDirectory, setSpaceDirectory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadSpaces = useCallback(async (id: string) => {
    if (!id) { setSpaces([]); return }
    setSpacesError('')
    try {
      setSpaces((await api.projectWorkspaces(id)).items)
    } catch (reason) {
      setSpaces(null)
      setSpacesError(errorText(reason))
    }
  }, [api])

  useEffect(() => { void loadSpaces(selectedProjectId) }, [selectedProjectId, loadSpaces])

  const registerSpace = async () => {
    if (!spaceName.trim() || !spaceDirectory.trim()) { setError('登记工作空间需要名称和目录。'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api.createWorkspace(selectedProjectId, { name: spaceName.trim(), directory: spaceDirectory.trim() })
      setSpaceName('')
      setSpaceDirectory('')
      await loadSpaces(selectedProjectId)
      setNotice('工作空间已登记。目录由部署侧校验，工作台只记录路径。')
    } catch (reason) {
      setError(`登记工作空间失败：${errorText(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ec-wb-page">
      <header className="ec-wb-page-head">
        <div><h1>项目空间</h1><p className="ec-wb-muted">目录和数据上下文在项目中设置一次；历史工作保留创建时快照。</p></div>
        <button type="button" className="ec-wb-button ec-wb-primary" onClick={() => setCreating((value) => !value)}>{creating ? '收起表单' : '＋ 新建项目'}</button>
      </header>
      {creating ? <CreateProjectForm api={api} onCreated={async (projectId) => { await onReload(); onSelect(projectId); setCreating(false) }} /> : null}
      <div className="ec-wb-project-grid">
        {projects.length === 0
          ? <p className="ec-wb-empty">尚未创建项目。</p>
          : projects.map((project) => (
            <button type="button" className={`ec-wb-project-card${project.projectId === selectedProjectId ? ' is-active' : ''}`}
              key={project.projectId} onClick={() => onSelect(project.projectId)}>
              <span className="ec-wb-project-code">{project.code || '未设置编号'}</span>
              <strong>{project.name}</strong>
              <small>{(data.works?.items ?? []).filter((work) => work.projectId === project.projectId).length} 项工作 · 查看空间 ›</small>
            </button>
          ))}
      </div>
      <div className="ec-wb-home-grid">
        <section className="ec-wb-card" aria-labelledby="ec-wb-spaces">
          <div className="ec-wb-card-head"><h2 id="ec-wb-spaces">工作空间</h2><span className="ec-wb-badge">{spaces?.length ?? 0}</span></div>
          {spacesError ? <ErrorBox message={`无法读取工作空间：${spacesError}`} onRetry={() => void loadSpaces(selectedProjectId)} /> : null}
          {spaces === null
            ? <p className="ec-wb-muted">正在读取工作空间…</p>
            : spaces.length === 0
              ? <p className="ec-wb-empty">还没有空间。登记执行主机上的真实目录后即可发起运行。</p>
              : spaces.map((space) => (
                <div className="ec-wb-row" key={space.workspaceId}>
                  <span className="ec-wb-row-main"><strong>{space.name}</strong><small className="ec-wb-muted">{space.directory}</small></span>
                </div>
              ))}
        </section>
        <aside className="ec-wb-card" aria-labelledby="ec-wb-space-form">
          <div className="ec-wb-card-head"><h2 id="ec-wb-space-form">登记工作空间</h2></div>
          <div className="ec-wb-grid">
            <Field label="空间名称"><input className="ec-wb-input" value={spaceName} maxLength={200} onChange={(event) => setSpaceName(event.target.value)} /></Field>
            <Field label="本地工作目录"><input className="ec-wb-input" value={spaceDirectory} maxLength={500} onChange={(event) => setSpaceDirectory(event.target.value)} /></Field>
          </div>
          {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
          {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
          <div className="ec-wb-form-actions">
            <button type="button" className="ec-wb-button ec-wb-primary" disabled={busy || !selectedProjectId} onClick={() => void registerSpace()}>
              {busy ? '提交中…' : '登记空间'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}

function AppsPage({ data }: { data: WorkbenchBootstrap }) {
  const apps = data.apps ?? []
  return (
    <div className="ec-wb-page">
      <header className="ec-wb-page-head">
        <div><h1>应用中心</h1><p className="ec-wb-muted">按用途查找业务应用。应用目录来自平台发布，不在页面写死。</p></div>
      </header>
      <div className="ec-wb-project-grid">
        {apps.length === 0
          ? <p className="ec-wb-empty">当前没有可用的应用发布。</p>
          : apps.map((app) => (
            <article className={`ec-wb-app-card${app.state === 'ACTIVE' ? '' : ' is-revoked'}`} key={`${app.appId}@${app.appVersion}`}>
              <span className="ec-wb-app-icon" aria-hidden="true">◈</span>
              <div className="ec-wb-row-main">
                <strong>{app.descriptor?.displayName ?? app.displayName ?? app.appId}</strong>
                <small className="ec-wb-muted">{app.appId} @ {app.appVersion}</small>
              </div>
              <span className="ec-wb-badge" data-tone={app.state === 'ACTIVE' ? 'ok' : 'muted'}>{app.state === 'ACTIVE' ? '可用' : '已撤销'}</span>
            </article>
          ))}
      </div>
    </div>
  )
}

function PendingPage({ api, data, onOpen }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  onOpen(workId: string, runId: string): void
}) {
  const works = data.works?.items ?? []
  const todos = data.todos ?? []
  const pendingTitles = usePendingWorkTitles(api, todos, works)
  // One section per source kind: the kind tells the employee which act resolves the item.
  const groups = new Map<TodoItem['kind'], TodoItem[]>()
  for (const item of todos) {
    const group = groups.get(item.kind) ?? []
    group.push(item)
    groups.set(item.kind, group)
  }
  const order: TodoItem['kind'][] = ['question', 'review', 'delivery-receipt']
  return (
    <div className="ec-wb-page">
      <header className="ec-wb-page-head">
        <div><h1>待我处理</h1><p className="ec-wb-muted">问题答复、交付复核与交付接收在同一张清单上；每项保留自己的来源与处理动作，最早的在前。</p></div>
        <span className="ec-wb-badge">{todos.length} 项</span>
      </header>
      {todos.length === 0
        ? <section className="ec-wb-card"><p className="ec-wb-empty">当前没有待处理事项。</p></section>
        : <div className="ec-wb-stack">
          {order.filter((kind) => groups.has(kind)).map((kind) => {
            const group = groups.get(kind)!
            return (
              <section className="ec-wb-card" key={kind} aria-labelledby={`ec-wb-todo-${kind}`}>
                <div className="ec-wb-card-head">
                  <h2 id={`ec-wb-todo-${kind}`}>{TODO_KINDS[kind].label}</h2>
                  <span className="ec-wb-badge">{group.length} 项</span>
                </div>
                <UnifiedTodoList items={group} works={works} titles={pendingTitles} onOpen={onOpen} />
              </section>
            )
          })}
          <section className="ec-wb-card" aria-labelledby="ec-wb-collab-note">
            <div className="ec-wb-card-head"><h2 id="ec-wb-collab-note">协作口径</h2></div>
            <p className="ec-wb-muted">
              当前是单操作者部署：没有任务分配或认领，这份清单上的每一项都由你自己处理；
              所有决定都以你的身份写入记录与审计（发起人/复核人/封存人等字段）。
              多操作者协作在真实身份系统接入后另行实现（E4-1 门控），现在不做假界面。
            </p>
          </section>
        </div>}
    </div>
  )
}

/** Language and time-zone preferences. They affect rendering only: recorded facts, business status
 *  values and stored digests are never translated or shifted. */
function PreferencesCard() {
  const preferences = usePreferences()
  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-prefs">
      <div className="ec-wb-card-head"><h2 id="ec-wb-prefs">显示与时间</h2></div>
      <p className="ec-wb-muted">界面语言与时区只影响本机显示；记录内容、业务日期和摘要不会因此改变。</p>
      <div className="ec-wb-grid">
        <Field label={t('label.language')}>
          <select className="ec-wb-select" value={preferences.locale}
            onChange={(event) => setPreferences({ locale: event.target.value as Locale })}>
            {LOCALES.map((locale) => <option key={locale.id} value={locale.id}>{locale.label}</option>)}
          </select>
        </Field>
        <Field label={t('label.timeZone')} hint="时间点按所选时区显示；仅有日期的业务值不会换算。">
          <select className="ec-wb-select" value={preferences.timeZone}
            onChange={(event) => setPreferences({ timeZone: event.target.value })}>
            {availableTimeZones().map((zone) => <option key={zone || 'local'} value={zone}>{zone || '本机时区'}</option>)}
          </select>
        </Field>
      </div>
    </section>
  )
}

/** Operations panel (E3-1): measured latency distribution, outbox depth, run counts and the
 *  deployment's doctor probe in one authorized read. There are no SLO targets yet, so the card
 *  states that fact and shows measurements — it never renders a green "meeting target" light. */
function OperationsCard({ api }: { api: WorkbenchApi }) {
  const [panel, setPanel] = useState<OpsPanel | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setPanel(await api.opsPanel())
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const topHistograms = panel
    ? Object.entries(panel.metrics.histograms ?? {}).slice(0, 6)
    : []
  const outbox = panel?.status?.outbox ?? {}
  const outboxText = Object.keys(outbox).length
    ? Object.entries(outbox).map(([state, count]) => `${state} ${count}`).join(' · ')
    : '无记录'

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-ops">
      <div className="ec-wb-card-head">
        <h2 id="ec-wb-ops">运营面板</h2>
        {panel ? <span className="ec-wb-badge" data-tone={panel.doctor?.ok === false ? 'warn' : 'ok'}>{panel.doctor ? (panel.doctor.ok ? 'doctor 通过' : 'doctor 有失败项') : 'doctor 未接入'}</span> : null}
      </div>
      <p className="ec-wb-muted">本进程实测指标（重启后清零，不跨进程聚合）。尚未定义 SLO 目标：面板展示实测分布，不冒充达标。失败告警以 doctor 检查与审计链为准。</p>
      {error ? <p className="ec-wb-empty">{error}</p> : null}
      {!panel && !error ? <p className="ec-wb-empty">{loading ? '读取中…' : ''}</p> : null}
      {panel ? (
        <>
          <dl className="ec-wb-facts">
            <dt>执行器</dt><dd>{panel.status?.executor ?? '未记录'}</dd>
            <dt>Outbox</dt><dd>{outboxText}</dd>
            <dt>doctor</dt><dd>{panel.doctorNote}</dd>
          </dl>
          {topHistograms.length > 0 ? (
            <table className="ec-wb-finding-table">
              <thead><tr><th scope="col">指标</th><th scope="col">样本</th><th scope="col">p50 ms</th><th scope="col">p95 ms</th><th scope="col">p99 ms</th><th scope="col">max ms</th></tr></thead>
              <tbody>
                {topHistograms.map(([name, stats]) => (
                  <tr key={name}><td>{name}</td><td>{stats.count}</td><td>{stats.p50}</td><td>{stats.p95}</td><td>{stats.p99}</td><td>{stats.max}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="ec-wb-muted">本进程尚无耗时样本。</p>}
          {panel.doctor ? (
            <ul className="ec-wb-muted">
              {panel.doctor.checks.filter((check) => check.status !== 'ok').map((check) => (
                <li key={check.name}>{check.status === 'fail' ? '✗' : '⚠'} {check.name}：{check.detail}</li>
              ))}
              {panel.doctor.checks.every((check) => check.status === 'ok') ? <li>全部检查 ok。</li> : null}
            </ul>
          ) : null}
          <div className="ec-wb-row">
            <button className="ec-wb-btn" type="button" onClick={() => void load()} disabled={loading}>{loading ? '读取中…' : '重新读取'}</button>
          </div>
        </>
      ) : null}
    </section>
  )
}

/** Audit viewer (E0b): the durable, SHA-256-chained operation log. Filter by object to trace one
 *  Work/Run's history; the chain's structural continuity is checked (each line links the previous
 *  digest). This is an integrity aid, not an electronic signature. Loads on demand. */
function AuditPanel({ api }: { api: WorkbenchApi }) {
  const [entries, setEntries] = useState<AuditEntryItem[]>([])
  const [target, setTarget] = useState('')
  const [needle, setNeedle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [headDigest, setHeadDigest] = useState('')
  const [lastSequence, setLastSequence] = useState(0)
  const [exhausted, setExhausted] = useState(false)

  const load = useCallback(async (after: number, append: boolean) => {
    setLoading(true)
    setError('')
    try {
      const result = await api.auditExport({ ...(target.trim() ? { target: target.trim() } : {}), after, limit: 200 })
      setEntries((previous) => append ? [...previous, ...result.entries] : result.entries)
      setHeadDigest(result.headDigest)
      setLastSequence(result.lastSequence)
      setExhausted(result.count < 200)
      setLoaded(true)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }, [api, target])

  const chainBroken = entries.some((entry, index) => index > 0 && entry.prevDigest !== entries[index - 1]?.digest)
  const search = needle.trim().toLocaleLowerCase()
  const visible = search
    ? entries.filter((entry) => `${entry.action} ${entry.actor} ${entry.target}`.toLocaleLowerCase().includes(search))
    : entries

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-audit">
      <div className="ec-wb-card-head"><h2 id="ec-wb-audit">审计日志</h2>{loaded ? <span className="ec-wb-badge">{entries.length}</span> : null}</div>
      <p className="ec-wb-muted">平台操作的持久审计，导出带 SHA-256 链。按对象 ID 可溯源一项工作/运行的历史；链衔接断裂会提示。这是完整性辅助，不是电子签名。</p>
      <div className="ec-wb-session-tools">
        <input className="ec-wb-input" type="search" value={target} placeholder="按对象 ID 溯源（target，可空）" aria-label="按对象 ID 过滤审计"
          onChange={(event) => setTarget(event.target.value)} />
        <button type="button" className="ec-wb-button" disabled={loading} onClick={() => void load(0, false)}>
          {loading && !loaded ? '正在读取…' : '加载 / 刷新'}
        </button>
      </div>
      {error ? <ErrorBox message={`无法读取审计：${error}`} onRetry={() => void load(0, false)} /> : null}
      {!loaded
        ? <p className="ec-wb-empty">点击「加载 / 刷新」读取审计日志；输入对象 ID 可只溯源该对象。</p>
        : (
          <>
            <div className="ec-wb-session-tools">
              <input className="ec-wb-input" type="search" value={needle} placeholder="在已加载条目中搜索动作/操作者" aria-label="搜索审计动作"
                onChange={(event) => setNeedle(event.target.value)} />
              <span className="ec-wb-muted" role="status">
                {chainBroken ? '⚠ 链衔接断裂' : '链衔接连续'}<span className="ec-wb-expert-only"> · 头摘要 {headDigest.slice(0, 16)}…</span>
              </span>
            </div>
            {visible.length === 0
              ? <p className="ec-wb-empty">没有匹配的审计条目。</p>
              : visible.map((entry) => (
                <div className="ec-wb-row" key={entry.sequence}>
                  <span className="ec-wb-row-main">
                    <strong>{entry.action}</strong>
                    <small className="ec-wb-muted">
                      {formatTime(entry.createdAt)} · {entry.actor} · 对象 {entry.target}
                      {entry.correlationId ? <span className="ec-wb-expert-only"> · {entry.correlationId}</span> : null}
                    </small>
                  </span>
                  <span className="ec-wb-badge">#{entry.sequence}</span>
                </div>
              ))}
            {!exhausted && !search
              ? <button type="button" className="ec-wb-button" disabled={loading} onClick={() => void load(lastSequence, true)}>
                {loading ? '正在读取…' : '加载后续条目'}
              </button>
              : null}
          </>
        )}
    </section>
  )
}

function SettingsPage({ api, data, onReload }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  onReload(): Promise<void>
}) {
  const catalog = data.models?.catalog
  const health = new Map((data.models?.health ?? []).map((item) => [item.selectionId, item]))
  // Latest approval per selection (the control plane orders newest first); approval absence
  // means "never granted" — it does not mean "not required".
  const approvals = new Map((data.models?.approvals ?? []).map((item) => [item.selectionId, item]))
  const quota = data.quotas
  return (
    <div className="ec-wb-page">
      <header className="ec-wb-page-head">
        <div><h1>平台设置</h1><p className="ec-wb-muted">执行模型、平台连接与运行状态。业务平台独立维护，执行引擎通过版本化适配层接入。</p></div>
      </header>
      <div className="ec-wb-home-grid">
        <div className="ec-wb-stack">
          <section className="ec-wb-card" aria-labelledby="ec-wb-identity">
            <div className="ec-wb-card-head"><h2 id="ec-wb-identity">身份与部署</h2><span className="ec-wb-badge" data-tone="warn">单操作者部署</span></div>
            <dl className="ec-wb-facts">
              <dt>部署形态</dt>
              <dd>本地单操作者：控制面由本机进程持有，无登录页、无多用户认证。</dd>
              <dt>操作者</dt>
              <dd>控制面按固定身份（local-operator 模式，不校验调用方）在服务端执行授权检查；同一台机器上的所有操作都记在这一个操作者名下。</dd>
              <dt>隔离</dt>
              <dd>无多用户隔离、无 SSO/多租户。这些能力尚未生效，因此界面不显示登录或权限管理——不显示不等于已具备。</dd>
              <dt>数据授权</dt>
              <dd>由 IT、API 与执行环境承担；工作台只登记资料引用与摘要，不读取目录内容。</dd>
              <dt>审计</dt>
              <dd>所有操作记入下方审计链，可导出核对；审计辅助追溯，不是电子签名。</dd>
            </dl>
            <p className="ec-wb-muted">真实企业认证（SSO/多租户）须按 IT 合同另行接入；接入之前界面保持诚实标注，不冒充已启用授权。</p>
          </section>
          <PreferencesCard />
          <ModelDefaultPanel api={api} catalog={catalog} preference={data.models?.preference} onReload={onReload} />
          <section className="ec-wb-card" aria-labelledby="ec-wb-model-catalog">
            <div className="ec-wb-card-head"><h2 id="ec-wb-model-catalog">模型目录</h2><span className="ec-wb-badge">{catalog?.entries?.length ?? 0}</span></div>
            <p className="ec-wb-muted">目录只列出经部署登记并接入的模型；选择随运行冻结，切换不会改写已有记录。</p>
            {!catalog || (catalog.entries ?? []).length === 0
              ? <p className="ec-wb-empty">平台尚未登记模型目录；创建运行前需要部署登记。</p>
              : (catalog.entries ?? []).map((entry) => {
                const fact = health.get(entry.selectionId)
                return (
                <div className="ec-wb-row" key={entry.selectionId}>
                  <span className="ec-wb-row-main">
                    <strong>{entry.displayName || entry.model}</strong>
                    <small className="ec-wb-muted ec-wb-expert-only">{entry.provider} / {entry.model} · {entry.selectionId}</small>
                    {fact
                      ? <small className="ec-wb-muted">健康：{fact.state === 'healthy' ? '正常' : fact.state === 'degraded' ? '降级' : fact.state === 'unavailable' ? `不可用${fact.reason ? `（${fact.reason}）` : ''}` : '未核对'} · {formatTime(fact.checkedAt)}</small>
                      : <small className="ec-wb-muted">健康：尚未探测（不代表正常）</small>}
                    <small className="ec-wb-muted">审批：{(() => {
                      const approval = approvals.get(entry.selectionId)
                      if (!approval) return '从未批准（是否强制以部署配置为准）'
                      if (approval.state === 'REVOKED') return `已撤回${approval.revokeReason ? `（${approval.revokeReason}）` : ''}`
                      const expired = approval.expiresAt ? Date.parse(approval.expiresAt) <= Date.now() : false
                      return expired
                        ? `已过期（${formatTime(approval.expiresAt)}）`
                        : `${approval.approvedBy} 批准${approval.expiresAt ? ` · 有效期至 ${formatTime(approval.expiresAt)}` : ''}`
                    })()}</small>
                  </span>
                  <span className="ec-wb-badge" data-tone={entry.enabled && fact?.state !== 'unavailable' ? 'ok' : 'warn'}>
                    {entry.enabled ? (fact?.state === 'unavailable' ? '健康不可用' : '可用') : '不可用'}
                  </span>
                </div>
                )
              })}
          </section>
          <OperationsCard api={api} />
          <AuditPanel api={api} />
        </div>
        <aside className="ec-wb-rail">
          <section className="ec-wb-card">
            <div className="ec-wb-card-head"><h2>执行环境</h2></div>
            <dl className="ec-wb-facts">
              <dt>执行器</dt><dd>{data.status?.executor ?? '未记录'}</dd>
              <dt>运行计数</dt><dd>{data.status?.runs ? Object.entries(data.status.runs).map(([state, count]) => `${state} ${count}`).join(' · ') : '未记录'}</dd>
            </dl>
          </section>
          <section className="ec-wb-card" aria-labelledby="ec-wb-storage">
            <div className="ec-wb-card-head"><h2 id="ec-wb-storage">存储与恢复</h2></div>
            {data.storage
              ? (
                <dl className="ec-wb-facts">
                  <dt>控制面数据库</dt>
                  <dd><span className="ec-wb-expert-only">{data.storage.controlStorePath}</span></dd>
                  <dt>备份覆盖</dt>
                  <dd>控制面 SQLite ✓ · 已封存成果 ✓ · 知识库 ✗ · 原生会话目录 ✗</dd>
                  <dt>恢复限制标记</dt>
                  <dd>{data.storage.recoveryRestrictionMarkers ? '已持久化' : '未持久化：恢复操作不携带限制标记，靠备份清单与摘要核对把关'}</dd>
                </dl>
              )
              : <p className="ec-wb-muted">控制面未上报存储拓扑（旧版本接口），备份覆盖范围请以运维文档为准。</p>}
            <p className="ec-wb-muted">备份不覆盖知识库与原生 DSH 会话目录——这两个缺口是事实，不是提醒。恢复前必须核对备份清单摘要，摘要不符的备份不得用于恢复。</p>
          </section>
          <section className="ec-wb-card" aria-labelledby="ec-wb-quotas">
            <div className="ec-wb-card-head"><h2 id="ec-wb-quotas">预算与配额</h2></div>
            {quota
              ? (
                <dl className="ec-wb-facts">
                  <dt>并发上限 / 项目</dt>
                  <dd>{quota.maxConcurrentRunsPerProject > 0 ? `${quota.maxConcurrentRunsPerProject} 个进行中` : '未启用（0 = 不强制）'}</dd>
                  <dt>单日上限 / 项目</dt>
                  <dd>{quota.maxRunsPerDayPerProject > 0 ? `${quota.maxRunsPerDayPerProject} 个 / ${quota.dayBoundary}` : '未启用（0 = 不强制）'}</dd>
                  <dt>计数口径</dt>
                  <dd>{quota.scope.counted}</dd>
                </dl>
              )
              : <p className="ec-wb-muted">控制面未上报配额事实（旧版本接口），配额是否生效请以部署配置为准。</p>}
            <p className="ec-wb-muted">配额只按运行记录计数：失败与取消的运行同样消耗当日额度；不绑定工作的运行不计入——这是口径声明，不是覆盖承诺。达到上限的运行会被拒绝创建，平台不会静默切换模型或项目。</p>
          </section>
        </aside>
      </div>
    </div>
  )
}

// ── Shell ────────────────────────────────────────────────────────────────────

const VIEW_TITLES: Record<WorkbenchView, string> = {
  works: '我的工作',
  sessions: '历史会话',
  projects: '项目空间',
  apps: '应用中心',
  pending: '待我处理',
  settings: '平台设置',
}

const PLATFORM_NAV_ICONS: Record<WorkbenchView, ReactNode> = {
  projects: <Glyph><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Glyph>,
  apps: <Glyph><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></Glyph>,
  works: <Glyph><line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></Glyph>,
  sessions: <Glyph><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5z" /></Glyph>,
  pending: <Glyph><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 13.8" /></Glyph>,
  settings: <Glyph><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></Glyph>,
}

/** Navigation order follows the reviewed draft: work first, then the spaces and tools around it. */
const PLATFORM_NAV: ReadonlyArray<{ id: WorkbenchView; label: string }> = [
  { id: 'works', label: '我的工作' },
  { id: 'sessions', label: '历史会话' },
  { id: 'projects', label: '项目空间' },
  { id: 'apps', label: '应用中心' },
  { id: 'pending', label: '待我处理' },
  { id: 'settings', label: '平台设置' },
]

export function WorkbenchPage({ SessionProvider, retainSession, releaseSession, watchWorkSession, createSession, renderSlot, sessionList, refreshSessionList }: WorkbenchPageProps) {
  const api = useMemo(() => new WorkbenchApi(API_BASE), [])
  const preferences = usePreferences()
  const hasData = useRef(false)
  const [data, setData] = useState<WorkbenchBootstrap | null>(null)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState('')
  const [notice, setNotice] = useState('')
  const [networkHint, setNetworkHint] = useState('')
  const [detailWork, setDetailWork] = useState<WorkbenchItem | null>(null)
  const [focusRunId, setFocusRunId] = useState<string | undefined>(undefined)
  const [compact, setCompact] = useState(readCompact)
  const [expert, setExpert] = useState(readExpert)
  const [creating, setCreating] = useState(false)
  const [startAppKey, setStartAppKey] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [page, setPage] = useState<WorkbenchView>('works')
  const [sessionWork, setSessionWork] = useState<{ workId: string; title: string; reference: SessionReference } | null>(null)
  const [historySession, setHistorySession] = useState<{ sessionId: string; title: string; reference: SessionReference } | null>(null)

  // Leaving the session view (nav, back, detail switch) releases the view's retained reference so
  // the embedded factory returns to its session-less posture; unmount releases it too. React
  // removes the SessionProvider subtree before this cleanup runs, so the renderer never reads a
  // released reference.
  const sessionViewOpen = sessionWork !== null || historySession !== null
  useEffect(() => {
    if (!sessionViewOpen) return undefined
    return () => releaseSession()
  }, [sessionViewOpen, releaseSession])

  const load = useCallback(async () => {
    try {
      setError('')
      setNetworkHint('')
      setData(await api.bootstrap())
      hasData.current = true
    } catch (reason) {
      const message = errorText(reason)
      if (reason instanceof PlatformApiError && reason.status === 0) setNetworkHint('请检查网络或平台服务，然后重试。')
      if (!hasData.current) setError(message)
      else setNetworkHint(`刷新失败：${message}`)
    }
  }, [api])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!selectedProjectId && data?.projects?.[0]) setSelectedProjectId(data.projects[0].projectId)
  }, [data, selectedProjectId])

  /** A cold boot races the native session catalog against this page's first retain: a refresh
   *  restore (or an early click) can reach for a session before `session.list` has landed, and
   *  retain refuses unknown identities. refreshList also silently drops a pull when a newer one
   *  supersedes it mid-flight while still resolving, so a single refresh is no guarantee — poll
   *  the catalog itself until it lists the session (then retain cannot fail on identity) or the
   *  deadline passes and the session is genuinely unknown. */
  const retainKnownSession = useCallback(async (sessionId: string): Promise<SessionReference> => {
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        return retainSession(sessionId)
      } catch (reason) {
        if (!errorText(reason).includes('unknown session')) throw reason
        if (sessionList.getSnapshot().ids.some((id) => id === sessionId) || Date.now() >= deadline) throw reason
        await refreshSessionList().catch(() => undefined)
        await new Promise((resolve) => { setTimeout(resolve, 200) })
      }
    }
  }, [retainSession, refreshSessionList, sessionList])

  /** `silent` marks a refresh-restore: a coordinate that no longer resolves is forgotten and the
   *  shell falls back to the works page instead of announcing a failure for a stale view. */
  const openWork = useCallback(async (workId: string, options?: { focusRunId?: string; silent?: boolean }) => {
    const silent = options?.silent === true
    setOpening(workId)
    if (!silent) setNotice('')
    try {
      const context = await api.workContext(workId)
      const sessionId = context.binding?.sessionId ?? context.sessionId
      if (!sessionId) {
        if (!silent) setNotice('正在为这项工作创建对话，已打开详情页。')
        openDetail({
          workId,
          title: context.work.title,
          projectId: context.work.projectId,
          appId: context.app.appId,
          appVersion: context.app.appVersion,
          state: context.work.state,
        })
        return
      }
      if (!context.binding?.domainId) {
        if (!silent) setNotice('此工作缺少执行环境绑定，暂无法关联对话提交记录。')
        return
      }
      const reference = await retainKnownSession(sessionId)
      watchWorkSession({ workId, domainId: context.binding.domainId, sessionId, since: context.binding.createdAt })
      setDetailWork(null)
      setFocusRunId(options?.focusRunId)
      setSessionWork({ workId, title: context.work.title, reference })
    } catch (reason) {
      console.error(`[platform-workbench] open work failed: ${errorText(reason)}`)
      if (silent) clearPersistedView()
      else setNotice(`无法打开工作：${errorText(reason)}`)
    } finally {
      setOpening('')
    }
  }, [api, retainKnownSession, watchWorkSession])

  // Open the embedded session view from the Work detail page (bound Session + domain already checked).
  const openBoundSession = useCallback(async (workId: string, sessionId: string, domainId: string, since?: string) => {
    setNotice('')
    try {
      const reference = await retainKnownSession(sessionId)
      watchWorkSession({ workId, domainId, sessionId, ...(since ? { since } : {}) })
      setSessionWork({ workId, title: detailWork?.title ?? '工作', reference })
    } catch (reason) {
      setNotice(`无法打开会话：${errorText(reason)}`)
    }
  }, [retainKnownSession, watchWorkSession, detailWork])

  /**
   * Create and bind a native Session for an unbound Work. The session is created in the Work's own
   * workspace directory; a missing execution domain is registered first (local deployment). The
   * binding carries the real session id and the application release digest the context returned.
   */
  const bindWorkSession = useCallback(async (context: WorkContext): Promise<{ sessionId: string; domainId: string }> => {
    if (!context.workspace) throw new Error('BINDING_WORKSPACE_REQUIRED')
    let domain = selectBindingDomain((await api.domains()).items)
    if (!domain) {
      const created = await api.createDomain({ kind: 'local' })
      domain = {
        domainId: created.domainId,
        kind: created.kind === 'hosted' ? 'hosted' : 'local',
        state: created.state ?? 'UNKNOWN',
      }
    }
    const sessionId = await createSession({ cwd: context.workspace.directory })
    await api.bindWorkSession(context.work.workId, bindingDraft(context, domain.domainId, sessionId))
    await load()
    return { sessionId, domainId: domain.domainId }
  }, [api, createSession, load])

  const closeSessionView = useCallback(() => { setSessionWork(null) }, [])

  /** Open a session straight from 历史会话: native Q&A only — no Work binding, no correlation. */
  const openHistorySession = useCallback(async (sessionId: string, title: string) => {
    setNotice('')
    try {
      const reference = await retainKnownSession(sessionId)
      setSessionWork(null)
      setDetailWork(null)
      setFocusRunId(undefined)
      setHistorySession({ sessionId, title, reference })
    } catch (reason) {
      setNotice(`无法打开历史会话：${errorText(reason)}`)
    }
  }, [retainKnownSession])

  const closeHistorySession = useCallback(() => { setHistorySession(null) }, [])

  const toggleCompact = () => {
    setCompact((previous) => {
      const next = !previous
      writeCompact(next)
      return next
    })
  }

  const toggleExpert = () => {
    setExpert((previous) => {
      const next = !previous
      writeExpert(next)
      return next
    })
  }

  const selectPage = (next: WorkbenchView) => {
    setPage(next)
    setSessionWork(null)
    setHistorySession(null)
    setDetailWork(null)
    setFocusRunId(undefined)
  }

  /** Open the create form, optionally retargeted at the application whose quick target was clicked. */
  const startCreate = (appKey?: string) => {
    setStartAppKey(appKey ?? '')
    setCreating(true)
  }

  const openDetail = (work: WorkbenchItem, runId?: string) => {
    setFocusRunId(runId)
    setDetailWork(work)
  }

  /** Resolve a Work by id from the loaded page, falling back to its own context so a Work outside
   *  that page (archived, or past the bootstrap limit) stays reachable instead of "not visible". */
  const resolveWork = async (workId: string): Promise<WorkbenchItem> => {
    const known = (data?.works?.items ?? []).find((item) => item.workId === workId)
    if (known) return known
    const context = await api.workContext(workId)
    return {
      workId: context.work.workId,
      title: context.work.title,
      projectId: context.work.projectId,
      appId: context.app.appId,
      appVersion: context.app.appVersion,
      state: context.work.state,
    }
  }

  /** Leave the console for the Work's detail page, keeping the run the console had focused so
   *  成果版本/输入批次 open filled instead of asking the employee to pick the run again. */
  const openDetailFromConsole = async (workId: string) => {
    try {
      const work = await resolveWork(workId)
      setSessionWork(null)
      openDetail(work, focusRunId)
    } catch (reason) {
      setNotice(`无法打开工作详情：${errorText(reason)}`)
    }
  }

  /** Open the page that answers one pending question, focusing that run. */
  const openPendingById = async (workId: string, runId: string) => {
    try {
      const work = await resolveWork(workId)
      openDetail(work, runId)
    } catch (reason) {
      setNotice(`无法打开待处理问题：${errorText(reason)}`)
    }
  }

  // ── Refresh survival ──────────────────────────────────────────────────────────
  // F5 must return the employee to the view they were in — the native WebUI behavior this page is
  // required to match — instead of flashing the works list while their chat disappears. The view
  // coordinate is read once at boot, re-applied, and mirrored to sessionStorage on every change
  // afterwards. Ids only: titles and references re-derive from the platform; a coordinate that no
  // longer resolves falls back to the works page.
  const savedViewRef = useRef<PersistedView | null | undefined>(undefined)
  if (savedViewRef.current === undefined) savedViewRef.current = hashToView(globalThis.location?.hash ?? '') ?? readPersistedView()
  const [restoring, setRestoring] = useState(() => savedViewRef.current != null)
  // E4-6 command palette: Ctrl/⌘+K from any view, including embedded sessions.
  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((value) => !value)
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])
  // Deep links: the URL hash mirrors the view coordinate (shareable/bookmarkable; refresh restores
  // from it). selfHashRef guards against treating our own writes as external navigation; lastKeyRef
  // decides push (primary change) vs replace (focus-only) so back/forward works without history spam.
  const selfHashRef = useRef<string>(globalThis.location?.hash ?? '')
  const lastKeyRef = useRef<string>(viewKey(savedViewRef.current ?? { page: 'works' }))
  const applyViewRef = useRef<(view: PersistedView) => void>(() => {})
  applyViewRef.current = (view) => {
    if (view.sessionWorkId) void openWork(view.sessionWorkId, { focusRunId: view.focusRunId, silent: true })
    else if (view.historySessionId) void openHistorySession(view.historySessionId, view.historySessionTitle ?? '历史会话')
    else if (view.detailWorkId) void resolveWork(view.detailWorkId).then((work) => openDetail(work, view.focusRunId)).catch(() => {})
    else if (view.page && WORKBENCH_VIEWS.includes(view.page as WorkbenchView)) selectPage(view.page as WorkbenchView)
  }

  // Keyed-page restores are synchronous and apply before the first paint. Everything deeper
  // (session retain may need one catalog refresh on a cold boot, detail needs a server resolve)
  // settles behind the `restoring` shell — the mount-time mirror must not fire while it does, or
  // it would clear the very coordinate it is about to restore.
  useLayoutEffect(() => {
    const saved = savedViewRef.current
    if (!saved || restoring) return
    if (!saved.sessionWorkId && !saved.detailWorkId && !saved.historySessionId
      && saved.page && saved.page !== 'works' && WORKBENCH_VIEWS.includes(saved.page as WorkbenchView)) {
      setPage(saved.page as WorkbenchView)
    }
  }, [])

  useEffect(() => {
    if (!restoring) return
    const saved = savedViewRef.current
    const finish = () => { savedViewRef.current = null; setRestoring(false) }
    if (!saved) { finish(); return }
    const { sessionWorkId, historySessionId, historySessionTitle, detailWorkId, focusRunId } = saved
    void (async () => {
      try {
        if (sessionWorkId) {
          await openWork(sessionWorkId, { focusRunId, silent: true })
        } else if (historySessionId) {
          await openHistorySession(historySessionId, historySessionTitle ?? '历史会话')
        } else if (detailWorkId) {
          openDetail(await resolveWork(detailWorkId), focusRunId)
        }
      } catch {
        clearPersistedView()
      }
    })().finally(finish)
    // The restore runs exactly once, at boot, against the boot-time callbacks.
  }, [])

  useEffect(() => {
    // While a restore is settling, the mirror keeps its saved coordinate so a second F5 during the
    // fetch still restores — never clears what it is about to restore.
    if (restoring) return
    const view: PersistedView = { page }
    if (detailWork) view.detailWorkId = detailWork.workId
    if (sessionWork) view.sessionWorkId = sessionWork.workId
    if (historySession) {
      view.historySessionId = historySession.sessionId
      view.historySessionTitle = historySession.title
    }
    if (focusRunId) view.focusRunId = focusRunId
    if (view.sessionWorkId || view.detailWorkId || view.historySessionId || view.page !== 'works') writePersistedView(view)
    else clearPersistedView()
    const hash = viewToHash(view)
    selfHashRef.current = hash
    try {
      if (globalThis.location && globalThis.location.hash !== hash) {
        const url = `${globalThis.location.pathname}${globalThis.location.search}${hash}`
        const key = viewKey(view)
        if (key !== lastKeyRef.current) { globalThis.history?.pushState(null, '', url); lastKeyRef.current = key }
        else globalThis.history?.replaceState(null, '', url)
      }
    } catch {
      // A navigation-restricted shell keeps the sessionStorage coordinate only.
    }
  }, [restoring, page, detailWork, sessionWork, historySession, focusRunId])

  // Browser back/forward and external deep links apply through the same handlers as boot restore.
  useEffect(() => {
    const onHashChange = (): void => {
      const hash = globalThis.location?.hash ?? ''
      if (hash === selfHashRef.current) return
      const view = hashToView(hash)
      if (!view) return
      selfHashRef.current = hash
      lastKeyRef.current = viewKey(view)
      applyViewRef.current(view)
    }
    globalThis.addEventListener?.('hashchange', onHashChange)
    return () => globalThis.removeEventListener?.('hashchange', onHashChange)
  }, [])

  const pendingCount = (data?.todos ?? data?.pending ?? []).length
  // "最近打开" lists work still in use; an archived Work only appears while it is the open one.
  const recentWorks = byRecent((data?.works?.items ?? [])
    .filter((work) => work.state !== 'ARCHIVED' || work.workId === sessionWork?.workId)).slice(0, 5)
  const projectName = (projectId: string) =>
    (data?.projects ?? []).find((project) => project.projectId === projectId)?.name ?? projectId
  const executorLabel = data?.status?.executor && data.status.executor !== 'not-configured'
    ? `执行器 ${data.status.executor}`
    : '执行器待配置'

  const shell = (children: ReactNode, options: { session?: boolean } = {}) => (
    <div className="ec-wb" data-density={compact ? 'compact' : 'normal'} data-expert={expert ? 'on' : 'off'}>
      {/* E4-4 keyboard path: a skip link lets keyboard users bypass the nav rail (visible on focus). */}
      <a className="ec-wb-skip" href="#ec-wb-content">跳到主内容</a>
      <div className="ec-wb-topbar">
        <span className="ec-wb-mark" aria-hidden="true">{BRAND_MARK}</span>
        <span className="ec-wb-wordmark">EMERALD</span>
        <span className="ec-wb-top-divider" aria-hidden="true" />
        <div className="ec-wb-breadcrumb">
          <span>企业 AI 平台</span><span aria-hidden="true">/</span>
          <span>{sessionWork ? sessionWork.title : historySession ? historySession.title : detailWork ? detailWork.title : navLabel(page, preferences.locale)}</span>
        </div>
        <div className="ec-wb-top-actions">
          <span className={`ec-wb-conn${error ? ' is-down' : ''}`} role="status">{error ? '平台未连接' : '平台已连接'}</span>
          <button type="button" className="ec-wb-icon-btn" aria-label="全局搜索（Ctrl+K）" title="全局搜索（Ctrl+K）" onClick={() => setPaletteOpen(true)}>{GLYPH_SEARCH_TOP}</button>
          <button type="button" className="ec-wb-icon-btn" aria-label="刷新平台数据" title="刷新" onClick={() => void load()}>{GLYPH_REFRESH}</button>
          <button type="button" className="ec-wb-icon-btn" aria-label="紧凑布局" title="紧凑布局" aria-pressed={compact} onClick={toggleCompact}>{GLYPH_DENSITY}</button>
          <button type="button" className="ec-wb-icon-btn" aria-label="专家诊断" title="专家诊断（显示路径/会话/摘要等技术细节）" aria-pressed={expert} onClick={toggleExpert}><Glyph size={16}><path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13 7l-2 10" /></Glyph></button>
          <button type="button" className="ec-wb-icon-btn" aria-label="平台设置" title="平台设置" onClick={() => selectPage('settings')}>{GLYPH_SETTINGS}</button>
        </div>
      </div>
      <div className="ec-wb-shell">
        <nav className="ec-wb-nav" aria-label="企业导航">
          {/* Brand lives once, in the top bar; the rail starts with the primary action. */}
          <button type="button" className="ec-wb-nav-new" onClick={() => { selectPage('works'); startCreate() }}>
            <span className="ec-wb-nav-plus" aria-hidden="true">＋</span>新建工作
          </button>
          <div className="ec-wb-nav-items">
            {PLATFORM_NAV.map((item) => (
              <button
                type="button"
                key={item.id}
                className="ec-wb-nav-item"
                aria-current={!sessionWork && !detailWork && page === item.id ? 'page' : undefined}
                onClick={() => selectPage(item.id)}
              >
                <span className="ec-wb-nav-glyph" aria-hidden="true">{PLATFORM_NAV_ICONS[item.id]}</span>{navLabel(item.id, preferences.locale)}
                {item.id === 'pending'
                  ? <span className="ec-wb-nav-count" data-alert={pendingCount > 0}>{pendingCount}</span>
                  : null}
              </button>
            ))}
          </div>
          <div className="ec-wb-nav-caption">最近打开</div>
          <div className="ec-wb-recent">
            {recentWorks.length === 0
              ? <p className="ec-wb-nav-empty">还没有工作记录。新建工作后，最近打开会出现在这里。</p>
              : recentWorks.map((work) => (
                <button
                  type="button"
                  key={work.workId}
                  className={`ec-wb-recent-item${sessionWork?.workId === work.workId ? ' is-active' : ''}`}
                  onClick={() => void openWork(work.workId)}
                >
                  <strong>{work.title}</strong>
                  <small>{projectName(work.projectId)} · {relativeTime(work.updatedAt, Date.now())}</small>
                </button>
              ))}
          </div>
          <button type="button" className="ec-wb-nav-bottom" onClick={() => selectPage('settings')}>
            <span className="ec-wb-nav-bottom-mark" aria-hidden="true"><Glyph size={13}>{SETTINGS_PATHS}</Glyph></span>
            <span>
              <strong>平台设置</strong>
              <span className="ec-wb-nav-bottom-sub">{executorLabel}</span>
            </span>
            <span className="ec-wb-nav-bottom-arrow" aria-hidden="true">›</span>
          </button>
        </nav>
        <main id="ec-wb-content" className={options.session ? 'ec-wb-main ec-wb-main-session' : 'ec-wb-main'}>
          {networkHint || notice ? <p className="ec-wb-status" role="status" aria-live="polite">{networkHint || notice}</p> : null}
          {children}
        </main>
      </div>
      <CommandPalette
        api={api}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenWork={(workId) => void openWork(workId)}
        onOpenRun={(workId, runId) => void openPendingById(workId, runId)}
        onNavigate={selectPage}
      />
    </div>
  )

  // A refresh restore that needs a server resolution shows the shell with an honest state until
  // the coordinate settles — never the works list flashing past the view the employee was in.
  if (restoring) {
    return shell(
      <div className="ec-wb-page"><p className="ec-wb-muted" role="status">正在恢复上次视图…</p></div>,
    )
  }
  if (error && !data) {
    return shell(
      <div className="ec-wb-page">
        <header className="ec-wb-page-head"><div><h1>{navLabel(page, preferences.locale)}</h1></div></header>
        <section className="ec-wb-card">
          <p className="ec-wb-muted">无法连接平台控制面（{error}）。{networkHint}</p>
          <div className="ec-wb-form-actions"><button type="button" className="ec-wb-button ec-wb-primary" onClick={() => void load()}>重试</button></div>
        </section>
      </div>,
    )
  }
  if (!data) return shell(<div className="ec-wb-page"><p className="ec-wb-muted" role="status">正在加载工作台…</p></div>)

  // Embedded native session view (T13 single-page form): the upstream conversation factory lives
  // inside the enterprise shell. The standard-kit SessionProvider binds the view to the Work's
  // retained reference (the ui-sidebar-right explicit-scoping pattern), so the session entry
  // resolves that exact Session while the native main view stays untouched.
  if (sessionWork) {
    return shell(
      <WorkConsole
        api={api}
        workId={sessionWork.workId}
        title={sessionWork.title}
        modelLabel={defaultModelLabel(data.models)}
        models={data.models}
        onBack={closeSessionView}
        onDetail={() => void openDetailFromConsole(sessionWork.workId)}
        onReload={load}
        {...(focusRunId ? { initialRunId: focusRunId } : {})}
        onFocusRun={(runId) => setFocusRunId(runId ?? undefined)}
      >
        <SessionProvider session={sessionWork.reference}>
          {renderSlot('workbench.session', {})}
        </SessionProvider>
      </WorkConsole>,
      { session: true },
    )
  }

  // A session opened from 历史会话: same embedded native conversation, no Work chrome — the
  // history page is conversation navigation, not a business entry (no run rail, no correlation).
  if (historySession) {
    return shell(
      <HistoryConsole title={historySession.title} onBack={closeHistorySession}>
        <SessionProvider session={historySession.reference}>
          {renderSlot('workbench.session', {})}
        </SessionProvider>
      </HistoryConsole>,
      { session: true },
    )
  }

  if (detailWork) {
    return shell(
      <WorkDetail
        api={api}
        data={data}
        workId={detailWork.workId}
        {...(focusRunId ? { initialRunId: focusRunId } : {})}
        projectName={(projectId) => (data.projects ?? []).find((project) => project.projectId === projectId)?.name ?? projectId}
        onBack={() => { setDetailWork(null); setFocusRunId(undefined); void load() }}
        onOpenSession={openBoundSession}
        onBindSession={bindWorkSession}
        onReload={load}
      />,
    )
  }

  return shell(
    <>
      {page === 'works' ? (
        <WorksPage
          api={api}
          data={data}
          onOpenWork={(workId) => void openWork(workId)}
          onDetail={openDetail}
          onOpenPending={(workId, runId) => void openPendingById(workId, runId)}
          onCreate={startCreate}
          onReload={load}
          creating={creating}
          opening={opening}
          projectId={selectedProjectId}
          onProjectChange={setSelectedProjectId}
          initialAppKey={startAppKey}
          onCreated={(work) => { setCreating(false); setStartAppKey(''); openDetail(work) }}
          onCancelCreate={() => setCreating(false)}
          onNavigate={selectPage}
        />
      ) : null}
      {page === 'sessions' ? (
        <SessionsHistoryPage
          sessionList={sessionList}
          refreshSessionList={refreshSessionList}
          onOpenSession={openHistorySession}
        />
      ) : null}
      {page === 'projects' ? (
        <ProjectsPage api={api} data={data} onReload={load} selectedProjectId={selectedProjectId} onSelect={setSelectedProjectId} />
      ) : null}
      {page === 'apps' ? <AppsPage data={data} /> : null}
      {page === 'pending' ? <PendingPage api={api} data={data} onOpen={(workId, runId) => void openPendingById(workId, runId)} /> : null}
      {page === 'settings' ? <SettingsPage api={api} data={data} onReload={load} /> : null}
    </>,
  )
}
