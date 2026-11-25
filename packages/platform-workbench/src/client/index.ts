/** Browser half of the enterprise workbench plugin (T02/T06/T12/T13; 单侧栏架构 2026-11-21).
 *
 *  The whole enterprise shell is one plugin-owned keyed `main` page (`emerald-platform`): its own
 *  main content, embedded conversation and right context rail. The enterprise navigation OWNS the
 *  left column: this bundle registers the root `sidebar` slot occupant (priority -1, shadowing the
 *  default `ui-sidebar` where it is not disabled) plus the `shell.leading` drawer opener, and the
 *  employee Web profile disables `ui-sidebar` outright (`employee-web.patch.yml`) so exactly one
 *  navigation exists. A plugin-owned lightweight route store connects the two slots — the sidebar
 *  dispatches navigation intents, the page executes them and publishes its coordinate back.
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
 *  column geometry, drawer mask and collapse state stay upstream-owned (ui-layout); this plugin
 *  renders the occupant content and handles its keyboard focus.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { WORKBENCH_CSS } from './styles.js'
import { EmbeddedSessionHost, WorkbenchPage, type SubmissionWatchOptions } from './WorkbenchPage.js'
import { createConversationApplicationSource, type ConversationApplication } from './conversation-application.js'
import { SubmissionWatcher, type SubmissionIo } from './submission-observer.js'
import { WorkbenchApi } from '../api.js'
import { createRouteStore } from './route-store.js'
import { SidebarLeadingOpener, SidebarNav } from './sidebar-nav.js'

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
  interface GlobalStandardProps {
    /** The application of the Work-bound conversation the workbench is showing; null when the
     *  conversation on screen is not a Work's (history session, works home). Every slot component
     *  may read it — a domain plugin hides its conversation entry when the conversation belongs to
     *  another application. Optional because the member exists only where this bundle is loaded;
     *  consumers merge the very same optional member (a merged member must keep one type).
     *  Source and contract: `conversation-application.ts`. */
    useConversationApplication?: SnapshotSelectorHook<ConversationApplication | null>
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

  // 单侧栏架构：一份插件自有的轻量路由状态连接 `sidebar` 与 `main` 两个 slot。侧栏是导航的
  // 唯一承载（品牌、全局创建、主导航、设置）；主区只渲染页面标题、主体、会话与右栏工作上下文。
  const workbenchRoute = createRouteStore()

  // The enterprise `sidebar` occupant. Registered at priority -1 so mounting this bundle can
  // never collide with ui-sidebar's priority-0 occupant: in profiles that keep the default
  // sidebar, the enterprise nav shadows it outright (lowest renders); in the employee profile
  // the canonical overlay (`employee-web.patch.yml`) disables ui-sidebar and this registration
  // becomes the single occupant. ui-sidebar's child seats (brand/panellist) disappear with it —
  // the enterprise nav owns those surfaces now.
  ctx.slots.inject('sidebar', () => ctx.slots.register(
    {
      name: 'sidebar',
      priority: -1,
      inject: () => ({
        route: workbenchRoute,
        toggleSidebar: () => ctx.layout.toggleSidebar(),
      }),
    },
    SidebarNav,
  ))
  // Drawer-open control in the frame's window-chrome seat. The host mounts this seat only while
  // a drawer is possible (or a fully hidden macOS sidebar), so it always renders the opener.
  // priority -1: ui-sidebar's HeaderLeadingControls occupies this seat at the default priority —
  // without the employee overlay both would collide at priority 0 and the composition throws.
  // The enterprise opener shadows it, exactly like the sidebar occupant above.
  ctx.slots.inject('shell.leading', () => ctx.slots.register(
    {
      name: 'shell.leading',
      priority: -1,
      inject: () => ({ toggleSidebar: () => ctx.layout.toggleSidebar() }),
    },
    SidebarLeadingOpener,
  ))

  const api = new WorkbenchApi('/platform-workbench')
  // 平台事实（2026-11-24）：工作台正在展示的会话所属应用，经 slots 的根标准工具包公开给会话内的
  // 全部组件（`useConversationApplication`）。域插件据此自行决定会话入口是否适用，平台不认识任何
  // 插件；disposer 归本插件 fiber 所有，插件卸载即撤下。
  const conversationApplication = createConversationApplicationSource()
  ctx.slots.provideRoot({ hooks: { conversationApplication: conversationApplication.observable } })
  // Refresh/deep-link restore (方案 B/A07): the page's boot restore opens a Work through the WP3
  // navigation gate, and the host's selectPanel below ABORTS any pending navigation signal. The
  // two race at boot, so the panel selection is published to the page as a promise: the restore
  // waits for it and can no longer be superseded by the enterprise first-screen selection.
  let resolvePlatformSelected!: () => void
  const platformSelected = new Promise<void>((resolve) => { resolvePlatformSelected = resolve })
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
  const releaseSession = (reference?: SessionReference): void => {
    // WP3 precise ownership: a reference argument releases only when it is STILL the active view
    // reference — an expired navigation can free what it retained without touching the reference
    // a newer navigation has already installed.
    if (reference !== undefined && reference !== viewReference) return
    const target = reference ?? viewReference
    viewReference = undefined
    target?.release()
  }
  ctx.effect(() => () => releaseSession(), 'platform-workbench: embedded session view reference')

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PLATFORM_PANEL_ID,
    children: { 'workbench.session': { kind: 'single', scope: 'session-maybe' } },
    inject: () => ({
      retainSession,
      releaseSession,
      /// WP3: the locked host's navigation gate. Each call supersedes the previous pending
      /// navigation (upstream contract: a later call, a panel selection, or disposal aborts the
      /// earlier signal); the page composes it with its own epoch counter for page-internal races.
      beginNavigation: () => ctx.layout.beginNavigation(),
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
      /// 单侧栏架构：主区向共享路由状态发布当前坐标，并执行侧栏派发的导航命令。
      route: workbenchRoute,
      /// Resolves once the enterprise first-screen panel selection has settled (or the retry
      /// budget ran out); the page's boot restore waits on it before opening a Work.
      platformSelected,
      /// Publish the application of the Work whose conversation is on screen (null when none).
      publishConversationApplication: (application: ConversationApplication | null): void => {
        conversationApplication.publish(application)
      },
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

  // First screen is the enterprise platform page, through the locked shell's PUBLIC layout API
  // only (WP6/单侧栏架构): the enterprise `sidebar` occupant above owns the left column and this
  // registration selects the workbench main panel, so the first screen is the enterprise home —
  // the default `ui-sidebar` never presents its own navigation as the first screen.
  const selectPlatform = (): void => {
    try { ctx.layout.selectPanel(PLATFORM_PANEL_ID as never) } catch { /* main not published yet */ }
  }
  ctx.effect(() => {
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      try {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === null) selectPlatform()
        else { clearInterval(timer); resolvePlatformSelected() }
      } catch { /* retry briefly while the main registry publishes */ }
      if (attempts >= 8) { clearInterval(timer); resolvePlatformSelected() }
    }, 180)
    return () => { clearInterval(timer); resolvePlatformSelected() }
  }, 'platform-workbench: enterprise platform default')
  ctx.effect(() => {
    const dispose = ctx.layout.panelInfo.subscribe(() => {
      // A main panel is active — the shell has rendered and the boot flash guard has done its job.
      clearTimeout(bootGuardFailsafe)
      document.documentElement.style.visibility = ''
    })
    return () => {
      dispose()
      clearTimeout(bootGuardFailsafe)
      document.documentElement.style.visibility = ''
    }
  }, 'platform-workbench: boot flash guard release on first panel selection')
}
