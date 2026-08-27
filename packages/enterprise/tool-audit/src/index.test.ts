import { describe, expect, it } from 'vitest'
import { apply, name } from './index.js'

describe('tool audit', () => {
  it('exports a plugin entry', () => {
    expect(apply).toBeTypeOf('function')
    expect(name).toBe('enterprise-tool-audit')
  })
})
