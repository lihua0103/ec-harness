import type { Context } from '@deepseek-ai/cordis'
import type { DataSecurityService } from '@dsh-enterprise/ui-settings'

interface ToolExecution {
  name: string
  args: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context { dataSecurityService: DataSecurityService }
  interface Events {
    'data-security/check-file': (filePath: string) => { allowed: boolean; reason?: string }
    'data-security/changed': (enabled: boolean) => void
    'tools/pre-execute': (exec: ToolExecution, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>
  }
}

/** 
 * 数据安全策略：拦截向模型暴露真实临床数据的行为。
 * 
 * 允许：
 * - inspect 返回元数据（文件列表、变量名、行数统计）
 * - run_code 执行模型编写的代码（模型不直接读数据）
 * - publish 生成输出文件路径
 * 
 * 拦截点在 Python Worker 内部：
 * - 不返回 df.head() 等样本数据
 * - 不在 receipt 中输出数据行
 * - systemPrompt 指导模型不要 print 数据
 */
export function apply(ctx: Context): void {
  // 数据安全开关当前只影响 Python Worker 内部行为，
  // 在 tools/pre-execute 层面不拦截，以允许基于元数据的代码生成。
  // 
  // 若需要完全禁用 Listing（如公网环境），应在 Profile 配置中移除 enterprise-listing 插件。
}

export const name = 'data-interceptor'
