/** 单侧栏架构（2026-11-21 设计）：企业导航独占员工界面的左栏。
 *
 *  `sidebar` 是 root 作用域的单占位 slot（[ui-layout 声明](../../../upstream/deepseek-harness-git/packages/client/ui-layout/src/client/index.ts)），
 *  AppFrame 负责列几何并把 owner props（collapsed/width/drawer）传给占位者：桌面展开渲染完整
 *  企业导航，折叠渲染 56px 图标栏（`data-sidebar-toggle` 供折叠焦点归还），窄屏抽屉态以对话框
 *  语义（role=dialog + aria-modal）挂载，Escape/焦点圈由上游 `useModalLayer` 原语承担，关闭后
 *  焦点经模态层还原到 `shell.leading` 的 `data-sidebar-opener` 打开控件。
 *
 *  导航意图全部走共享路由状态（route-store）→ 主区执行；侧栏不持有业务数据，也不决定权限。
 */
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { focusWithoutRing, isBehindModal, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchRouteCommand, WorkbenchRouteStore } from './route-store.js'
import { navLabel, t, usePreferences } from './i18n.js'
import type { WorkbenchView } from './view-state.js'
import { EmeraldBrandMark, PendingIcon, ProjectsIcon, AppsIcon, SettingsIcon, SessionsIcon } from './components.js'

export interface SidebarNavInjected {
  /** 共享路由状态：读侧（useSyncExternalStore）+ 命令派发侧。 */
  route: WorkbenchRouteStore
  /** 宿主公开布局动作：折叠 ⟷ 展开，抽屉打开 ⟷ 关闭（ctx.layout.toggleSidebar）。 */
  toggleSidebar(): void
}

export type SidebarNavProps = PropsRuntime<'sidebar'> & InjectFace<SidebarNavInjected>

/** Nav order follows the reviewed draft: work first, then the spaces and tools around it.
 *  平台设置固定在栏底（设计规格：底部「平台设置」集中承载偏好）。 */
const SIDE_NAV: ReadonlyArray<{ id: WorkbenchView }> = [
  { id: 'works' },
  { id: 'sessions' },
  { id: 'projects' },
  { id: 'apps' },
  { id: 'pending' },
]

/** 方案 B 基准：全局轨默认收起为图标轨。标记记录**期望状态**：'collapsed'（默认/上次收起）或
 *  'expanded'（员工手动展开过，此后不再自动收起）。宿主进程重启恢复展开时，插件按标记再收起。 */
const RAIL_DEFAULT_KEY = 'emerald.workbench.rail-default'

const readRailIntent = (): string => {
  try { return globalThis.localStorage?.getItem(RAIL_DEFAULT_KEY) ?? 'collapsed' } catch { return 'collapsed' }
}

const writeRailIntent = (value: 'collapsed' | 'expanded'): void => {
  try { globalThis.localStorage?.setItem(RAIL_DEFAULT_KEY, value) } catch { /* storage-restricted shell keeps the intent in-memory only */ }
}

const SIDE_ICONS: Record<WorkbenchView, (props: { size: number; active: boolean }) => React.ReactNode> = {
  works: EmeraldBrandMark,
  sessions: SessionsIcon,
  projects: ProjectsIcon,
  apps: AppsIcon,
  pending: PendingIcon,
  settings: SettingsIcon,
}

function SideGlyph({ view, size, active }: { view: WorkbenchView; size: number; active: boolean }) {
  const Icon = SIDE_ICONS[view]
  return <Icon size={size} active={active} />
}

export function SidebarNav({ collapsed, drawer, toggleSidebar, route }: SidebarNavProps) {
  const { locale } = usePreferences()
  const snapshot = useSyncExternalStore(route.subscribe, route.getSnapshot)
  const rootRef = useRef<HTMLDivElement>(null)
  const focusOwner = useRef<Element | null>(null)
  // 方案 B 基准图（03/04）：全局轨是深靛图标轨。宿主默认展开；员工手动展开后（标记
  // 'expanded'）不再自动收起——保留宿主的原生折叠几何与开关，这里只对齐默认形态。
  useEffect(() => {
    if (collapsed) return
    if (readRailIntent() === 'expanded') return
    writeRailIntent('collapsed')
    toggleSidebar()
  }, [collapsed, toggleSidebar])
  // 手动开关写入期望状态：员工展开后重启也不再自动收起。
  const collapseRail = () => { writeRailIntent('collapsed'); toggleSidebar() }
  const expandRail = () => { writeRailIntent('expanded'); toggleSidebar() }
  // Drawer-open state renders a modal dialog: the upstream primitive owns Escape, the Tab ring
  // and focus restore to the invoker (the shell.leading opener) on close.
  const dialogOpen = drawer && !collapsed
  useModalLayer(rootRef, dialogOpen, () => toggleSidebar())
  // Collapse focus return (rail): when the collapsing column held focus, move it to the rail's
  // expand toggle. The drawer path is covered by useModalLayer's restore.
  const wasCollapsed = useRef(collapsed)
  useLayoutEffect(() => {
    if (collapsed === wasCollapsed.current) return
    wasCollapsed.current = collapsed
    if (!collapsed) return
    const controlled = focusOwner.current?.getAttribute('aria-controls')?.split(/\s+/) ?? []
    const ownsMenuFocus = controlled.some((id) => rootRef.current?.ownerDocument.getElementById(id)?.contains(document.activeElement))
    if (focusOwner.current !== document.activeElement && !ownsMenuFocus) return
    const opener = drawer
      ? rootRef.current?.ownerDocument.querySelector<HTMLElement>('[data-sidebar-opener]')
      : rootRef.current?.querySelector<HTMLElement>('[data-sidebar-toggle]')
    if (opener != null && !isBehindModal(opener)) focusWithoutRing(opener, { preventScroll: true })
  }, [drawer, collapsed])

  // A closed drawer keeps no content: the host marks the column inert and the shell.leading
  // opener is the only way back in.
  if (drawer && collapsed) return null

  const pageActive = (view: WorkbenchView): boolean =>
    snapshot.viewKind === 'page' && snapshot.page === view
  const dispatch = (command: WorkbenchRouteCommand) => route.dispatch(command)
  const icon = (view: WorkbenchView, size: number): React.ReactNode => (
    <SideGlyph view={view} size={size} active={pageActive(view)} />
  )

  if (collapsed) {
    // 图标轨：logo 即展开开关；每项只有图标，名称由 aria-label 与 title 提供——宿主的折叠列只有
    // 56px，放不下可翻译的文字（2026-11-24 修复：标签与连接状态曾被裁切）。「待我处理」带数量徽标
    // （收起是默认形态，徽标不能只在展开态出现）；连接状态是一个带可访问名称的点。
    // 创建入口在索引标题旁的 ＋（与基准图一致），轨道不再重复加号。
    const pending = snapshot.pendingCount
    const railLabel = (view: WorkbenchView): string =>
      view === 'pending' && pending > 0 ? t('side.pendingBadge', locale).replace('{count}', String(pending)) : navLabel(view, locale)
    const connection = snapshot.connected ? t('desk.connected', locale) : t('home.connDown', locale)
    return (
      <div ref={rootRef} className="ec-wb ec-wb-side ec-wb-side-rail">
        <button
          type="button"
          data-sidebar-toggle
          className="ec-wb-side-rail-toggle"
          aria-label={t('side.expand', locale)}
          aria-expanded={false}
          onClick={expandRail}
        >
          <EmeraldBrandMark size={22} />
        </button>
        {SIDE_NAV.map((item) => (
          <button
            type="button"
            key={item.id}
            className="ec-wb-side-rail-item"
            aria-label={railLabel(item.id)}
            title={navLabel(item.id, locale)}
            aria-current={pageActive(item.id) ? 'page' : undefined}
            onClick={() => dispatch({ kind: 'navigate', page: item.id })}
          >
            {icon(item.id, 20)}
            {item.id === 'pending' && pending > 0
              ? <span className="ec-wb-side-rail-badge" aria-hidden="true">{pending}</span>
              : null}
          </button>
        ))}
        <span className="ec-wb-side-rail-spring" aria-hidden="true" />
        <button
          type="button"
          className="ec-wb-side-rail-item"
          aria-label={navLabel('settings', locale)}
          title={navLabel('settings', locale)}
          aria-current={pageActive('settings') ? 'page' : undefined}
          onClick={() => dispatch({ kind: 'navigate', page: 'settings' })}
        >
          {icon('settings', 20)}
        </button>
        <span
          className={`ec-wb-side-rail-conn${snapshot.connected ? '' : ' is-down'}`}
          role="status"
          aria-label={connection}
          title={connection}
        >
          <span className="ec-wb-side-rail-conn-dot" aria-hidden="true" />
        </span>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="ec-wb ec-wb-side"
      role={dialogOpen ? 'dialog' : undefined}
      aria-modal={dialogOpen || undefined}
      aria-label={dialogOpen ? t('side.drawerLabel', locale) : undefined}
      data-shortcut-modal={drawer ? 'sidebar' : undefined}
      tabIndex={dialogOpen ? -1 : undefined}
      onFocusCapture={(event) => { focusOwner.current = event.target }}
    >
      <div className="ec-wb-side-brand">
        <EmeraldBrandMark size={22} />
        <span className="ec-wb-side-wordmark">EMERALD</span>
        <button
          type="button"
          data-sidebar-toggle
          data-modal-autofocus={dialogOpen || undefined}
          className="ec-wb-side-toggle"
          aria-label={t('side.collapse', locale)}
          aria-expanded={!collapsed}
          onClick={collapseRail}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <line x1="9" y1="4" x2="9" y2="20" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      {/* 「新建工作」是唯一全局主按钮；预选应用/项目由主区按来源页填充。 */}
      <button type="button" className="ec-wb-side-new" onClick={() => dispatch({ kind: 'create' })}>
        <span className="ec-wb-side-new-plus" aria-hidden="true">＋</span>
        {t('home.newLabel', locale)}
      </button>
      <nav className="ec-wb-side-items" aria-label={t('home.navLandmark', locale)}>
        {SIDE_NAV.map((item) => (
          <button
            type="button"
            key={item.id}
            className="ec-wb-side-item"
            aria-current={pageActive(item.id) ? 'page' : undefined}
            onClick={() => dispatch({ kind: 'navigate', page: item.id })}
          >
            <span className="ec-wb-side-glyph" aria-hidden="true">{icon(item.id, 16)}</span>
            <span className="ec-wb-side-label">{navLabel(item.id, locale)}</span>
            {item.id === 'pending'
              ? <span className="ec-wb-side-count" data-alert={snapshot.pendingCount > 0}>{snapshot.pendingCount}</span>
              : null}
          </button>
        ))}
      </nav>
      <div className="ec-wb-side-foot">
        <button
          type="button"
          className="ec-wb-side-item ec-wb-side-settings"
          aria-current={pageActive('settings') ? 'page' : undefined}
          onClick={() => dispatch({ kind: 'navigate', page: 'settings' })}
        >
          <span className="ec-wb-side-glyph" aria-hidden="true">{icon('settings', 16)}</span>
          <span className="ec-wb-side-label">{navLabel('settings', locale)}</span>
          {!snapshot.connected ? <span className="ec-wb-side-conn" role="status">{t('home.connDown', locale)}</span> : null}
        </button>
      </div>
    </div>
  )
}

/** `shell.leading` 占位者：窗口左上的抽屉打开控件。宿主只在抽屉态（或 macOS 折叠态）挂载本
 *  seat，因此这里始终渲染打开按钮；`data-sidebar-opener` 是折叠焦点归还的查找锚点。 */
export interface SidebarLeadingInjected {
  toggleSidebar(): void
}
export type SidebarLeadingProps = PropsRuntime<'shell.leading'> & InjectFace<SidebarLeadingInjected>

export function SidebarLeadingOpener({ toggleSidebar }: SidebarLeadingProps) {
  const { locale } = usePreferences()
  return (
    <button
      type="button"
      data-sidebar-opener
      className="ec-wb ec-wb-side-opener"
      aria-label={t('side.expand', locale)}
      onClick={() => { writeRailIntent('expanded'); toggleSidebar() }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <line x1="9" y1="4" x2="9" y2="20" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  )
}
