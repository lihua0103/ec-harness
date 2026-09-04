import { describe, expect, it } from 'vitest'
import { DEFAULT_DATA_SECURITY_CONFIG, sanitizeConfig } from './data-security-service.js'

describe('数据安全开关配置', () => {
  it('默认开启，且策略对象不可变更', () => {
    expect(DEFAULT_DATA_SECURITY_CONFIG).toEqual({
      enabled: true,
      policy: 'two-value-interception',
    })
    expect(Object.isFrozen(DEFAULT_DATA_SECURITY_CONFIG)).toBe(true)
  })

  it('只接受 enabled 布尔值，历史扩展名配置被忽略', () => {
    expect(sanitizeConfig({ enabled: false, datasetExtensions: ['.parquet'] }))
      .toEqual({ enabled: false, policy: 'two-value-interception' })
    expect(() => sanitizeConfig({ datasetExtensions: ['.parquet'] })).toThrow()
  })
})
