/** Pure projections for the work index (「我的工作」主从列表, 方案 B/B1).
 *
 *  Grouping, row time labels, row state chips and the preview-selection rule live here so the
 *  browser components stay declarative and every rule stays testable without a clock or a
 *  network: `now` and the locale are injected by the caller. The module touches no fetch, no
 *  authorization and no session — rows arrive already resolved (`WorkRow`), and a selection is
 *  only ever a `workId`, never a Work object copy (the index holds no business objects).
 */
import { runTone, type WorkRow } from '../reports.js'
import { runStateText, t, type Locale } from './i18n.js'

/** One labelled block of the index list. 「今天 / 更早」are the only group labels, and they are
 *  used only for the recent order (plan §3): the local day boundary decides membership, and rows
 *  without a usable `updatedAt` keep an unlabelled trailing section instead of a fabricated time. */
export interface WorkIndexSection {
  key: 'today' | 'earlier' | 'undated'
  label: string
  rows: WorkRow[]
}

const timeOf = (value: string | undefined): number => {
  if (!value) return Number.NaN
  const time = new Date(value).getTime()
  return Number.isFinite(time) && time > 0 ? time : Number.NaN
}

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Compact time label for one index row: clock time today, a weekday within the last week, a
 *  calendar date beyond it. An unrecorded or unparseable time yields '' — nothing is invented. */
export function workTimeLabel(value: string | undefined, now: number, locale: Locale = 'zh-CN'): string {
  const time = timeOf(value)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  const current = new Date(now)
  const sameDay = date.getFullYear() === current.getFullYear()
    && date.getMonth() === current.getMonth()
    && date.getDate() === current.getDate()
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return clock
  const yesterday = new Date(now - 86_400_000)
  const isYesterday = date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()
  if (isYesterday) return locale === 'en-US' ? 'Yesterday' : '昨天'
  if (now - time < 7 * 86_400_000) return locale === 'en-US' ? WEEKDAYS_EN[date.getDay()] : WEEKDAYS_ZH[date.getDay()]
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 「今天 / 更早」grouping for the recent order. Other orders return one unlabelled section so
 *  the list never implies a chronology a sort did not produce. Never mutates the input. */
export function groupWorkRows(rows: readonly WorkRow[], now: number, locale: Locale = 'zh-CN'): WorkIndexSection[] {
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const today: WorkRow[] = []
  const earlier: WorkRow[] = []
  const undated: WorkRow[] = []
  for (const row of rows) {
    const time = timeOf(row.updatedAt)
    if (!Number.isFinite(time)) { undated.push(row); continue }
    if (time >= dayStart.getTime()) today.push(row)
    else earlier.push(row)
  }
  const sections: WorkIndexSection[] = []
  if (today.length > 0) sections.push({ key: 'today', label: locale === 'en-US' ? 'Today' : '今天', rows: today })
  if (earlier.length > 0) sections.push({ key: 'earlier', label: locale === 'en-US' ? 'Earlier' : '更早', rows: earlier })
  if (undated.length > 0) sections.push({ key: 'undated', label: '', rows: undated })
  return sections
}

/** The preview-selection rule (plan §2): a still-visible selection wins, otherwise the visible
 *  priority work, otherwise the first visible row; an empty result selects nothing. Waiting or
 *  failed loads never reach this rule — the caller keeps the previous selection until a result
 *  lands, because an error is not an empty result. */
export function pickPreviewWorkId(
  rows: readonly Pick<WorkRow, 'workId'>[],
  selectedId: string | null,
  priorityWorkId: string | null,
): string | null {
  if (selectedId && rows.some((row) => row.workId === selectedId)) return selectedId
  if (priorityWorkId && rows.some((row) => row.workId === priorityWorkId)) return priorityWorkId
  return rows[0]?.workId ?? null
}

/** Display state of one index row: the Work's latest known run wins, then the archive marker,
 *  then the honest "no run recorded". Tone follows the run's recorded state, never a guess. */
export function workRowState(
  row: Pick<WorkRow, 'state'>,
  latestRun: { snapshot?: { state?: string } } | undefined,
  locale: Locale = 'zh-CN',
): { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' } {
  if (latestRun) return { label: runStateText(latestRun.snapshot?.state, locale), tone: runTone(latestRun.snapshot?.state) }
  if (row.state === 'ARCHIVED') return { label: t('home.archived', locale), tone: 'muted' }
  return { label: t('home.noRun', locale), tone: 'muted' }
}
