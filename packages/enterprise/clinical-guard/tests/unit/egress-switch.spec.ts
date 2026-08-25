import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { EgressSwitch, EgressType } from '../../lib/core/egress-switch.js'
import { DEFAULT_CONFIG } from '../../lib/config.js'

describe('EgressSwitch - 数据安全开关', () => {
  let ctx: Context
  let egressSwitch: EgressSwitch

  beforeEach(() => {
    ctx = new Context()
  })

  describe('开关状态', () => {
    it('默认应该开启', () => {
      egressSwitch = new EgressSwitch(ctx, DEFAULT_CONFIG.dataEgressControl)
      
      expect(egressSwitch.shouldIntercept(EgressType.SAS_DATASET)).toBe(true)
      expect(egressSwitch.shouldIntercept(EgressType.SPEC_DATA)).toBe(true)
    })

    it('关闭后不应该拦截', () => {
      const config = {
        ...DEFAULT_CONFIG.dataEgressControl,
        enabled: false,
      }
      egressSwitch = new EgressSwitch(ctx, config)
      
      expect(egressSwitch.shouldIntercept(EgressType.SAS_DATASET)).toBe(false)
      expect(egressSwitch.shouldIntercept(EgressType.SPEC_DATA)).toBe(false)
    })

    it('可以单独控制 SAS 拦截', () => {
      const config = {
        ...DEFAULT_CONFIG.dataEgressControl,
        sasDatasetEgress: {
          enabled: false,
          aiInterception: true,
        },
      }
      egressSwitch = new EgressSwitch(ctx, config)
      
      expect(egressSwitch.shouldIntercept(EgressType.SAS_DATASET)).toBe(false)
      expect(egressSwitch.shouldIntercept(EgressType.SPEC_DATA)).toBe(true)
    })

    it('可以单独控制 Spec 拦截', () => {
      const config = {
        ...DEFAULT_CONFIG.dataEgressControl,
        specDataEgress: {
          enabled: false,
          aiInterception: true,
        },
      }
      egressSwitch = new EgressSwitch(ctx, config)
      
      expect(egressSwitch.shouldIntercept(EgressType.SAS_DATASET)).toBe(true)
      expect(egressSwitch.shouldIntercept(EgressType.SPEC_DATA)).toBe(false)
    })
  })

  describe('AI 拦截', () => {
    it('默认启用 AI 拦截', () => {
      egressSwitch = new EgressSwitch(ctx, DEFAULT_CONFIG.dataEgressControl)
      
      expect(egressSwitch.isAiInterceptionEnabled(EgressType.SAS_DATASET)).toBe(true)
      expect(egressSwitch.isAiInterceptionEnabled(EgressType.SPEC_DATA)).toBe(true)
    })

    it('可以禁用 AI 拦截', () => {
      const config = {
        ...DEFAULT_CONFIG.dataEgressControl,
        sasDatasetEgress: {
          enabled: true,
          aiInterception: false,
        },
      }
      egressSwitch = new EgressSwitch(ctx, config)
      
      expect(egressSwitch.isAiInterceptionEnabled(EgressType.SAS_DATASET)).toBe(false)
    })
  })

  describe('拦截执行', () => {
    beforeEach(() => {
      egressSwitch = new EgressSwitch(ctx, DEFAULT_CONFIG.dataEgressControl)
    })

    it('开关关闭时应该直接放行', async () => {
      const config = {
        ...DEFAULT_CONFIG.dataEgressControl,
        enabled: false,
      }
      egressSwitch = new EgressSwitch(ctx, config)
      
      const result = await egressSwitch.intercept(EgressType.SAS_DATASET, { test: 'data' })
      
      expect(result.allowed).toBe(true)
      expect(result.reason).toContain('关闭')
    })

    it('应该返回拦截结果', async () => {
      const result = await egressSwitch.intercept(EgressType.SAS_DATASET, { test: 'data' })
      
      expect(result).toHaveProperty('allowed')
      expect(result).toHaveProperty('timestamp')
      expect(result).toHaveProperty('egressType')
      expect(result.egressType).toBe(EgressType.SAS_DATASET)
    })
  })

  describe('配置更新', () => {
    it('应该支持热更新配置', () => {
      egressSwitch = new EgressSwitch(ctx, DEFAULT_CONFIG.dataEgressControl)
      
      const newConfig = {
        ...DEFAULT_CONFIG.dataEgressControl,
        enabled: false,
      }
      
      egressSwitch.updateConfig(newConfig)
      
      expect(egressSwitch.shouldIntercept(EgressType.SAS_DATASET)).toBe(false)
    })

    it('应该能获取当前配置', () => {
      egressSwitch = new EgressSwitch(ctx, DEFAULT_CONFIG.dataEgressControl)
      
      const config = egressSwitch.getConfig()
      
      expect(config.enabled).toBe(true)
      expect(config.sasDatasetEgress.enabled).toBe(true)
      expect(config.specDataEgress.enabled).toBe(true)
    })
  })
})
