import { describe, expect, it, vi } from 'vitest'
import { apply, name } from './index.ts'
import type { ToolGuard } from './dataset-guard.ts'

describe('enterprise-tool-audit plugin entry', () => {
  it('导出插件名并经 ctx.effect 注册 monotonic guard', () => {
    const guards: ToolGuard[] = []
    const effect = vi.fn((register: () => () => void) => register())
    const ctx = {
      effect,
      tools: { guard(guard: ToolGuard) { guards.push(guard); return () => undefined } },
      logger: { info: vi.fn() },
    }
    apply(ctx as never)
    expect(name).toBe('enterprise-tool-audit')
    expect(effect).toHaveBeenCalledOnce()
    expect(guards).toHaveLength(1)
    expect(guards[0]({ name: 'read', arguments: { path: 'doc/spec.txt' } })).toBeUndefined()
  })
})
