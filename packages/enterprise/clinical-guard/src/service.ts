import { Context, Service } from '@deepseek-ai/cordis'
import { ClinicalGuardConfig, DEFAULT_CONFIG } from './config'
import { EgressSwitch, EgressType } from './core/egress-switch'
import { HeaderDetector } from './core/header-detector'
import { EdcFieldDetector } from './core/edc-field-detector'
import { ListingTemplateManager, ListingTemplateType } from './core/listing-template'

/**
 * 临床数据守护服务
 */
export class ClinicalGuardService extends Service {
  private egressSwitch: EgressSwitch
  private headerDetector?: HeaderDetector
  private edcFieldDetector?: EdcFieldDetector
  private listingTemplateManager?: ListingTemplateManager

  constructor(ctx: Context, public config: ClinicalGuardConfig) {
    super(ctx, 'clinicalGuard')

    this.egressSwitch = new EgressSwitch(ctx, config.dataEgressControl)

    ctx.logger.info('🏥 临床数据守护服务已启动')
    this.initialize()
  }

  private initialize() {
    const { ctx, config } = this

    if (config.headerDetection.enabled) {
      this.headerDetector = new HeaderDetector(
        ctx,
        config.pythonPath || 'python',
        config.headerDetection.aiEnhanced
      )
      ctx.logger.info('✅ 表头检测器已启用')
    }

    if (config.edcFieldRecognition.enabled) {
      this.edcFieldDetector = new EdcFieldDetector(
        ctx,
        config.edcFieldRecognition.systems
      )
      ctx.logger.info('✅ EDC 字段识别器已启用')
    }

    if (config.listingTemplate.enabled) {
      this.listingTemplateManager = new ListingTemplateManager(
        ctx,
        config.listingTemplate.standardTemplates,
        config.listingTemplate.customTemplates
      )
      ctx.logger.info('✅ Listing 模板管理器已启用')
    }

    ctx.logger.info('临床数据守护服务初始化完成')
  }

  public async checkEgress(egressType: EgressType, data: any) {
    return this.egressSwitch.intercept(egressType, data)
  }

  public async detectHeaders(data: any) {
    if (!this.headerDetector) {
      throw new Error('表头检测器未启用')
    }
    return this.headerDetector.detect(data)
  }

  public async recognizeEdcFields(data: any) {
    if (!this.edcFieldDetector) {
      throw new Error('EDC 字段识别器未启用')
    }
    return this.edcFieldDetector.recognize(data)
  }

  public getListingTemplate(type: ListingTemplateType) {
    if (!this.listingTemplateManager) {
      throw new Error('Listing 模板管理器未启用')
    }
    return this.listingTemplateManager.getTemplate(type)
  }

  public listListingTemplates() {
    if (!this.listingTemplateManager) {
      throw new Error('Listing 模板管理器未启用')
    }
    return this.listingTemplateManager.listTemplates()
  }

  public applyListingTemplate(data: any[], type: ListingTemplateType) {
    if (!this.listingTemplateManager) {
      throw new Error('Listing 模板管理器未启用')
    }
    const template = this.listingTemplateManager.getTemplate(type)
    if (!template) {
      throw new Error(`模板不存在: ${type}`)
    }
    return this.listingTemplateManager.applyTemplate(data, template)
  }

  public getEgressSwitchStatus() {
    return {
      enabled: this.config.dataEgressControl.enabled,
      sasDatasetEgress: this.config.dataEgressControl.sasDatasetEgress,
      specDataEgress: this.config.dataEgressControl.specDataEgress,
    }
  }

  public getStatus() {
    return {
      egressSwitch: this.getEgressSwitchStatus(),
      headerDetector: {
        enabled: !!this.headerDetector,
        aiEnhanced: this.config.headerDetection.aiEnhanced,
      },
      edcFieldDetector: {
        enabled: !!this.edcFieldDetector,
        supportedSystems: this.config.edcFieldRecognition.systems,
      },
      listingTemplateManager: {
        enabled: !!this.listingTemplateManager,
        templateCount: this.listingTemplateManager?.listTemplates().length || 0,
      },
    }
  }
}

export { ClinicalGuardConfig, DEFAULT_CONFIG, EgressType, ListingTemplateType }
