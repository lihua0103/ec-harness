/**
 * 企业设置客户端 bundle 的 wire 契约与行为测试。
 *
 * client.js 是浏览器端 CJS 工厂，这里在 Node 里以桩替身驱动：预置
 * window.__ModuleLoader__ 后动态导入一次，捕获注册；每个用例再以假
 * require 物化 exports，验证槽位注册、字典注册与开关数据面的 fetch 契约。
 */
import { describe, expect, it, vi } from 'vitest'

interface Registration {
  id: string
  factory: (req: (spec: string) => unknown) => Record<string, unknown>
}

interface Controller {
  load: () => Promise<{ enabled: boolean, policy: string }>
  save: (enabled: boolean) => Promise<{ enabled: boolean, policy: string }>
}

const registrations: Registration[] = []
;(globalThis as { window?: unknown }).window = {
  __ModuleLoader__: {
    load: (candidate: Registration) => { registrations.push(candidate) },
  },
}

// 顶层导入一次：client.js 的模块体只执行一次（ESM 缓存），注册发生在导入期。
const registration = await import('./client.js').then(() => {
  const [first] = registrations
  expect(first).toBeDefined()
  if (first === undefined) throw new Error('client bundle did not register')
  return first
})

/** 物化一次客户端工厂：返回 exports 与假 React 收到的 require 面。 */
function materialize(): Record<string, unknown> {
  const reactStub = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) =>
      ({ type, props: { ...(props as Record<string, unknown>), children } }),
    useState: (init: unknown) => [init, () => undefined],
    useEffect: () => undefined,
    useCallback: (fn: unknown) => fn,
  }
  return registration.factory((spec) => {
    if (spec === 'react') return reactStub
    throw new Error(`client bundle requested unexpected module: ${spec}`)
  })
}

function asController(value: unknown): Controller {
  return value as Controller
}

/** fetch 桩的 ok 响应体。 */
function okResponse(body: unknown, ok = true): { ok: boolean, status: number, json: () => Promise<unknown> } {
  return { ok, status: ok ? 200 : 403, json: async () => body }
}

describe('client bundle wire 契约', () => {
  it('以宿主组合里的 entry 名注册（@dsh-enterprise/ui-settings）', () => {
    expect(registration.id).toBe('@dsh-enterprise/ui-settings')
    const mod = materialize()
    expect(typeof mod.apply).toBe('function')
    expect(mod.inject).toEqual(['slots', 'locale'])
  })

  it('require 面只允许模块表基线词（react）', () => {
    expect(() => registration.factory(() => ({}))).not.toThrow()
  })
})

describe('apply 的槽位与字典注册', () => {
  it('注册 zh/en 字典并把行挂进 settings.general.item 槽位', () => {
    const mod = materialize()
    const registerDict = vi.fn(() => () => undefined)
    let injectedKey = ''
    let registered: { options: Record<string, unknown>, component: unknown } | undefined
    const ctx = {
      logger: undefined,
      effect: (fn: () => (() => void) | void) => {
        const dispose = fn()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      locale: { register: registerDict },
      slots: {
        inject: (key: string, cb: () => () => void) => {
          injectedKey = key
          cb()
          return () => undefined
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registered = { options, component }
          return () => undefined
        },
      },
    }

    ;(mod.apply as (c: unknown) => void)(ctx)

    expect(injectedKey).toBe('settings.general.item')
    expect(registered?.options).toMatchObject({
      name: 'settings.general.item',
      id: 'enterprise-data-security',
      order: 100,
      locale: mod.LOCALE_NAMESPACE,
    })
    expect(typeof registered?.component).toBe('function')

    expect(registerDict).toHaveBeenCalledTimes(1)
    const dictCall = registerDict.mock.calls[0]
    expect(dictCall).toBeDefined()
    const [ns, dicts] = dictCall as unknown as [string, Record<string, Record<string, string>>]
    expect(ns).toBe(mod.LOCALE_NAMESPACE)
    for (const locale of ['zh', 'en']) {
      expect(Object.keys(dicts[locale] ?? {}).toSorted()).toEqual(['desc', 'loadFailed', 'saveFailed', 'title'])
      for (const value of Object.values(dicts[locale] ?? {})) expect(value).not.toBe('')
    }

    // 真实渲染一次行组件（props 合成契约：locale 声明只给 t seat），
    // 防"渲染期 ReferenceError 被槽位边界吸收"这类回归。
    const component = registered?.component as (props: { t: (key: string) => string }) => unknown
    const element = component({ t: (key) => `t:${key}` }) as { props: Record<string, unknown> }
    expect(element).toBeDefined()
    const switchChild = (element.props.children as unknown[]).at(-1) as { props: Record<string, unknown> }
    expect(switchChild.props.role).toBe('switch')
    expect(switchChild.props['aria-checked']).toBe('true')
  })
})

describe('开关数据面 fetch 契约', () => {
  it('load：校验 policy 与 enabled 形状', async () => {
    const mod = materialize()
    const controller = asController((mod.createDataSecurityController as (f?: unknown) => unknown)(
      (input: unknown) => {
        expect(input).toBe('/api/settings/data-security')
        return Promise.resolve(okResponse({ enabled: false, policy: 'two-value-interception' }))
      },
    ))
    await expect(controller.load()).resolves.toEqual({ enabled: false, policy: 'two-value-interception' })

    const badPolicy = asController((mod.createDataSecurityController as (f?: unknown) => unknown)(
      () => Promise.resolve(okResponse({ enabled: true, policy: 'something-else' })),
    ))
    await expect(badPolicy.load()).rejects.toThrow('unexpected data security policy')

    const httpError = asController((mod.createDataSecurityController as (f?: unknown) => unknown)(
      () => Promise.resolve(okResponse({}, false)),
    ))
    await expect(httpError.load()).rejects.toThrow('HTTP 403')
  })

  it('save：POST + 防 CSRF 头 + boolean body，失败抛错', async () => {
    const mod = materialize()
    const initCapture: Array<RequestInit & { headers: Record<string, string> }> = []
    const controller = asController((mod.createDataSecurityController as (f?: unknown) => unknown)(
      (_input: unknown, init: RequestInit) => {
        initCapture.push(init as RequestInit & { headers: Record<string, string> })
        return Promise.resolve(okResponse({ enabled: true, policy: 'two-value-interception' }))
      },
    ))

    await expect(controller.save(true)).resolves.toEqual({ enabled: true, policy: 'two-value-interception' })

    expect(initCapture).toHaveLength(1)
    const sent = initCapture[0]
    expect(sent?.method).toBe('POST')
    expect(sent?.headers['x-dsh-settings']).toBe('1')
    expect(JSON.parse(String(sent?.body))).toEqual({ enabled: true })

    const httpError = asController((mod.createDataSecurityController as (f?: unknown) => unknown)(
      () => Promise.resolve(okResponse({ error: 'Forbidden' }, false)),
    ))
    await expect(httpError.save(false)).rejects.toThrow('HTTP 403')
  })
})
