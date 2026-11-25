/** Refresh survival of the workbench's own view coordinate (2026-11-17).
 *
 *  The native WebUI keeps you in your conversation across F5 because its main-view election is
 *  durable. This page's view was component state only, so a reload threw the employee back to the
 *  works list — an open chat "flashed away". The view coordinate is therefore mirrored to
 *  sessionStorage — per browser tab, ids and one display title only, never business content — and
 *  re-applied at boot. A coordinate that no longer resolves (work deleted, session gone) falls
 *  back to the works page instead of erroring.
 */

/** One persisted view coordinate. Absent fields stay absent; extra unknown fields are dropped. */
export interface PersistedView {
  /** Keyed page shown when no deeper view is open. */
  page?: string
  /** Work whose detail page was open. */
  detailWorkId?: string
  /** Work whose session console was open. */
  sessionWorkId?: string
  /** Session opened straight from 历史会话, with its display title (no server round trip needed). */
  historySessionId?: string
  historySessionTitle?: string
  /** Run the console or detail page had focused. */
  focusRunId?: string
}

/** The workbench's keyed pages. Defined here (the view-coordinate module) so the sidebar and
 *  the route store can share it without importing the page component. */
export type WorkbenchView = 'works' | 'sessions' | 'projects' | 'apps' | 'pending' | 'settings'

const VIEW_KEY = 'ec-wb-view'

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

const pick = (source: Record<string, unknown>, key: string): string | undefined =>
  isNonEmptyString(source[key]) ? source[key] : undefined

/** Read the coordinate back; malformed or empty storage reads as "nothing saved". */
export function readPersistedView(): PersistedView | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(VIEW_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const source = parsed as Record<string, unknown>
    const view: PersistedView = {}
    const fields = ['page', 'detailWorkId', 'sessionWorkId', 'historySessionId', 'historySessionTitle', 'focusRunId'] as const
    for (const field of fields) {
      const value = pick(source, field)
      if (value !== undefined) (view as Record<string, string>)[field] = value
    }
    return Object.keys(view).length > 0 ? view : null
  } catch {
    return null
  }
}

/** Mirror the coordinate; a storage-restricted shell keeps the in-memory view only. */
export function writePersistedView(view: PersistedView): void {
  try {
    globalThis.sessionStorage?.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    // Nothing durable is written where storage is unavailable.
  }
}

/** Forget the coordinate — used when it no longer resolves or the employee is back at the root. */
export function clearPersistedView(): void {
  try {
    globalThis.sessionStorage?.removeItem(VIEW_KEY)
  } catch {
    // Nothing to clean up where storage is unavailable.
  }
}

/** Closed set of keyed pages a deep link may name; an unknown page is refused, not coerced. */
const LINKABLE_PAGES = ['works', 'sessions', 'projects', 'apps', 'pending', 'settings'] as const

/**
 * Encode a view coordinate as a shareable URL hash. Ids only — a deep link is a navigation
 * coordinate, never an authorization: opening it still resolves through the platform's own checks.
 * Format: `#/work/<id>[?run=<id>]`, `#/detail/<id>[?run=<id>]`, `#/session/<id>`, `#/<page>`.
 */
export function viewToHash(view: PersistedView): string {
  const run = view.focusRunId ? `?run=${encodeURIComponent(view.focusRunId)}` : ''
  if (view.sessionWorkId) return `#/work/${encodeURIComponent(view.sessionWorkId)}${run}`
  if (view.detailWorkId) return `#/detail/${encodeURIComponent(view.detailWorkId)}${run}`
  if (view.historySessionId) return `#/session/${encodeURIComponent(view.historySessionId)}`
  if (view.page && view.page !== 'works' && (LINKABLE_PAGES as readonly string[]).includes(view.page)) return `#/${view.page}`
  return '#/works'
}

/** Decode a URL hash back to a coordinate; a malformed or unknown link reads as "no deep link". */
export function hashToView(hash: string): PersistedView | null {
  if (typeof hash !== 'string' || !hash.startsWith('#/')) return null
  const [path, query] = hash.slice(2).split('?')
  const segments = (path ?? '').split('/').filter((segment) => segment.length > 0)
  const [kind, id] = segments
  const view: PersistedView = {}
  const run = query ? new URLSearchParams(query).get('run') : null
  if (run) view.focusRunId = run
  if (kind === 'work' && id) view.sessionWorkId = decodeURIComponent(id)
  else if (kind === 'detail' && id) view.detailWorkId = decodeURIComponent(id)
  else if (kind === 'session' && id) view.historySessionId = decodeURIComponent(id)
  else if (kind && (LINKABLE_PAGES as readonly string[]).includes(kind)) view.page = kind
  else return null
  return Object.keys(view).length > 0 ? view : null
}

/** The primary coordinate without the focused run — used to decide push vs replace history. */
export function viewKey(view: PersistedView): string {
  return viewToHash({ ...view, focusRunId: undefined })
}
