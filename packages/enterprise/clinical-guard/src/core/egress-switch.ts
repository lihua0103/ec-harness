import { Context } from '@deepseek-ai/cordis'
import type { DataEgressControlConfig } from '../config'

/**
 * 数据出域类型
 */
export enum EgressType {
  SAS_DATASET = 'sas_dataset',
  SPEC_DATA = 'spec_data',
}

/**
 * 拦截结果
 */
export interface InterceptionResult {
  allowed: boolean
  reason?: string
  timestamp: number
  egressType: EgressType
}

/**
 * 数据安全开关管理器
 * 
 * 核心功能：
 * - 全局开关控制
 * - SAS 数据集出域拦截
 * - Spec 数据出域拦截
 * - 默认开启，关闭后不做任何拦截
 */
export class EgressSwitch {
  constructor(
    private ctx: Context,
    private config: DataEgressControlConfig
  ) {
    this.logSwitchStatus()
  }

  /**
   * 记录开关状态
   */
  private logSwitchStatus() {
    const { enabled, sasDatasetEgress, specDataEgress } = this.config
    
    if (!enabled) {
      this.ctx.logger.warn('🔓 数据安全开关已关闭 - 不做任何拦截')
      return
    }
    
    this.ctx.logger.info('🔒 数据安全开关已开启')
    this.ctx.logger.info(`  - SAS 数据集拦截: ${sasDatasetEgress.enabled ? '✅' : '❌'}`)
    this.ctx.logger.info(`  - Spec 数据拦截: ${specDataEgress.enabled ? '✅' : '❌'}`)
  }

  /**
   * 检查是否应该拦截
   * 
   * @param egressType 出域类型
   * @returns 是否应该执行拦截检查
   */
  public shouldIntercept(egressType: EgressType): boolean {
    // 主开关关闭，直接放行
    if (!this.config.enabled) {
      return false
    }

    // 根据类型检查子开关
    switch (egressType) {
      case EgressType.SAS_DATASET:
        return this.config.sasDatasetEgress.enabled
      
      case EgressType.SPEC_DATA:
        return this.config.specDataEgress.enabled
      
      default:
        return false
    }
  }

  /**
   * 是否启用 AI 拦截
   */
  public isAiInterceptionEnabled(egressType: EgressType): boolean {
    if (!this.config.enabled) {
      return false
    }

    switch (egressType) {
      case EgressType.SAS_DATASET:
        return this.config.sasDatasetEgress.aiInterception
      
      case EgressType.SPEC_DATA:
        return this.config.specDataEgress.aiInterception
      
      default:
        return false
    }
  }

  /**
   * 执行拦截检查
   * 
   * @param egressType 出域类型
   * @param data 要检查的数据
   * @returns 拦截结果
   */
  public async intercept(
    egressType: EgressType,
    data: any
  ): Promise<InterceptionResult> {
    const timestamp = Date.now()

    // 检查是否应该拦截
    if (!this.shouldIntercept(egressType)) {
      return {
        allowed: true,
        reason: '数据安全开关已关闭或该类型拦截已禁用',
        timestamp,
        egressType,
      }
    }

    // 执行具体的拦截逻辑
    try {
      const result = await this.performInterception(egressType, data)
      
      // 记录拦截结果
      if (!result.allowed) {
        this.ctx.logger.warn(`🚫 数据出域被拦截`, {
          type: egressType,
          reason: result.reason,
        })
      }

      return result
    } catch (error) {
      this.ctx.logger.error('拦截检查失败', error)
      
      // 失败时的默认策略：拒绝出域（安全优先）
      return {
        allowed: false,
        reason: `拦截检查失败: ${error instanceof Error ? error.message : '未知错误'}`,
        timestamp,
        egressType,
      }
    }
  }

  /**
   * 执行具体的拦截逻辑
   */
  private async performInterception(
    egressType: EgressType,
    data: any
  ): Promise<InterceptionResult> {
    const timestamp = Date.now()

    switch (egressType) {
      case EgressType.SAS_DATASET:
        return this.interceptSasDataset(data, timestamp)
      
      case EgressType.SPEC_DATA:
        return this.interceptSpecData(data, timestamp)
      
      default:
        return {
          allowed: false,
          reason: '未知的出域类型',
          timestamp,
          egressType,
        }
    }
  }

  /**
   * SAS 数据集出域拦截
   */
  private async interceptSasDataset(
    data: any,
    timestamp: number
  ): Promise<InterceptionResult> {
    // TODO: 实现 SAS 数据集拦截逻辑
    // 1. 检查数据格式
    // 2. 如果启用 AI，调用 AI 决策
    // 3. 返回拦截结果

    const useAi = this.config.sasDatasetEgress.aiInterception

    if (useAi) {
      // AI 拦截逻辑
      this.ctx.logger.debug('使用 AI 检查 SAS 数据集')
      // TODO: 调用 AI 模型
    }

    // 临时实现：基础检查
    return {
      allowed: true,
      reason: 'SAS 数据集检查通过',
      timestamp,
      egressType: EgressType.SAS_DATASET,
    }
  }

  /**
   * Spec 数据出域拦截
   */
  private async interceptSpecData(
    data: any,
    timestamp: number
  ): Promise<InterceptionResult> {
    // TODO: 实现 Spec 数据拦截逻辑
    // 1. 解析 Spec 内容
    // 2. 如果启用 AI，调用 AI 理解
    // 3. 返回拦截结果

    const useAi = this.config.specDataEgress.aiInterception

    if (useAi) {
      // AI 辅助理解逻辑
      this.ctx.logger.debug('使用 AI 理解 Spec 需求')
      // TODO: 调用 AI 模型
    }

    // 临时实现：基础检查
    return {
      allowed: true,
      reason: 'Spec 数据检查通过',
      timestamp,
      egressType: EgressType.SPEC_DATA,
    }
  }

  /**
   * 更新配置（支持热更新）
   */
  public updateConfig(newConfig: DataEgressControlConfig) {
    this.config = newConfig
    this.logSwitchStatus()
  }

  /**
   * 获取当前配置
   */
  public getConfig(): DataEgressControlConfig {
    return { ...this.config }
  }
}
