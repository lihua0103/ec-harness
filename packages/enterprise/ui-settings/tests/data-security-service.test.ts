import { describe, it, expect } from 'vitest'
import { App } from '@deepseek-ai/cordis'
import { DataSecurityService } from '../src/data-security-service.ts'

describe('DataSecurityService', () => {
  it('should default to enabled', async () => {
    const app = new App()
    const mockWebServer = { register: () => {} }
    app.provide('webServer', mockWebServer)
    app.plugin(DataSecurityService)
    await app.start()
    
    expect(app.dataSecurityService.isEnabled()).toBe(true)
    
    await app.stop()
  })

  it('should toggle enabled state', async () => {
    const app = new App()
    const mockWebServer = { register: () => {} }
    app.provide('webServer', mockWebServer)
    app.plugin(DataSecurityService)
    await app.start()
    
    await app.dataSecurityService.setEnabled(false)
    expect(app.dataSecurityService.isEnabled()).toBe(false)
    
    await app.dataSecurityService.setEnabled(true)
    expect(app.dataSecurityService.isEnabled()).toBe(true)
    
    await app.stop()
  })

  it('should emit event when enabled state changes', async () => {
    const app = new App()
    const mockWebServer = { register: () => {} }
    app.provide('webServer', mockWebServer)
    app.plugin(DataSecurityService)
    await app.start()
    
    let eventFired = false
    app.on('data-security/changed', (enabled) => {
      eventFired = true
      expect(enabled).toBe(false)
    })
    
    await app.dataSecurityService.setEnabled(false)
    expect(eventFired).toBe(true)
    
    await app.stop()
  })

  it('should return protected patterns', async () => {
    const app = new App()
    const mockWebServer = { register: () => {} }
    app.provide('webServer', mockWebServer)
    app.plugin(DataSecurityService)
    await app.start()
    
    const patterns = app.dataSecurityService.getProtectedPatterns()
    expect(patterns).toContain('**/*.sas7bdat')
    expect(patterns).toContain('**/*.xpt')
    expect(patterns).toContain('**/data/**/*.xlsx')
    
    await app.stop()
  })
})
