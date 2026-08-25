import type { Context } from '@deepseek-ai/cordis'

/**
 * 数据出域控制配置
 */
export interface DataEgressControlConfig {
  enabled: boolean
  sasDatasetEgress: {
    enabled: boolean
    aiInterception: boolean
  }
  specDataEgress: {
    enabled: boolean
    aiInterception: boolean
  }
}

/**
 * 表头检测配置
 */
export interface HeaderDetectionConfig {
  enabled: boolean
  aiEnhanced: boolean
}

/**
 * EDC 字段识别配置
 */
export interface EdcFieldRecognitionConfig {
  enabled: boolean
  systems: string[]
}

/**
 * Listing 模板配置
 */
export interface ListingTemplateConfig {
  enabled: boolean
  standardTemplates: boolean
  customTemplates: string[]
}

/**
 * 临床数据守护完整配置
 */
export interface ClinicalGuardConfig {
  dataEgressControl: DataEgressControlConfig
  headerDetection: HeaderDetectionConfig
  edcFieldRecognition: EdcFieldRecognitionConfig
  listingTemplate: ListingTemplateConfig
  pythonPath?: string
  auditLogPath?: string
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: ClinicalGuardConfig = {
  dataEgressControl: {
    enabled: true,
    sasDatasetEgress: {
      enabled: true,
      aiInterception: true,
    },
    specDataEgress: {
      enabled: true,
      aiInterception: true,
    },
  },
  headerDetection: {
    enabled: true,
    aiEnhanced: true,
  },
  edcFieldRecognition: {
    enabled: true,
    systems: ['Medidata', 'Oracle', 'Veeva'],
  },
  listingTemplate: {
    enabled: true,
    standardTemplates: true,
    customTemplates: [],
  },
}

// Schema 会在主入口中定义
export const Config = null as any
