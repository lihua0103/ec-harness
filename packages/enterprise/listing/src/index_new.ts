/**
 * 企业临床 Listing 插件入口（ADR-0003 + 多 Sheet 规范化）
 * 
 * 更新：
 * 1. publish 操作自动生成多 sheet Excel（包含 Contents 页）
 * 2. 新增 merge_listings 工具用于迁移现有单文件输出
 * 3. 统一样式规范应用
 */
import type { Context } from '@deepseek-ai/cordis'
import { PythonWorker } from './worker.js'

export const name = 'enterprise-listing'

const FAST_TIMEOUT_MS = 30_000
const HEAVY_TIMEOUT_MS = 900_000

export function apply(ctx: Context): void {
  const worker = new PythonWorker()
  const disposers: Array<() => void> = []

  // Tool 1: enterprise_listing_inspect
  disposers.push(
    (ctx as any).command(
      {
        name: 'enterprise_listing_inspect',
        description:
          '识别项目 doc/ 下 spec/ALS（Excel/Word），解析字段定义、表单需求、数据集列表。' +
          '扫描项目内 SAS/XPT/CSV 数据集（.zip 密码自动推导），' +
          '全部 DataFrame 预载并返回结构、schema、预览行。调用后数据集持久保留在会话，' +
          'run_code 直接按名取用。建议 inspect 仅调用一次，之后反复 run_code 迭代产出。',
        parameters: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'harness 项目绝对路径',
            },
            scenario: {
              type: 'string',
              enum: ['medical', 'rbqm', 'manual', 'report'],
              description: 'Listing 场景类型（可选，自动推断）',
            },
            credentialRef: {
              type: 'string',
              description: '加密归档的显式凭据引用（可选）',
            },
          },
          required: ['project'],
        },
      },
      async (args: { project: string; scenario?: string; credentialRef?: string }) => {
        try {
          const result = await worker.request(
            {
              operation: 'listing_inspect',
              project: args.project,
              scenario: args.scenario,
              credentialRef: args.credentialRef,
            },
            HEAVY_TIMEOUT_MS
          )

          if (!result.ok) {
            throw Object.assign(
              new Error(result.reason || 'inspect failed'),
              { code: result.code || 'INSPECT_ERROR', expose: true }
            )
          }

          return result.inspection
        } catch (err: any) {
          throw Object.assign(
            new Error(err.message || 'inspect 执行失败'),
            { code: err.code || 'INSPECT_ERROR', expose: true }
          )
        }
      }
    )
  )

  // Tool 2: enterprise_listing_run_code
  disposers.push(
    (ctx as any).command(
      {
        name: 'enterprise_listing_run_code',
        description:
          '在持久 Python 会话执行代码。内置：datasets（dict，按名取 DataFrame）、' +
          'pd、np。会话状态跨调用保持，可迭代开发；超时或进程崩溃后自动重置，' +
          '模型需重新 inspect + run_code。代码必须定义 result 或 outputs 变量作为输出。' +
          'outputs 应为字典，格式 {sheet_name: DataFrame}，用于生成多 sheet Excel。',
        parameters: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'harness 项目绝对路径',
            },
            code: {
              type: 'string',
              description: 'Python 代码（支持多行，可用 df.head()/print 预览数据）',
            },
            credentialRef: {
              type: 'string',
              description: '加密归档的显式凭据引用（可选）',
            },
          },
          required: ['project', 'code'],
        },
      },
      async (args: { project: string; code: string; credentialRef?: string }) => {
        try {
          const result = await worker.request(
            {
              operation: 'listing_run_code',
              project: args.project,
              code: args.code,
              credentialRef: args.credentialRef,
            },
            FAST_TIMEOUT_MS
          )

          if (!result.ok) {
            throw Object.assign(
              new Error(result.reason || 'run_code failed'),
              { code: result.code || 'RUN_CODE_ERROR', expose: true, retryable: result.retryable }
            )
          }

          return result.receipt
        } catch (err: any) {
          throw Object.assign(
            new Error(err.message || 'run_code 执行失败'),
            { code: err.code || 'RUN_CODE_ERROR', expose: true }
          )
        }
      }
    )
  )

  // Tool 3: enterprise_listing_publish
  disposers.push(
    (ctx as any).command(
      {
        name: 'enterprise_listing_publish',
        description:
          '发布最近一次成功的 run_code 结果到多 Sheet Excel 文件。' +
          '自动生成 Contents 目录页，应用场景样式规范，支持变化追踪。' +
          '如果 outputs 包含多个 DataFrame，每个会成为独立的 sheet。',
        parameters: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'harness 项目绝对路径',
            },
            scenario: {
              type: 'string',
              enum: ['medical', 'rbqm', 'manual', 'report'],
              description: 'Listing 场景类型',
            },
            trackChanges: {
              type: 'boolean',
              description: '是否追踪相对上一版本的变化（默认 true）',
            },
          },
          required: ['project', 'scenario'],
        },
      },
      async (args: { project: string; scenario: string; trackChanges?: boolean }) => {
        try {
          const result = await worker.request(
            {
              operation: 'listing_publish',
              project: args.project,
              scenario: args.scenario,
              trackChanges: args.trackChanges !== false,
            },
            HEAVY_TIMEOUT_MS
          )

          if (!result.ok) {
            throw Object.assign(
              new Error(result.reason || 'publish failed'),
              { code: result.code || 'PUBLISH_ERROR', expose: true }
            )
          }

          return result.receipt
        } catch (err: any) {
          throw Object.assign(
            new Error(err.message || 'publish 执行失败'),
            { code: err.code || 'PUBLISH_ERROR', expose: true }
          )
        }
      }
    )
  )

  // Tool 4: enterprise_listing_merge (新增，用于迁移)
  disposers.push(
    (ctx as any).command(
      {
        name: 'enterprise_listing_merge',
        description:
          '合并现有的多个单独 listing Excel 文件到一个多 Sheet 文件。' +
          '用于从旧的单文件输出模式迁移到新的多 Sheet 规范。' +
          '自动生成 Contents 页并应用样式。',
        parameters: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'harness 项目绝对路径',
            },
            scenario: {
              type: 'string',
              enum: ['medical', 'rbqm', 'manual', 'report'],
              description: 'Listing 场景类型',
            },
            sourceDir: {
              type: 'string',
              description: '源 listing 文件目录（可选，默认为 .clinical-listing/output/{scenario}）',
            },
          },
          required: ['project', 'scenario'],
        },
      },
      async (args: { project: string; scenario: string; sourceDir?: string }) => {
        try {
          const result = await worker.request(
            {
              operation: 'listing_merge',
              project: args.project,
              scenario: args.scenario,
              sourceDir: args.sourceDir,
            },
            HEAVY_TIMEOUT_MS
          )

          if (!result.ok) {
            throw Object.assign(
              new Error(result.reason || 'merge failed'),
              { code: result.code || 'MERGE_ERROR', expose: true }
            )
          }

          return result.receipt
        } catch (err: any) {
          throw Object.assign(
            new Error(err.message || 'merge 执行失败'),
            { code: err.code || 'MERGE_ERROR', expose: true }
          )
        }
      }
    )
  )

  ctx.logger?.info('[listing] Enterprise listing plugin loaded with multi-sheet support')

  if ((ctx as any).acceptHmr) {
    ;(ctx as any).acceptHmr(import.meta.url, (replacement: any) => {
      disposers.push(...replacement.apply(ctx))
    })
  }

  ctx.effect(() => () => {
    for (let i = disposers.length - 1; i >= 0; i--) disposers[i]()
    worker.dispose()
  })
}
