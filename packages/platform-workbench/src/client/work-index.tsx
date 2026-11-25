/** The work index: the controlled master list of 「我的工作」(方案 B/B2).
 *
 *  Everything arrives through props — query results and their states from `useWorkIndex`,
 *  grouping/date labels from the pure `work-index-model`, the selection as a bare `workId` —
 *  and the only output is `onInspect(workId)`. The component holds no Work or Session object
 *  copy, fetches nothing itself, and never presents the loaded count as the catalogue total.
 *  Rows are plain buttons (no tree/grid roles): each names itself 「查看…工作摘要」 and the
 *  selected row carries `aria-current`.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { monogram, type WorkRow } from '../reports.js'
import { t, usePreferences } from './i18n.js'
import { groupWorkRows, workTimeLabel } from './work-index-model.js'
import type { WorkIndexData, WorkIndexFilters } from './use-work-index.js'

export interface WorkIndexChip {
  label: string
  tone: 'ok' | 'warn' | 'error' | 'muted'
}

export interface WorkIndexProps {
  index: WorkIndexData
  filters: WorkIndexFilters
  onFiltersChange(patch: Partial<WorkIndexFilters>): void
  /** The highlighted row: the preview on the works home, the current Work in a session. */
  selectedId: string | null
  /** Session mode marks the selected row 「当前对话」 and its click is ignored upstream. */
  sessionMode: boolean
  chips: ReadonlyMap<string, WorkIndexChip[]>
  /** A Work is being opened (disabled rows keep the list honest about pending navigation). */
  busy: boolean
  projects: ReadonlyArray<{ projectId: string; name: string }>
  onInspect(workId: string): void
  /** The header's ＋ dispatches the existing global create intent (plan §2). */
  onCreate(): void
  /** The index scroll position survives leaving and re-entering the desk shell. */
  scrollMemory?: { current: number }
  labelId?: string
}

export function WorkIndex({ index, filters, onFiltersChange, selectedId, sessionMode, chips, busy, projects, onInspect, onCreate, scrollMemory, labelId }: WorkIndexProps) {
  const { locale } = usePreferences()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (scrollMemory && listRef.current) listRef.current.scrollTop = scrollMemory.current
    // The memory ref is stable; restore exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const rememberScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (scrollMemory) scrollMemory.current = event.currentTarget.scrollTop
  }

  const activeFilterCount = (filters.query.trim() ? 1 : 0)
    + (filters.state !== 'active' ? 1 : 0)
    + (filters.sort !== 'recent' ? 1 : 0)
    + (filters.projectId ? 1 : 0)
  const now = Date.now()
  const sections = filters.sort === 'recent'
    ? groupWorkRows(index.rows, now, locale)
    : (index.rows.length > 0 ? [{ key: 'all' as const, label: '', rows: [...index.rows] }] : [])

  const emptyMessage = (): string => {
    if (index.error) return index.error
    if (index.busy) return t('home.querying', locale)
    if (index.serverMode) return t('home.noMatches', locale)
    if (index.loadedCount === 0) return t('home.empty', locale)
    if (index.filtering && index.missing > 0) return `${t('home.partial', locale)} (${index.loadedCount}/${index.total})`
    if (index.filtering) return t('home.noMatches', locale)
    return t('home.noActive', locale)
  }

  return (
    <div className="ec-wb-desk-index-frame">
      <p className="ec-wb-desk-brand">
        Emerald <small>{t('desk.brandSuffix', locale)}</small>
      </p>
      <div className="ec-wb-desk-index-head">
        <div className="ec-wb-desk-index-tools">
          <h2 className="ec-wb-desk-index-title" id={labelId}>{t('desk.index', locale)}</h2>
          {/* 基准图 12 号稿：标题行右侧的绿色「＋ 新建工作」按钮是索引创建入口（走既有 create
              意图）。按钮文字是真实 DOM 文本——不用 CSS 伪元素注入可见文字。 */}
          <button type="button" className="ec-wb-desk-index-add" title={t('home.newLabel', locale)} onClick={onCreate}>
            <span className="ec-wb-desk-index-add-plus" aria-hidden="true">＋</span>
            <span className="ec-wb-desk-index-add-label">{t('home.newLabel', locale)}</span>
          </button>
        </div>
        <div className="ec-wb-search ec-wb-desk-index-search">
          <span className="ec-wb-search-glyph" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false">
              <circle cx="11" cy="11" r="6.5" /><line x1="16" y1="16" x2="21" y2="21" />
            </svg>
          </span>
          <input
            className="ec-wb-input ec-wb-search-input"
            type="search"
            aria-label={t('home.search', locale)}
            placeholder={t('home.search', locale)}
            value={filters.query}
            onChange={(event) => onFiltersChange({ query: event.target.value })}
          />
          {filters.query
            ? <button type="button" className="ec-wb-search-clear" aria-label={t('home.clearSearch', locale)} onClick={() => onFiltersChange({ query: '' })}>×</button>
            : (
              <button
                type="button"
                className="ec-wb-desk-filter"
                aria-label={t('desk.filters', locale)}
                title={t('desk.filters', locale)}
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((value) => !value)}
              >
                {activeFilterCount > 0 ? <span className="ec-wb-desk-filter-count" aria-hidden="true">{activeFilterCount}</span> : null}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <polygon points="3 5 21 5 14 13 14 20 10 22 10 13 3 5" />
                </svg>
              </button>
            )}
        </div>
        {filtersOpen
          ? (
            <div className="ec-wb-desk-filter-panel" data-window-drag-exclude>
              <label className="ec-wb-desk-filter-field">
                {t('home.filter', locale)}
                <select
                  className="ec-wb-select"
                  value={filters.state}
                  onChange={(event) => onFiltersChange({ state: event.target.value as WorkIndexFilters['state'] })}
                >
                  <option value="active">{t('home.active', locale)}</option>
                  <option value="archived">{t('home.archived', locale)}{index.archivedCount > 0 ? ` (${index.archivedCount})` : ''}</option>
                  <option value="all">{t('home.allStates', locale)}</option>
                </select>
              </label>
              <label className="ec-wb-desk-filter-field">
                {t('home.projectFilter', locale)}
                <select
                  className="ec-wb-select"
                  value={filters.projectId}
                  onChange={(event) => onFiltersChange({ projectId: event.target.value })}
                >
                  <option value="">{t('home.allProjects', locale)}</option>
                  {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
                </select>
              </label>
              <label className="ec-wb-desk-filter-field">
                {t('home.sort', locale)}
                <select
                  className="ec-wb-select"
                  value={filters.sort}
                  disabled={index.serverMode}
                  title={index.serverMode ? t('home.serverSort', locale) : undefined}
                  onChange={(event) => onFiltersChange({ sort: event.target.value as WorkIndexFilters['sort'] })}
                >
                  <option value="recent">{t('home.activity', locale)}</option>
                  <option value="title">{t('home.name', locale)}</option>
                  <option value="project">{t('home.byProject', locale)}</option>
                </select>
              </label>
              {index.filtering
                ? (
                  <div className="ec-wb-form-actions">
                    <button
                      type="button"
                      className="ec-wb-button"
                      onClick={() => onFiltersChange({ query: '', state: 'active', sort: 'recent', projectId: '' })}
                    >
                      {t('home.reset', locale)}
                    </button>
                  </div>
                )
                : null}
            </div>
          )
          : null}
      </div>

      <div className="ec-wb-desk-index-list" ref={listRef} onScroll={rememberScroll} aria-busy={busy || index.busy}>
        {index.rows.length === 0
          ? (
            <div className="ec-wb-desk-index-empty">
              <p role="status">{emptyMessage()}</p>
              {index.filtering && index.loadedCount > 0
                ? (
                  <button
                    type="button"
                    className="ec-wb-button"
                    onClick={() => onFiltersChange({ query: '', state: 'active', sort: 'recent', projectId: '' })}
                  >
                    {t('home.reset', locale)}
                  </button>
                )
                : null}
              {!index.serverMode && filters.state === 'active' && index.archivedCount > 0
                ? <button type="button" className="ec-wb-button" onClick={() => onFiltersChange({ state: 'archived' })}>{t('home.archived', locale)} ({index.archivedCount})</button>
                : null}
            </div>
          )
          : sections.map((section) => (
            <div className="ec-wb-desk-section" key={section.key}>
              {section.label ? <p className="ec-wb-desk-section-label" aria-hidden="true">{section.label}</p> : null}
              {section.rows.map((row) => <WorkIndexRow
                key={row.workId}
                row={row}
                now={now}
                locale={locale}
                selected={row.workId === selectedId}
                sessionMode={sessionMode}
                rowChips={chips.get(row.workId) ?? []}
                busy={busy}
                onInspect={onInspect}
              />)}
            </div>
          ))}
        {index.error && index.rows.length > 0
          ? <p className="ec-wb-error-text ec-wb-desk-index-note" role="alert">{index.error}</p>
          : null}
      </div>

      <div className="ec-wb-desk-index-foot">
        <span aria-live="polite">
          {t('home.shown', locale)}: {index.rows.length}
          {!index.serverMode && !index.complete ? ` / ${t('home.loaded', locale)}: ${index.loadedCount}/${index.total}` : ''}
        </span>
        {index.hasMore
          ? (
            <button
              type="button"
              className="ec-wb-text-link"
              disabled={index.busy || index.loadingAll}
              onClick={() => { if (index.serverMode) void index.loadMore(); else void index.loadAll() }}
            >
              {index.busy || index.loadingAll ? t('home.loading', locale) : t('home.more', locale)}
            </button>
          )
          : null}
      </div>
    </div>
  )
}

/** One index row. The accessible name is 「查看…工作摘要」: inspecting a row previews its
 *  summary and nothing else — no open, no bind, no run (plan §2). */
function WorkIndexRow({ row, now, locale, selected, sessionMode, rowChips, busy, onInspect }: {
  row: WorkRow
  now: number
  locale: 'zh-CN' | 'en-US'
  selected: boolean
  sessionMode: boolean
  rowChips: WorkIndexChip[]
  busy: boolean
  onInspect(workId: string): void
}) {
  const time = workTimeLabel(row.updatedAt, now, locale)
  return (
    <button
      type="button"
      className="ec-wb-desk-row"
      aria-current={selected ? 'true' : undefined}
      aria-label={t('desk.rowLabel', locale).replace('{title}', row.title)}
      disabled={busy}
      onClick={() => onInspect(row.workId)}
    >
      <span className="ec-wb-desk-row-icon" aria-hidden="true">{monogram(row.title)}</span>
      <span className="ec-wb-desk-row-main">
        <span className="ec-wb-desk-row-title">{row.title}</span>
        <span className="ec-wb-desk-row-project">{row.projectName}</span>
        {rowChips.length > 0
          ? (
            <span className="ec-wb-desk-row-tags">
              {rowChips.map((chip) => (
                <span key={chip.label} className="ec-wb-desk-row-chip" data-tone={chip.tone}>{chip.label}</span>
              ))}
            </span>
          )
          : null}
      </span>
      <span className="ec-wb-desk-row-meta">
        {time ? <time dateTime={row.updatedAt} className="ec-wb-desk-row-time">{time}</time> : null}
        {sessionMode && selected ? <span className="ec-wb-desk-row-current">{t('desk.current', locale)}</span> : null}
      </span>
    </button>
  )
}
