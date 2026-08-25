/**
 * 临床数据识别模式库
 * 
 * 从 Python patterns.py 迁移而来，使用 TypeScript 重新实现
 * 核心功能：受试者ID、CDISC字段、临床术语识别
 */

/**
 * 模式定义
 */
export interface PatternDefinition {
  pattern: RegExp
  name: string
  severity: 'high' | 'medium' | 'low'
}

/**
 * 威胁检测结果
 */
export interface ThreatDetection {
  type: string
  confidence: number
  evidence: string
  location: string
  patternName: string
  severity: 'high' | 'medium' | 'low'
}

/**
 * 受试者编号模式
 */
export const SUBJECT_ID_PATTERNS: PatternDefinition[] = [
  {
    pattern: /\b\d{3,4}-\d{3,6}\b/g,
    name: '站点-受试者编号',
    severity: 'high',
  },
  {
    pattern: /\b[A-Z]{1,4}\d{6,8}\b/gi,
    name: '字母前缀编号',
    severity: 'high',
  },
  {
    pattern: /\b[A-Z]{2,4}-\d{2,4}-\d{3,6}\b/gi,
    name: '复合站点编号',
    severity: 'high',
  },
  {
    pattern: /\b(?:(?=[A-Z0-9]*\d)[A-Z0-9]{1,20}-(?=[A-Z0-9]*\d)[A-Z0-9]{1,20}-(?=[A-Z0-9]*\d)[A-Z0-9]{1,20}|(?:\d{2,}-[A-Z0-9]{1,20}-[A-Z0-9]{1,20}|[A-Z0-9]{1,20}-\d{2,}-[A-Z0-9]{1,20}|[A-Z0-9]{1,20}-[A-Z0-9]{1,20}-\d{2,}))\b/gi,
    name: 'USUBJID格式',
    severity: 'high',
  },
]

/**
 * 临床日期模式
 */
export const DATE_PATTERNS: PatternDefinition[] = [
  {
    pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\b/g,
    name: 'ISO8601时间戳',
    severity: 'medium',
  },
  {
    pattern: /\b\d{4}-\d{2}-\d{2}\b/g,
    name: 'ISO日期',
    severity: 'low',
  },
  {
    pattern: /\b\d{2}[A-Z]{3}\d{4}\b/gi,
    name: 'SAS日期',
    severity: 'medium',
  },
  {
    pattern: /\b\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2}\b/gi,
    name: '临床日期时间',
    severity: 'medium',
  },
]

/**
 * 医学编码模式
 */
export const MEDICAL_CODE_PATTERNS: PatternDefinition[] = [
  {
    pattern: /\bPT:\s*\d{8}\b/gi,
    name: 'MedDRA PT编码',
    severity: 'high',
  },
  {
    pattern: /\bLLT:\s*\d{8}\b/gi,
    name: 'MedDRA LLT编码',
    severity: 'high',
  },
  {
    pattern: /\bAE\d{6,8}\b/gi,
    name: '不良事件编码',
    severity: 'high',
  },
]

/**
 * CDISC 标准字段名
 */
export const CDISC_CORE_FIELDS = new Set([
  'usubjid', 'subjid', 'subject', 'siteid', 'screenid', 'randid',
  'rfstdtc', 'rfendtc', 'dthdtc', 'aestdtc', 'aeendtc',
  'cmstdtc', 'cmendt', 'exstdtc', 'exendtc',
  'vstdtc', 'lbdtc', 'egdtc', 'mhdtc',
  'aeterm', 'aedecod', 'cmdecod', 'mhdecod',
])

/**
 * 临床术语集合
 */
export const CLINICAL_TERMS = new Set([
  'subject', 'patient', 'participant', 'adverse', 'event',
  'concomitant', 'medication', 'medical', 'history',
  'vital', 'sign', 'laboratory', 'ecg', 'randomization',
])

/**
 * SAS 临床域名
 */
export const SAS_CLINICAL_DOMAINS = new Set([
  'dm', 'ae', 'cm', 'ex', 'vs', 'lb', 'eg', 'mh',
  'sv', 'ds', 'suppqual', 'relrec',
])

/**
 * 临床数据识别器
 */
export class ClinicalDataRecognizer {
  /**
   * 扫描文本中的威胁
   */
  public scanText(text: string): ThreatDetection[] {
    const threats: ThreatDetection[] = []

    // 检查受试者ID
    for (const { pattern, name, severity } of SUBJECT_ID_PATTERNS) {
      const matches = text.matchAll(pattern)
      for (const match of matches) {
        threats.push({
          type: 'subject_id',
          confidence: 0.95,
          evidence: match[0],
          location: 'text',
          patternName: name,
          severity,
        })
      }
    }

    // 检查医学编码
    for (const { pattern, name, severity } of MEDICAL_CODE_PATTERNS) {
      const matches = text.matchAll(pattern)
      for (const match of matches) {
        threats.push({
          type: 'medical_code',
          confidence: 0.90,
          evidence: match[0],
          location: 'text',
          patternName: name,
          severity,
        })
      }
    }

    // 检查临床术语组合
    const lowerText = text.toLowerCase()
    const termCount = Array.from(CLINICAL_TERMS).filter(term => 
      lowerText.includes(term)
    ).length

    if (termCount >= 3) {
      threats.push({
        type: 'clinical_terms',
        confidence: 0.70 + (termCount * 0.05),
        evidence: `检测到 ${termCount} 个临床术语`,
        location: 'text',
        patternName: '临床术语组合',
        severity: 'medium',
      })
    }

    return threats
  }

  /**
   * 扫描结构化数据
   */
  public scanStructured(data: any, path: string = 'root'): ThreatDetection[] {
    const threats: ThreatDetection[] = []

    if (typeof data === 'string') {
      return this.scanText(data)
    }

    if (Array.isArray(data)) {
      data.forEach((item, index) => {
        threats.push(...this.scanStructured(item, `${path}[${index}]`))
      })
      return threats
    }

    if (data && typeof data === 'object') {
      // 检查字段名
      for (const key of Object.keys(data)) {
        const lowerKey = key.toLowerCase()
        if (CDISC_CORE_FIELDS.has(lowerKey)) {
          threats.push({
            type: 'cdisc_field',
            confidence: 1.0,
            evidence: key,
            location: `${path}.${key}`,
            patternName: 'CDISC标准字段',
            severity: 'high',
          })
        }
      }

      // 递归扫描值
      for (const [key, value] of Object.entries(data)) {
        threats.push(...this.scanStructured(value, `${path}.${key}`))
      }
    }

    return threats
  }

  /**
   * 威胁去重
   */
  public deduplicateThreats(threats: ThreatDetection[]): ThreatDetection[] {
    const seen = new Set<string>()
    const unique: ThreatDetection[] = []

    for (const threat of threats) {
      const key = `${threat.type}:${threat.patternName}:${threat.evidence}`
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(threat)
      }
    }

    return unique
  }
}
