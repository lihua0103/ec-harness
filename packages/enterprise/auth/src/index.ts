import type { Context } from '@deepseek-ai/cordis'

/** 企业认证扩展的生命周期入口。认证实现必须接入企业身份平台。 */
export default function enterpriseAuth(ctx: Context): void {
  ctx.effect(() => {
    // TODO: 注册企业身份服务、凭证解析器和登出清理逻辑。
    return () => undefined
  })
}
