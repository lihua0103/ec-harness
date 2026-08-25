import { Context, Service } from '@deepseek-ai/cordis'

/**
 * 企业认证配置
 *
 * 注意：cordis v4 不再导出 Schema（Schema 由独立的 @deepseek-ai/schemastery
 * 提供）。这里用 TypeScript 接口 + 默认值常量做配置契约，避免引入未安装的依赖。
 */
export interface Config {
  enabled: boolean
  provider: 'ldap' | 'oauth2' | 'saml'
  sessionTimeout: number
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: Config = {
  enabled: true,
  provider: 'oauth2',
  sessionTimeout: 3600000,
}

/**
 * 企业认证服务
 */
export class EnterpriseAuthService extends Service {
  public config: Config

  constructor(ctx: Context, config: Partial<Config> = {}) {
    // cordis v4 的 Service 构造签名为 (ctx, name)
    super(ctx, 'enterpriseAuth')
    this.config = { ...DEFAULT_CONFIG, ...config }

    if (!this.config.enabled) {
      ctx.logger.info('企业认证已禁用')
      return
    }

    ctx.logger.info(`企业认证服务已启动，使用 ${this.config.provider} 提供商`)
  }

  /**
   * 用户认证
   */
  async authenticate(username: string, _password: string) {
    if (!this.config.enabled) {
      throw new Error('企业认证未启用')
    }
    this.ctx.logger.info(`用户认证: ${username}`)
    // TODO: 按 provider 分派到 LDAP / OAuth2 / SAML 具体实现
    throw new Error(`认证提供商 ${this.config.provider} 尚未实现`)
  }
}

export const name = '@dsh-guard/enterprise-auth'

export const Config = DEFAULT_CONFIG

export function apply(ctx: Context, config: Partial<Config> = {}) {
  ctx.plugin(EnterpriseAuthService, config)
}

// TypeScript 模块扩展
declare module '@deepseek-ai/cordis' {
  interface Context {
    enterpriseAuth: EnterpriseAuthService
  }
}
