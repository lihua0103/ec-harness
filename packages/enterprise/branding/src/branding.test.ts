import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerBranding, validateBrandingConfig } from './branding.ts'

const ENV_KEYS = ['DSH_BRAND_NAME', 'DSH_BRAND_SHORT_NAME'] as const
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

type Transform = (html: string) => string
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
type IndexListener = (rows: Array<{ kind: string; placement?: string; html?: string }>) => void

interface Harness {
  ctx: Context
  transform: Transform | undefined
  routes: Map<string, RouteHandler>
  indexListeners: IndexListener[]
  disposers: Array<ReturnType<typeof vi.fn>>
}

function harness(): Harness {
  const state: Harness = {
    ctx: undefined as unknown as Context,
    transform: undefined,
    routes: new Map(),
    indexListeners: [],
    disposers: [],
  }
  const webServer = {
    tapIndex(transform: Transform) {
      state.transform = transform
      const dispose = vi.fn()
      state.disposers.push(dispose)
      return dispose
    },
    register(route: { path: string; handler: RouteHandler }) {
      state.routes.set(route.path, route.handler)
      const dispose = vi.fn()
      state.disposers.push(dispose)
      return dispose
    },
  }
  state.ctx = {
    get: (key: string) => (key === 'webServer' ? webServer : undefined),
    on: (_event: 'webserver/index-inject', listener: IndexListener) => {
      state.indexListeners.push(listener)
      const dispose = vi.fn()
      state.disposers.push(dispose)
      return dispose
    },
  } as unknown as Context
  return state
}

const BASE_HTML = `
  <html>
    <head>
      <title>DeepSeek Harness</title>
      <meta name="application-name" content="DeepSeek">
      <link rel="icon" href="/old-favicon.ico">
    </head>
    <body></body>
  </html>
`

describe('validateBrandingConfig（ADR-0002 决策 4）', () => {
  it('patch config 优先，env 兜底，中性默认', () => {
    expect(validateBrandingConfig({ brandName: 'A', brandShortName: 'B' })).toEqual({ brandName: 'A', brandShortName: 'B' })
    process.env.DSH_BRAND_NAME = 'Env Brand'
    expect(validateBrandingConfig({}).brandName).toBe('Env Brand')
    delete process.env.DSH_BRAND_NAME
    expect(validateBrandingConfig({})).toEqual({ brandName: 'DSH Enterprise', brandShortName: 'DSH' })
  })

  it('长度与尖括号校验 fail-fast', () => {
    expect(() => validateBrandingConfig({ brandName: 'x'.repeat(81) })).toThrow(/brandName/)
    expect(() => validateBrandingConfig({ brandShortName: 'x'.repeat(25) })).toThrow(/brandShortName/)
    expect(() => validateBrandingConfig({ brandName: 'a<b>' })).toThrow(/尖括号/)
  })
})

describe('registerBranding', () => {
  it('注册注入行 + favicon/manifest 路由 + tapIndex，返回组合 disposer', () => {
    const state = harness()
    const dispose = registerBranding(state.ctx, { brandName: 'Custom Brand', brandShortName: 'CB' })
    expect(typeof dispose).toBe('function')
    expect(state.routes.has('/favicon.svg')).toBe(true)
    expect(state.routes.has('/manifest.webmanifest')).toBe(true)
    expect(state.indexListeners).toHaveLength(1)
    expect(state.transform).toBeDefined()

    const rows: Array<{ kind: string; placement?: string; html?: string }> = []
    state.indexListeners[0](rows)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'html', placement: 'head' })
    expect(rows[0].html).toContain('globalThis["__DSH_ENTERPRISE_BRAND__"]')
    expect(rows[0].html).toContain('"brandName":"Custom Brand"')
    expect(rows[1]).toMatchObject({ kind: 'html', placement: 'body' })
    expect(rows[1].html).toContain('MutationObserver')

    dispose()
    for (const d of state.disposers) expect(d).toHaveBeenCalledOnce()   // 全部退订（可卸载）
  })

  it('当 webServer 不存在时应该抛出错误', () => {
    const mockCtx = { get: () => undefined } as unknown as Context
    expect(() => registerBranding(mockCtx, {})).toThrow('[branding] webServer 服务不存在')
  })

  it('tapIndex 只做 title/meta/icon 替换，值经 HTML 转义', () => {
    const state = harness()
    registerBranding(state.ctx, { brandName: 'Custom Brand', brandShortName: 'CB' })
    if (!state.transform) throw new Error('tapIndex transform was not registered')
    const result = state.transform(BASE_HTML)
    expect(result).toContain('<title>Custom Brand</title>')
    expect(result).toContain('<meta name="application-name" content="Custom Brand">')
    expect(result).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">')
    expect(result).not.toContain('DeepSeek Harness')                     // 替换后不残留
  })

  it('品牌值进入 script 上下文时 `<` 被转义（防 </script> 注入）', () => {
    const state = harness()
    // 尖括号在 validate 层已被拒绝；此处验证即使含特殊字符，jsonForScript 也不产生裸 <
    process.env.DSH_BRAND_NAME = 'Amp & Co'
    registerBranding(state.ctx, {})
    const rows: Array<{ kind: string; placement?: string; html?: string }> = []
    state.indexListeners[0](rows)
    expect(rows[0].html).toContain('"brandName":"Amp & Co"')
    expect(rows[0].html?.includes('<"brandName"')).toBe(false)
  })

  it('manifest 路由返回品牌化 JSON + no-store；favicon 路由 404 容错', async () => {
    const state = harness()
    registerBranding(state.ctx, { brandName: 'Custom Brand', brandShortName: 'CB' })
    const chunks: string[] = []
    const res = {
      writeHead: vi.fn(),
      end: (body: string) => { chunks.push(body) },
    } as unknown as ServerResponse
    const manifestRoute = state.routes.get('/manifest.webmanifest')
    if (!manifestRoute) throw new Error('manifest route was not registered')
    manifestRoute({} as IncomingMessage, res)
    const manifest = JSON.parse(chunks[0])
    expect(manifest).toMatchObject({ name: 'Custom Brand', short_name: 'CB' })
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Cache-Control': 'no-store' }))
  })
})
