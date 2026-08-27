/**
 * 企业临床 Listing 插件入口（ADR-0003）
 * 
 * 完全不限 AI 操作：无沙箱、无脱敏信封、无出域检查。
 * 两个模型可见工具 + 系统提示构成引导：
 * 
 * 1. enterprise_listing_inspect - 识别项目 doc/ 内 spec/ALS 文档并全量
 *    解析（字段映射、需求行），扫描并解压项目内 SAS/XPT/CSV 数据集
 *    （zip 密码自动推导），全部数据集以 DataFrame 预载，
 *    返回结构、schema 与预览行（数据值直接可见）。
 * 
 * 2. enterprise_listing_run_code - 在持久 Python 会话里执行模型代码：
 *    datasets（按名取 DataFrame）、pd、np 内置。会话状态跨调用保持，
 *    迭代式开发。
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
          '模型需重新 inspect + run_code。代码必须定义 result 或 outputs 变量作为输出。',
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
          '发布最近一次成功的 run_code 结果到 Excel 文件。' +
          '自动添加 Contents sheet 和必要的系统字段列。',
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
          },
          required: ['project', 'scenario'],
        },
      },
      async (args: { project: string; scenario: string }) => {
        try {
          const result = await worker.request(
            {
              operation: 'listing_publish',
              project: args.project,
              scenario: args.scenario,
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

  ctx.logger?.info('[listing] Enterprise listing plugin loaded')

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
