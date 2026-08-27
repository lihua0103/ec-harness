import { describe, it, expect } from 'vitest'
import { DataSecurityService } from '../src/data-security-service.ts'

describe('DataSecurityService', () => {
  it('should export DataSecurityService class', () => {
    expect(DataSecurityService).toBeTypeOf('function')
  })

  it('should have correct inject dependencies', () => {
    expect(DataSecurityService.inject).toEqual(['webServer'])
  })
})
