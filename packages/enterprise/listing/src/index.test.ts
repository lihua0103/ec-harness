import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject } from './index.js'

const requests: Array<Record<string, unknown>> = []
const dispose = vi.fn()
vi.mock('./worker.js', () => ({ PythonWorker: class {
  async request(req: Record<string, unknown>): Promise<unknown> {
    requests.push(req)
    if (req.operation === 'listing_inspect') return { ok: true, inspection: { project: req.project, datasets: ['AE'] } }
    if (req.operation === 'listing_run_code') return { ok: true, receipt: { outputCount: 2, publishReady: true } }
    if (req.operation === 'listing_publish') return { ok: true, receipt: { format: 'single-workbook-multi-sheet-xlsx', outputFile: 'MEDICAL_LISTINGS.xlsx' } }
    return { ok: false, reason: 'Unknown operation' }
  }
  dispose(): void { dispose() }
} }))

interface ToolDefinition {
  name: string; description: string; parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown> }
  execute: (args: unknown, exec: { agent: object; signal: AbortSignal }) => Promise<unknown>
}

describe('enterprise-listing plugin', () => {
  let tools: Map<string, ToolDefinition>
  let promptSections: Array<{ name: string; order: number; text: string }>
  let cleanup: (() => void) | undefined
  beforeEach(() => {
    requests.length = 0; dispose.mockClear(); tools = new Map(); promptSections = []; cleanup = undefined
    const ctx = {
      tools: { register(definition: ToolDefinition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
      systemPrompt: { section(section: { name: string; order: number; text: string }) { promptSections.push(section); return () => undefined } },
      effect(fn: () => () => void) { cleanup = fn(); return cleanup }, logger: { info: vi.fn() },
    } as unknown as Context
    apply(ctx)
  })

  it('声明正式 JSON Schema 并注册三个模型工具', () => {
    expect(inject).toEqual(['tools', 'systemPrompt'])
    expect([...tools.keys()]).toEqual(['enterprise_listing_inspect', 'enterprise_listing_run_code', 'enterprise_listing_publish'])
    for (const tool of tools.values()) expect(tool.output?.schema).toMatchObject({ type: 'object' })
  })

  it('向模型注入不可绕过的 Multi-Sheet 发布约束', () => {
    expect(promptSections).toHaveLength(1)
    expect(promptSections[0]?.text).toContain('必须定义 outputs 字典')
    expect(promptSections[0]?.text).toContain('publish 是唯一交付路径')
    expect(promptSections[0]?.text).toContain('manual/medical 使用 RT01 标准结构')
    expect(promptSections[0]?.text).toContain('report 使用 DM Status Report 标准')
  })

  it('按 Agent 隔离并转发 inspect → run_code → publish', async () => {
    const exec = { agent: {}, signal: new AbortController().signal }
    await tools.get('enterprise_listing_inspect')?.execute({ project: '/study', scenario: 'medical' }, exec)
    const run = await tools.get('enterprise_listing_run_code')?.execute({ project: '/study', code: 'outputs = {"AE": datasets["AE"]}' }, exec)
    const publish = await tools.get('enterprise_listing_publish')?.execute({ project: '/study', scenario: 'medical', trackChanges: false }, exec)
    expect(run).toEqual({ outputCount: 2, publishReady: true })
    expect(publish).toMatchObject({ format: 'single-workbook-multi-sheet-xlsx' })
    expect(requests.map(item => item.operation)).toEqual(['listing_inspect', 'listing_run_code', 'listing_publish'])
  })

  it('卸载插件时释放已经创建的 Worker', async () => {
    const exec = { agent: {}, signal: new AbortController().signal }
    await tools.get('enterprise_listing_inspect')?.execute({ project: '/study' }, exec)
    cleanup?.()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
