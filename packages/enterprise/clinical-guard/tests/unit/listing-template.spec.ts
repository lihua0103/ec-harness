import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ListingTemplateManager, ListingTemplateType } from '../../lib/core/listing-template.js'

describe('ListingTemplateManager - Listing 模板管理器', () => {
  let ctx: Context
  let manager: ListingTemplateManager

  beforeEach(() => {
    ctx = new Context()
    manager = new ListingTemplateManager(ctx, true, [])
  })

  describe('标准模板', () => {
    it('应该加载所有标准模板', () => {
      const templates = manager.listTemplates()
      
      expect(templates.length).toBeGreaterThanOrEqual(5)
    })

    it('应该包含人口统计学模板', () => {
      const template = manager.getTemplate(ListingTemplateType.DEMOGRAPHICS)
      
      expect(template).toBeDefined()
      expect(template?.name).toContain('Demographics')
      expect(template?.columns).toContain('SUBJID')
      expect(template?.columns).toContain('AGE')
      expect(template?.columns).toContain('SEX')
    })

    it('应该包含不良事件模板', () => {
      const template = manager.getTemplate(ListingTemplateType.ADVERSE_EVENTS)
      
      expect(template).toBeDefined()
      expect(template?.columns).toContain('AETERM')
      expect(template?.columns).toContain('AESEV')
    })
  })

  describe('模板应用', () => {
    it('应该正确过滤列', () => {
      const testData = [
        { SUBJID: '001', AGE: 30, SEX: 'M', EXTRA: 'xxx' },
        { SUBJID: '002', AGE: 25, SEX: 'F', EXTRA: 'yyy' },
      ]
      
      const template = manager.getTemplate(ListingTemplateType.DEMOGRAPHICS)!
      const result = manager.applyTemplate(testData, template)
      
      expect(result.data[0]).toHaveProperty('SUBJID')
      expect(result.data[0]).toHaveProperty('AGE')
      expect(result.data[0]).toHaveProperty('SEX')
      expect(result.data[0]).not.toHaveProperty('EXTRA')
    })

    it('应该正确排序', () => {
      const testData = [
        { SUBJID: '003', AGE: 40, SEX: 'M' },
        { SUBJID: '001', AGE: 30, SEX: 'M' },
        { SUBJID: '002', AGE: 25, SEX: 'F' },
      ]
      
      const template = manager.getTemplate(ListingTemplateType.DEMOGRAPHICS)!
      const result = manager.applyTemplate(testData, template)
      
      expect(result.data[0].SUBJID).toBe('001')
      expect(result.data[1].SUBJID).toBe('002')
      expect(result.data[2].SUBJID).toBe('003')
    })
  })

  describe('自定义模板', () => {
    it('应该能创建自定义模板', () => {
      const customTemplate = manager.createCustomTemplate('my-template', {
        description: '自定义模板',
        columns: ['COL1', 'COL2'],
      })
      
      expect(customTemplate.name).toBe('my-template')
      expect(customTemplate.type).toBe(ListingTemplateType.CUSTOM)
      expect(customTemplate.columns).toEqual(['COL1', 'COL2'])
    })
  })
})
