import { describe, expect, it } from 'vitest'
import { DEFAULT_DATASET_EXTENSIONS, sanitizeConfig } from './data-security-service.js'

describe('sanitizeConfig（磁盘配置校验，纯函数）', () => {
  it('合法配置透传，扩展名规范化小写', () => {
    expect(sanitizeConfig({ enabled: false, datasetExtensions: ['.SAS7BDAT', '.Parquet'] }))
      .toEqual({ enabled: false, datasetExtensions: ['.sas7bdat', '.parquet'] })
  })

  it('旧版遗留键（auxExcelExtensions 等）自动丢弃——ADR-0007 场景②已废除', () => {
    const result = sanitizeConfig({ enabled: true, datasetExtensions: ['.xpt'], auxExcelExtensions: ['.xlsx'] })
    expect(result).toEqual({ enabled: true, datasetExtensions: ['.xpt'] })
    expect('auxExcelExtensions' in result).toBe(false)
  })

  it('空/全空白扩展名表回落默认（与 listing python DATA_EXTENSIONS 对齐）', () => {
    expect(sanitizeConfig({ enabled: true, datasetExtensions: [] }).datasetExtensions)
      .toEqual(DEFAULT_DATASET_EXTENSIONS)
    expect(sanitizeConfig({ enabled: true }).datasetExtensions).toEqual(DEFAULT_DATASET_EXTENSIONS)
  })

  it('非法形状 fail-fast：enabled 非 boolean / 扩展名表非 string[]', () => {
    expect(() => sanitizeConfig({})).toThrow(/enabled/)
    expect(() => sanitizeConfig({ enabled: 'yes' })).toThrow(/enabled/)
    expect(() => sanitizeConfig({ enabled: true, datasetExtensions: '.csv' })).toThrow(/string\[\]/)
    expect(() => sanitizeConfig({ enabled: true, datasetExtensions: [1] })).toThrow(/string\[\]/)
    expect(() => sanitizeConfig(null)).toThrow(/enabled/)
  })
})
