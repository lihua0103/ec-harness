import { Context } from '@deepseek-ai/cordis'

/**
 * 企业认证插件示例
 * 在 Cordis 启动时注册一个只读服务，Web UI 可通过 ctx.enterpriseAuth 读取登录态。
 */
export function apply(ctx: Context) {
  ctx.effect(() => {
    const dispose = ctx.set('enterpriseAuth', {
      provider: 'sso-example',
      check(token: string) {
        // TODO: 替换为企业 SSO 校验逻辑
        return token.startsWith('guard-')
      },
    })
    return () => dispose()
  })
}
