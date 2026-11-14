/** Pure report/paging helpers for the workbench detail views (T07/T09).
 *
 *  These rules are shared by the browser page and its tests and touch no DOM, React or transport:
 *  paging windows, artifact summaries and download paths are decided in one place so a long history
 *  is never silently truncated and a download never addresses a different run.
 */

export interface ArtifactSummary {
  name: string
  digest: string
  bytes: number
  mediaType?: string
  sealedAt?: string
}

export interface PageWindow {
  total: number
  offset: number
  limit: number
  /** 1-based page number. */
  page: number
  pages: number
  hasPrevious: boolean
  hasNext: boolean
  /** 1-based index of the first item on this page; 0 when empty. */
  first: number
  /** 1-based index of the last item on this page; 0 when empty. */
  last: number
}

/**
 * Clamp a requested page onto a real window. An out-of-range offset is corrected to the last
 * page instead of returning an empty page that looks like "no records".
 */
export function pageWindow(total: number, offset: number, limit: number): PageWindow {
  const safeTotal = Number.isSafeInteger(total) && total > 0 ? total : 0
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 10
  const maxOffset = safeTotal === 0 ? 0 : Math.floor((safeTotal - 1) / safeLimit) * safeLimit
  const safeOffset = !Number.isSafeInteger(offset) || offset < 0 ? 0 : Math.min(offset, maxOffset)
  const pages = Math.max(1, Math.ceil(safeTotal / safeLimit))
  const first = safeTotal === 0 ? 0 : safeOffset + 1
  const last = Math.min(safeOffset + safeLimit, safeTotal)
  return {
    total: safeTotal,
    offset: safeOffset,
    limit: safeLimit,
    page: Math.floor(safeOffset / safeLimit) + 1,
    pages,
    hasPrevious: safeOffset > 0,
    hasNext: last < safeTotal,
    first,
    last,
  }
}

/** Sealed vs metadata-only artifacts and their total size, never counting an invalid size. */
export function summarizeArtifacts(items: readonly ArtifactSummary[]): {
  total: number
  sealed: number
  unsealed: number
  bytes: number
} {
  let sealed = 0
  let bytes = 0
  for (const item of items) {
    if (typeof item.sealedAt === 'string' && item.sealedAt.length > 0) sealed += 1
    if (Number.isSafeInteger(item.bytes) && item.bytes > 0) bytes += item.bytes
  }
  return { total: items.length, sealed, unsealed: items.length - sealed, bytes }
}

/**
 * Control-plane download path for one sealed artifact. Every path segment is encoded, and a
 * `.`/`..` segment is refused instead of being normalised by the browser — a name can never
 * address another run or escape the seal root.
 */
export function artifactDownloadPath(runId: string, name: string): string {
  const segments = String(name ?? '')
    .split('/')
    .filter((segment) => segment.length > 0)
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('ARTIFACT_PATH_INVALID')
  }
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${segments.map((segment) => encodeURIComponent(segment)).join('/')}/download`
}

const RUN_STATES: Record<string, string> = {
  QUEUED: '已排队',
  STARTING: '启动中',
  RUNNING: '运行中',
  WAITING_FOR_USER: '等待答复',
  FINALIZING: '正在封存',
  CANCELLING: '正在停止',
  UNKNOWN: '结果未知',
  SUCCEEDED: '已成功',
  FAILED: '失败',
  CANCELLED: '已取消',
}

/** Human label for a durable run state; an unknown value is shown as unknown, not guessed. */
export function runStateLabel(state: unknown): string {
  return typeof state === 'string' && RUN_STATES[state] ? RUN_STATES[state] : '状态未记录'
}

/** Display tone for a durable run state. Only recorded states get a colour; anything else stays
 *  neutral so an unrecognised value never reads as a healthy green run. */
export function runTone(state: unknown): 'ok' | 'warn' | 'error' | 'muted' {
  if (state === 'RUNNING' || state === 'SUCCEEDED') return 'ok'
  if (state === 'FAILED') return 'error'
  if (state === 'QUEUED' || state === 'STARTING' || state === 'WAITING_FOR_USER'
    || state === 'FINALIZING' || state === 'CANCELLING' || state === 'UNKNOWN') return 'warn'
  return 'muted'
}

/**
 * Short activity label for a recorded timestamp, relative to an explicit `now` so the rule is
 * testable without a clock. Only elapsed time is derived — an absent or unparseable value is
 * reported as unrecorded rather than shown as "just now".
 */
export function relativeTime(value: unknown, now: number): string {
  if (typeof value !== 'string' || !value) return '时间未记录'
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return '时间未记录'
  const elapsed = now - time
  if (elapsed < 0) return '刚刚'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const date = new Date(time)
  const current = new Date(now)
  const sameDay = date.getFullYear() === current.getFullYear()
    && date.getMonth() === current.getMonth()
    && date.getDate() === current.getDate()
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `今天 ${clock}`
  const yesterday = new Date(now - 86_400_000)
  const isYesterday = date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()
  if (isYesterday) return `昨天 ${clock}`
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * One or two characters used as a Work/project tile label. Latin words contribute their first
 * letter (upper-cased, two for a multi-word name); a CJK title contributes its leading characters.
 * An empty title falls back to a neutral dot instead of an empty tile.
 */
export function monogram(title: unknown): string {
  const text = typeof title === 'string' ? title.trim() : ''
  if (!text) return '·'
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  if (words.length > 1 && /^[A-Za-z]/.test(words[0]) && /^[A-Za-z]/.test(words[1])) {
    return (words[0][0] + words[1][0]).toUpperCase()
  }
  const first = words[0]
  if (/^[A-Za-z]/.test(first)) return first.slice(0, 2).toUpperCase()
  return Array.from(first).slice(0, 1).join('')
}

/** One Works-queue row with its labels already resolved, so selection is pure and testable. */
export interface WorkRow {
  workId: string
  title: string
  state: string
  updatedAt?: string
  projectId: string
  projectName: string
  appId: string
  appVersion: string
  appName: string
}

export interface WorkListOptions {
  /** Free text over the Work title, its project name and its application name. */
  query: string
  state: 'active' | 'archived' | 'all'
  sort: 'recent' | 'title' | 'project'
}

const timeOf = (value: string | undefined): number => {
  if (!value) return Number.NaN
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : Number.NaN
}

/**
 * Filter and order the Works queue. Search is a case-insensitive substring over the three labels
 * an employee actually recognises; a Work with no recorded activity sorts last under "recent"
 * rather than being treated as the newest. Never mutates the input.
 */
export function selectWorkRows(rows: readonly WorkRow[], options: WorkListOptions): WorkRow[] {
  const query = options.query.trim().toLocaleLowerCase()
  const filtered = rows.filter((row) => {
    if (options.state === 'active' && row.state === 'ARCHIVED') return false
    if (options.state === 'archived' && row.state !== 'ARCHIVED') return false
    if (!query) return true
    return `${row.title}\n${row.projectName}\n${row.appName}`.toLocaleLowerCase().includes(query)
  })
  const byTitle = (left: WorkRow, right: WorkRow) => left.title.localeCompare(right.title, 'zh-CN')
  return [...filtered].sort((left, right) => {
    if (options.sort === 'title') return byTitle(left, right)
    if (options.sort === 'project') {
      const byProject = left.projectName.localeCompare(right.projectName, 'zh-CN')
      return byProject !== 0 ? byProject : byTitle(left, right)
    }
    const a = timeOf(left.updatedAt)
    const b = timeOf(right.updatedAt)
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b - a
    if (Number.isFinite(a) !== Number.isFinite(b)) return Number.isFinite(a) ? -1 : 1
    return byTitle(left, right)
  })
}

/** Format a byte count for display; never claims a size that was not recorded. */
export function formatBytes(bytes: unknown): string {
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) return '大小未记录'
  const value = bytes as number
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
