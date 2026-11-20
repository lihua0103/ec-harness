/** Browser half of the enterprise workbench plugin (T02/T06/T12/T13).
 *
 *  The whole enterprise shell is one plugin-owned keyed `main` page (`emerald-platform`): its own
 *  left navigation, main content and right context rail, so the main column is the platform page
 *  rather than a set of global panel icons. The plugin selects that page at boot and collapses the
 *  native sidebar when this browser has not recorded that choice.
 *
 *  The native conversation capability is embedded in that page (T13, single-page form): the page
 *  declares a `workbench.session` child slot with `scope: 'session-maybe'`, and the session entry
 *  hosts the upstream `conversation.content` factory with `variant: 'embedded'`. Opening a Work
 *  retains the bound Session under this plugin's own reference source and hands the reference to
 *  the standard-kit `SessionProvider` — the explicit-scoping pattern of the upstream right
 *  Sidebar's session views. The scope binds to that exact reference, so the native main view (the
 *  workspace navigation's own retention) is never contended with or observed. There is no page
 *  switch, no second chat, no iframe and no copied session state. Streaming, tools, queue, stop,
 *  questions and refresh recovery stay on the native conversation stack. The native `sidebar`
 *  container remains upstream-owned; this plugin only fills declared slots.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { EMERALD_BRAND_NAME, EmeraldBrandMark, EmeraldPanelIcon } from './components.js'
import { WORKBENCH_CSS } from './styles.js'
import { EmbeddedSessionHost, WorkbenchPage, type SubmissionWatchOptions } from './WorkbenchPage.js'
import { SubmissionWatcher, type SubmissionIo } from './submission-observer.js'
import { WorkbenchApi } from '../api.js'

/** Required services: slot registry, layout panel selection, the Client Session object layer
 *  (independent view retention plus durable composer submissions), and the native Workspace
 *  registry used to admit a Work's directory before its Session is created. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces']

/** The single plugin-owned main page; `conversation` stays upstream-owned. */
export const PLATFORM_PANEL_ID = 'emerald-platform'

// The embedded-session child of the platform page. Declared here so the registration below
// typechecks against the slot map; the entry component itself is WorkbenchPage's session host.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The platform page's embedded native-session area; follows the retained main view. */
    'workbench.session': { kind: 'single'; scope: 'session-maybe' }
  }
}

/**
 * Install the single enterprise page (with its embedded conversation host), the sidebar entry and
 * the brand marks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // Boot flash guard: this plugin owns the first screen, but the shell paints its previous main
  // view (an open conversation) for a beat before the platform panel is selected — the chat
  // "flashed away" on every refresh. The document stays unlit until the platform page is actually
  // active (or a failsafe fires, so a broken boot still renders). An inline style, not a CSS rule:
  // page styles are contractually scoped under `.ec-wb`, and this transient unlit beat follows the
  // same save/restore inline-style pattern as the native-sidebar hiding below.
  document.documentElement.style.visibility = 'hidden'
  const bootGuardFailsafe = setTimeout(() => {
    document.documentElement.style.visibility = ''
  }, 2500)

  // Page styles are scoped under `.ec-wb` and removed with this effect, so disabling the plugin
  // leaves no styling behind.
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@ec-clinical/platform-workbench'
    tag.textContent = WORKBENCH_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'platform-workbench: page styles')

  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, EmeraldBrandMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, EMERALD_BRAND_NAME))

  const api = new WorkbenchApi('/platform-workbench')
  const io = (options: SubmissionWatchOptions): SubmissionIo => ({
    list: async () => (await api.workSubmissions(options.workId)).items,
    record: async (input) => (await api.recordSubmission({
      workId: options.workId,
      domainId: options.domainId,
      sessionId: options.sessionId,
      requestId: input.requestId,
      input: { text: input.text },
    })) as never,
    acknowledge: (submissionId, admission) => api.acknowledgeSubmission(submissionId, admission),
    consume: (submissionId) => api.consumeSubmission(submissionId),
  })
  const watcher = new SubmissionWatcher(
    ctx,
    io,
    (message) => { console.error(`[platform-workbench] submission observer: ${message}`) },
  )
  ctx.effect(() => () => watcher.stopAll(), 'platform-workbench: submission observers')

  // The embedded conversation view is scoped to this plugin's own retained reference (the same
  // explicit pattern as the upstream right Sidebar's session views): the reference is the
  // SessionProvider target, released when the page leaves the session view or the plugin unloads.
  // It never touches the native main view election, which belongs to the workspace navigation.
  let viewReference: SessionReference | undefined
  const retainSession = (sessionId: string): SessionReference => {
    const reference = ctx.sessions.retain(sessionId as never, { source: 'platformWorkbench' })
    void reference.ready.catch((error: unknown) => {
      console.error(`[platform-workbench] embedded session ${sessionId} open failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    const previous = viewReference
    viewReference = reference
    previous?.release()
    return reference
  }
  const releaseSession = (): void => {
    const reference = viewReference
    viewReference = undefined
    reference?.release()
  }
  ctx.effect(() => () => releaseSession(), 'platform-workbench: embedded session view reference')

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PLATFORM_PANEL_ID,
    children: { 'workbench.session': { kind: 'single', scope: 'session-maybe' } },
    inject: () => ({
      retainSession,
      releaseSession,
      /// Start enterprise correlation for this Work's bound Session. It observes the public
      /// durable event window only; the native composer is never intercepted.
      watchWorkSession: (work: SubmissionWatchOptions) => {
        console.info(`[platform-workbench] watch requested for ${work.workId}/${work.sessionId}`)
        watcher.watch(work)
      },
      submissionObserverCount: () => watcher.size,
      /// Create a real native Session for a Work that has none, inside the Work's own directory.
      /// The directory is admitted as a native Workspace first (Host create is idempotent), so the
      /// embedded conversation opens ready to type instead of asking which folder to use.
      createSession: async (options: { cwd?: string }) => {
        let workspaceId: string | undefined
        if (options.cwd) {
          const workspaces = ctx.get('workspaces') as {
            create(input: { path: string }): Promise<{ workspaceId: string }>
          }
          workspaceId = (await workspaces.create({ path: options.cwd })).workspaceId
        }
        return String(await ctx.sessions.create(workspaceId ? { workspaceId: workspaceId as never } : {}))
      },
      /// The Host session catalog for the 历史会话 page (the same list the upstream sidebar
      /// reads). The snapshot object is the observable source itself — getSnapshot/subscribe —
      /// so the page subscribes with useSyncExternalStore and stays live across list mutations.
      sessionList: ctx.sessions.list,
      refreshSessionList: () => ctx.sessions.refresh(),
    }),
  }, WorkbenchPage))

  // The embedded-session entry: hosts the upstream conversation factory (embedded variant) and
  // resolves the retained main view through the renderer's root session-maybe scope — no
  // host-side SessionProvider. Its inject face publishes the registered conversation View roster
  // (a hooks source) so the embedded area can offer the View tabs the native session header hosts.
  // A hooks source is a uSES store: getSnapshot must return the SAME reference until the roster
  // really changes, or every render re-subscribes and React aborts with "Maximum update depth".
  let cachedViewIds: readonly string[] = Object.freeze([])
  const computeViewIds = (): readonly string[] => ctx.slots.entries('conversation.view')
    .map((entry) => ({
      id: typeof entry.options.id === 'string' ? entry.options.id : '',
      order: typeof entry.options.order === 'number' ? entry.options.order : 0,
    }))
    .filter((view) => view.id !== '')
    .sort((left, right) => left.order - right.order)
    .map((view) => view.id)
  const conversationViewIds = {
    getSnapshot: (): readonly string[] => {
      const next = computeViewIds()
      const unchanged = next.length === cachedViewIds.length
        && next.every((id, index) => id === cachedViewIds[index])
      if (!unchanged) cachedViewIds = Object.freeze(next)
      return cachedViewIds
    },
    subscribe: (listener: () => void): (() => void) =>
      ctx.slots.subscribe('conversation.view', listener),
  }
  ctx.slots.inject('workbench.session', () => ctx.slots.register({
    name: 'workbench.session',
    inject: () => ({ hooks: { conversationViewIds } }),
  }, EmbeddedSessionHost))

  // One collapsed-sidebar entry so the platform page is still reachable from the native rail.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PLATFORM_PANEL_ID,
    order: 0,
    label: () => '企业平台',
  }, EmeraldPanelIcon))

  // First screen is the enterprise platform page. The native `sidebar` is an upstream-owned grid
  // column, not a declared slot; while the platform page is the active main panel we hide that
  // column and zero its grid track so the platform page occupies the whole column, then restore the
  // exact inline styles when another main panel (or plugin teardown) takes over. This is a
  // guarded, reversible layout mode — never a restyle of other pages — and falls back to the
  // icon rail when the shell's structure is not the expected one.
  interface NativeSidebarParts { column: HTMLElement; frame: HTMLElement }
  interface SavedSidebar extends NativeSidebarParts { columnDisplay: string; frameGrid: string }
  let savedSidebar: SavedSidebar | undefined
  const nativeSidebarParts = (): NativeSidebarParts | undefined => {
    const toggle = document.querySelector('button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]')
    if (!toggle) return undefined
    // toggle → logo row → sidebar root → display:contents wrapper → sidebar column → frame
    const root = toggle.parentElement?.parentElement
    const column = root?.parentElement?.parentElement
    const frame = column?.parentElement
    if (!root || !column || !frame) return undefined
    if (getComputedStyle(frame).display !== 'grid') return undefined
    return { column: column as HTMLElement, frame: frame as HTMLElement }
  }
  const hideNativeSidebar = (): void => {
    try {
      const parts = nativeSidebarParts()
      if (!parts) return
      if (!savedSidebar) {
        savedSidebar = {
          ...parts,
          columnDisplay: parts.column.style.display,
          frameGrid: parts.frame.style.gridTemplateColumns,
        }
      }
      const tracks = getComputedStyle(parts.frame).gridTemplateColumns.split(' ').filter(Boolean)
      if (tracks.length >= 2) {
        parts.frame.style.gridTemplateColumns = ['0px', 'minmax(0, 1fr)', ...tracks.slice(2)].join(' ')
      }
      parts.column.style.display = 'none'
    } catch {
      // The shell may not have rendered yet or its layout changed; the icon rail is the fallback.
    }
  }
  const restoreNativeSidebar = (): void => {
    if (!savedSidebar) return
    try {
      savedSidebar.column.style.display = savedSidebar.columnDisplay
      savedSidebar.frame.style.gridTemplateColumns = savedSidebar.frameGrid
    } catch {
      // The element was replaced by a shell re-render; nothing to restore.
    }
    savedSidebar = undefined
  }
  const selectPlatform = (): void => {
    try { ctx.layout.selectPanel(PLATFORM_PANEL_ID as never) } catch { /* main not published yet */ }
    setTimeout(hideNativeSidebar, 180)
  }
  const syncSidebarForPanel = (): void => {
    try {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === PLATFORM_PANEL_ID) {
        // The platform page is rendering: the boot guard has done its job.
        clearTimeout(bootGuardFailsafe)
        document.documentElement.style.visibility = ''
        setTimeout(hideNativeSidebar, 120)
      } else restoreNativeSidebar()
    } catch { /* layout unavailable */ }
  }
  ctx.effect(() => {
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      try {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === null) selectPlatform()
        else syncSidebarForPanel()
      } catch { /* retry briefly while the main registry publishes */ }
      if (attempts >= 8) clearInterval(timer)
    }, 180)
    return () => {
      clearInterval(timer); restoreNativeSidebar()
      clearTimeout(bootGuardFailsafe)
      document.documentElement.style.visibility = ''
    }
  }, 'platform-workbench: enterprise platform default')
  ctx.effect(() => {
    const dispose = ctx.layout.panelInfo.subscribe(syncSidebarForPanel)
    return () => { dispose(); restoreNativeSidebar() }
  }, 'platform-workbench: platform page hides the native sidebar column')
}
