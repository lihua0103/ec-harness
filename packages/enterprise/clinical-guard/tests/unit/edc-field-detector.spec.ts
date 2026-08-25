import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { EdcFieldDetector } from '../../lib/core/edc-field-detector.js'

describe('EdcFieldDetector - EDC 字段识别器', () => {
  let ctx: Context
  let detector: EdcFieldDetector

  beforeEach(() => {
    ctx = new Context()
    detector = new EdcFieldDetector(ctx, ['Medidata', 'Oracle', 'Veeva'])
  })

  describe('EDC 系统检测', () => {
    it('应该识别 Medidata 系统', async () => {
      const medidataData = {
        STUDYID: 'ABC123',
        SUBJID: '001',
        SITEID: '001',
        DATAPAGE: 'DM',
      }
      
      const result = await detector.recognize(medidataData)
      
      expect(result.detected).toBe(true)
      expect(result.system).toBe('Medidata')
    })

    it('应该识别 Oracle 系统', async () => {
      const oracleData = {
        PROTOCOL: 'XYZ789',
        PATIENT_ID: '001',
        SITE_NUM: '101',
      }
      
      const result = await detector.recognize(oracleData)
      
      expect(result.detected).toBe(true)
      expect(result.system).toBe('Oracle')
    })

    it('应该识别 Veeva 系统', async () => {
      const veevaData = {
        study__v: 'STU001',
        subject__v: 'SUB001',
        site__v: 'SITE001',
      }
      
      const result = await detector.recognize(veevaData)
      
      expect(result.detected).toBe(true)
      expect(result.system).toBe('Veeva')
    })

    it('无法识别的系统应该返回 Unknown', async () => {
      const unknownData = {
        random_field: 'value',
        another_field: 123,
      }
      
      const result = await detector.recognize(unknownData)
      
      expect(result.detected).toBe(false)
      expect(result.system).toBe('Unknown')
    })
  })

  describe('字段识别', () => {
    it('应该识别 Medidata 常见字段', async () => {
      const data = {
        STUDYID: 'ABC123',
        SITEID: '001',
        SUBJID: '001',
        VISIT: 'BASELINE',
        VISITDT: '2024-01-01',
      }
      
      const result = await detector.recognize(data)
      
      expect(result.fields.length).toBeGreaterThan(0)
      expect(result.fields.some(f => f.name === 'STUDYID')).toBe(true)
      expect(result.fields.some(f => f.name === 'SUBJID')).toBe(true)
    })
  })

  describe('系统支持', () => {
    it('应该支持配置的 EDC 系统', () => {
      expect(detector.isSupported('Medidata')).toBe(true)
      expect(detector.isSupported('Oracle')).toBe(true)
      expect(detector.isSupported('Veeva')).toBe(true)
    })

    it('不应该支持未配置的系统', () => {
      expect(detector.isSupported('Unknown')).toBe(false)
    })
  })
})
