/** 平台向会话内扩展公开的一个事实：工作台正在展示的会话属于哪个应用（2026-11-24）。
 *
 *  工作的会话由平台创建并绑定，应用只记在控制面的工作与绑定里——原生会话本身和挂在会话里的
 *  扩展此前都无从得知。插件客户端经标准工具包的 `useConversationApplication` 读取它，自行决定
 *  自己的会话入口是否适用于当前应用：会话绑定到别的应用时自行隐藏；`null` 表示当前不是"某项
 *  工作的会话"（历史会话、首页等），入口照常显示。平台不认识任何插件，插件也不依赖平台的数据
 *  来源——两边只共享这个只读快照。
 *
 *  快照遵循 useSyncExternalStore 合同：值不变时引用不变，否则每次渲染都会重订阅。 */

export interface ConversationApplication {
  readonly appId: string
  readonly appVersion: string
  /** 平台发布目录里的显示名；目录未带显示名时回落到 appId。 */
  readonly displayName: string
}

export interface ObservableConversationApplication {
  getSnapshot(): ConversationApplication | null
  subscribe(listener: () => void): () => void
}

export interface ConversationApplicationSource {
  /** 注册进 slots.provideRoot 的裸快照源（getSnapshot + subscribe），不是 React 钩子。 */
  readonly observable: ObservableConversationApplication
  /** 发布当前会话所属应用；与现值相同时既不换引用也不通知。 */
  publish(next: ConversationApplication | null): void
}

const sameApplication = (
  left: ConversationApplication | null,
  right: ConversationApplication | null,
): boolean => left === right || (left !== null && right !== null
  && left.appId === right.appId && left.appVersion === right.appVersion && left.displayName === right.displayName)

export function createConversationApplicationSource(): ConversationApplicationSource {
  let snapshot: ConversationApplication | null = null
  const listeners = new Set<() => void>()
  return {
    observable: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    publish(next) {
      if (sameApplication(snapshot, next)) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}
