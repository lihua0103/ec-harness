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
  errorText,
  type ArtifactItem,
  type AuditEntryItem,
  type CatalogReleaseDetail,
  type CatalogSummary,
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
  type PersonalPreferenceItem,
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
import { homePriority, latestHomeRuns } from '../home-priority.js'
import { artifactDownloadPath, formatBytes, monogram, pageWindow, relativeTime, runTone, summarizeArtifacts, type WorkRow } from '../reports.js'
import { buildAnswers, chosenModel, modelChoices, runInput, type NativeQuestion } from '../forms.js'
import type { WorkContext } from '../work-context.js'
import { bindingDraft, selectBindingDomain } from '../work-context.js'
import type { SubmissionWatchOptions } from './submission-observer.js'
import { workPointers } from './pointers.js'
import { clearPersistedView, hashToView, readPersistedView, viewKey, viewToHash, writePersistedView, type PersistedView, type WorkbenchView } from './view-state.js'
import { NavigationGate } from './navigation.js'
import type { WorkbenchRouteCommand, WorkbenchRouteStore } from './route-store.js'
import { EmbeddedConversationViews, EmbeddedViewsProvider, useEmbeddedViewElection } from './embedded-views.js'
import type { ConversationApplication } from './conversation-application.js'
import { KnowledgeBasisCard } from './run-insights.js'
import { RUN_EVENT_LABELS, WorkBrief } from './work-brief.js'
import { WorkIndex, type WorkIndexChip } from './work-index.js'
import { DeskPanel, DeskToolsMenu } from './work-desk-frame.js'
import { pickPreviewWorkId, workRowState } from './work-index-model.js'
import { useWorkIndex, type WorkIndexData, type WorkIndexFilters } from './use-work-index.js'
import { UnifiedTodoList, TODO_KINDS, type TodoItem } from './todo-rows.js'
import {
  availableTimeZones,
  formatDate,
  formatDateTime,
  getPreferences,
  navLabel,
  runStateText,
  setPreferences,
  t,
  usePreferences,
  LOCALES,
  type Locale,
} from './i18n.js'

export type { SubmissionWatchOptions } from './submission-observer.js'
export type { WorkbenchView } from './view-state.js'

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
  /** Release the view's retained reference. With a reference argument, only releases when that
   *  reference is STILL the active view reference (WP3: expired intents free what they own). */
  releaseSession(reference?: SessionReference): void
  /** WP3: the host's navigation gate — each call aborts the previous pending navigation's signal. */
  beginNavigation(): AbortSignal
  /** 单侧栏架构：共享路由状态。主区发布当前坐标并执行侧栏派发的导航命令。 */
  route: WorkbenchRouteStore
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
  /** Resolves once the host's first-screen panel selection has settled; the boot restore waits
   *  on it, because a concurrent selectPanel would abort the restore's navigation intent. */
  platformSelected: Promise<void>
  /** Publish the application of the Work whose conversation is on screen — the platform fact
   *  conversation entries read to decide whether they apply (null when none is on screen). */
  publishConversationApplication(application: ConversationApplication | null): void
}

export type WorkbenchPageProps =
  PropsRuntime<'main'>
  & PropsRenderSlots<'workbench.session'>
  & InjectFace<WorkbenchPageInjected>

/** Props of the embedded-session host entry: session-maybe standard seats, the factory seat, and
 *  the registered conversation View roster (a hooks source from this entry's inject face). */
type WorkbenchSessionHostProps = PropsRuntime<'workbench.session'> & PropsRenderFactories & {
  useConversationViewIds: <S>(select: (ids: readonly string[]) => S) => S
}

/** The `views` local slot of the `conversation.content` factory: our embedded occurrence renders
 *  the host-elected View (see `embedded-views.tsx`), the seat the native header does not provide. */
const EMBEDDED_CONTENT_SLOTS = { views: EmbeddedConversationViews }

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
  sessionId, useSession, useSessions, useConversation, renderFactorySlot, useConversationViewIds,
}: WorkbenchSessionHostProps) {
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const viewIds = useConversationViewIds(ids => ids)
  const election = useEmbeddedViewElection(sessionId, viewIds)
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : conversationPhase(session, conversation)
  const openState = session?.openState
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  const settling = sessionId !== undefined && shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true
  const hero = sessionId === undefined
    || (shellPhase === 'blank' && (openState === 'open' || summaryBlank === true))
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  // The View tab strip the native session header would host. Without it, a tool-call 「查看」 action
  // (Trajectory View) leaves the embedded conversation with no way back — the tab is that way.
  const tabStrip = election.tabs.length > 1
    ? (
      <div className="ec-wb-session-view-tabs" role="tablist" aria-label={t('session.viewTabs')}>
        {election.tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === election.selected}
            className={tab.id === election.selected ? 'ec-wb-session-view-tab ec-wb-session-view-tab-active' : 'ec-wb-session-view-tab'}
            onClick={() => election.select(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    )
    : null
  return (
    <div className="ec-wb-session-conversation" data-ec-embedded-session={sessionId ?? undefined}>
      {tabStrip}
      <EmbeddedViewsProvider selected={election.selected}>
        {renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, { slots: EMBEDDED_CONTENT_SLOTS })}
      </EmbeddedViewsProvider>
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
const SEARCH_PATHS = (
  <>
    <circle cx="11" cy="11" r="6.5" />
    <line x1="16" y1="16" x2="21" y2="21" />
  </>
)
const GLYPH_CHECK = <Glyph size={11}><polyline points="4 12.5 9 17.5 20 6.5" /></Glyph>
const GLYPH_SEARCH_TOP = <Glyph size={16}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.2" y2="16.2" /></Glyph>
const GLYPH_SPARK = <Glyph size={19}><path d="M12 3.5 14.6 9.4 20.5 12 14.6 14.6 12 20.5 9.4 14.6 3.5 12 9.4 9.4Z" /></Glyph>

/** Today's date as the home eyebrow; the platform records no "business day", so this is local time. */
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

/** E3-4 unified todo rows moved to `todo-rows.tsx` (shared with the work brief). */

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
    // Escape closes from anywhere: focus lands on the input one tick later, so a quick Escape
    // would otherwise fall on the body and leave the overlay open — a keyboard trap.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
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
    // DSH 0.2.2-rc.2 起 macOS Desktop 只在 data-window-drag 行内自动排除控件；本浮层覆盖整个窗口，
    // 背板与面板自行声明拖拽排除，否则面板落在标题栏拖拽行上时会被拖动窗口（Web 与 Windows 不受影响）。
    <div className="ec-wb-palette-backdrop" data-window-drag-exclude onClick={onClose}>
      <div className="ec-wb-palette" role="dialog" aria-modal="true" aria-label="全局搜索" data-window-drag-exclude onClick={(event) => event.stopPropagation()}>
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

/** Unified todo rows (E3-4) live in `todo-rows.tsx` now. */

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
  // 获准目录（W5/R2）：表单只列出当前项目获准创建的发布。控制面按默认指针、策略与审批
  // 过滤，浏览器不自行决定版本；bootstrap 的应用摘要只是展示信息，不再是创建清单。
  const [catalog, setCatalog] = useState<CatalogSummary[]>([])
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [catalogError, setCatalogError] = useState('')
  const [projectId, setProjectId] = useState(() =>
    projects.some((project) => project.projectId === initialProjectId) ? initialProjectId ?? '' : projects[0]?.projectId ?? '')
  const [workspaceId, setWorkspaceId] = useState('')
  const [spaces, setSpaces] = useState<WorkspaceItem[] | null>(null)
  const [spacesError, setSpacesError] = useState('')
  const [appKey, setAppKey] = useState(initialAppKey ?? '')
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

  useEffect(() => { void loadSpaces(projectId) }, [projectId, loadSpaces])

  // 获准目录随项目读取；换项目重读。循环取全所有目录页，创建清单不被单页截断；
  // 撤权后这里直接报错，不显示缓存的旧目录（R2/R4）。
  const loadCatalog = useCallback(async (id: string) => {
    if (!id) { setCatalog([]); setCatalogState('ready'); return }
    setCatalogState('loading')
    try {
      const items: CatalogSummary[] = []
      let cursor: string | null = null
      for (;;) {
        const page = await api.catalogSummaries(id, { cursor, limit: 100 })
        items.push(...page.items)
        cursor = page.nextCursor
        if (!cursor) break
      }
      setCatalog(items)
      setCatalogState('ready')
      setCatalogError('')
    } catch (reason) {
      setCatalog([])
      setCatalogState('error')
      setCatalogError(errorText(reason))
    }
  }, [api])
  useEffect(() => { void loadCatalog(projectId) }, [projectId, loadCatalog])

  // 目录就绪后校验当前选择：快速目标的发布不在获准目录里就回落到第一项，绝不提交未获准的版本。
  useEffect(() => {
    if (catalogState !== 'ready') return
    setAppKey((previous) => {
      const wanted = initialAppKey && catalog.some((app) => `${app.appId}|${app.appVersion}` === initialAppKey)
        ? initialAppKey
        : previous
      return catalog.some((app) => `${app.appId}|${app.appVersion}` === wanted)
        ? wanted
        : catalog[0] ? `${catalog[0].appId}|${catalog[0].appVersion}` : ''
    })
  }, [catalog, catalogState, initialAppKey])
  // A project with no directory cannot proceed, so its registration form opens by itself; the
  // employee can still close it once the project actually has one.
  useEffect(() => { if (spaces && spaces.length === 0) setSpaceFormOpen(true) }, [spaces])

  const selectedApp = catalog.find((app) => `${app.appId}|${app.appVersion}` === appKey)
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
            <Field label="应用" hint={selectedApp?.listingTypes?.length ? `该应用声明场景：${selectedApp.listingTypes.join(' / ')}；场景在发起运行时选择` : '应用来自平台获准目录；员工的日常问答不使用应用也可以进行。'}>
              {catalogState === 'loading'
                ? <p className="ec-wb-muted" role="status">正在读取获准目录…</p>
                : catalogState === 'error'
                  ? <ErrorBox message={`无法读取获准目录：${catalogError}`} onRetry={() => void loadCatalog(projectId)} />
                  : catalog.length === 0
                    ? <p className="ec-wb-empty">当前项目没有获准的应用发布；请联系平台管理员登记。</p>
                    : (
                      <select className="ec-wb-select" value={appKey} onChange={(event) => setAppKey(event.target.value)}>
                        {catalog.map((app) => (
                          <option key={`${app.appId}@${app.appVersion}`} value={`${app.appId}|${app.appVersion}`}>
                            {app.displayName} @{app.appVersion}
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
              <dt>应用</dt><dd>{selectedApp ? `${selectedApp.displayName} @${selectedApp.appVersion}` : '未选择'}</dd>
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
  /** Scenarios the released application declares; options come from the release descriptor. */
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
            <span className="ec-wb-field-label">业务场景</span>
            <select className="ec-wb-select" aria-label="业务场景" value={listingType} disabled={busy}
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
  // 复核目标清单（W4）：绑定记录来自请求时冻结的服务端清单；legacy 记录没有 deliverable，
  // 界面如实标注「未绑定具体成果版本」，不冒充已绑定。
  const target = open?.deliverable ?? latestDecision?.deliverable
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
      await api.decideReview(open.reviewId, decision, open.revision, {
        expectedManifestDigest: open.deliverable?.manifestDigest,
        note: note.trim() || undefined,
      })
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
        <dt>目标清单</dt>
        <dd>{!open && !latestDecision
          ? '未发起'
          : target
            ? <>已绑定 {target.manifest.artifacts.length} 项封存工件<span className="ec-wb-expert-only"> · 清单摘要 {target.manifestDigest.slice(0, 12)}…</span></>
            : '未绑定具体成果版本（旧记录）'}</dd>
      </dl>
      <p className="ec-wb-muted">运行成功、成果封存与业务复核是三件不同的事；复核记录绑定本次运行，不改变运行状态，也不代替交付批准。决定按复核绑定的成果清单提交，清单不一致的决定不会被服务端接受。</p>
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
function DeliveryPointerCard({ api, workId, runs, reviewsError }: {
  api: WorkbenchApi
  workId: string
  runs: Page<RunSummary>
  reviewsError?: string
}) {
  const [baselines, setBaselines] = useState<Page<InputBaselineItem> | null>(null)
  const [baselinesError, setBaselinesError] = useState('')
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null)
  const candidateRunId = runs.items.find((run) => run.snapshot?.state === 'SUCCEEDED')?.runId ?? null

  // 输入基线自含加载：工作台右栏没有详情页的批次状态，指针卡自己读；读不到就如实说明，不冒充「无批次」。
  useEffect(() => {
    let live = true
    setBaselines(null)
    void (async () => {
      try {
        const page = await api.workInputBaselines(workId, { offset: 0, limit: BASELINE_PAGE })
        if (live) { setBaselines(page); setBaselinesError('') }
      } catch (reason) {
        if (live) { setBaselines(null); setBaselinesError(errorText(reason)) }
      }
    })()
    return () => { live = false }
  }, [api, workId])

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

  const pointers = workPointers(baselines?.items ?? [], runs.items, reviews)
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
          {baselines === null
            ? (baselinesError ? `输入批次读取失败：${baselinesError}` : '正在读取输入批次…')
            : pointers.baseline
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

/** 输入批次卡（自含加载）：批次只追加，不覆盖旧基线；换批重跑表单随卡片出现。
 *  工作详情页与工作台右栏共用同一张卡，避免两份批次状态各自漂移。 */
function InputBaselinesCard({ api, workId, catalog, preference, hasWorkspace, activeRunId, allowRerun, onCreated }: {
  api: WorkbenchApi
  workId: string
  catalog: ModelCatalog | null | undefined
  preference: ModelPreference | null | undefined
  hasWorkspace: boolean
  activeRunId?: string | null
  allowRerun?: boolean
  onCreated(runId: string): void
}) {
  const [baselines, setBaselines] = useState<Page<InputBaselineItem>>({ total: 0, items: [] })
  const [baselinesOffset, setBaselinesOffset] = useState(0)
  const [baselinesError, setBaselinesError] = useState('')

  const load = useCallback(async (offset: number) => {
    setBaselinesError('')
    try {
      const page = await api.workInputBaselines(workId, { offset, limit: BASELINE_PAGE })
      setBaselines(page)
      setBaselinesOffset(offset)
    } catch (reason) {
      setBaselinesError(errorText(reason))
    }
  }, [api, workId])
  useEffect(() => { void load(0) }, [load])

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-baselines">
      <div className="ec-wb-card-head"><h2 id="ec-wb-baselines">输入批次</h2><span className="ec-wb-badge">{baselines.total}</span></div>
      <p className="ec-wb-muted">批次只追加，不覆盖旧基线；旧执行始终对应它当时的输入摘要。</p>
      {baselinesError
        ? <ErrorBox message={`无法读取输入批次：${baselinesError}`} onRetry={() => void load(baselinesOffset)} />
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
              <Pager total={baselines.total} offset={baselinesOffset} limit={BASELINE_PAGE} busy={false} onOffset={(offset) => void load(offset)} />
            </div>
          )}
      {allowRerun
        ? (
          <RerunForm
            api={api}
            workId={workId}
            catalog={catalog}
            preference={preference}
            hasWorkspace={hasWorkspace}
            activeRunId={activeRunId}
            onCreated={(runId) => { void load(0); onCreated(runId) }}
          />
        )
        : null}
    </section>
  )
}

/** 本次执行输入卡（自含加载）：该运行实际接收的冻结输入，由控制面分页裁定。
 *  工作详情页与工作台右栏共用同一张卡。 */
function RunInputsCard({ api, runId, refreshToken }: {
  api: WorkbenchApi
  runId: string | null
  refreshToken?: number
}) {
  const [inputs, setInputs] = useState<Page<InputCommitItem>>({ total: 0, items: [] })
  const [inputsOffset, setInputsOffset] = useState(0)
  const [inputsError, setInputsError] = useState('')

  const load = useCallback(async (offset: number) => {
    if (!runId) return
    setInputsError('')
    try {
      const page = await api.runInputs(runId, { offset, limit: INPUT_PAGE })
      setInputs(page)
      setInputsOffset(offset)
    } catch (reason) {
      setInputs({ total: 0, items: [] })
      setInputsError(errorText(reason))
    }
  }, [api, runId])

  useEffect(() => { void load(0) }, [load, refreshToken])

  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-run-inputs">
      <div className="ec-wb-card-head"><h2 id="ec-wb-run-inputs">本次执行输入</h2><span className="ec-wb-badge">{inputs.total}</span></div>
      {!runId
        ? <p className="ec-wb-empty">选择一个运行后可查看该次执行接收的输入。</p>
        : inputsError
          ? <ErrorBox message={`无法读取执行输入：${inputsError}`} onRetry={() => void load(inputsOffset)} />
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
                <Pager total={inputs.total} offset={inputsOffset} limit={INPUT_PAGE} busy={false} onOffset={(offset) => void load(offset)} />
              </div>
            )}
    </section>
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
  const [interactionToken, setInteractionToken] = useState(0)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveNotice, setArchiveNotice] = useState('')
  const [bindBusy, setBindBusy] = useState(false)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)
  const [bindingError, setBindingError] = useState('')
  // 获准目录的发布声明（W5/R2）：按需读取，不进任何缓存；读不到就报错，不显示旧声明。
  const [decl, setDecl] = useState<{ listingTypes: string[]; resultViews: ResultViewDecl[] } | null>(null)
  const [declError, setDeclError] = useState('')

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

  useEffect(() => { void loadContext() }, [loadContext])
  useEffect(() => { void loadRuns(0) }, [loadRuns])

  // 发布声明按需读取（W5/R2）：bootstrap 应用摘要不再携带 descriptor；详情页自己读
  // /api/catalog/:appId，撤权或下架后读取失败时如实报错，绝不显示缓存的旧声明。
  useEffect(() => {
    if (!context) { setDecl(null); setDeclError(''); return undefined }
    let live = true
    setDecl(null)
    void (async () => {
      try {
        const detail = await api.catalogRelease(context.app.appId, context.work.projectId)
        if (!live) return
        setDecl({
          listingTypes: Array.isArray(detail.app.descriptor?.listingTypes) ? detail.app.descriptor.listingTypes : [],
          resultViews: Array.isArray(detail.app.descriptor?.resultViews) ? detail.app.descriptor.resultViews : [],
        })
        setDeclError('')
      } catch (reason) {
        if (!live) return
        setDecl(null)
        setDeclError(errorText(reason))
      }
    })()
    return () => { live = false }
  }, [api, context])

  useEffect(() => {
    if (selectedRunId) {
      void loadArtifacts(selectedRunId)
    } else {
      setArtifacts([])
    }
  }, [selectedRunId, loadArtifacts])
  useEffect(() => { heading.current?.focus() }, [])

  const selectedRun = runs.items.find((run) => run.runId === selectedRunId) ?? null
  const artifactWindow = pageWindow(artifacts.length, artifactsOffset, ARTIFACT_PAGE)
  const visibleArtifacts = artifacts.slice(artifactWindow.offset, artifactWindow.offset + ARTIFACT_PAGE)
  const artifactSummary = summarizeArtifacts(artifacts)
  const boundSessionId = context?.binding?.sessionId ?? context?.sessionId ?? null
  const listingTypes = decl?.listingTypes ?? []
  const resultViews = decl?.resultViews ?? []
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
            <Freshness at={lastLoadedAt} busy={runsLoading} onRefresh={() => { void loadContext(); void loadRuns(runsOffset) }} />
            <button type="button" className="ec-wb-button ec-wb-primary" onClick={openBound} disabled={!boundSessionId}>{bindBusy ? '正在创建对话…' : t('action.enterChat')}</button>
            <button type="button" className="ec-wb-button" onClick={() => void onReload()}>{t('action.refresh')}</button>
            <button type="button" className="ec-wb-button" disabled={archiveBusy || context?.work.state === 'ARCHIVED'} onClick={() => void archive()}>
              {archiveBusy ? '归档中…' : t('action.archive')}
            </button>
          </div>
        </header>
        <p className="ec-wb-status" role="status" aria-live="polite">{notice}{archiveNotice ? ` ${archiveNotice}` : ''}</p>

        {contextError ? <ErrorBox message={`无法读取工作上下文：${contextError}`} onRetry={() => void loadContext()} /> : null}
        {declError ? <p className="ec-wb-muted" role="status">发布声明读取失败：{declError}。场景与结果视图暂不可选；不显示缓存的旧声明。</p> : null}

        <div className="ec-wb-detail">
          <div className="ec-wb-stack">
            <DeliveryPointerCard api={api} workId={workId} runs={runs} />
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
                  resultViews={resultViews}
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

            <InputBaselinesCard
              api={api}
              workId={workId}
              catalog={data.models?.catalog}
              preference={data.models?.preference}
              hasWorkspace={!!context?.workspace}
              activeRunId={activeRun?.runId ?? null}
              allowRerun={context?.work.state !== 'ARCHIVED'}
              onCreated={(runId) => void onRunCreated(runId)}
            />

            <RunInputsCard api={api} runId={selectedRun?.runId ?? null} refreshToken={interactionToken} />
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
 *  first. Unlike the live activity window, these survive a control-plane restart. Labels are
 *  shared with the work brief (`work-brief.tsx`). */
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

type SessionProviderComponent = WorkbenchPageProps['SessionProvider']

function WorkConsole({ api, workId, title, modelLabel, models, onReload, initialRunId, onFocusRun, SessionProvider, sessionSlot, workSessionId, retainSessionById, retainWorkSession, adoptWorkReference, workEpoch, releaseRunReference, railPanelOpen, onRailPanelToggle, children }: {
  api: WorkbenchApi
  workId: string
  title: string
  modelLabel: string
  models?: WorkbenchBootstrap['models']
  /** Refresh the shell bootstrap so the home counters reflect a run this console just changed. */
  onReload(): Promise<void>
  /** Run to focus on open — a refresh restore re-enters the run the employee had selected. */
  initialRunId?: string
  /** The employee's focused run, mirrored to the persisted view coordinate for refresh survival. */
  onFocusRun?(runId: string | null): void
  /** The framework SessionProvider target: the center's one native conversation stream rebinds
   *  to whichever session the rail selection names — 会话对话 shows the Work session, a 运行
   *  row shows that run's own native conversation. Exactly one stream is mounted at all times. */
  SessionProvider: SessionProviderComponent
  /** The registered session slot (the native conversation UI) rendered inside the provider. */
  sessionSlot: ReactNode
  /** The Work's own bound session id — the center returns here when the selection is 会话对话. */
  workSessionId: string
  /** Retain any known session id (catalog-race tolerant) as the active single-slot reference. */
  retainSessionById(sessionId: string): Promise<SessionReference>
  /** Synchronous direct retain, used ONLY for the Work's own session on the way back: it cannot
   *  hit the catalog race (openWork already retained it), and the single-slot release of the run
   *  reference plus the viewSession clear must land in one batched continuation — a released
   *  reference throws the moment SessionProvider's renderer reads it (binding → "is released"). */
  retainWorkSession(sessionId: string): SessionReference
  /** Adopt the fresh reference a retain returned back into the page state. The single slot
   *  releases the previous Work reference on every swap, so the stored copy goes stale the
   *  moment any other session is retained — `children` must render the CURRENT reference or
   *  SessionProvider's renderer throws "is released". */
  adoptWorkReference(reference: SessionReference): void
  /** Incremented on every page-level Work-session commit or adopt (openWork, openBoundSession,
   *  the way-back swap). The run view is valid only under the epoch it was opened in: a later
   *  epoch means the page re-retained some session on the single slot, which released this
   *  view's reference — the view must withdraw (or re-bind) instead of rendering it. */
  workEpoch: number
  /** WP3-precise release: frees a retained run reference only when it is still the active slot. */
  releaseRunReference(reference: SessionReference): void
  /** Desk shell (方案 B): the main area is too narrow for a persistent rail column — the CSS
   *  container query turns the rail (工作资料) into a temporary panel and shows the toggle.
   *  Panel semantics are additive shell behaviour — mount timing, request ownership and the
   *  reference swap below never change with the width. */
  railPanelOpen?: boolean
  onRailPanelToggle?(open: boolean): void
  children: ReactNode
}) {
  const [context, setContext] = useState<WorkContext | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [runsTotal, setRunsTotal] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null)
  // 2026-11-23 定调：右边有会话历史，点击切换，中间 chat 就要显示对应历史数据。中心永远只有
  // 一个原生会话流，但流绑定哪个会话跟随右栏选择：会话对话 → Work 自己的会话；运行行 → 该运行
  // result.sessionId 的原生会话。runView 持有该交换的单槽引用；epoch 不匹配即撤回（引用已被
  // 页面级交换释放，渲染它会直接抛错）。
  const [runView, setRunView] = useState<{ runId: string; epoch: number; reference: SessionReference } | null>(null)
  const [viewError, setViewError] = useState('')
  const [viewBusy, setViewBusy] = useState(false)
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([])
  const [error, setError] = useState('')
  const [artifactsError, setArtifactsError] = useState('')
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [token, setToken] = useState(0)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)
  const [downloadNotice, setDownloadNotice] = useState('')
  // W5 纵向切片：启动/问答/成果/复核都在右栏完成；「详情」是右栏内的展开而不是跳转页——
  // 跳转会卸载原生会话，违背 R4「原生会话不卸载」。
  const [runsLimit, setRunsLimit] = useState(5)
  const [detailOpen, setDetailOpen] = useState(false)
  const [showAllArtifacts, setShowAllArtifacts] = useState(false)
  const [draftSeed, setDraftSeed] = useState('')
  const [interactionToken, setInteractionToken] = useState(0)
  const [decl, setDecl] = useState<{ listingTypes: string[]; resultViews: ResultViewDecl[] } | null>(null)
  const [declError, setDeclError] = useState('')
  // SSE drives live run updates when connected; the 15s poll is the fallback. A ref lets the
  // mount-time interval read the latest liveness without re-subscribing.
  const sseLiveRef = useRef(false)
  // Mirrors for the synchronous swap handlers: load's auto-refresh prune and the rail clicks run
  // with whatever closure the callback was built in, so they read the refs, not the state.
  const selectedRunIdRef = useRef<string | null>(selectedRunId)
  selectedRunIdRef.current = selectedRunId
  // Mirrors for the synchronous swap handlers and the async seq guard: rail clicks and load's
  // prune run with whatever closure built them, so they read the refs, not the state.
  const runViewRef = useRef(runView)
  runViewRef.current = runView
  const workEpochRef = useRef(workEpoch)
  workEpochRef.current = workEpoch
  // One increment per swap attempt: a superseded attempt releases what it retained (WP3) and
  // commits nothing — only the newest attempt may commit a run reference to the single slot.
  const swapSeqRef = useRef(0)

  // An async swap INTO a run's native conversation. retainSessionById is catalog-race tolerant;
  // from its resolution to the commit there is no await, so the single-slot release inside the
  // retain and this batched commit never land in different paints (a released reference throws
  // the moment SessionProvider's renderer reads it). A run without a result.sessionId — unknown,
  // or a session the host cannot resolve — stays on the Work chat with an honest rail error.
  const openRunView = useCallback(async (run: RunSummary): Promise<void> => {
    setSelectedRunId(run.runId)
    onFocusRun?.(run.runId)
    const current = runViewRef.current
    if (current && current.runId === run.runId && current.epoch === workEpochRef.current) return
    const seq = ++swapSeqRef.current
    setViewError('')
    setViewBusy(true)
    try {
      const detail = await api.runDetail(run.runId)
      const sessionId = detail.result?.sessionId
      if (!sessionId) throw new Error('RUN_SESSION_MISSING')
      const reference = await retainSessionById(sessionId)
      if (swapSeqRef.current !== seq) { releaseRunReference(reference); return }
      setRunView({ runId: run.runId, epoch: workEpochRef.current, reference })
      setViewBusy(false)
    } catch (reason) {
      if (swapSeqRef.current !== seq) return
      setViewBusy(false)
      setViewError(errorText(reason))
    }
  }, [api, onFocusRun, releaseRunReference, retainSessionById])

  // The way back is a SYNCHRONOUS swap: re-retain the Work session on the single slot (which
  // releases the run reference), adopt the returned fresh reference into the page state (the
  // stored Work reference went stale when the run was retained), and clear the run view in the
  // same batched continuation. Retains are synchronous, so the whole dance is one event-handler
  // batch — the released run reference is never painted. Returns false only when the Work
  // session can no longer be retained at all; the run view then stays with an honest error.
  const closeRunView = useCallback((): boolean => {
    setViewError('')
    const current = runViewRef.current
    if (!current || current.epoch !== workEpochRef.current) {
      // Nothing live to tear down — a stale epoch means the page already re-retained some
      // session; this is a pure selection reset.
      setRunView(null)
      setSelectedRunId(null)
      onFocusRun?.(null)
      return true
    }
    try {
      const reference = retainWorkSession(workSessionId)
      adoptWorkReference(reference)
      setRunView(null)
      setSelectedRunId(null)
      onFocusRun?.(null)
      return true
    } catch (reason) {
      setViewError(errorText(reason))
      return false
    }
  }, [adoptWorkReference, onFocusRun, retainWorkSession, workSessionId])

  // A run view whose epoch moved on is holding a released reference: withdraw it in the first
  // commit after the page-level swap (the render guard below already hides it that commit).
  useEffect(() => {
    if (runView && runView.epoch !== workEpoch) setRunView(null)
  }, [runView, workEpoch])
  // The view the center renders: only a run view under its own epoch may mount the run session.
  const runViewLive = runView !== null && runView.epoch === workEpoch

  const load = useCallback(async () => {
    try {
      const [resolved, page] = await Promise.all([
        api.workContext(workId),
        api.workRuns(workId, { offset: 0, limit: runsLimit }),
      ])
      setContext(resolved)
      setRuns(page.items)
      setRunsTotal(page.total)
      setError('')
      setLastLoadedAt(Date.now())
      setSelectedRunId((previous) => previous && page.items.some((run) => run.runId === previous)
        ? previous
        : null)
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [api, workId, runsLimit])

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

  // The center swap (above) mounts at most one SessionProvider: the Work's children under the
  // Work session, or the same session slot under the selected run's retained reference.

  // 发布声明按需读取（W5/R2）：与详情页同一规则——不缓存，撤权后如实报错，不显示旧声明。
  useEffect(() => {
    if (!context) { setDecl(null); setDeclError(''); return undefined }
    let live = true
    setDecl(null)
    void (async () => {
      try {
        const detail = await api.catalogRelease(context.app.appId, context.work.projectId)
        if (!live) return
        setDecl({
          listingTypes: Array.isArray(detail.app.descriptor?.listingTypes) ? detail.app.descriptor.listingTypes : [],
          resultViews: Array.isArray(detail.app.descriptor?.resultViews) ? detail.app.descriptor.resultViews : [],
        })
        setDeclError('')
      } catch (reason) {
        if (!live) return
        setDecl(null)
        setDeclError(errorText(reason))
      }
    })()
    return () => { live = false }
  }, [api, context])

  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null
  // A run that is executing right now is a fact the employee must see even while they read live
  // chat; recording it on the rail keeps "暂无" from contradicting the run history below it.
  const activeRun = runs.find((run) => ['QUEUED', 'STARTING', 'RUNNING'].includes(String(run.snapshot?.state))) ?? null
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

  /** 复核/问答/运行任一变化后同时刷新运行事实与登记面板；onReload 同步首页计数。 */
  const refreshAll = useCallback(() => {
    setToken((value) => value + 1)
    setInteractionToken((value) => value + 1)
    void onReload()
  }, [onReload])

  // 工作资料临时面板（方案 B）：窄主区下右栏收成面板（几何由 container query 表达）。Escape
  // 关闭、打开即移入面板、关闭后焦点还给触发按钮；这只改变外壳几何，不改数据拥有者、挂载
  // 时机或请求语义。宽容器下「工作资料」按钮被 CSS 隐藏，面板不会打开。
  const railRef = useRef<HTMLElement | null>(null)
  const railDialogOpen = railPanelOpen === true
  useEffect(() => {
    if (!railDialogOpen) return undefined
    const rail = railRef.current
    const previous = document.activeElement as HTMLElement | null
    const timer = setTimeout(() => {
      // 焦点落在面板容器上（打开态带 tabIndex=-1），而不是面板里的第一个控件：聚焦控件会让浏览器
      // 把它滚进视口，面板一打开就停在半截（2026-11-24 实测滚过 670px）。容器自身就是滚动容器，
      // 聚焦它不会移动内容；之后按 Tab 自然进入第一个控件。
      rail?.focus({ preventScroll: true })
    }, 0)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onRailPanelToggle?.(false) }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [railDialogOpen, onRailPanelToggle])

  return (
    <div className="ec-wb-console">
      <header className="ec-wb-console-head">
        <div>
          {/* 基准图 B2：内容区从工作标题开始；返回走全局导航（我的工作）或索引点击另一行，
              头部不再放第二套返回链接。 */}
          <div className="ec-wb-console-crumb">
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
          <button type="button" className="ec-wb-button ec-wb-rail-toggle" aria-expanded={Boolean(railPanelOpen)}
            onClick={() => onRailPanelToggle?.(!railPanelOpen)}>
            {t('rail.materials')}
          </button>
          <button type="button" className="ec-wb-button" aria-expanded={detailOpen} aria-controls="ec-wb-console-detail"
            onClick={() => setDetailOpen((value) => !value)}>
            {detailOpen ? '收起详情' : '详情'}
          </button>
          <button type="button" className="ec-wb-button ec-wb-stop"
            disabled={!selectedRun || !!control.busy || terminal || state === 'UNKNOWN'}
            onClick={() => void control.act('cancel')}>
            {control.busy === 'cancel' ? '请求中…' : t('action.stop')}
          </button>
        </div>
      </header>

      {/* data-desk-rail（方案 B）：宽容器恒为列布局（CSS 忽略该值）；窄容器 open/closed 把右栏
          收成「工作资料」临时面板。面板态只改外壳几何——中心仍是原生会话，数据拥有者不变。 */}
      <div className="ec-wb-console-body" data-desk-rail={railPanelOpen ? 'open' : 'closed'}>
        {/* 2026-11-23 定调：中心永远只有一个原生会话流，但流绑定哪个会话跟随右栏运行历史的选择
            ——会话对话渲染 Work 会话（children），运行行渲染该运行自己的原生会话（同一 sessionSlot
            换绑）。两个分支共用同一个 thread 容器与同一份几何，交换只换内容不换布局；任何时刻
            只挂载一个 SessionProvider，抄本/事件/知识依据仍然只在右栏。 */}
        <div className="ec-wb-console-center">
          <div className="ec-wb-console-thread" data-run-view={runViewLive && runView ? runView.runId : undefined}>
            {runViewLive && runView
              ? (
                <SessionProvider key={`run:${runView.runId}`} session={runView.reference}>
                  {sessionSlot}
                </SessionProvider>
              )
              : children}
          </div>
        </div>
        <aside className="ec-wb-console-rail" aria-label={t('rail.materials')} ref={railRef} tabIndex={railDialogOpen ? -1 : undefined}>
          {/* 基准图 B2：右栏是「工作资料」；分组只是视觉收拢——每张卡片的挂载条件与请求语义
              原样保留；高优先事项（复核/问答）不藏在默认关闭的深层面板。 */}
          <h2 className="ec-wb-rail-title">{t('rail.materials')}</h2>
          <section className="ec-wb-rail-group" aria-labelledby="ec-wb-rail-current">
            <h2 className="ec-wb-rail-group-title" id="ec-wb-rail-current">{t('rail.currentRun')}</h2>
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
              {!selectedRun && activeRun
                ? (
                  <div className="ec-wb-fact-line">
                    <span>活动运行</span>
                    <span>{activeRun.runId.slice(0, 8)} · {runStateText(activeRun.snapshot?.state)}</span>
                  </div>
                )
                : null}
            </div>
            {!selectedRun && activeRun
              ? (
                <div className="ec-wb-form-actions">
                  <button type="button" className="ec-wb-button"
                    onClick={() => { void openRunView(activeRun) }}>
                    查看运行记录
                  </button>
                </div>
              )
              : null}
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

            {/* 运行记录只在右栏（2026-11-23：中心永远只有一个原生会话流）：选中运行的对话抄本、
                事件日志与知识依据都在这里，中心不叠加任何运行视图。 */}
            {selectedRun
              ? (
                <>
                  <section className="ec-wb-card ec-wb-rail-transcript" aria-labelledby="ec-wb-rail-transcript">
                    <div className="ec-wb-card-head">
                      <h3 id="ec-wb-rail-transcript">运行记录</h3>
                    </div>
                    <RunTranscript api={api} runId={selectedRun.runId} token={token} onRetryError={() => setToken((current) => current + 1)} />
                  </section>
                  <RunEvents api={api} runId={selectedRun.runId} token={token} />
                  <KnowledgeBasisCard api={api} runId={selectedRun.runId} />
                </>
              )
              : null}

            {selectedRun
              ? (
                <ResultViewsCard
                  api={api}
                  run={selectedRun}
                  resultViews={decl?.resultViews ?? []}
                  comparableRunIds={runs
                    .filter((candidate) => candidate.runId !== selectedRun.runId && candidate.snapshot?.state === 'SUCCEEDED')
                    .map((candidate) => ({ runId: candidate.runId, label: `运行 ${candidate.runId.slice(0, 8)} · ${formatTime(candidate.createdAt)}` }))}
                />
              )
              : null}
          </section>

          <section className="ec-wb-rail-group" aria-labelledby="ec-wb-rail-pending">
            <h2 className="ec-wb-rail-group-title" id="ec-wb-rail-pending">{t('rail.pending')}</h2>
            {/* W5 纵向切片——复核在右栏完成：面板先读复核记录携带的目标清单，决定随清单提交。 */}
            {selectedRun
              ? <ReviewPanel api={api} run={selectedRun} onChanged={refreshAll} />
              : null}

            {/* W5——问答回复在右栏完成；答复登记不当作引擎接收，未知不自动重投。 */}
            {selectedRun
              ? (
                <InteractionPanel
                  api={api}
                  runId={selectedRun.runId}
                  refreshToken={interactionToken}
                  onChanged={refreshAll}
                />
              )
              : null}

            <DeliveryPackagesCard api={api} workId={workId} runs={{ total: runsTotal, items: runs }} workArchived={archived} />
          </section>

          <section className="ec-wb-rail-group" aria-labelledby="ec-wb-rail-launch">
            <h2 className="ec-wb-rail-group-title" id="ec-wb-rail-launch">{t('rail.launch')}</h2>
            {declError ? <p className="ec-wb-muted" role="status">发布声明读取失败：{declError}。场景与结果视图暂不可选；不显示缓存的旧声明。</p> : null}

            {!archived
              ? (
                <>
                  <DraftPanel api={api} workId={workId} onUseDraft={setDraftSeed} />
                  <RunLauncher
                    api={api}
                    workId={workId}
                    catalog={models?.catalog}
                    preference={models?.preference}
                    hasWorkspace={!!context?.workspace && !archived}
                    listingTypes={decl?.listingTypes ?? []}
                    activeRunId={activeRun?.runId ?? null}
                    initialText={draftSeed}
                    onCreated={(runId) => { closeRunView(); setSelectedRunId(runId); onFocusRun?.(null); refreshAll() }}
                  />
                </>
              )
              : null}
          </section>

          <section className="ec-wb-rail-group" aria-labelledby="ec-wb-rail-files">
            <h2 className="ec-wb-rail-group-title" id="ec-wb-rail-files">{t('rail.files')}</h2>
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
                        {artifacts.slice(0, showAllArtifacts ? artifacts.length : 5).map((artifact) => (
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
                      {artifacts.length > (showAllArtifacts ? 0 : 5)
                        ? (
                          <button type="button" className="ec-wb-text-link" aria-expanded={showAllArtifacts}
                            onClick={() => setShowAllArtifacts((value) => !value)}>
                            {showAllArtifacts ? '收起' : `查看全部 ${artifacts.length} 项`}
                          </button>
                        )
                        : null}
                    </>
                  )}
            {downloadNotice ? <p className="ec-wb-error-text" role="alert">{downloadNotice}</p> : null}
            </section>
          </section>

          <section className="ec-wb-rail-group" aria-labelledby="ec-wb-rail-runs">
            <h2 className="ec-wb-rail-group-title" id="ec-wb-rail-runs">{t('rail.runs')}</h2>
            <section className="ec-wb-card ec-wb-runs-card" aria-labelledby="ec-wb-console-runs">
            <div className="ec-wb-card-head">
              <h3 id="ec-wb-console-runs">运行历史</h3>
              <span className="ec-wb-badge">{runsTotal}</span>
            </div>
            {/* 诚实反馈就地显示：打开运行会话失败（会话未知/无原生会话）不吞掉，也不假装已切换。 */}
            {viewBusy ? <p className="ec-wb-muted" role="status">正在打开该运行的原生会话…</p> : null}
            {viewError ? <p className="ec-wb-error-text" role="alert">无法打开该运行的原生会话：{viewError}。对话抄本仍在上方运行记录卡片中。</p> : null}
            <button type="button" className="ec-wb-run-row" aria-current={selectedRunId === null}
              onClick={() => { closeRunView() }}>
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
                  onClick={() => { void openRunView(run) }}>
                  <span className="ec-wb-run-dot" data-tone={runTone(run.snapshot?.state)} aria-hidden="true" />
                  <span className="ec-wb-row-main">
                    <strong>运行 {run.runId.slice(0, 8)}</strong>
                    <small>{relativeTime(run.createdAt, Date.now())} · {runStateText(run.snapshot?.state)}</small>
                  </span>
                </button>
              ))}
            {runsTotal > runs.length && runsLimit < 100
              ? <button type="button" className="ec-wb-text-link" onClick={() => setRunsLimit(100)}>查看全部 {runsTotal} 次运行</button>
              : null}
            {runsLimit > 5
              ? <button type="button" className="ec-wb-text-link" onClick={() => setRunsLimit(5)}>收起</button>
              : null}
            {runsTotal > runsLimit
              ? <p className="ec-wb-muted">已显示最近 {runs.length} 次运行；其余 {runsTotal - runs.length} 次更早的运行未列出。</p>
              : null}
            </section>
          </section>

          {/* 详情在右栏内展开（R4）：打开/切换/收起都不导航、不卸载原生会话；展开的是
              工作上下文事实（指针、输入批次、执行输入），不是另一个页面。 */}
          <div id="ec-wb-console-detail" role="region" aria-label="工作详情" hidden={!detailOpen}>
            {detailOpen
              ? (
                <>
                  <DeliveryPointerCard api={api} workId={workId} runs={{ total: runsTotal, items: runs }} />
                  <InputBaselinesCard
                    api={api}
                    workId={workId}
                    catalog={models?.catalog}
                    preference={models?.preference}
                    hasWorkspace={!!context?.workspace && !archived}
                    activeRunId={activeRun?.runId ?? null}
onCreated={(runId) => { closeRunView(); setSelectedRunId(runId); onFocusRun?.(null); refreshAll() }}
                  />
                  <RunInputsCard api={api} runId={selectedRun?.runId ?? null} refreshToken={token} />
                </>
              )
              : null}
          </div>
        </aside>
      </div>
    </div>
  )
}

// ── Enterprise pages ─────────────────────────────────────────────────────────

/** The home launch entry. Quick targets are the applications this employee actually used most
 *  recently (falling back to the published catalogue), never a hard-coded product list. */
/** One page of the full Works list. The control plane caps a page, so "load all" keeps asking
 *  until it has every record instead of searching a silently truncated set. */
/** 「我的工作」desk content (方案 B/B2/B3): the stage beside the work index. The old home grid
 *  (priority slip + context rail) folds into the index + brief pair: selection honours the
 *  priority rule at page level, todos surface for the selected Work, and projects/applications
 *  keep their own pages. The create wizard renders in the stage and never fights the brief for
 *  focus; the index column (or the single-column inline index) remains the only list. */
function WorksPage({ api, data, index, previewRow, previewWork, briefTodos, briefTodosKnown, creating, opening, projectId, initialAppKey, onInspect, onBackToIndex, onOpenWork, onDetail, onOpenPending, onCreate, onCreated, onCancelCreate, onReload }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  index: WorkIndexData
  previewRow: WorkRow | null
  previewWork: WorkbenchItem | undefined
  briefTodos: TodoItem[]
  briefTodosKnown: boolean
  creating: boolean
  opening: string
  projectId: string
  initialAppKey: string
  onInspect(workId: string): void
  onBackToIndex(): void
  onOpenWork(workId: string): void
  onDetail(work: WorkbenchItem, runId?: string): void
  onOpenPending(workId: string, runId: string): void
  onCreate(appKey?: string): void
  onCreated(work: WorkbenchItem): void
  onCancelCreate(): void
  onReload(): Promise<void>
}) {
  if (creating) {
    const projects = data.projects ?? []
    const activeProject = projects.find((project) => project.projectId === projectId) ?? projects[0]
    return (
      <div className="ec-wb-brief-stage">
        <NewWorkForm
          api={api}
          data={data}
          initialProjectId={activeProject?.projectId ?? ''}
          initialAppKey={initialAppKey}
          onCreated={onCreated}
          onReload={onReload}
          onCancel={onCancelCreate}
        />
      </div>
    )
  }

  // 宽容器：desk 的索引列显示索引，主区显示选中工作的摘要（或空态引导）。窄容器（<800px）：索引
  // 作为行内块排到主区上方；选中一行后让位给摘要并给出「返回工作索引」。索引只挂载在 desk 网格里
  // （见 shell），这里不再渲染第二份；显隐全部由 CSS container query 承担，此处不持宽度状态。
  const brief = previewRow
    ? (
      <WorkBrief
        api={api}
        row={previewRow}
        work={previewWork}
        todos={briefTodos}
        todosKnown={briefTodosKnown}
        opening={opening}
        onEnter={onOpenWork}
        onDetail={onDetail}
        onOpenPending={onOpenPending}
        onDownload={(runId, name) => saveArtifact(runId, name)}
      />
    )
    : null

  return (
    <div className="ec-wb-page ec-wb-page-home">
      <div className="ec-wb-home-brief" data-home-empty={brief ? undefined : 'true'}>
        {/* 单列首页的「返回工作索引」：只在窄容器 + brief 形态显示（CSS，形态在 desk 根上）。 */}
        <button type="button" className="ec-wb-desk-back" onClick={onBackToIndex}>
          <span aria-hidden="true">←</span> {t('desk.index')}
        </button>
        {brief ?? (
          <div className="ec-wb-brief-stage">
            <div className="ec-wb-empty-state">
              <h2>{t('desk.emptyTitle')}</h2>
              <p>{index.rows.length === 0 && index.loadedCount === 0 ? t('home.empty') : t('home.noActive')}</p>
              <button type="button" className="ec-wb-button ec-wb-primary" onClick={() => onCreate()}>{t('home.new')}</button>
            </div>
          </div>
        )}
      </div>
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
                <strong>{app.displayName ?? app.appId}</strong>
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

/** L2 我的习惯（开发设计 §2/§5 preferences.*）：服务端按登录主体持久化的类型化偏好。
 *  仅对本人生效；暂停后新运行不再注入；删除写墓碑（备份恢复不复活，T03）。
 *  值来自封闭键注册表（服务端仍是权威校验者）；修订冲突如实提示，不用最后写入覆盖。 */
const HABIT_KEYS: Array<{ key: string; label: string; options: Array<{ value: string; label: string }>; pluginScoped: boolean }> = [
  {
    key: 'output.locale',
    label: '输出语言',
    options: [{ value: 'zh-CN', label: '中文' }, { value: 'en-US', label: 'English' }],
    pluginScoped: true,
  },
  {
    key: 'review.summaryOrder',
    label: '复核摘要排序',
    options: [
      { value: 'exceptionsFirst', label: '异常优先' },
      { value: 'chronological', label: '时间顺序' },
      { value: 'asIs', label: '按原文' },
    ],
    pluginScoped: true,
  },
  {
    key: 'layout.density',
    label: '界面显示密度（仅全局）',
    options: [{ value: 'compact', label: '紧凑' }, { value: 'comfortable', label: '舒适' }],
    pluginScoped: false,
  },
]

function MyHabitsCard({ api }: { api: WorkbenchApi }) {
  const [items, setItems] = useState<PersonalPreferenceItem[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems((await api.preferences()).items)
      setError('')
    } catch (reason) {
      setError(errorText(reason))
      setItems(null)
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const mutate = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(success)
      await load()
    } catch (reason) {
      if (reason instanceof PlatformApiError && reason.code === 'PREFERENCE_REVISION_STALE') {
        setError('该习惯刚在另一台设备上修改过；请刷新后重试——你的这次覆盖未被采用（不用最后写入覆盖）。')
      } else {
        setError(errorText(reason))
      }
    } finally {
      setBusy(false)
    }
  }

  const current = (key: string) => items?.find((item) => item.pluginKey === '' && item.key === key)
  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-habits" data-testid="my-habits">
      <div className="ec-wb-card-head">
        <h2 id="ec-wb-habits">我的习惯</h2>
        <span className="ec-wb-badge">{items ? `${items.length} 项` : '…'}</span>
      </div>
      <p className="ec-wb-muted">
        这里保存的是你个人的协作习惯，只对你自己生效、不参与任何业务验证；他人不可见。暂停后新运行不再应用；
        删除后即使恢复备份也不会复活。偏好服务不可用时按标准呈现继续工作，并如实标注「未应用个人习惯」。
      </p>
      {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
      {items === null && !error ? <p className="ec-wb-empty">{busy ? '读取中…' : ''}</p> : null}
      {items !== null
        ? HABIT_KEYS.map((habit) => {
          const item = current(habit.key)
          return (
            <div className="ec-wb-row" key={habit.key} data-testid={`habit-${habit.key}`}>
              <span className="ec-wb-row-main">
                <strong>{habit.label}</strong>
                <small className="ec-wb-muted">
                  {item
                    ? `当前：${String(item.value)} · 修订 ${item.revision} · ${item.state === 'PAUSED' ? '已暂停（不再注入新运行）' : '生效中'} · ${formatTime(item.updatedAt)}`
                    : '未设置（按标准呈现）'}
                </small>
              </span>
              <span className="ec-wb-row-actions">
                <select
                  className="ec-wb-select"
                  value={item && typeof item.value === 'string' ? String(item.value) : ''}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value
                    if (!value) return
                    void mutate(
                      () => api.setPreference(habit.key, value, { expectedRevision: item?.revision ?? 0 }),
                      `${habit.label} 已保存（只对本人生效）`,
                    )
                  }}
                >
                  <option value="" disabled>选择…</option>
                  {habit.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                {item ? (
                  item.state === 'PAUSED' ? (
                    <button className="ec-wb-btn" type="button" disabled={busy}
                      onClick={() => void mutate(() => api.setPreference(habit.key, String(item.value), { expectedRevision: item.revision }), `${habit.label} 已恢复`)}>
                      恢复
                    </button>
                  ) : (
                    <button className="ec-wb-btn" type="button" disabled={busy}
                      onClick={() => void mutate(() => api.pausePreference(habit.key), `${habit.label} 已暂停`)}>
                      暂停
                    </button>
                  )
                ) : null}
                {item ? (
                  <button className="ec-wb-btn" type="button" disabled={busy}
                    onClick={() => void mutate(() => api.deletePreference(habit.key), `${habit.label} 已删除（不可恢复，重新设置将从头开始）`)}>
                    删除
                  </button>
                ) : null}
              </span>
            </div>
          )
        })
        : null}
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

/** 数据安全开关（与模型无关，由用户自己决定开/关）。状态存在服务端文件 `.runtime/data-boundary.json`，
 *  业务插件与命令行 `.runtime/data-boundary.cjs` 读的是同一个文件；浏览器本地偏好放不了它。 */
function DataBoundaryCard({ api }: { api: WorkbenchApi }) {
  const [state, setState] = useState<Awaited<ReturnType<WorkbenchApi['dataBoundary']>> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.dataBoundary().then(
      (value) => { if (!cancelled) setState(value) },
      (reason) => { if (!cancelled) setError(String((reason as Error)?.message ?? reason)) },
    )
    return () => { cancelled = true }
  }, [api])
  const flip = async (dataSecurity: boolean) => {
    setBusy(true)
    setError('')
    try {
      setState(await api.setDataBoundary(dataSecurity))
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-data-boundary">
      <div className="ec-wb-card-head">
        <h2 id="ec-wb-data-boundary">数据安全</h2>
        <span className="ec-wb-badge" data-tone={state && !state.dataSecurity ? 'warn' : undefined}>{state ? (state.dataSecurity ? '已开启' : '已关闭') : '读取中'}</span>
      </div>
      <p className="ec-wb-muted">与模型无关，由你决定。开启：插件不读取 Cover / Approval，受试者号与 DM/DBD 评审意见只计数；关闭：以上内容原值可读。</p>
      <div className="ec-wb-row">
        <span className="ec-wb-row-main">
          <strong>脱敏边界{state ? (state.dataSecurity ? '：生效中' : '：已放开') : ''}</strong>
          <small className="ec-wb-muted">{error || (state?.exists ? '开关文件已保存' : '尚无开关文件，按默认（开启）运行')}</small>
        </span>
        <button type="button" className="ec-wb-button" disabled={busy || !state || state.dataSecurity === true} onClick={() => void flip(true)}>开启</button>
        <button type="button" className="ec-wb-button" disabled={busy || !state || state.dataSecurity === false} onClick={() => void flip(false)}>关闭</button>
      </div>
      <p className="ec-wb-muted">改动立即写入开关文件；插件工具的说明在插件加载时选定，重启 WebUI 后完全生效。</p>
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
          <MyHabitsCard api={api} />
          <ModelDefaultPanel api={api} catalog={catalog} preference={data.models?.preference} onReload={onReload} />
          <DataBoundaryCard api={api} />
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

/** 单侧栏架构：企业导航的条目与图标移至 `sidebar-nav.tsx`；主区只保留页面标题与内容。 */

/** One Work's conversation on screen: the retained native reference plus the application the Work
 *  belongs to (published to conversation entries as the platform fact, see conversation-application.ts). */
interface SessionWorkEntry {
  workId: string
  title: string
  sessionId: string
  reference: SessionReference
  /** Null only when the Work's application could not be resolved; entries then stay unfiltered. */
  application: ConversationApplication | null
}

export function WorkbenchPage({ SessionProvider, retainSession, releaseSession, beginNavigation, watchWorkSession, createSession, renderSlot, sessionList, refreshSessionList, route, platformSelected, publishConversationApplication }: WorkbenchPageProps) {
  const api = useMemo(() => new WorkbenchApi(API_BASE), [])
  // 单侧栏架构：主区执行侧栏派发的导航命令。命令处理放在 ref 中，任何渲染后都指向最新闭包，
  // 注册副作用只随 route 变化挂载/卸载一次。
  const routeCommandRef = useRef<(command: WorkbenchRouteCommand) => void>(() => {})
  useEffect(() => {
    route.setHandler((command) => routeCommandRef.current(command))
    return () => route.setHandler(null)
  }, [route])
  // WP3: one gate per page instance. Every async navigation begins an intent on it; only the
  // newest intent commits page state, so A→B out-of-order returns and host panel switches can
  // never let a stale navigation win. Unmount disposes it — no commit after teardown.
  const gate = useMemo(() => new NavigationGate({ beginNavigation }), [])
  const gateRef = useRef(gate)
  gateRef.current = gate
  useEffect(() => () => gateRef.current.dispose(), [])
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
  const [sessionWork, setSessionWork] = useState<SessionWorkEntry | null>(null)
  const [historySession, setHistorySession] = useState<{ sessionId: string; title: string; reference: SessionReference } | null>(null)

  /** 新建工作表单属于「我的工作」首页坐标，不是独立视图。每一条离开该坐标的路径——另一个键控页、
   *  索引里另一行的摘要、某 Work 的会话/只读详情——都在同一批更新里关闭它，表单不会在员工回来时
   *  再次出现。2026-11-23 回归：此前 creating 只在表单自己的取消/提交里清除，打开表单后点索引
   *  另一行只改高亮（摘要被表单挡住），切到其他页面再回来表单仍在。 */
  const closeCreate = useCallback(() => { setCreating(false); setStartAppKey('') }, [])

  // ── Work desk (方案 B): page-level index + preview ─────────────────────────
  // 索引查询状态与 previewWorkId 都是页面级（方案 B §4）：首页与会话外壳共享同一份索引，
  // 预选只是 workId——它永远不决定原生 Session 引用（那是 openWork/绑定既有路径的事）。
  const [indexFilters, setIndexFilters] = useState<WorkIndexFilters>({ query: '', state: 'active', sort: 'recent', projectId: '' })
  const [previewWorkId, setPreviewWorkId] = useState<string | null>(null)
  // 单列首页的「返回索引」：清掉预览展示但不销毁预选；新筛选或新选择会重新允许自动预选。
  const [previewCleared, setPreviewCleared] = useState(false)
  const [deskPanel, setDeskPanel] = useState<'index' | 'rail' | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const indexScrollMemory = useRef(0)
  const index = useWorkIndex(api, data, indexFilters)

  // Leaving the session view (nav, back, detail switch) releases the view's retained reference so
  // the embedded factory returns to its session-less posture; unmount releases it too. React
  // removes the SessionProvider subtree before this cleanup runs, so the renderer never reads a
  // released reference.
  const sessionViewOpen = sessionWork !== null || historySession !== null
  useEffect(() => {
    if (!sessionViewOpen) return undefined
    return () => releaseSession()
  }, [sessionViewOpen, releaseSession])
  // 平台事实（2026-11-24）：把屏幕上这项工作的应用发布给会话内组件（`useConversationApplication`）。
  // 新会话的输入框与本次提交一同挂载，首轮渲染读到的还是上一个会话的值；在提交阶段（绘制前）发布，
  // 订阅者会在绘制前同步重渲染，所以不会看到按上一个应用渲染的入口。离开工作会话（历史会话、
  // 首页）即回到 null。
  useLayoutEffect(() => {
    publishConversationApplication(sessionWork?.application ?? null)
  }, [publishConversationApplication, sessionWork?.application])

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

  // ── Desk width (方案 B §5)：列显隐由 CSS container query 驱动 ────────────────
  // desk 根是 inline-size 容器，CSS 按容器宽度切换索引列/资料栏形态（≥1120 会话三列、
  // ≥800 首页两列、840 以下资料面板、800 以下首页单列）。JS 只保留面板的模态语义
  // （deskPanel 的 Escape/焦点），不再持有宽度状态——测量 stage 自身会造成显隐反馈循环。

  // 优先事项（可见结果内）驱动首次预选；homePriority 的判定保持既有语义（待办 → 失败运行）。
  const latestRuns = useMemo(() => latestHomeRuns(data?.runs?.items ?? []), [data])
  const priorityWork = useMemo(() => {
    const visibleWorks = index.rows
      .map((row) => index.byId.get(row.workId))
      .filter((work): work is WorkbenchItem => Boolean(work))
    return homePriority(visibleWorks, latestRuns, data?.todos ?? [])
  }, [index.rows, index.byId, latestRuns, data])

  // 预选规则（方案 B §2）：仍可见的预选保留；否则可见的优先事项；否则首项；空集不选。
  // 等待与失败不算空结果——只有成功返回的新结果集参与重选。
  useLayoutEffect(() => {
    if (page !== 'works' || sessionWork || detailWork) return
    if (previewCleared) return
    if (previewWorkId && index.rows.some((row) => row.workId === previewWorkId)) return
    if (index.busy || index.error) return
    const next = pickPreviewWorkId(index.rows, previewWorkId, priorityWork?.work.workId ?? null)
    if (next !== previewWorkId) setPreviewWorkId(next)
  }, [page, sessionWork, detailWork, previewCleared, previewWorkId, index.rows, index.busy, index.error, priorityWork])

  /** 筛选更新：提交新筛选后允许自动预选重新生效（仍可见则保留原预选，否则重选）。 */
  const updateIndexFilters = (patch: Partial<WorkIndexFilters>) => {
    setIndexFilters((previous) => ({ ...previous, ...patch }))
    setPreviewCleared(false)
  }

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

  /** The single slot releases the previous reference on every retain, so the Work's stored
   *  reference goes stale as soon as a run view swaps in. Every way back re-retains the Work
   *  session and adopts the returned reference here in the same batched continuation — the
   *  fallback `children` must never render a released reference (ScopeAreaProvider reads the
   *  binding during render and the harness throws). The epoch bump lets a still-mounted run
   *  view know its reference was released by this swap and withdraw in the same commit. */
  const [workEpoch, setWorkEpoch] = useState(0)
  const adoptWorkReference = useCallback((reference: SessionReference) => {
    setSessionWork((previous) => (previous ? { ...previous, reference } : previous))
    setWorkEpoch((epoch) => epoch + 1)
  }, [])
  /** openWork/openBoundSession commit a freshly retained Work session through the same epoch
   *  guard: a run view still mounted under the previous epoch (boot-restore superseded by a
   *  manual open) withdraws in this batched commit instead of rendering the reference this
   *  retain just released. */
  const commitWorkSession = useCallback((entry: SessionWorkEntry) => {
    setSessionWork(entry)
    setWorkEpoch((epoch) => epoch + 1)
    closeCreate()
  }, [closeCreate])

  /** `silent` marks a refresh-restore: a coordinate that no longer resolves is forgotten and the
   *  shell falls back to the works page instead of announcing a failure for a stale view.
   *  WP3: the whole navigation runs under one intent — a superseded intent (newer openWork, host
   *  panel switch, unmount) commits nothing and releases only the reference it retained. */
  const openWork = useCallback(async (workId: string, options?: { focusRunId?: string; silent?: boolean }) => {
    const silent = options?.silent === true
    const intent = gateRef.current.begin()
    setOpening(workId)
    if (!silent) setNotice('')
    try {
      const context = await api.workContext(workId)
      // silent = boot restore（restoring 遮罩挡住一切交互）：intent 失效只可能来自宿主自己的
      // 首屏 panel 动作（selectPanel abort 所有 pending navigation），不是一次新的用户导航，
      // 所以恢复照常提交；用户点击路径保持 WP3 语义（失效即放弃）。
      if (!intent.current() && !silent) return
      // 历史只读入口（W5/R4）：归档工作不再挂载原生会话——打开即只读详情页，记录与成果照常
      // 可查，不新建对话，也不会把归档工作送回带运行待办的控制台。
      if (context.work.state === 'ARCHIVED') {
        if (!silent) setNotice('这项工作已归档，已打开只读详情。')
        openDetail({
          workId,
          title: context.work.title,
          projectId: context.work.projectId,
          appId: context.app.appId,
          appVersion: context.app.appVersion,
          state: 'ARCHIVED',
        }, options?.focusRunId)
        return
      }
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
      if (!intent.current() && !silent) {
        // The intent expired while retaining: release only this navigation's own reference.
        releaseSession(reference)
        return
      }
      watchWorkSession({ workId, domainId: context.binding.domainId, sessionId, since: context.binding.createdAt })
      setDetailWork(null)
      setFocusRunId(options?.focusRunId)
      commitWorkSession({
        workId, title: context.work.title, sessionId, reference,
        application: { appId: context.app.appId, appVersion: context.app.appVersion, displayName: context.app.displayName },
      })
    } catch (reason) {
      console.error(`[platform-workbench] open work failed: ${errorText(reason)}`)
      if (!intent.current()) return
      if (silent) clearPersistedView()
      else setNotice(`无法打开工作：${errorText(reason)}`)
    } finally {
      if (intent.current()) setOpening('')
      else setOpening((current) => (current === workId ? '' : current))
    }
  }, [api, retainKnownSession, watchWorkSession, releaseSession, commitWorkSession])

  // Open the embedded session view from the Work detail page (bound Session + domain already checked).
  const openBoundSession = useCallback(async (workId: string, sessionId: string, domainId: string, since?: string) => {
    const intent = gateRef.current.begin()
    setNotice('')
    try {
      const reference = await retainKnownSession(sessionId)
      if (!intent.current()) {
        releaseSession(reference)
        return
      }
      watchWorkSession({ workId, domainId, sessionId, ...(since ? { since } : {}) })
      // The detail page carries the release coordinates; the display name comes from the published catalogue.
      const displayName = detailWork
        ? (data?.apps ?? []).find((app) => app.appId === detailWork.appId && app.appVersion === detailWork.appVersion)?.displayName ?? detailWork.appId
        : ''
      commitWorkSession({
        workId, title: detailWork?.title ?? '工作', sessionId, reference,
        application: detailWork ? { appId: detailWork.appId, appVersion: detailWork.appVersion, displayName } : null,
      })
    } catch (reason) {
      if (intent.current()) setNotice(`无法打开会话：${errorText(reason)}`)
    }
  }, [retainKnownSession, watchWorkSession, detailWork, data, releaseSession, commitWorkSession])

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
    const intent = gateRef.current.begin()
    setNotice('')
    try {
      const reference = await retainKnownSession(sessionId)
      if (!intent.current()) {
        releaseSession(reference)
        return
      }
      setSessionWork(null)
      setDetailWork(null)
      setFocusRunId(undefined)
      setHistorySession({ sessionId, title, reference })
      closeCreate()
    } catch (reason) {
      if (intent.current()) setNotice(`无法打开历史会话：${errorText(reason)}`)
    }
  }, [retainKnownSession, releaseSession, closeCreate])

  const closeHistorySession = useCallback(() => { setHistorySession(null) }, [])

  /** 索引行的「查看…工作摘要」。首页只更新预览；会话中点当前项不重开，点另一行是显式离开
   *  当前工作——走既有离开/导航清理回工作页，再应用目标预览，绝不自动进入另一个会话。 */
  const inspectWork = (workId: string) => {
    setDeskPanel(null)
    if (sessionWork) {
      if (sessionWork.workId === workId) return
      selectPage('works')
      setPreviewWorkId(workId)
      setPreviewCleared(false)
      return
    }
    // 首页上选另一行是显式离开创建表单：所选工作的摘要接管 stage。
    closeCreate()
    setPreviewWorkId(workId)
    setPreviewCleared(false)
  }

  /** 单列首页「返回工作索引」：收起摘要展示，预选保留（宽屏回来仍可见）。 */
  const backToIndex = () => { setPreviewCleared(true); setDeskPanel(null) }

  /** 摘要的下载走既有 saveArtifact：失败就地反馈，不保存错误页，不自动重试（方案 B §3）。 */
  const downloadBriefArtifact = (runId: string, name: string) => saveArtifact(runId, name)

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
    closeCreate()
    // 换页关掉桌面临时面板（手机上也不与宿主全局抽屉叠开）。
    setDeskPanel(null)
  }

  /** Open the create form, optionally retargeted at the application whose quick target was clicked. */
  const startCreate = (appKey?: string) => {
    setStartAppKey(appKey ?? '')
    setCreating(true)
  }

  const openDetail = (work: WorkbenchItem, runId?: string) => {
    setFocusRunId(runId)
    setDetailWork(work)
    closeCreate()
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

  /** 「查看详情」不再从控制台清空 Session（W5/R4：该路径已移除）——控制台的详情是右栏内展开。
   *  待处理入口按工作状态分流：使用中的工作进控制台（原生会话保持挂载），归档工作进只读详情。 */
  const openPendingById = async (workId: string, runId: string) => {
    const intent = gateRef.current.begin()
    try {
      const work = await resolveWork(workId)
      if (!intent.current()) return
      if (work.state === 'ARCHIVED') openDetail(work, runId)
      else void openWork(workId, { focusRunId: runId })
    } catch (reason) {
      if (intent.current()) setNotice(`无法打开待处理问题：${errorText(reason)}`)
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
    else if (view.detailWorkId) {
      const intent = gateRef.current.begin()
      void resolveWork(view.detailWorkId)
        .then((work) => { if (intent.current()) openDetail(work, view.focusRunId) })
        .catch(() => {})
    } else if (view.page && WORKBENCH_VIEWS.includes(view.page as WorkbenchView)) selectPage(view.page as WorkbenchView)
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
        // 首屏面板选择会 abort 打进行中的导航 intent（WP3 宿主合同），恢复必须排在它之后，
        // 否则 F5/深链的会话恢复会被 selectPanel 静默打断（A07）。
        await platformSelected
        if (sessionWorkId) {
          await openWork(sessionWorkId, { focusRunId, silent: true })
        } else if (historySessionId) {
          await openHistorySession(historySessionId, historySessionTitle ?? '历史会话')
        } else if (detailWorkId) {
          openDetail(await resolveWork(detailWorkId), focusRunId)
        } else if (saved.page && WORKBENCH_VIEWS.includes(saved.page as WorkbenchView)) {
          selectPage(saved.page as WorkbenchView)
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
  const projectName = (projectId: string) =>
    (data?.projects ?? []).find((project) => project.projectId === projectId)?.name ?? projectId

  // ── Desk index decorations (方案 B) ────────────────────────────────────────
  // 行内状态标签只保留需要人工处理的语义：warn/error 运行、归档、以及匹配的待复核。
  const reviewWorkIds = useMemo(() => {
    const ids = new Set<string>()
    for (const todo of data?.todos ?? []) {
      if (todo.kind === 'review' && todo.workId) ids.add(todo.workId)
    }
    return ids
  }, [data])
  const deskIndexChips = useMemo(() => {
    const map = new Map<string, WorkIndexChip[]>()
    // 标签文案随界面语言：workRowState / t 的 locale 是显式参数，漏传会回落到 zh-CN（English 模式下
    // 行内状态标签曾是中文），且 memo 依赖里必须带上语言，切换后才重算。
    const locale = preferences.locale
    for (const row of index.rows) {
      const chips: WorkIndexChip[] = []
      const state = workRowState(row, latestRuns.get(row.workId), locale)
      if (state.tone === 'error' || state.tone === 'warn' || row.state === 'ARCHIVED') chips.push(state)
      if (reviewWorkIds.has(row.workId)) chips.push({ label: t('brief.needsReview', locale), tone: 'warn' })
      if (chips.length > 0) map.set(row.workId, chips)
    }
    return map
  }, [index.rows, latestRuns, reviewWorkIds, preferences.locale])

  // 预览对象：只在可见行里取（自动预选保证有效性），摘要数据按 workId 由 brief 自行读取。
  const previewRow = previewWorkId ? index.rows.find((row) => row.workId === previewWorkId) ?? null : null
  const previewWork = previewWorkId ? index.byId.get(previewWorkId) : undefined
  const briefTodos = useMemo(
    () => (data?.todos ?? []).filter((todo) => todo.workId === previewWorkId),
    [data, previewWorkId],
  )

  // 单侧栏架构：把当前坐标发布给侧栏（uSES 快照），并执行侧栏派发的导航命令。侧栏不持有业务
  // 数据——pendingCount/连接状态都是主区读得的服务端事实，侧栏只如实显示。
  routeCommandRef.current = (command) => {
    switch (command.kind) {
      case 'navigate': selectPage(command.page); break
      case 'create': selectPage('works'); startCreate(command.appKey); break
      case 'open-work': void openWork(command.workId); break
    }
  }
  const viewKind = sessionWork ? 'work' : historySession ? 'history' : detailWork ? 'detail' : 'page'
  useEffect(() => {
    route.publish({
      page,
      viewKind,
      activeWorkId: sessionWork?.workId ?? detailWork?.workId ?? null,
      activeTitle: sessionWork?.title ?? historySession?.title ?? detailWork?.title ?? null,
      pendingCount,
      connected: !error,
    })
  })

  // ── Desk shell (方案 B §2): 全局导航(宿主列) | 工作索引 | 工作摘要 或 工作索引 | 原生会话 |
  // 工作资料。索引只在「我的工作」首页与会话外壳出现——它是「我的工作」的主从列表，不是第二套
  // 全局导航；其他页面沿用原布局。桌面外壳把顶栏放进 stage 列，与基准图一致。
  const deskIndexNode = data
    ? (
      <WorkIndex
        index={index}
        filters={indexFilters}
        onFiltersChange={updateIndexFilters}
        selectedId={sessionWork ? sessionWork.workId : previewWorkId}
        sessionMode={sessionWork !== null}
        chips={deskIndexChips}
        busy={Boolean(opening)}
        projects={data.projects ?? []}
        onInspect={inspectWork}
        onCreate={() => { setDeskPanel(null); selectPage('works'); startCreate() }}
        scrollMemory={indexScrollMemory}
      />
    )
    : null

  const shell = (children: ReactNode, options: { session?: boolean; desk?: boolean } = {}) => {
    // 基准图 B1/B2：顶栏从「📁 项目名 / 视图名」两级面包屑开始，右侧是「全局搜索 Ctrl K」与
    // 一个有名称的工具菜单（刷新/紧凑/专家诊断收纳其中，不删除）。连接状态在全局轨底部。
    const crumbWork = sessionWork ?? null
    const crumbWorkItem = crumbWork
      ? index.byId.get(crumbWork.workId)
      : detailWork ?? previewWork
    const crumbPrimary = crumbWorkItem
      ? (data?.projects ?? []).find((project) => project.projectId === crumbWorkItem.projectId)?.name ?? crumbWorkItem.projectId
      : navLabel(page, preferences.locale)
    const crumbSecondary = crumbWork
      ? t('desk.crumbSession', preferences.locale)
      : detailWork || (options.desk && page === 'works' && previewWork)
        ? t('desk.crumbDetail', preferences.locale)
        : navLabel(page, preferences.locale)
    const topbar = (
      <div className="ec-wb-topbar">
        <div className="ec-wb-breadcrumb">
          {options.desk ? (
            <>
              <span className="ec-wb-breadcrumb-glyph" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                </svg>
              </span>
              <span className="ec-wb-breadcrumb-root">{crumbPrimary}</span>
              <span className="ec-wb-breadcrumb-sep" aria-hidden="true">/</span>
              <span>{crumbSecondary}</span>
            </>
          ) : (
            <span>{sessionWork ? sessionWork.title : historySession ? historySession.title : detailWork ? detailWork.title : navLabel(page, preferences.locale)}</span>
          )}
        </div>
        {options.desk
          ? (
            <>
              <button
                type="button"
                className="ec-wb-desk-index-toggle"
                aria-haspopup="dialog"
                aria-expanded={deskPanel === 'index'}
                onClick={() => setDeskPanel(deskPanel === 'index' ? null : 'index')}
              >
                <Glyph size={14}><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="9" x2="9" y2="20" /></Glyph>
                {t('desk.index', preferences.locale)}
              </button>
              <div className="ec-wb-top-actions">
                <button type="button" className="ec-wb-desk-search" onClick={() => setPaletteOpen(true)}>
                  <Glyph size={14}>{SEARCH_PATHS}</Glyph>
                  <span>{t('desk.searchGlobal', preferences.locale)}</span>
                  <kbd aria-hidden="true">Ctrl K</kbd>
                </button>
                <DeskToolsMenu
                  open={toolsOpen}
                  onOpenChange={setToolsOpen}
                  actions={[
                    { id: 'refresh', label: '刷新平台数据', onSelect: () => void load() },
                    { id: 'compact', label: '紧凑布局', checked: compact, onSelect: toggleCompact },
                    { id: 'expert', label: '专家诊断', checked: expert, onSelect: toggleExpert },
                  ]}
                />
              </div>
            </>
          )
          : (
            <div className="ec-wb-top-actions">
              <span className={`ec-wb-conn${error ? ' is-down' : ''}`} role="status">{error ? '平台未连接' : '平台已连接'}</span>
              <button type="button" className="ec-wb-icon-btn" aria-label="全局搜索（Ctrl+K）" title="全局搜索（Ctrl+K）" onClick={() => setPaletteOpen(true)}>{GLYPH_SEARCH_TOP}</button>
              <button type="button" className="ec-wb-icon-btn" aria-label="刷新平台数据" title="刷新" onClick={() => void load()}>{GLYPH_REFRESH}</button>
              <button type="button" className="ec-wb-icon-btn" aria-label="紧凑布局" title="紧凑布局" aria-pressed={compact} onClick={toggleCompact}>{GLYPH_DENSITY}</button>
              <button type="button" className="ec-wb-icon-btn" aria-label="专家诊断" title="专家诊断（显示路径/会话/摘要等技术细节）" aria-pressed={expert} onClick={toggleExpert}><Glyph size={16}><path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13 7l-2 10" /></Glyph></button>
            </div>
          )}
      </div>
    )
    const palette = (
      <CommandPalette
        api={api}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenWork={(workId) => void openWork(workId)}
        onOpenRun={(workId, runId) => void openPendingById(workId, runId)}
        onNavigate={selectPage}
      />
    )
    if (options.desk && data) {
      // 首页形态（只在 <800px 时决定索引让不让位给摘要）：有摘要或创建表单在显示就是 brief。
      // 「返回工作索引」置 previewCleared——它必须参与这里，否则按钮点了没反应（既有缺陷，
      // 2026-11-24 修复）；预选本身保留，宽屏回来摘要仍在。创建表单由 WorksPage 提前返回、不带
      // 首页根节点，所以这个坐标放在 desk 根上。
      const homeMode = creating || (previewRow && !previewCleared) ? 'brief' : 'index'
      return (
        <div className="ec-wb ec-wb-desk-outer">
          <div
            className="ec-wb ec-wb-desk"
            data-density={compact ? 'compact' : 'normal'}
            data-expert={expert ? 'on' : 'off'}
            data-desk-view={options.session ? 'session' : 'home'}
            data-home-mode={homeMode}
            data-desk-panel={deskPanel === 'index' ? 'index' : undefined}
          >
          {/* E4-4 keyboard path: a skip link lets keyboard users bypass the topbar (visible on focus).
              单侧栏架构：左栏导航由 `sidebar` slot 的企业导航承担；工作索引是主区的主从列表，用带
              名称的 section 语义与全局导航区分。desk 是命名区域网格（index | top + main），工作索引
              只挂载这一份——是列、行内块还是收起，全由 container query（CSS）决定（2026-11-24：此前
              首页同时挂了列与窄屏内联两份 DOM）。 */}
          <a className="ec-wb-skip" href="#ec-wb-content">跳到主内容</a>
          {topbar}
          <section className="ec-wb-desk-index" aria-label={t('desk.index', preferences.locale)}>
            {deskIndexNode}
          </section>
          <main id="ec-wb-content" className={options.session ? 'ec-wb-main ec-wb-main-session' : 'ec-wb-main'}>
            {networkHint || notice ? <p className="ec-wb-status" role="status" aria-live="polite">{networkHint || notice}</p> : null}
            {children}
          </main>
          {/* 索引收起后的临时面板：与右栏资料面板共用一个槽位（deskPanel），同时只有一个；只在
              打开期间才存在第二份索引。按钮只在窄容器出现（CSS），宽容器下本面板不会打开。 */}
          <DeskPanel open={deskPanel === 'index'} onClose={() => setDeskPanel(null)} label={t('desk.index', preferences.locale)}>
            {deskIndexNode}
          </DeskPanel>
          {palette}
          </div>
        </div>
      )
    }
    return (
      <div className="ec-wb" data-density={compact ? 'compact' : 'normal'} data-expert={expert ? 'on' : 'off'}>
        <a className="ec-wb-skip" href="#ec-wb-content">跳到主内容</a>
        {topbar}
        <div className="ec-wb-shell">
          <main id="ec-wb-content" className={options.session ? 'ec-wb-main ec-wb-main-session' : 'ec-wb-main'}>
            {networkHint || notice ? <p className="ec-wb-status" role="status" aria-live="polite">{networkHint || notice}</p> : null}
            {children}
          </main>
        </div>
        {palette}
      </div>
    )
  }

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
  // resolves that exact Session while the native main view stays untouched. Desk layout (方案 B):
  // 工作索引 | 原生会话 | 工作资料 — the index travels with the session, but it only ever
  // previews; entering another Work still goes through the explicit leave path.
  if (sessionWork) {
    return shell(
      <WorkConsole
        api={api}
        workId={sessionWork.workId}
        title={sessionWork.title}
        modelLabel={defaultModelLabel(data.models)}
        models={data.models}
        onReload={load}
        {...(focusRunId ? { initialRunId: focusRunId } : {})}
        onFocusRun={(runId) => setFocusRunId(runId ?? undefined)}
        SessionProvider={SessionProvider}
        sessionSlot={renderSlot('workbench.session', {})}
        workSessionId={sessionWork.sessionId}
        retainSessionById={retainKnownSession}
        retainWorkSession={retainSession}
        adoptWorkReference={adoptWorkReference}
        workEpoch={workEpoch}
        releaseRunReference={releaseSession}
        railPanelOpen={deskPanel === 'rail'}
        onRailPanelToggle={(open) => setDeskPanel(open ? 'rail' : null)}
      >
        <SessionProvider session={sessionWork.reference}>
          {renderSlot('workbench.session', {})}
        </SessionProvider>
      </WorkConsole>,
      { session: true, desk: true },
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
          index={index}
          previewRow={previewRow}
          previewWork={previewWork}
          briefTodos={briefTodos}
          briefTodosKnown={data.todos != null}
          creating={creating}
          opening={opening}
          projectId={selectedProjectId}
          initialAppKey={startAppKey}
          onInspect={inspectWork}
          onBackToIndex={backToIndex}
          onOpenWork={(workId) => void openWork(workId)}
          onDetail={openDetail}
          onOpenPending={(workId, runId) => void openPendingById(workId, runId)}
          onCreate={startCreate}
          onCreated={openDetail}
          onCancelCreate={closeCreate}
          onReload={load}
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
    { desk: page === 'works' },
  )
}
