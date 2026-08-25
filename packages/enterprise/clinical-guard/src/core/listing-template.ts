import { Context } from '@deepseek-ai/cordis'

/**
 * Listing 模板类型
 */
export enum ListingTemplateType {
  DEMOGRAPHICS = 'demographics',
  ADVERSE_EVENTS = 'adverse_events',
  LAB_RESULTS = 'lab_results',
  VITAL_SIGNS = 'vital_signs',
  EFFICACY = 'efficacy',
  CUSTOM = 'custom',
}

/**
 * Listing 样式规范
 */
export interface ListingStyle {
  fontSize: number
  fontFamily: string
  orientation: 'portrait' | 'landscape'
  margins: {
    top: number
    bottom: number
    left: number
    right: number
  }
  header: {
    includeProtocol: boolean
    includeTitle: boolean
    includeDate: boolean
  }
  footer: {
    includePageNumber: boolean
    includeTimestamp: boolean
  }
}

/**
 * Listing 模板
 */
export interface ListingTemplate {
  type: ListingTemplateType
  name: string
  description: string
  style: ListingStyle
  columns: string[]
  sortBy?: string[]
  filters?: Record<string, any>
}

/**
 * Listing 模板管理器
 * 
 * 提供标准化的 Listing 输出规范模板
 */
export class ListingTemplateManager {
  private standardTemplates: Map<ListingTemplateType, ListingTemplate>
  private customTemplates: Map<string, ListingTemplate>

  constructor(
    private ctx: Context,
    private useStandardTemplates: boolean,
    customTemplatePaths: string[]
  ) {
    this.standardTemplates = new Map()
    this.customTemplates = new Map()

    if (this.useStandardTemplates) {
      this.loadStandardTemplates()
    }

    this.loadCustomTemplates(customTemplatePaths)
  }

  /**
   * 加载标准模板
   */
  private loadStandardTemplates() {
    this.ctx.logger.info('加载标准 Listing 模板')

    // 人口统计学模板
    this.standardTemplates.set(ListingTemplateType.DEMOGRAPHICS, {
      type: ListingTemplateType.DEMOGRAPHICS,
      name: 'Demographics Listing',
      description: '人口统计学数据 Listing',
      style: this.getDefaultStyle(),
      columns: [
        'SUBJID',
        'AGE',
        'SEX',
        'RACE',
        'ETHNIC',
        'COUNTRY',
      ],
      sortBy: ['SUBJID'],
    })

    // 不良事件模板
    this.standardTemplates.set(ListingTemplateType.ADVERSE_EVENTS, {
      type: ListingTemplateType.ADVERSE_EVENTS,
      name: 'Adverse Events Listing',
      description: '不良事件 Listing',
      style: this.getDefaultStyle(),
      columns: [
        'SUBJID',
        'AETERM',
        'AESTDTC',
        'AEENDTC',
        'AESEV',
        'AESER',
        'AEREL',
      ],
      sortBy: ['SUBJID', 'AESTDTC'],
    })

    // 实验室结果模板
    this.standardTemplates.set(ListingTemplateType.LAB_RESULTS, {
      type: ListingTemplateType.LAB_RESULTS,
      name: 'Laboratory Results Listing',
      description: '实验室结果 Listing',
      style: this.getDefaultStyle(),
      columns: [
        'SUBJID',
        'LBTESTCD',
        'LBTEST',
        'LBSTRESN',
        'LBSTRESU',
        'LBORNRLO',
        'LBORNRHI',
        'LBDTC',
      ],
      sortBy: ['SUBJID', 'LBDTC', 'LBTESTCD'],
    })

    // 生命体征模板
    this.standardTemplates.set(ListingTemplateType.VITAL_SIGNS, {
      type: ListingTemplateType.VITAL_SIGNS,
      name: 'Vital Signs Listing',
      description: '生命体征 Listing',
      style: this.getDefaultStyle(),
      columns: [
        'SUBJID',
        'VSTESTCD',
        'VSTEST',
        'VSSTRESN',
        'VSSTRESU',
        'VSDTC',
      ],
      sortBy: ['SUBJID', 'VSDTC', 'VSTESTCD'],
    })

    // 疗效模板
    this.standardTemplates.set(ListingTemplateType.EFFICACY, {
      type: ListingTemplateType.EFFICACY,
      name: 'Efficacy Listing',
      description: '疗效数据 Listing',
      style: this.getDefaultStyle(),
      columns: [
        'SUBJID',
        'PARAMCD',
        'PARAM',
        'AVAL',
        'AVALU',
        'ADT',
      ],
      sortBy: ['SUBJID', 'ADT', 'PARAMCD'],
    })

    this.ctx.logger.info(`已加载 ${this.standardTemplates.size} 个标准模板`)
  }

  /**
   * 加载自定义模板
   */
  private loadCustomTemplates(paths: string[]) {
    if (paths.length === 0) {
      return
    }

    this.ctx.logger.info(`加载 ${paths.length} 个自定义模板`)
    // TODO: 从文件加载自定义模板
  }

  /**
   * 获取默认样式
   */
  private getDefaultStyle(): ListingStyle {
    return {
      fontSize: 9,
      fontFamily: 'Courier New',
      orientation: 'landscape',
      margins: {
        top: 1,
        bottom: 1,
        left: 0.5,
        right: 0.5,
      },
      header: {
        includeProtocol: true,
        includeTitle: true,
        includeDate: true,
      },
      footer: {
        includePageNumber: true,
        includeTimestamp: true,
      },
    }
  }

  /**
   * 获取模板
   */
  public getTemplate(type: ListingTemplateType): ListingTemplate | undefined {
    return this.standardTemplates.get(type)
  }

  /**
   * 获取自定义模板
   */
  public getCustomTemplate(name: string): ListingTemplate | undefined {
    return this.customTemplates.get(name)
  }

  /**
   * 列出所有可用模板
   */
  public listTemplates(): ListingTemplate[] {
    const templates: ListingTemplate[] = []

    for (const template of this.standardTemplates.values()) {
      templates.push(template)
    }

    for (const template of this.customTemplates.values()) {
      templates.push(template)
    }

    return templates
  }

  /**
   * 应用模板到数据
   */
  public applyTemplate(
    data: any[],
    template: ListingTemplate
  ): any {
    this.ctx.logger.debug(`应用模板: ${template.name}`)

    // 过滤列
    const filteredData = data.map(row => {
      const filtered: any = {}
      for (const col of template.columns) {
        if (col in row) {
          filtered[col] = row[col]
        }
      }
      return filtered
    })

    // 排序
    if (template.sortBy && template.sortBy.length > 0) {
      filteredData.sort((a, b) => {
        for (const col of template.sortBy!) {
          const aVal = a[col]
          const bVal = b[col]
          if (aVal < bVal) return -1
          if (aVal > bVal) return 1
        }
        return 0
      })
    }

    // 应用过滤器
    let result = filteredData
    if (template.filters) {
      result = filteredData.filter(row => {
        for (const [key, value] of Object.entries(template.filters!)) {
          if (row[key] !== value) {
            return false
          }
        }
        return true
      })
    }

    return {
      data: result,
      style: template.style,
      metadata: {
        type: template.type,
        name: template.name,
        columns: template.columns,
        rowCount: result.length,
      },
    }
  }

  /**
   * 创建自定义模板
   */
  public createCustomTemplate(
    name: string,
    template: Partial<ListingTemplate>
  ): ListingTemplate {
    const fullTemplate: ListingTemplate = {
      type: ListingTemplateType.CUSTOM,
      name,
      description: template.description || '',
      style: template.style || this.getDefaultStyle(),
      columns: template.columns || [],
      sortBy: template.sortBy,
      filters: template.filters,
    }

    this.customTemplates.set(name, fullTemplate)
    this.ctx.logger.info(`创建自定义模板: ${name}`)

    return fullTemplate
  }
}
