import { describe, it, expect } from 'vitest'
import * as entry from './index.js'

describe('enterprise-ui-settings entry', () => {
  it('should export name and inject', () => {
    expect('default' in entry).toBe(false)
    expect(entry.name).toBe('enterprise-ui-settings')
    expect(entry.inject).toEqual(['webServer'])
    expect(entry.apply).toBeTypeOf('function')
  })
})
