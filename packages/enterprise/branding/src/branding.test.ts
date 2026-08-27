import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerBranding, type BrandingConfig } from './branding.ts'

const ENV_KEYS = ['DSH_BRAND_NAME', 'DSH_BRAND_SHORT_NAME'] as const
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('registerBranding', () => {
  it('应该注册品牌配置并返回清理函数', () => {
    const mockCtx = {
      get: (key: string) => {
        if (key === 'webServer') {
          return {
            on: () => {},
            off: () => {},
          }
        }
        return undefined
      },
    } as unknown as Context

    const config: BrandingConfig = {
      brandName: 'Test Brand',
      brandShortName: 'TB',
    }

    const dispose = registerBranding(mockCtx, config)
    expect(typeof dispose).toBe('function')
  })

  it('当 webServer 不存在时应该抛出错误', () => {
    const mockCtx = {
      get: () => undefined,
    } as unknown as Context

    expect(() => registerBranding(mockCtx, {})).toThrow('[branding] webServer 服务不存在')
  })

  it('应该使用默认品牌名称', () => {
    let capturedHandler: ((html: string) => string) | null = null
    
    const mockCtx = {
      get: (key: string) => {
        if (key === 'webServer') {
          return {
            on: (_event: string, handler: (html: string) => string) => {
              capturedHandler = handler
            },
            off: () => {},
          }
        }
        return undefined
      },
    } as unknown as Context

    registerBranding(mockCtx, {})
    
    expect(capturedHandler).not.toBeNull()
    
    const testHtml = '<html><head><title>Old Title</title></head><body></body></html>'
    const result = capturedHandler!(testHtml)
    
    expect(result).toContain('<title>DSH Enterprise</title>')
    expect(result).toContain('globalThis["__DSH_ENTERPRISE_BRAND__"]')
  })

  it('应该替换所有品牌相关的HTML元素', () => {
    let capturedHandler: ((html: string) => string) | null = null
    
    const mockCtx = {
      get: (key: string) => {
        if (key === 'webServer') {
          return {
            on: (_event: string, handler: (html: string) => string) => {
              capturedHandler = handler
            },
            off: () => {},
          }
        }
        return undefined
      },
    } as unknown as Context

    const config: BrandingConfig = {
      brandName: 'Custom Brand',
      brandShortName: 'CB',
    }

    registerBranding(mockCtx, config)
    
    const testHtml = `
      <html>
        <head>
          <title>DeepSeek Harness</title>
          <meta name="application-name" content="DeepSeek">
          <link rel="icon" href="/old-favicon.ico">
        </head>
        <body></body>
      </html>
    `
    
    const result = capturedHandler!(testHtml)
    
    expect(result).toContain('<title>Custom Brand</title>')
    expect(result).toContain('<meta name="application-name" content="Custom Brand">')
    expect(result).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">')
    expect(result).toContain('"brandName":"Custom Brand"')
    expect(result).toContain('"brandShortName":"CB"')
  })
})