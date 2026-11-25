/** Unified todo rows shared by the 待我处理 page and the work brief (E3-4, 方案 B).
 *
 *  Each row names its source kind and its own resolution verb — the list never blurs a review
 *  decision or a receipt into "a question to answer". A row is actionable only when the platform
 *  recorded both the Work and the Run it belongs to; anything else stays an honest, disabled row.
 */
import type { WorkbenchBootstrap, WorkbenchItem } from '../api.js'
import { formatDateTime, getPreferences } from './i18n.js'

export type TodoItem = NonNullable<WorkbenchBootstrap['todos']>[number]

/** Display name of a recorded instant with the user's locale/zone; unrecorded says so. */
function formatTime(value: unknown): string {
  const preferences = getPreferences()
  return formatDateTime(value, preferences, preferences.locale === 'en-US' ? 'Time not recorded' : '时间未记录')
}

export const TODO_KINDS: Record<'question' | 'review' | 'delivery-receipt' | 'model-approval', { label: string; verb: string }> = {
  question: { label: '问题答复', verb: '回答' },
  review: { label: '交付复核', verb: '决定' },
  'delivery-receipt': { label: '交付接收', verb: '确认接收' },
  'model-approval': { label: '模型审批', verb: '去审批' },
}

export function UnifiedTodoList({ items, works, titles, onOpen }: {
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
