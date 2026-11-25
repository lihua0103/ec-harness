/** List engine behind the work index (「我的工作」, 方案 B/B1).
 *
 *  Extracted from the old `WorksQueue` without changing its behavior: the same bootstrap merge
 *  (bootstrap records win by id, extended loads survive a refresh), the same 250 ms debounced
 *  server-side cursor search that never depends on which bootstrap page loaded, the same
 *  load-all loop with its honest cap, and the same partial-catalogue wording. The hook owns
 *  transport state only — grouping, selection and date labels stay in `work-index-model.ts`,
 *  and no component prefetches per-row context, artifacts or events here.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { WorkbenchApi, errorText, type WorkbenchBootstrap, type WorkbenchItem } from '../api.js'
import { selectWorkRows, type WorkRow } from '../reports.js'
import { t } from './i18n.js'

const WORKS_PAGE = 100
const WORKS_LOAD_CAP = 5000

export interface WorkIndexFilters {
  /** Free text; a non-empty term switches the list to the server-side whole-catalogue query. */
  query: string
  state: 'active' | 'archived' | 'all'
  sort: 'recent' | 'title' | 'project'
  /** Project scope; '' shows every authorized project. */
  projectId: string
}

export interface WorkIndexData {
  /** Visible rows in display order (server hits in server mode, projected rows otherwise). */
  rows: WorkRow[]
  /** Every known Work by id — visible rows and server hits that sit outside the bootstrap page. */
  byId: Map<string, WorkbenchItem>
  /** The control plane's recorded total; the UI never presents the loaded count as the total. */
  total: number
  /** How many distinct Works are actually loaded (bootstrap page + extended loads + hits). */
  loadedCount: number
  complete: boolean
  missing: number
  archivedCount: number
  /** True when any filter deviates from the default view. */
  filtering: boolean
  /** Server-mode is a whole-catalogue query; client sort is disabled while it holds. */
  serverMode: boolean
  busy: boolean
  error: string
  loadingAll: boolean
  /** Another page exists (server cursor or an unloaded catalogue tail). */
  hasMore: boolean
  /** Next cursor page of the running server query; a no-op when there is no cursor. */
  loadMore(): Promise<void>
  /** Extend past the bootstrap page with plain list pages until the cap. */
  loadAll(): Promise<void>
}

export function useWorkIndex(api: WorkbenchApi, data: WorkbenchBootstrap | null, filters: WorkIndexFilters): WorkIndexData {
  const [extra, setExtra] = useState<WorkbenchItem[]>([])
  const [loadingAll, setLoadingAll] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [server, setServer] = useState<{ rows: WorkRow[]; items: WorkbenchItem[]; cursor: string | null } | null>(null)
  const [serverBusy, setServerBusy] = useState(false)
  const [serverError, setServerError] = useState('')
  const serverQuery = filters.query.trim()
  const serverState = filters.state === 'active' ? 'ACTIVE' : filters.state === 'archived' ? 'ARCHIVED' : undefined

  const projects = useMemo(() => data?.projects ?? [], [data])
  const apps = useMemo(() => data?.apps ?? [], [data])
  const projectName = (id: string) => projects.find((project) => project.projectId === id)?.name ?? id
  const appLabel = (appId: string, appVersion: string) => {
    const app = apps.find((candidate) => candidate.appId === appId && candidate.appVersion === appVersion)
    return app?.displayName ?? appId
  }
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

  // The old queue remounted per project scope, which dropped extended loads with it; the hook
  // keeps one instance, so the scope change does the same reset explicitly.
  useEffect(() => {
    setExtra([])
    setLoadError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filters.projectId])

  // Bootstrap records are fresher than anything loaded earlier, so they win on id; records only
  // present in the extended load are kept so a refresh never shrinks the list back to one page.
  const all = useMemo(() => {
    const merged = new Map<string, WorkbenchItem>()
    for (const work of extra) merged.set(work.workId, work)
    for (const work of data?.works?.items ?? []) merged.set(work.workId, work)
    return [...merged.values()]
  }, [extra, data])
  const total = Math.max(data?.works?.total ?? 0, all.length)
  const complete = all.length >= total

  // E4-3: a search is a server-side query over the whole catalogue, cursor-paginated — it never
  // depends on which bootstrap page happened to be loaded. Out-of-order or stale responses are
  // dropped by their AbortController, never by comparing ids.
  useEffect(() => {
    setServer(null)
    setServerError('')
    setServerBusy(Boolean(serverQuery || filters.projectId))
    if (!serverQuery && !filters.projectId) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setServerBusy(true)
      api.queryWorks(
        { q: serverQuery, projectId: filters.projectId, ...(serverState ? { state: serverState } : {}) },
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
          setServerError(`${t('home.loadError')}: ${errorText(reason)}`)
        })
        .finally(() => {
          if (!controller.signal.aborted) setServerBusy(false)
        })
    }, 250)
    return () => { controller.abort(); clearTimeout(timer) }
    // toRow/serverState derive from data and stateFilter; the query string is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, serverQuery, filters.projectId, filters.state])

  const nextPage = useRef<AbortController | null>(null)
  useEffect(() => () => nextPage.current?.abort(), [api, serverQuery, filters.projectId, filters.state])
  const loadMore = async () => {
    if (!server?.cursor || serverBusy) return
    const request = new AbortController()
    nextPage.current?.abort()
    nextPage.current = request
    setServerBusy(true)
    try {
      const page = await api.queryWorks({
        q: serverQuery, projectId: filters.projectId,
        ...(serverState ? { state: serverState } : {}),
        cursor: server.cursor,
      }, request.signal)
      if (request.signal.aborted) return
      setServer((prev) => (prev
        ? { rows: [...prev.rows, ...page.items.map(toRow)], items: [...prev.items, ...page.items], cursor: page.nextCursor }
        : prev))
    } catch (reason) {
      if (!request.signal.aborted) setServerError(`${t('home.loadError')}: ${errorText(reason)}`)
    } finally {
      if (!request.signal.aborted) setServerBusy(false)
    }
  }

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
        setLoadError(`${t('home.limit')} (${offset}/${total})`)
      }
    } catch (reason) {
      setLoadError(`${t('home.loadError')}: ${errorText(reason)}`)
    } finally {
      setLoadingAll(false)
    }
  }

  const serverMode = serverQuery.length > 0 || Boolean(filters.projectId)
  const rows = serverMode ? (server?.rows ?? []) : selectWorkRows(all.map(toRow), { query: filters.query, state: filters.state, sort: filters.sort })
  // Server hits may sit outside the bootstrap page; they must still open, so they join byId.
  const byId = useMemo(() => new Map([...all, ...(server?.items ?? [])].map((work) => [work.workId, work])), [all, server])
  const archivedCount = all.filter((work) => work.state === 'ARCHIVED').length
  const filtering = serverQuery.length > 0 || filters.state !== 'active' || filters.sort !== 'recent' || Boolean(filters.projectId)
  const missing = Math.max(0, total - all.length)

  return {
    rows,
    byId,
    total,
    loadedCount: all.length,
    complete,
    missing,
    archivedCount,
    filtering,
    serverMode,
    busy: serverBusy,
    error: serverError || loadError,
    loadingAll,
    hasMore: serverMode ? Boolean(server?.cursor) : !complete,
    loadMore,
    loadAll,
  }
}
