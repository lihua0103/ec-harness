/** 单侧栏架构（2026-11-21 设计）：一份插件自有的轻量路由状态连接 `sidebar` 与 `main:emerald-platform`
 *  两个 slot。侧栏是导航的唯一承载（品牌、全局创建、主导航、设置）；主区只渲染页面标题、主体、
 *  会话与右栏工作上下文。共享状态只有当前页、活动 Work/Session 坐标与创建动作——工作台不存储
 *  消息或会话副本，业务数据仍以控制面 API 为唯一来源。
 *
 *  发布/订阅遵循 useSyncExternalStore 合同：快照引用在真正变化前保持不变，否则每次渲染都会重订阅。
 */
import type { WorkbenchView } from './view-state.js'

/** 主区当前视图形态：键控页、某 Work 的原生会话、历史会话或只读详情。 */
export type ActiveViewKind = 'page' | 'work' | 'history' | 'detail'

export interface WorkbenchRouteSnapshot {
  /** 当前键控页（侧栏导航高亮依据）。 */
  readonly page: WorkbenchView
  /** 主区当前视图形态；`work`/`history`/`detail` 时不按 page 高亮。 */
  readonly viewKind: ActiveViewKind
  /** 活动 Work/Session 的展示坐标（诊断与标题；侧栏不呈现业务正文）。 */
  readonly activeWorkId: string | null
  readonly activeTitle: string | null
  /** 待我处理数量（侧栏徽标）。 */
  readonly pendingCount: number
  /** 主区与控制面的连接状态（侧栏如实显示，不猜测）。 */
  readonly connected: boolean
}

export type WorkbenchRouteCommand =
  | { kind: 'navigate'; page: WorkbenchView }
  | { kind: 'create'; appKey?: string }
  | { kind: 'open-work'; workId: string }

export const INITIAL_ROUTE_SNAPSHOT: WorkbenchRouteSnapshot = {
  page: 'works',
  viewKind: 'page',
  activeWorkId: null,
  activeTitle: null,
  pendingCount: 0,
  connected: false,
}

type RouteListener = () => void
type RouteHandler = (command: WorkbenchRouteCommand) => void

export interface WorkbenchRouteStore {
  getSnapshot(): WorkbenchRouteSnapshot
  subscribe(listener: RouteListener): () => void
  /** 主区在挂载时发布状态；侧栏据此渲染。无变化时不通知。 */
  publish(patch: Partial<WorkbenchRouteSnapshot>): void
  /** 侧栏派发导航意图；主区未挂载时命令被丢弃（首屏仍由默认页选择保证）。 */
  dispatch(command: WorkbenchRouteCommand): void
  /** 主区注册命令执行者；卸载时清除。 */
  setHandler(handler: RouteHandler | null): void
}

export function createRouteStore(): WorkbenchRouteStore {
  let snapshot: WorkbenchRouteSnapshot = INITIAL_ROUTE_SNAPSHOT
  const listeners = new Set<RouteListener>()
  let handler: RouteHandler | null = null
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish(patch) {
      let changed = false
      for (const key of Object.keys(patch) as Array<keyof WorkbenchRouteSnapshot>) {
        if (snapshot[key] !== patch[key]) { changed = true; break }
      }
      if (!changed) return
      snapshot = { ...snapshot, ...patch }
      for (const listener of [...listeners]) listener()
    },
    dispatch(command) {
      handler?.(command)
    },
    setHandler(next) {
      handler = next
    },
  }
}
