/** Enterprise workbench shell for the native WebUI (T02/T06/T07/T09/T10/T12/T13).
 *
 *  Five keyed pages form the enterprise shell — 项目空间 / 应用中心 / 我的工作 / 待处理 / 平台设置 —
 *  and the plugin selects 我的工作 at boot so the first screen is an enterprise home, not a bare
 *  chat. Works are the navigation unit; native Sessions are reached only through a bound Work, so
 *  test conversations never become business entries.
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
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  conversationPhase,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
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
  type InputBaselineItem,
  type InputCommitItem,
  type InteractionItem,
  type ModelCatalog,
  type ModelPreference,
  type Page,
  type RunSummary,
  type WorkbenchBootstrap,
  type WorkbenchItem,
  type WorkspaceItem,
} from '../api.js'
import { artifactDownloadPath, formatBytes, monogram, pageWindow, relativeTime, runStateLabel, runTone, selectWorkRows, summarizeArtifacts, type WorkRow } from '../reports.js'
import { buildAnswers, chosenModel, modelChoices, runInput, type NativeQuestion } from '../forms.js'
import type { WorkContext } from '../work-context.js'
import { bindingDraft, selectBindingDomain } from '../work-context.js'
import type { SubmissionWatchOptions } from './submission-observer.js'

export type { SubmissionWatchOptions } from './submission-observer.js'

export type WorkbenchView = 'works' | 'projects' | 'apps' | 'pending' | 'settings'

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

const API_BASE = '/platform-workbench'
const RUN_PAGE = 10
const ARTIFACT_PAGE = 10
const INPUT_PAGE = 10
const BASELINE_PAGE = 10
const COMPACT_KEY = 'emerald.workbench.compact'

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
  return new Date(now).toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' })
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

function ErrorBox({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="ec-wb-error" role="alert">
      <p>{message}</p>
      <button type="button" className="ec-wb-button" onClick={onRetry}>重试</button>
    </div>
  )
}

function StateBadge({ state }: { state: unknown }) {
  return <span className="ec-wb-badge" data-tone={runTone(state)}>{runStateLabel(state)}</span>
}

function formatTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '时间未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN')
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

/** Titles of Works that are named by a pending question but sit outside the loaded page. One
 *  bounded context read per such Work, so the "需要你处理" list can name what it is asking about. */
function usePendingWorkTitles(
  api: WorkbenchApi,
  pending: NonNullable<WorkbenchBootstrap['pending']>,
  works: WorkbenchItem[],
): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({})
  const known = new Set(works.map((work) => work.workId))
  const missing = [...new Set(pending
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

/** Pending questions across Works. A Work outside the loaded page is still openable: the page
 *  resolves it from its own context on click rather than declaring it invisible. */
function PendingList({ items, works, titles, onOpen }: {
  items: NonNullable<WorkbenchBootstrap['pending']>
  works: WorkbenchItem[]
  titles?: Record<string, string>
  onOpen(workId: string, runId: string): void
}) {
  if (items.length === 0) return <p className="ec-wb-empty">当前没有等待答复的问题。</p>
  return (
    <div className="ec-wb-rows">
      {items.map((item) => {
        const work = works.find((candidate) => candidate.workId === item.workId)
        const title = work?.title ?? (item.workId ? titles?.[item.workId] : undefined) ?? `工作 ${String(item.workId ?? '').slice(0, 8)}`
        return (
          <button
            type="button"
            className="ec-wb-row-button"
            key={item.interactionId}
            disabled={!item.workId}
            onClick={() => { if (item.workId) onOpen(item.workId, item.runId) }}
          >
            <span className="ec-wb-row-main">
              <strong>{title}</strong>
              <small className="ec-wb-muted">{item.questions} 个问题 · {formatTime(item.createdAt)}</small>
            </span>
            <span className="ec-wb-muted">{work ? '回答 ›' : '打开 ›'}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── New work / project ───────────────────────────────────────────────────────

function NewWorkForm({ api, data, initialProjectId, initialAppKey, onCreated, onReload }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  /** Project chosen on the home launch panel; falls back to the first visible project. */
  initialProjectId?: string
  /** Application chosen by a quick target (`appId|appVersion`); falls back to the first active one. */
  initialAppKey?: string
  onCreated(work: WorkbenchItem): void
  onReload(): Promise<void>
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

  const selectedApp = apps.find((app) => `${app.appId}|${app.appVersion}` === appKey)
  const canSubmit = !!projectId && !!workspaceId && !!selectedApp && title.trim().length > 0 && !busy

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
      await onReload()
      onCreated(created)
      setNotice('工作已创建。可在工作详情中发起运行或绑定的原生会话中对话。')
    } catch (reason) {
      setError(`创建工作失败：${errorText(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ec-wb-card ec-wb-form" aria-labelledby="ec-wb-new">
      <div className="ec-wb-card-head"><h2 id="ec-wb-new">新建工作</h2></div>
      <p className="ec-wb-muted">选择项目、空间和应用，写清目标。创建工作只记录企业意图；对话在绑定的原生会话中进行。</p>
      {projects.length === 0
        ? <p className="ec-wb-empty">尚未创建项目。请先在「项目空间」登记项目。</p>
        : (
          <div className="ec-wb-grid">
            <Field label="项目">
              <select className="ec-wb-select" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
              </select>
            </Field>
            <Field label="工作空间" hint="空间指向执行主机上的真实目录。">
              {spacesError
                ? <ErrorBox message={`无法读取工作空间：${spacesError}`} onRetry={() => void loadSpaces(projectId)} />
                : spaces === null
                  ? <p className="ec-wb-muted">正在读取工作空间…</p>
                  : spaces.length === 0
                    ? <p className="ec-wb-empty">该项目还没有工作空间；请先登记一个目录。</p>
                    : (
                      <select className="ec-wb-select" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
                        {spaces.map((space) => <option key={space.workspaceId} value={space.workspaceId}>{space.name} — {space.directory}</option>)}
                      </select>
                    )}
            </Field>
            <Field label="应用">
              {apps.length === 0
                ? <p className="ec-wb-empty">当前没有可用的应用发布。</p>
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
            <Field label="工作标题">
              <input className="ec-wb-input" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field label="完整工作目标">
              <textarea className="ec-wb-textarea" rows={4} value={goal} maxLength={10_000} onChange={(event) => setGoal(event.target.value)} />
            </Field>
          </div>
        )}
      {spaces && spaces.length === 0 && projects.length > 0
        ? (
          <div className="ec-wb-subform">
            <h3>登记工作空间</h3>
            <div className="ec-wb-grid">
              <Field label="空间名称">
                <input className="ec-wb-input" value={spaceName} maxLength={200} onChange={(event) => setSpaceName(event.target.value)} />
              </Field>
              <Field label="目录（执行主机上的绝对路径）">
                <input className="ec-wb-input" value={spaceDirectory} maxLength={500} onChange={(event) => setSpaceDirectory(event.target.value)} />
              </Field>
            </div>
            <button type="button" className="ec-wb-button" disabled={busy} onClick={() => void registerSpace()}>登记空间</button>
          </div>
        )
        : null}
      {error ? <p className="ec-wb-error-text" role="alert">{error}</p> : null}
      {notice ? <p className="ec-wb-muted" role="status">{notice}</p> : null}
      <div className="ec-wb-form-actions">
        <button type="button" className="ec-wb-button ec-wb-primary" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? '提交中…' : '创建工作'}
        </button>
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
      <p className="ec-wb-muted">运行使用平台控制的执行器；模型在创建时冻结。普通对话请打开绑定的原生会话。</p>
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
        onClick={() => void act('cancel')}>{busy === 'cancel' ? '请求中…' : '请求停止'}</button>
      <button type="button" className="ec-wb-button" disabled={!!busy || !terminal}
        onClick={() => void act('retry')}>{busy === 'retry' ? '提交中…' : '重试运行'}</button>
      <button type="button" className="ec-wb-button" disabled={!!busy || !unknown}
        onClick={() => void act('reconcile')}>{busy === 'reconcile' ? '确认中…' : '确认已停止并释放空间'}</button>
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

  const loadContext = useCallback(async () => {
    try {
      setContextError('')
      setContext(await api.workContext(workId))
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
      setNotice('此工作尚未关联原生会话；绑定会话后才能从工作台进入。')
      return
    }
    setNotice('')
    onOpenSession(workId, sessionId, domainId, context?.binding?.createdAt)
  }

  /** Create the Work's native Session and bind it; the session id is the Host's own id. */
  const bindSession = async () => {
    if (!context || bindBusy) return
    if (boundSessionId) {
      const confirm = (globalThis as { confirm?: (message: string) => boolean }).confirm
      if (confirm && !confirm('将新建一个原生会话并设为该工作的当前会话；原有关联保留为历史（reopened）。继续？')) return
    }
    setBindBusy(true)
    setNotice('')
    try {
      const bound = await onBindSession(context)
      await loadContext()
      onOpenSession(workId, bound.sessionId, bound.domainId)
    } catch (reason) {
      setNotice(`绑定未完成：${errorText(reason)}`)
    } finally {
      setBindBusy(false)
    }
  }

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
            <button type="button" className="ec-wb-button ec-wb-primary" onClick={openBound} disabled={!boundSessionId}>打开会话</button>
            <button type="button" className="ec-wb-button" onClick={() => void onReload()}>刷新</button>
            <button type="button" className="ec-wb-button" disabled={archiveBusy || context?.work.state === 'ARCHIVED'} onClick={() => void archive()}>
              {archiveBusy ? '归档中…' : '归档工作'}
            </button>
          </div>
        </header>
        <p className="ec-wb-status" role="status" aria-live="polite">{notice}{archiveNotice ? ` ${archiveNotice}` : ''}</p>

        {contextError ? <ErrorBox message={`无法读取工作上下文：${contextError}`} onRetry={() => void loadContext()} /> : null}

        <div className="ec-wb-detail">
          <div className="ec-wb-stack">
            <DraftPanel api={api} workId={workId} onUseDraft={setDraftSeed} />
            {context && context.work.state !== 'ARCHIVED'
              ? (
                <section className="ec-wb-card" aria-labelledby="ec-wb-bind">
                  <div className="ec-wb-card-head">
                    <h2 id="ec-wb-bind">原生会话</h2>
                    <span className="ec-wb-badge" data-tone={boundSessionId ? 'ok' : 'warn'}>{boundSessionId ? '已绑定' : '未绑定'}</span>
                  </div>
                  <p className="ec-wb-muted">
                    {boundSessionId
                      ? '此工作已关联原生会话，可直接对话；回复按原生流式呈现，运行记录与成果仍由平台保存。'
                      : '此工作还没有原生会话。绑定后可在工作台内直接对话，回复按原生流式呈现；运行记录与成果仍由平台保存。'}
                  </p>
                  <p className="ec-wb-muted">
                    {context.workspace
                      ? `新会话将在工作空间目录 ${context.workspace.directory} 中创建；没有执行域时会先登记本机执行域（local）。重新绑定会把当前会话保留为历史（reopened）。`
                      : '此工作尚未选择工作空间，没有可用来创建会话的目录。'}
                  </p>
                  <div className="ec-wb-row-actions">
                    {boundSessionId ? (
                      <button type="button" className="ec-wb-button" onClick={openBound}>打开会话</button>
                    ) : null}
                    <button type="button" className={boundSessionId ? 'ec-wb-button' : 'ec-wb-button ec-wb-primary'}
                      disabled={bindBusy || !context.workspace} onClick={() => void bindSession()}>
                      {bindBusy ? '正在创建会话…' : boundSessionId ? '重新绑定新的原生会话' : '新建原生会话并绑定'}
                    </button>
                    {!context.workspace ? <span className="ec-wb-muted">请先在项目空间为该工作登记目录。</span> : null}
                  </div>
                </section>
              )
              : null}
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
                    <dt>应用</dt><dd>{context.app.displayName} · {context.app.appVersion}</dd>
                    <dt>原生会话</dt>
                    <dd>{context.binding ? <><span className="ec-wb-digest">{context.binding.sessionId}</span>（{context.binding.relation}）</> : '未绑定；请先绑定原生会话。'}</dd>
                    <dt>执行域</dt><dd>{context.domain ? `${context.domain.kind} · ${context.domain.state}` : '尚未登记执行域'}</dd>
                    <dt>工作空间</dt><dd>{context.workspace ? context.workspace.directory : '未选择工作空间'}</dd>
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
                                  ? <a className="ec-wb-link" href={`${API_BASE}${artifactDownloadPath(selectedRun.runId, artifact.name)}`}>下载</a>
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

            <section className="ec-wb-card" aria-labelledby="ec-wb-baselines">
              <div className="ec-wb-card-head"><h2 id="ec-wb-baselines">输入批次</h2><span className="ec-wb-badge">{baselines.total}</span></div>
              <p className="ec-wb-muted">批次只追加，不覆盖旧基线；旧执行始终对应它当时的输入摘要。</p>
              {baselinesError
                ? <ErrorBox message={`无法读取输入批次：${baselinesError}`} onRetry={() => void loadBaselines(baselinesOffset)} />
                : baselines.items.length === 0
                  ? <p className="ec-wb-empty">尚未登记输入批次。</p>
                  : (
                    <div>
                      {baselines.items.map((baseline) => (
                        <div className="ec-wb-row" key={baseline.baselineId}>
                          <span className="ec-wb-row-main">
                            <strong>第 {baseline.revision} 批 · {baseline.sourceRef}</strong>
                            <small className="ec-wb-muted"><span className="ec-wb-digest">{baseline.digest.slice(0, 12)}…</span> · {formatTime(baseline.createdAt)}</small>
                          </span>
                        </div>
                      ))}
                      <Pager total={baselines.total} offset={baselinesOffset} limit={BASELINE_PAGE} busy={false} onOffset={(offset) => void loadBaselines(offset)} />
                    </div>
                  )}
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
                              <small className="ec-wb-muted">{commit.state} · <span className="ec-wb-digest">{commit.contentDigest.slice(0, 12)}…</span></small>
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
function WorkConsole({ api, workId, title, modelLabel, onBack, onDetail, onReload, children }: {
  api: WorkbenchApi
  workId: string
  title: string
  modelLabel: string
  onBack(): void
  onDetail(): void
  /** Refresh the shell bootstrap so the home counters reflect a run this console just changed. */
  onReload(): Promise<void>
  children: ReactNode
}) {
  const [context, setContext] = useState<WorkContext | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [runsTotal, setRunsTotal] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([])
  const [error, setError] = useState('')
  const [artifactsError, setArtifactsError] = useState('')
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [token, setToken] = useState(0)

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
      setSelectedRunId((previous) => previous && page.items.some((run) => run.runId === previous)
        ? previous
        : page.items[0]?.runId ?? null)
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [api, workId])

  useEffect(() => { void load() }, [load, token])
  useEffect(() => {
    const timer = setInterval(() => {
      if (globalThis.document?.visibilityState === 'visible') setToken((value) => value + 1)
    }, CONSOLE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

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
  const control = useRunControl(api, selectedRun, () => { setToken((value) => value + 1); void onReload() })
  const state = selectedRun?.snapshot?.state
  const terminal = state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED'
  const archived = context?.work.state === 'ARCHIVED'
  const pill = selectedRun
    ? { label: runStateLabel(state), tone: runTone(state) }
    : archived ? { label: '已归档', tone: 'muted' } : { label: '尚无运行记录', tone: 'muted' }
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
            <span>{selectedRun ? `运行 ${selectedRun.runId.slice(0, 8)}` : '原生会话'}</span>
          </div>
          <div className="ec-wb-console-title-row">
            <h2 className="ec-wb-console-title">{context?.work.title ?? title}</h2>
            <span className="ec-wb-pill" data-tone={pill.tone}>{pill.label}</span>
          </div>
        </div>
        <div className="ec-wb-console-actions">
          <button type="button" className="ec-wb-button" onClick={onDetail}>查看目标与成果</button>
          <button type="button" className="ec-wb-button ec-wb-stop"
            disabled={!selectedRun || !!control.busy || terminal || state === 'UNKNOWN'}
            onClick={() => void control.act('cancel')}>
            {control.busy === 'cancel' ? '请求中…' : '请求停止'}
          </button>
        </div>
      </header>

      <div className="ec-wb-console-body">
        <div className="ec-wb-console-thread">{children}</div>
        <aside className="ec-wb-console-rail" aria-label="运行信息">
          {error ? <ErrorBox message={`无法读取运行信息：${error}`} onRetry={() => setToken((value) => value + 1)} /> : null}

          <section className="ec-wb-card" aria-labelledby="ec-wb-console-state">
            <div className="ec-wb-card-head">
              <h3 id="ec-wb-console-state">运行状态</h3>
              <button type="button" className="ec-wb-text-link" onClick={onDetail}>运行详情</button>
            </div>
            <div>
              <div className="ec-wb-fact-line"><span>当前状态</span><span>{pill.label}</span></div>
              <div className="ec-wb-fact-line"><span>运行编号</span><span>{selectedRun ? selectedRun.runId.slice(0, 8) : '暂无'}</span></div>
              <div className="ec-wb-fact-line"><span>开始时间</span><span>{selectedRun ? formatTime(selectedRun.createdAt) : '暂无'}</span></div>
              <div className="ec-wb-fact-line"><span>默认模型</span><span>{modelLabel || '尚未登记'}</span></div>
              <div className="ec-wb-fact-line"><span>工作空间</span><span>{context?.workspace?.directory ?? '未选择'}</span></div>
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
                              ? <a className="ec-wb-dl ec-wb-link" href={`${API_BASE}${artifactDownloadPath(selectedRun.runId, artifact.name)}`}>下载</a>
                              : null}
                          </div>
                        ))}
                      </div>
                      {artifacts.length > 5 ? <button type="button" className="ec-wb-text-link" onClick={onDetail}>查看全部 {artifacts.length} 项</button> : null}
                    </>
                  )}
          </section>

          <section className="ec-wb-card" aria-labelledby="ec-wb-console-runs">
            <div className="ec-wb-card-head">
              <h3 id="ec-wb-console-runs">运行历史</h3>
              <span className="ec-wb-badge">{runsTotal}</span>
            </div>
            {runs.length === 0
              ? <p className="ec-wb-empty">此工作还没有执行记录。</p>
              : runs.map((run) => (
                <button type="button" className="ec-wb-run-row" key={run.runId}
                  aria-current={run.runId === selectedRunId}
                  onClick={() => setSelectedRunId(run.runId)}>
                  <span className="ec-wb-run-dot" data-tone={runTone(run.snapshot?.state)} aria-hidden="true" />
                  <span className="ec-wb-row-main">
                    <strong>运行 {run.runId.slice(0, 8)}</strong>
                    <small>{relativeTime(run.createdAt, Date.now())} · {runStateLabel(run.snapshot?.state)}</small>
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
  const autoLoadTried = useRef(false)

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

  const rows: WorkRow[] = all.map((work) => ({
    workId: work.workId,
    title: work.title,
    state: work.state,
    ...(work.updatedAt ? { updatedAt: work.updatedAt } : {}),
    projectId: work.projectId,
    projectName: projectName(work.projectId),
    appId: work.appId,
    appVersion: work.appVersion,
    appName: appLabel(work.appId, work.appVersion),
  }))
  const visible = selectWorkRows(rows, { query, state: stateFilter, sort })
  const byId = new Map(all.map((work) => [work.workId, work]))
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
    if (run) return { label: runStateLabel(run.snapshot?.state), tone: runTone(run.snapshot?.state) }
    return work.state === 'ARCHIVED' ? { label: '已归档', tone: 'muted' } : { label: '未发起运行', tone: 'muted' }
  }

  // A search must cover the catalogue, not one bootstrap page: the first query over a partial list
  // loads the rest once, so "no match" can never mean "not on this page".
  useEffect(() => {
    if (autoLoadTried.current || complete || loadingAll || query.trim().length === 0) return
    autoLoadTried.current = true
    void loadAll()
  }, [query, complete, loadingAll])

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
            value={sort} onChange={(event) => setSort(event.target.value as 'recent' | 'title' | 'project')}>
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
              {all.length === 0
                ? '还没有工作。用上方入口新建一项；对话在绑定的原生会话中进行。'
                : filtering && missing > 0
                  ? `已加载的 ${all.length} 项里没有匹配；其余 ${missing} 项尚未加载，可能就在其中。`
                  : filtering
                    ? '没有匹配的工作。换个关键词，或放宽状态筛选。'
                    : `没有进行中的工作。已归档的 ${archivedCount} 项记录与成果仍可查阅。`}
            </p>
            {all.length > 0
              ? (
                <div className="ec-wb-form-actions">
                  {filtering && missing > 0
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
          <div className="ec-wb-table" role="table" aria-label="最近工作" aria-busy={opening !== ''}>
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
      {loadError ? <p className="ec-wb-error-text ec-wb-queue-note" role="alert">{loadError}</p> : null}
      <div className="ec-wb-queue-foot">
        <i aria-hidden="true" />
        <span aria-live="polite">
          {filtering ? `筛选出 ${visible.length} 项` : `${visible.length} 项工作`}
          {complete ? '' : ` · 已加载 ${all.length}/${total}`}
        </span>
        {!complete
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

function WorksPage({ api, data, onOpenWork, onDetail, onOpenPending, onCreate, onReload, creating, opening, projectId, onProjectChange, initialAppKey, onCreated, onNavigate }: {
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
  onNavigate(view: WorkbenchView): void
}) {
  const projects = data.projects ?? []
  const works = data.works?.items ?? []
  const pending = data.pending ?? []
  const pendingTitles = usePendingWorkTitles(api, pending, works)
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
          <LaunchPanel data={data} projectId={activeProject?.projectId ?? ''} onProjectChange={onProjectChange} onStart={onCreate} />
          {creating
            ? (
              <NewWorkForm
                api={api}
                data={data}
                initialProjectId={activeProject?.projectId ?? ''}
                initialAppKey={initialAppKey}
                onCreated={onCreated}
                onReload={onReload}
              />
            )
            : null}
          {opening ? <p className="ec-wb-muted" role="status">正在打开工作…</p> : null}
          <WorksQueue api={api} data={data} onOpenWork={onOpenWork} onDetail={onDetail} opening={opening} />
        </div>

        <aside className="ec-wb-rail" aria-label="待处理、运行就绪与项目">
          <section className="ec-wb-card" aria-labelledby="ec-wb-pending-home">
            <div className="ec-wb-card-head">
              <h3 id="ec-wb-pending-home">需要你处理</h3>
              <span className="ec-wb-badge" data-tone={pending.length > 0 ? 'warn' : undefined}>{pending.length}</span>
            </div>
            {pending.length === 0
              ? (
                <div className="ec-wb-pending-empty">
                  <span className="ec-wb-empty-icon" aria-hidden="true">{GLYPH_CHECK}</span>
                  <p>目前没有等待答复的事项。<small>AI 需要你参与时，会在这里提醒。</small></p>
                </div>
              )
              : <PendingList items={pending} works={works} titles={pendingTitles} onOpen={onOpenPending} />}
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
  const pendingTitles = usePendingWorkTitles(api, data.pending ?? [], works)
  return (
    <div className="ec-wb-page">
      <header className="ec-wb-page-head">
        <div><h1>待我处理</h1><p className="ec-wb-muted">平台执行器提出的问题；每项只能答复一次。</p></div>
        <span className="ec-wb-badge">{(data.pending ?? []).length} 项</span>
      </header>
      <section className="ec-wb-card">
        <PendingList items={data.pending ?? []} works={works} titles={pendingTitles} onOpen={onOpen} />
      </section>
    </div>
  )
}

function SettingsPage({ api, data, onReload }: {
  api: WorkbenchApi
  data: WorkbenchBootstrap
  onReload(): Promise<void>
}) {
  const catalog = data.models?.catalog
  return (
    <div className="ec-wb-page">
      <header className="ec-wb-page-head">
        <div><h1>平台设置</h1><p className="ec-wb-muted">执行模型、平台连接与运行状态。业务平台独立维护，执行引擎通过版本化适配层接入。</p></div>
      </header>
      <div className="ec-wb-home-grid">
        <div className="ec-wb-stack">
          <ModelDefaultPanel api={api} catalog={catalog} preference={data.models?.preference} onReload={onReload} />
          <section className="ec-wb-card" aria-labelledby="ec-wb-model-catalog">
            <div className="ec-wb-card-head"><h2 id="ec-wb-model-catalog">模型目录</h2><span className="ec-wb-badge">{catalog?.entries?.length ?? 0}</span></div>
            <p className="ec-wb-muted">目录只列出经部署登记并接入的模型；选择随运行冻结，切换不会改写已有记录。</p>
            {!catalog || (catalog.entries ?? []).length === 0
              ? <p className="ec-wb-empty">平台尚未登记模型目录；创建运行前需要部署登记。</p>
              : (catalog.entries ?? []).map((entry) => (
                <div className="ec-wb-row" key={entry.selectionId}>
                  <span className="ec-wb-row-main">
                    <strong>{entry.displayName || entry.model}</strong>
                    <small className="ec-wb-muted">{entry.provider} / {entry.model} · {entry.selectionId}</small>
                  </span>
                  <span className="ec-wb-badge" data-tone={entry.enabled ? 'ok' : 'warn'}>{entry.enabled ? '可用' : '不可用'}</span>
                </div>
              ))}
          </section>
        </div>
        <aside className="ec-wb-rail">
          <section className="ec-wb-card">
            <div className="ec-wb-card-head"><h2>执行环境</h2></div>
            <dl className="ec-wb-facts">
              <dt>执行器</dt><dd>{data.status?.executor ?? '未记录'}</dd>
              <dt>运行计数</dt><dd>{data.status?.runs ? Object.entries(data.status.runs).map(([state, count]) => `${state} ${count}`).join(' · ') : '未记录'}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}

// ── Shell ────────────────────────────────────────────────────────────────────

const VIEW_TITLES: Record<WorkbenchView, string> = {
  works: '我的工作',
  projects: '项目空间',
  apps: '应用中心',
  pending: '待我处理',
  settings: '平台设置',
}

const PLATFORM_NAV_ICONS: Record<WorkbenchView, ReactNode> = {
  projects: <Glyph><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Glyph>,
  apps: <Glyph><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></Glyph>,
  works: <Glyph><line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></Glyph>,
  pending: <Glyph><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 13.8" /></Glyph>,
  settings: <Glyph><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></Glyph>,
}

/** Navigation order follows the reviewed draft: work first, then the spaces and tools around it. */
const PLATFORM_NAV: ReadonlyArray<{ id: WorkbenchView; label: string }> = [
  { id: 'works', label: '我的工作' },
  { id: 'projects', label: '项目空间' },
  { id: 'apps', label: '应用中心' },
  { id: 'pending', label: '待我处理' },
  { id: 'settings', label: '平台设置' },
]

export function WorkbenchPage({ SessionProvider, retainSession, releaseSession, watchWorkSession, createSession, renderSlot }: WorkbenchPageProps) {
  const api = useMemo(() => new WorkbenchApi(API_BASE), [])
  const hasData = useRef(false)
  const [data, setData] = useState<WorkbenchBootstrap | null>(null)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState('')
  const [notice, setNotice] = useState('')
  const [networkHint, setNetworkHint] = useState('')
  const [detailWork, setDetailWork] = useState<WorkbenchItem | null>(null)
  const [focusRunId, setFocusRunId] = useState<string | undefined>(undefined)
  const [compact, setCompact] = useState(readCompact)
  const [creating, setCreating] = useState(false)
  const [startAppKey, setStartAppKey] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [page, setPage] = useState<WorkbenchView>('works')
  const [sessionWork, setSessionWork] = useState<{ workId: string; title: string; reference: SessionReference } | null>(null)

  // Leaving the session view (nav, back, detail switch) releases the view's retained reference so
  // the embedded factory returns to its session-less posture; unmount releases it too. React
  // removes the SessionProvider subtree before this cleanup runs, so the renderer never reads a
  // released reference.
  const sessionViewOpen = sessionWork !== null
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

  const openWork = useCallback(async (workId: string) => {
    setOpening(workId)
    setNotice('')
    try {
      const context = await api.workContext(workId)
      const sessionId = context.binding?.sessionId ?? context.sessionId
      if (!sessionId) {
        setNotice('此工作尚未关联原生会话；已打开工作详情，可在其中新建会话并绑定。')
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
        setNotice('此工作缺少执行域绑定，无法关联原生提交记录。')
        return
      }
      const reference = retainSession(sessionId)
      watchWorkSession({ workId, domainId: context.binding.domainId, sessionId, since: context.binding.createdAt })
      setDetailWork(null)
      setFocusRunId(undefined)
      setSessionWork({ workId, title: context.work.title, reference })
    } catch (reason) {
      console.error(`[platform-workbench] open work failed: ${errorText(reason)}`)
      setNotice(`无法打开工作：${errorText(reason)}`)
    } finally {
      setOpening('')
    }
  }, [api, retainSession, watchWorkSession])

  // Open the embedded session view from the Work detail page (bound Session + domain already checked).
  const openBoundSession = useCallback((workId: string, sessionId: string, domainId: string, since?: string) => {
    setNotice('')
    const reference = retainSession(sessionId)
    watchWorkSession({ workId, domainId, sessionId, ...(since ? { since } : {}) })
    setSessionWork({ workId, title: detailWork?.title ?? '工作', reference })
  }, [retainSession, watchWorkSession, detailWork])

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

  const toggleCompact = () => {
    setCompact((previous) => {
      const next = !previous
      writeCompact(next)
      return next
    })
  }

  const selectPage = (next: WorkbenchView) => {
    setPage(next)
    setSessionWork(null)
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

  /** Leave the console for the Work's detail page. */
  const openDetailFromConsole = async (workId: string) => {
    try {
      const work = await resolveWork(workId)
      setSessionWork(null)
      openDetail(work)
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

  const pendingCount = (data?.pending ?? []).length
  // "最近打开" lists work still in use; an archived Work only appears while it is the open one.
  const recentWorks = byRecent((data?.works?.items ?? [])
    .filter((work) => work.state !== 'ARCHIVED' || work.workId === sessionWork?.workId)).slice(0, 5)
  const projectName = (projectId: string) =>
    (data?.projects ?? []).find((project) => project.projectId === projectId)?.name ?? projectId
  const executorLabel = data?.status?.executor && data.status.executor !== 'not-configured'
    ? `执行器 ${data.status.executor}`
    : '执行器待配置'

  const shell = (children: ReactNode, options: { session?: boolean } = {}) => (
    <div className="ec-wb" data-density={compact ? 'compact' : 'normal'}>
      <div className="ec-wb-topbar">
        <span className="ec-wb-mark" aria-hidden="true">{BRAND_MARK}</span>
        <span className="ec-wb-wordmark">EMERALD</span>
        <span className="ec-wb-top-divider" aria-hidden="true" />
        <div className="ec-wb-breadcrumb">
          <span>企业 AI 平台</span><span aria-hidden="true">/</span>
          <span>{sessionWork ? sessionWork.title : detailWork ? detailWork.title : VIEW_TITLES[page]}</span>
        </div>
        <div className="ec-wb-top-actions">
          <span className={`ec-wb-conn${error ? ' is-down' : ''}`} role="status">{error ? '平台未连接' : '平台已连接'}</span>
          <button type="button" className="ec-wb-icon-btn" aria-label="刷新平台数据" title="刷新" onClick={() => void load()}>{GLYPH_REFRESH}</button>
          <button type="button" className="ec-wb-icon-btn" aria-label="紧凑布局" title="紧凑布局" aria-pressed={compact} onClick={toggleCompact}>{GLYPH_DENSITY}</button>
          <button type="button" className="ec-wb-icon-btn" aria-label="平台设置" title="平台设置" onClick={() => selectPage('settings')}>{GLYPH_SETTINGS}</button>
        </div>
      </div>
      <div className="ec-wb-shell">
        <nav className="ec-wb-nav" aria-label="企业导航">
          <div className="ec-wb-nav-brand">
            <span className="ec-wb-nav-mark" aria-hidden="true">{BRAND_MARK}</span>
            <span><strong>EMERALD</strong><small>企业 AI 平台</small></span>
          </div>
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
                <span className="ec-wb-nav-glyph" aria-hidden="true">{PLATFORM_NAV_ICONS[item.id]}</span>{item.label}
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
        <div className={options.session ? 'ec-wb-main ec-wb-main-session' : 'ec-wb-main'}>
          {networkHint || notice ? <p className="ec-wb-status" role="status" aria-live="polite">{networkHint || notice}</p> : null}
          {children}
        </div>
      </div>
    </div>
  )

  if (error && !data) {
    return shell(
      <div className="ec-wb-page">
        <header className="ec-wb-page-head"><div><h1>{VIEW_TITLES[page]}</h1></div></header>
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
        onBack={closeSessionView}
        onDetail={() => void openDetailFromConsole(sessionWork.workId)}
        onReload={load}
      >
        <SessionProvider session={sessionWork.reference}>
          {renderSlot('workbench.session', {})}
        </SessionProvider>
      </WorkConsole>,
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
          onNavigate={selectPage}
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
