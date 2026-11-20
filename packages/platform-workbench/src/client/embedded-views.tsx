/** Embedded conversation View navigation.
 *
 *  The upstream Conversation renders its View tabs (对话 / 轨迹) inside the native session
 *  header, which only the `main.conversation` page owns. An embedded occurrence
 *  (`conversation.content` with `variant: 'embedded'`) therefore loses the way back: a tool-call
 *  「查看」 action opens the Trajectory View in the shared Conversation store, but the tab strip
 *  that would switch back is not mounted here.
 *
 *  This module supplies that navigation for the embedded occurrence through declared surfaces
 *  only: the `conversation.content` factory's `views` local slot (replacing the default
 *  passthrough), and the `conversation.session` owner prop `view` (the documented pin for the
 *  elected View). It never reaches into the Conversation store or another plugin's DOM. The
 *  persisted View preference is only *observed* — the store mirrors it to localStorage under its
 *  documented `dsh.conversation` key — so an upstream selection made elsewhere (the 「查看」
 *  action) is followed instead of fought.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { getPreferences } from './i18n.js'

/** Persisted Conversation-store identity (`ConversationStoreState`), suffixed by Session id. */
export const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** The fixed Chat View id; the shell falls back to it when no View is preferred. */
export const CHAT_VIEW_ID = 'chat'

export interface EmbeddedViewTab {
  id: string
  label: string
}

const VIEW_LABELS: Readonly<Record<string, Readonly<{ 'zh-CN': string; 'en-US': string }>>> = {
  chat: { 'zh-CN': '对话', 'en-US': 'Chat' },
  trajectory: { 'zh-CN': '轨迹', 'en-US': 'Trajectory' },
}

/** Resolve the tab roster (registration order preserved, duplicates dropped) with known labels.
 *  Unknown View ids stay visible under their id so a newly installed View is still reachable. */
export function embeddedViewTabs(
  ids: readonly string[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): EmbeddedViewTab[] {
  const seen = new Set<string>()
  const tabs: EmbeddedViewTab[] = []
  for (const id of ids) {
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    tabs.push({ id, label: VIEW_LABELS[id]?.[locale] ?? id })
  }
  return tabs
}

/** Read the persisted Conversation View preference for one Session, or undefined when absent.
 *  Observation only: the caller never writes this key, so the live store stays authoritative. */
export function persistedConversationView(
  sessionId: string,
  storage?: Pick<Storage, 'getItem'> | null,
): string | undefined {
  const target = storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
  if (target === null) return undefined
  try {
    const raw = target.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('view' in parsed)) return undefined
    const view = (parsed as { view?: unknown }).view
    return typeof view === 'string' && view !== '' ? view : undefined
  } catch {
    return undefined
  }
}

/** Initial election: Chat when registered, otherwise the first registered View. */
export function initialEmbeddedView(tabs: readonly EmbeddedViewTab[]): string | undefined {
  if (tabs.some((tab) => tab.id === CHAT_VIEW_ID)) return CHAT_VIEW_ID
  return tabs[0]?.id
}

const NO_TABS: readonly EmbeddedViewTab[] = Object.freeze([])

interface EmbeddedViewsContextValue {
  readonly selected: string | undefined
}

const EmbeddedViewsContext = createContext<EmbeddedViewsContextValue>({ selected: undefined })

/** Provide the host-owned election to the embedded Views occurrence. */
export function EmbeddedViewsProvider(props: { selected: string | undefined; children: ReactNode }) {
  return (
    <EmbeddedViewsContext.Provider value={{ selected: props.selected }}>
      {props.children}
    </EmbeddedViewsContext.Provider>
  )
}

interface EmbeddedConversationViewsProps {
  renderSlot?: (key: 'conversation.session', owner: { view?: string }) => ReactNode
}

/**
 * The `conversation.content` local `views` occurrence for the embedded host: renders the elected
 * View through the declared owner prop. Without a host provider it is a strict passthrough, so the
 * occurrence behaves exactly like the shipped default in any other composition.
 */
export function EmbeddedConversationViews(rawProps: unknown) {
  const { renderSlot } = rawProps as EmbeddedConversationViewsProps
  const { selected } = useContext(EmbeddedViewsContext)
  if (renderSlot === undefined) return null
  return <>{renderSlot('conversation.session', selected === undefined ? {} : { view: selected })}</>
}

/** Host-owned View election for one embedded Session: initial Chat, upstream changes followed,
 *  and an explicit tab click as the way back. */
export function useEmbeddedViewElection(
  sessionId: string | undefined,
  viewIds: readonly string[],
): {
  tabs: readonly EmbeddedViewTab[]
  selected: string | undefined
  select: (id: string) => void
} {
  const locale = getPreferences().locale
  const tabs = embeddedViewTabs(viewIds, locale)
  const signature = tabs.map((tab) => tab.id).join('\u0000')
  const [selected, setSelected] = useState<string | undefined>(() => initialEmbeddedView(tabs))

  // A different Session starts from the same deterministic election.
  const electionFor = (ids: readonly string[]): string | undefined =>
    initialEmbeddedView(embeddedViewTabs(ids, getPreferences().locale))
  useEffect(() => {
    setSelected(electionFor(signature === '' ? [] : signature.split('\u0000')))
  }, [sessionId, signature])

  // Follow View selections made elsewhere (the tool-call 「查看」 action selects Trajectory in the
  // shared store). Only a *change* is adopted: a stale preference that merely disagrees with the
  // employee's explicit tab click must not drag the embedded area back.
  const lastPersisted = useRef<string | undefined>(undefined)
  useEffect(() => {
    lastPersisted.current = sessionId === undefined ? undefined : persistedConversationView(sessionId)
    if (sessionId === undefined) return undefined
    const timer = setInterval(() => {
      const next = persistedConversationView(sessionId)
      if (next === lastPersisted.current) return
      lastPersisted.current = next
      if (next !== undefined && signature.split('\u0000').includes(next)) setSelected(next)
    }, 400)
    return () => { clearInterval(timer) }
  }, [sessionId, signature])

  const select = (id: string): void => { setSelected(id) }
  return { tabs: tabs.length === 0 ? NO_TABS : tabs, selected, select }
}