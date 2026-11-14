# 嵌入式会话宿主探针（2026-11-13）

方向修订的实证记录：企业工作台不再采用 ADR-0003 的「平台页 ↔ 原生会话页」两页切换，而是**将原生 chat 会话能力以 `variant:'embedded'` 嵌入自研工作台整页**。本文件记录探针（最小验证件）的目的、方法、结论与可复刻的接入配方。

## 结论（全部实测通过，vitest 2/2）

1. **外部插件可以做 presentation host。** 自研插件的 keyed `main` 整页内直接调用 `renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero })`，原生会话体（session 外壳 + scroll body + composer 座）在宿主子树内渲染。
2. **当前主会话自动解析。** 渲染器根部 `createSlotRenderer()` 已把整棵树包进 `<ScopeProvider scope="session-maybe">`，它订阅 ui-session 适配器的 `current`（当前主会话绑定源）。宿主页面**无需自己安装会话 Provider**——会话绑定经 React context 流入工厂。
3. **会话选择由 `mainView` 保留驱动。** `sessions.retain(sessionId, { source: 'mainView' })` → `uiSession.publishMain()`（订阅 sessions.list）→ `adapter.current` 更新 → 嵌入工厂重渲染到该会话。这正是 ui-workspace `replaceMain()` 的现有机制，工作台页面切换会话 = 调 retain 即可。
4. **embedded 变体天然无主 Header。** 全文档无 `conversation.header` DOM；主面板（ConversationMainPanel）不在树内。宽控位（widthControls）留空不渲染。
5. **外部视图可挂入会话外壳。** 插件注册 `conversation.view` 条目即可出现在嵌入外壳的视图区（激活视图按存储偏好 → `DEFAULT_VIEW_ID='chat'` 选举；探针用 id `'chat'` 的桩视图实证渲染）。
6. **无会话时不崩。** 无 `mainView` 保留时，同一宿主渲染 session-less 姿态（工厂 root 出现、无 session 属性、composer 座仍在）——即工作台首屏落地态。

## 接入配方（重写 WorkbenchPage 时照此实施）

1. 组合必须挂载：ui-session（运行时自带）+ **ui-conversation**（注册 factory 与全部 `conversation.*` 槽）；生产组合还需 **ui-chat**（chat 视图）与 ui-workspace/navigation。
2. 工作台页 = keyed `main` 槽上的一个新 key 条目，页内直接 `renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero })`。
3. `phase` / `hero` 由宿主计算（照抄 ConversationMainPanel 的小段计算）：`session`/`conversation` 任一为 undefined → blank；settling = blank+loading 且非 summary-blank；hero = 无会话或 blank(已开/summary-blank)。探针静态传 `phase:'active', hero:false`（已会话场景）。
4. 页面切换会话：`ctx.sessions.retain(nextId, { source: 'mainView' })`（配合旧引用 release）。
5. 保留 `selectWorkspace` 提升路径：`conversation.hero.workspace` 槽与 composer 的 inert/blocked 姿态由工厂内部处理，宿主不重复实现。
6. 首屏无会话态即「无保留」姿态，天然支持（结论 6）。

## 探针代码（运行后已从上游临时目录删除；重跑前按此复原到 `packages/client/ui-conversation/tests/embedded-host.probe.spec.tsx`）

```tsx
// @vitest-environment jsdom
// TEMPORARY EMBEDDING PROBE — not part of the upstream baseline; delete after the run.
import { Fragment } from 'react'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { describe, expect, it, vi } from 'vitest'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'

usePinnedBrowserLanguages('zh-CN')

const SID = 'session-1' as SessionId

const RootFrame = (props: { renderSlot?: (key: string, owner: object, opts?: object) => unknown }) => (
  <Fragment>{props.renderSlot?.('main', {}, { entryKey: 'workbench-probe' })}</Fragment>
)

function ProbePage(props: { renderSlot?: (key: string, owner: object, opts?: object) => unknown }) {
  return (
    <div data-probe-page="">
      {props.renderSlot?.('workbench.ret', {})}
    </div>
  )
}

function ProbeHost(props: { renderFactorySlot?: (name: string, input: object, opts?: object) => unknown }) {
  return (
    <div data-probe-host="">
      {props.renderFactorySlot?.('conversation.content', { variant: 'embedded', phase: 'active', hero: false })}
    </div>
  )
}

async function bench(options: { retainMainView?: boolean } = {}) {
  // No vitest globals → no Testing Library auto-cleanup.
  document.body.replaceChildren()
  const runtime = await SlotTestRuntime.create()
  const developerTools = createSnapshotStore(true)
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: unknown, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
    }),
    openSession: vi.fn(),
  } as never)
  runtime.ctx.provide('configForms', { developerTools: { enabled: developerTools }, get: () => stubConfigForm().scope } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, RootFrame as never)
  const feature = await runtime.mount({ inject: [...inject], apply })
  runtime.slots.register({
    name: 'main',
    key: 'workbench-probe',
    children: { 'workbench.ret': { kind: 'single', scope: 'session-maybe' } },
  }, ProbePage as never)
  runtime.slots.register({ name: 'workbench.ret' }, ProbeHost as never)
  // Id 'chat' rides the default-view election (DEFAULT_VIEW_ID = 'chat').
  runtime.slots.register({ name: 'conversation.view', id: 'chat', label: 'probe' },
    (() => <div data-probe-view="" />) as never)
  await runtime.sessions.add({ id: SID })
  const reference = options.retainMainView === false ? undefined : runtime.sessions.retain(SID, { source: 'mainView' })
  runtime.renderRoot()
  return { runtime, feature, reference }
}

describe('embedded conversation.content probe (external presentation host)', () => {
  it('renders the embedded Factory inside an external main-keyed page and resolves the current main Session', async () => {
    const { runtime, reference } = await bench()
    expect(document.querySelector('[data-probe-page]'), 'probe page mounted').not.toBeNull()
    const content = document.querySelector('[data-probe-host] [data-conversation-content]')
    expect(content, 'embedded conversation.content rendered inside the external host').not.toBeNull()
    expect(content?.getAttribute('data-conversation-session')).toBe(SID)
    expect(content?.getAttribute('data-content-phase')).toBe('active')
    expect(document.querySelector('[data-probe-host] [data-conversation-scroll]'), 'scroll body rendered').not.toBeNull()
    expect(document.querySelector('[data-probe-host] [data-composer-seat]'), 'composer seat rendered').not.toBeNull()
    expect(document.querySelector('[data-probe-host] [data-probe-view]'), 'external conversation.view rendered in the embedded shell').not.toBeNull()
    expect(document.querySelector('[data-conversation-header-leading]'), 'no main Header anywhere').toBeNull()
    reference?.release()
    await runtime.dispose()
  })

  it('without a mainView retention the external host renders the session-less posture without failing', async () => {
    const { runtime } = await bench({ retainMainView: false })
    const content = document.querySelector('[data-probe-host] [data-conversation-content]')
    expect(content, 'Factory still renders without a Session').not.toBeNull()
    expect(content?.getAttribute('data-conversation-session')).toBeNull()
    expect(document.querySelector('[data-probe-host] [data-probe-view]'), 'no session shell without a Session').toBeNull()
    expect(document.querySelector('[data-probe-host] [data-composer-seat]'), 'composer seat still mounted').not.toBeNull()
    await runtime.dispose()
  })
})
```

## 复跑方式

```bash
# 1) 将上方代码复原为 upstream/deepseek-harness-git/packages/client/ui-conversation/tests/embedded-host.probe.spec.tsx
# 2) 在 upstream 根目录运行
cd upstream/deepseek-harness-git && node_modules/.bin/vitest run packages/client/ui-conversation/tests/embedded-host.probe.spec.tsx
# 3) 运行后删除该临时文件，保持上游基线干净
```

## 机制备注（供后续实现与排障）

- **会话绑定的来源**：`createSlotRenderer()` → `RootStandardProvider` → `<ScopeProvider scope="session-maybe">` → `RootOutlet`。ScopeProvider 订阅 `host.scope('session-maybe').current`；ui-session 适配器 `current` 由 `publishMain()` 维护（选 `retainedBy.mainView > 0` 的会话，粘滞于当前直到失主）。
- **条目级 SessionProvider 的用途**：`standardKit` 只给**声明了非 root children 的条目**注入 `SessionProvider` seat（`scopeAreaProvider(adapter)`），用于宿主以**显式 SessionReference** 圈定子树会话（如 subagent 侧栏聊天）；「跟随当前主会话」不需要它。
- **embedded 变体差异**：工厂 root 加 `css.embeddedBody`；`conversation.hero.frame` 收到 `hero:false`；主 Header 与 width controls 不在工厂职责内（Header 由 ConversationMainPanel 渲染）。
- **本地槽**：`views` 默认实现渲染 `conversation.session` 单槽（→ 激活视图区）；`widthControls` 默认为空。宿主可经 `renderFactorySlot(..., { slots: {...} })` 替换。
- **测试基建注意**：上游 vitest 无 `globals`，Testing Library 不会自动清理 DOM——多用例文件须在每用例开头 `document.body.replaceChildren()`；`using` 声明在 bench 函数内会在返回时立即释放引用，会话保留必须活过 render 与断言。
