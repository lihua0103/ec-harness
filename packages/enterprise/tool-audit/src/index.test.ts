import { describe, expect, it, vi } from 'vitest'
import { apply, name } from './index.ts'

interface Listener {
  (exec: { name: string; arguments: unknown }, next: () => Promise<unknown>): Promise<unknown>
}

describe('enterprise-tool-audit plugin entry', () => {
  it('导出插件名并经 ctx.effect 注册 pre-execute 护栏（可卸载）', () => {
    const listeners: Listener[] = []
    const dispose = vi.fn()
    const effect = vi.fn((register: () => () => void) => register())
    const ctx = {
      effect,
      on: (_event: 'tools/pre-execute', listener: Listener) => { listeners.push(listener); return dispose },
      logger: { info: vi.fn() },
    }
    apply(ctx as never)
    expect(name).toBe('enterprise-tool-audit')
    expect(effect).toHaveBeenCalledOnce()
    expect(listeners).toHaveLength(1)
    expect(dispose).not.toHaveBeenCalled()
  })
})
