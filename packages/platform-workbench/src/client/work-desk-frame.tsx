/** Desk shell pieces: the temporary panel used by the collapsed 工作索引 (and shared slot for
 *  the work-materials panel) (方案 B/B2).
 *
 *  The panel is an absolute overlay INSIDE the desk root — `position: fixed` stays reserved for
 *  the command palette backdrop (T09 contract). It follows the page's own modal pattern (the
 *  E4-6 command palette): named dialog, focus moves to the panel on open, Escape closes from
 *  anywhere, Tab cycles inside the panel and focus returns to the trigger on close. The index
 *  column and the console rail share ONE `data-desk-panel` slot, so a phone never shows two
 *  temporary panels at once (plan §5).
 */
import { useEffect, useRef, useState } from 'react'

export interface DeskPanelProps {
  open: boolean
  onClose(): void
  /** Accessible name of the dialog. */
  label: string
  children: React.ReactNode
}

const PANEL_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export function DeskPanel({ open, onClose, label, children }: DeskPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return undefined
    const panel = panelRef.current
    // E4-4 focus management: the panel takes focus when it opens and hands it back to the
    // trigger when it closes; Escape closes from anywhere (focus lands one tick later, so a
    // quick Escape would otherwise fall on the body and strand the keyboard).
    const previous = document.activeElement as HTMLElement | null
    const timer = setTimeout(() => {
      const first = panel?.querySelector<HTMLElement>(PANEL_FOCUSABLE)
      ;(first ?? panel)?.focus()
    }, 0)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(PANEL_FOCUSABLE)]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <>
      <div className="ec-wb-desk-panel-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className="ec-wb-desk-panel"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </>
  )
}

export interface DeskToolsMenuProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Named actions (plan §2: 刷新/紧凑/专家诊断 keep named entries, never deleted). */
  actions: Array<{ id: string; label: string; checked?: boolean; onSelect(): void }>
}

/** 顶栏右侧有名称的工具菜单（方案 B §2）：宽度充足时与基准图一致只显全局搜索，
 *  刷新/紧凑/专家诊断收进菜单而不是删除。Escape/点击外部关闭，焦点还给触发按钮。 */
export function DeskToolsMenu({ open, onOpenChange, actions }: DeskToolsMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return undefined
    const previous = document.activeElement as HTMLElement | null
    const timer = setTimeout(() => menuRef.current?.focus(), 0)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onOpenChange(false) }
    }
    const onClick = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onOpenChange(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
      previous?.focus?.()
    }
  }, [open, onOpenChange])

  return (
    <div className="ec-wb-desk-tools">
      <button
        type="button"
        className="ec-wb-desk-tools-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多工具"
        title="更多工具"
        onClick={() => onOpenChange(!open)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open
        ? (
          <div ref={menuRef} className="ec-wb-desk-tools-menu" role="menu" aria-label="更多工具" tabIndex={-1}>
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={action.checked ?? undefined}
                className="ec-wb-desk-tools-item"
                onClick={() => { action.onSelect(); onOpenChange(false) }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )
        : null}
    </div>
  )
}

