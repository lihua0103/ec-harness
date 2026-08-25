import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ClinicalGuardService, DEFAULT_CONFIG, EgressType, ListingTemplateType } from '../../lib/service.js'

describe('ClinicalGuardService - 临床数据守护服务', () => {
  let ctx: Context
  let service: ClinicalGuardService

  beforeEach(() => {
    ctx = new Context()
    service = new ClinicalGuardService(ctx, DEFAULT_CONFIG)
  })

  afterEach(async () => {
    await ctx.dispose()
  })

  describe('服务初始化', () => {
    it('应该正确初始化', () => {
      expect(service).toBeDefined()
      expect(service.config).toEqual(DEFAULT_CONFIG)
    })

    it('应该启用所有默认功能', () => {
      const status = service.getStatus()
      
      expect(status.egressSwitch.enabled).toBe(true)
      expect(status.headerDetector.enabled).toBe(true)
      expect(status.edcFieldDetector.enabled).toBe(true)
      expect(status.listingTemplateManager.enabled).toBe(true)
    })
  })

  describe('数据出域检查', () => {
    it('应该能检查 SAS 数据集出域', async () => {
      const result = await service.checkEgress(
        EgressType.SAS_DATASET,
        { test: 'data' }
      )
      
      expect(result).toHaveProperty('allowed')
      expect(result).toHaveProperty('timestamp')
      expect(result.egressType).toBe(EgressType.SAS_DATASET)
    })

    it('应该能检查 Spec 数据出域', async () => {
      const result = await service.checkEgress(
        EgressType.SPEC_DATA,
        { test: 'spec' }
      )
      
      expect(result).toHaveProperty('allowed')
      expect(result.egressType).toBe(EgressType.SPEC_DATA)
    })

    it('关闭开关后应该直接放行', async () => {
      const disabledConfig = {
        ...DEFAULT_CONFIG,
        dataEgressControl: {
          ...DEFAULT_CONFIG.dataEgressControl,
          enabled: false,
        },
      }
      
      const disabledService = new ClinicalGuardService(ctx, disabledConfig)
      const result = await disabledService.checkEgress(
        EgressType.SAS_DATASET,
        { test: 'data' }
      )
      
      expect(result.allowed).toBe(true)
    })
  })

  describe('Listing 模板', () => {
    it('应该能列出所有模板', () => {
      const templates = service.listListingTemplates()
      
      expect(Array.isArray(templates)).toBe(true)
      expect(templates.length).toBeGreaterThan(0)
    })

    it('应该能获取特定模板', () => {
      const template = service.getListingTemplate(ListingTemplateType.DEMOGRAPHICS)
      
      expect(template).toBeDefined()
      expect(template?.type).toBe(ListingTemplateType.DEMOGRAPHICS)
      expect(template?.columns).toContain('SUBJID')
    })

    it('应该能应用模板到数据', () => {
      const testData = [
        { SUBJID: '001', AGE: 30, SEX: 'M', OTHER: 'xxx' },
        { SUBJID: '002', AGE: 25, SEX: 'F', OTHER: 'yyy' },
      ]
      
      const result = service.applyListingTemplate(
        testData,
        ListingTemplateType.DEMOGRAPHICS
      )
      
      expect(result).toHaveProperty('data')
      expect(result).toHaveProperty('style')
      expect(result).toHaveProperty('metadata')
      expect(result.data.length).toBe(2)
      expect(result.data[0]).not.toHaveProperty('OTHER')
    })
  })

  describe('EDC 字段识别', () => {
    it('应该能识别 EDC 字段', async () => {
      const testData = {
        STUDYID: 'ABC123',
        SUBJID: '001',
        VISITDT: '2024-01-01',
      }
      
      const result = await service.recognizeEdcFields(testData)
      
      expect(result).toHaveProperty('detected')
      expect(result).toHaveProperty('system')
      expect(result).toHaveProperty('fields')
    })
  })

  describe('服务状态', () => {
    it('应该返回完整的服务状态', () => {
      const status = service.getStatus()
      
      expect(status).toHaveProperty('egressSwitch')
      expect(status).toHaveProperty('headerDetector')
      expect(status).toHaveProperty('edcFieldDetector')
      expect(status).toHaveProperty('listingTemplateManager')
    })

    it('应该返回正确的开关状态', () => {
      const switchStatus = service.getEgressSwitchStatus()
      
      expect(switchStatus.enabled).toBe(true)
      expect(switchStatus.sasDatasetEgress.enabled).toBe(true)
      expect(switchStatus.specDataEgress.enabled).toBe(true)
    })
  })
})
