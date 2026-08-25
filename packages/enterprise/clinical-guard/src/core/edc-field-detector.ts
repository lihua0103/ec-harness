import { Context } from '@deepseek-ai/cordis'

/**
 * EDC 系统类型
 */
export type EdcSystem = 'Medidata' | 'Oracle' | 'Veeva' | 'Unknown'

/**
 * EDC 字段信息
 */
export interface EdcField {
  name: string
  type: string
  system: EdcSystem
  confidence: number
}

/**
 * EDC 字段识别结果
 */
export interface EdcRecognitionResult {
  detected: boolean
  system: EdcSystem
  fields: EdcField[]
  confidence: number
}

/**
 * EDC 字段识别器
 */
export class EdcFieldDetector {
  // Medidata 特征字段
  private readonly medidataFields = [
    'STUDYID', 'SITEID', 'SUBJID', 'VISIT', 'VISITDT',
    'FORMNAME', 'FOLDEROID', 'DATAPAGE'
  ]

  // Oracle 特征字段
  private readonly oracleFields = [
    'PROTOCOL', 'SITE_NUM', 'PATIENT_ID', 'VISIT_NAME',
    'CRF_NAME', 'PAGE_NAME'
  ]

  // Veeva 特征字段（带 __v 后缀）
  private readonly veevaFields = [
    'study__v', 'site__v', 'subject__v', 'visit__v',
    'form__v', 'field__v'
  ]

  constructor(
    private ctx: Context,
    private supportedSystems: string[]
  ) {}

  /**
   * 识别 EDC 字段
   */
  public async recognize(data: any): Promise<EdcRecognitionResult> {
    this.ctx.logger.debug('开始 EDC 字段识别')

    try {
      // 检测 EDC 系统类型
      const system = await this.detectSystem(data)

      if (system === 'Unknown') {
        return {
          detected: false,
          system: 'Unknown',
          fields: [],
          confidence: 0,
        }
      }

      // 识别字段
      const fields = await this.recognizeFields(data, system)

      return {
        detected: true,
        system,
        fields,
        confidence: this.calculateConfidence(fields),
      }
    } catch (error) {
      this.ctx.logger.error('EDC 字段识别失败', error)
      throw error
    }
  }

  /**
   * 检测 EDC 系统类型
   */
  private async detectSystem(data: any): Promise<EdcSystem> {
    if (!data || typeof data !== 'object') {
      return 'Unknown'
    }

    const keys = Object.keys(data).map(k => k.toUpperCase())

    // 计算每个系统的匹配分数
    let medidataScore = 0
    let oracleScore = 0
    let veevaScore = 0

    // 检查 Medidata 字段
    for (const field of this.medidataFields) {
      if (keys.includes(field.toUpperCase())) {
        medidataScore++
      }
    }

    // 检查 Oracle 字段
    for (const field of this.oracleFields) {
      if (keys.includes(field.toUpperCase())) {
        oracleScore++
      }
    }

    // 检查 Veeva 字段（特殊处理 __v 后缀）
    for (const key of Object.keys(data)) {
      if (key.toLowerCase().endsWith('__v')) {
        veevaScore++
      }
    }

    // 返回得分最高的系统
    const maxScore = Math.max(medidataScore, oracleScore, veevaScore)
    
    if (maxScore === 0) {
      return 'Unknown'
    }

    if (medidataScore === maxScore) {
      return 'Medidata'
    }
    
    if (oracleScore === maxScore) {
      return 'Oracle'
    }
    
    if (veevaScore === maxScore) {
      return 'Veeva'
    }

    return 'Unknown'
  }

  /**
   * 识别字段
   */
  private async recognizeFields(
    data: any,
    system: EdcSystem
  ): Promise<EdcField[]> {
    const fields: EdcField[] = []

    switch (system) {
      case 'Medidata':
        fields.push(...this.recognizeMedidataFields(data))
        break

      case 'Oracle':
        fields.push(...this.recognizeOracleFields(data))
        break

      case 'Veeva':
        fields.push(...this.recognizeVeevaFields(data))
        break
    }

    return fields
  }

  /**
   * 识别 Medidata 字段
   */
  private recognizeMedidataFields(data: any): EdcField[] {
    const fields: EdcField[] = []

    for (const fieldName of this.medidataFields) {
      if (this.hasField(data, fieldName)) {
        fields.push({
          name: fieldName,
          type: 'string',
          system: 'Medidata',
          confidence: 0.9,
        })
      }
    }

    return fields
  }

  /**
   * 识别 Oracle 字段
   */
  private recognizeOracleFields(data: any): EdcField[] {
    const fields: EdcField[] = []

    for (const fieldName of this.oracleFields) {
      if (this.hasField(data, fieldName)) {
        fields.push({
          name: fieldName,
          type: 'string',
          system: 'Oracle',
          confidence: 0.9,
        })
      }
    }

    return fields
  }

  /**
   * 识别 Veeva 字段
   */
  private recognizeVeevaFields(data: any): EdcField[] {
    const fields: EdcField[] = []

    for (const fieldName of this.veevaFields) {
      if (this.hasField(data, fieldName)) {
        fields.push({
          name: fieldName,
          type: 'string',
          system: 'Veeva',
          confidence: 0.9,
        })
      }
    }

    return fields
  }

  /**
   * 检查数据中是否有指定字段（不区分大小写）
   */
  private hasField(data: any, fieldName: string): boolean {
    if (typeof data !== 'object' || data === null) {
      return false
    }

    const lowerFieldName = fieldName.toLowerCase()

    for (const key of Object.keys(data)) {
      if (key.toLowerCase() === lowerFieldName) {
        return true
      }
    }

    return false
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(fields: EdcField[]): number {
    if (fields.length === 0) {
      return 0
    }

    const avgConfidence = fields.reduce((sum, f) => sum + f.confidence, 0) / fields.length
    return avgConfidence
  }

  /**
   * 是否支持该 EDC 系统
   */
  public isSupported(system: EdcSystem): boolean {
    return this.supportedSystems.includes(system)
  }
}
