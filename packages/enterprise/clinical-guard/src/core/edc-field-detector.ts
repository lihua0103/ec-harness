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
 * 
 * 识别临床试验 EDC 系统的数据字段
 */
export class EdcFieldDetector {
  constructor(
    private ctx: Context,
    private supportedSystems: string[]
  ) {}

  /**
   * 识别 EDC 字段
   * 
   * @param data 数据内容
   * @returns 识别结果
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
    // TODO: 实现 EDC 系统检测逻辑
    // 根据字段特征识别是哪个 EDC 系统

    const dataStr = JSON.stringify(data).toLowerCase()

    // Medidata 特征
    if (dataStr.includes('rave') || dataStr.includes('medidata')) {
      return 'Medidata'
    }

    // Oracle 特征
    if (dataStr.includes('oracle') || dataStr.includes('inform')) {
      return 'Oracle'
    }

    // Veeva 特征
    if (dataStr.includes('veeva') || dataStr.includes('vault')) {
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

    // 根据不同的 EDC 系统识别字段
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
    // TODO: 实现 Medidata 特定字段识别
    const fields: EdcField[] = []

    // 常见 Medidata 字段
    const commonFields = [
      'STUDYID', 'SITEID', 'SUBJID', 'VISIT', 'VISITDT',
      'FORMNAME', 'FOLDEROID', 'DATAPAGE'
    ]

    for (const fieldName of commonFields) {
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

    const commonFields = [
      'PROTOCOL', 'SITE_NUM', 'PATIENT_ID', 'VISIT_NAME',
      'CRF_NAME', 'PAGE_NAME'
    ]

    for (const fieldName of commonFields) {
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

    const commonFields = [
      'study__v', 'site__v', 'subject__v', 'visit__v',
      'form__v', 'field__v'
    ]

    for (const fieldName of commonFields) {
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
   * 检查数据中是否有指定字段
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
