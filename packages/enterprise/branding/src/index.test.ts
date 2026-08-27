import { describe, expect, it } from 'vitest'
import * as entry from './index.ts'

const { apply: plugin } = entry

describe('branding plugin entry', () => {
  it('keeps inject through the loader-visible namespace shape', () => {
    expect('default' in entry).toBe(false)
    expect(entry.name).toBe('enterprise-branding')
    expect(entry.inject).toEqual(['webServer'])
    expect(plugin).toBeTypeOf('function')
  })
})
