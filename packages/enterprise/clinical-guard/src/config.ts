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
 * 企业品牌配置
 *
 * 品牌注入依赖 webServer 服务；headless 模式下自动跳过。
 */
export interface BrandingConfig {
  /** 是否启用品牌注入，默认 true */
  enabled: boolean
  /** 完整品牌名称，1-80 字符，不含尖括号 */
  brandName?: string
  /** 简短品牌名称，1-24 字符，不含尖括号 */
  brandShortName?: string
}

/**
 * Listing 各阶段超时配置（毫秒）
 */
export interface ListingTimeoutConfig {
  inspect?: number
  runCode?: number
  publish?: number
}

/**
 * 临床数据守护完整配置
 */
export interface ClinicalGuardConfig {
  dataEgressControl: DataEgressControlConfig
  headerDetection: HeaderDetectionConfig
  edcFieldRecognition: EdcFieldRecognitionConfig
  listingTemplate: ListingTemplateConfig
  /** 企业品牌配置 */
  branding?: BrandingConfig
  /** Python 解释器路径，默认自动检测 */
  pythonPath?: string
  /** 审计日志目录 */
  auditLogPath?: string
  /** 本地凭据目录（用于加密 ZIP 密码引用） */
  credentialsDir?: string
  /** 本地数据访问模式 */
  localDataAccess?: 'disabled' | 'uat-local'
  /** 本地数据根目录（仅旧版宿主无 session cwd 时使用） */
  localDataRoot?: string
  /** Listing 操作超时 */
  listingTimeoutMs?: number | ListingTimeoutConfig
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
  branding: {
    enabled: true,
    brandName: 'Emerald Clinical',
    brandShortName: 'Emerald',
  },
}

// Schema 会在主入口中定义
export const Config = null as any
