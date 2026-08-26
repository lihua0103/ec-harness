import type { Context } from '@deepseek-ai/cordis'

/** 企业设置 UI 的 Host 侧扩展入口。Client 组件应独立放置并通过公开 slots 注册。 */
export default function enterpriseSettings(ctx: Context): void {
  ctx.effect(() => {
    // TODO: 注册企业设置 namespace 与公开 RPC/slot 数据。
    return () => undefined
  })
}
