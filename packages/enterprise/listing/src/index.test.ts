import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject } from './index.js'

const requests: Array<Record<string, unknown>> = []
const dispose = vi.fn()
vi.mock('./worker.js', () => ({ PythonWorker: class {
  async request(req: Record<string, unknown>): Promise<unknown> {
    requests.push(req)
    if (req.operation === 'listing_inspect') return { ok: true, inspection: { project: req.project, datasets: ['AE'], dataInterception: req.dataInterception } }
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

function makeContext(dataSecurityService?: { isEnabled(): boolean; getDatasetExtensions?(): string[] }) {
  const tools = new Map<string, ToolDefinition>()
  const promptSections: Array<{ name: string; order: number; text: string }> = []
  const ctx = {
    tools: { register(definition: ToolDefinition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section(section: { name: string; order: number; text: string }) { promptSections.push(section); return () => undefined } },
    dataSecurityService,
    effect(fn: () => () => void) { return fn() }, logger: { info: vi.fn() },
  } as unknown as Context
  return { ctx, tools, promptSections }
}

describe('enterprise-listing plugin', () => {
  let tools: Map<string, ToolDefinition>
  let promptSections: Array<{ name: string; order: number; text: string }>
  let cleanup: (() => void) | undefined
  beforeEach(() => {
    requests.length = 0; dispose.mockClear()
    const made = makeContext()
    tools = made.tools; promptSections = made.promptSections
    apply(made.ctx)
    cleanup = undefined
  })

  it('声明正式 JSON Schema 并注册三个模型工具', () => {
    expect(inject).toEqual(['tools', 'systemPrompt'])
    expect([...tools.keys()]).toEqual(['enterprise_listing_inspect', 'enterprise_listing_run_code', 'enterprise_listing_publish'])
    for (const tool of tools.values()) expect(tool.output?.schema).toMatchObject({ type: 'object' })
  })

  it('工具 schema 不暴露任何拦截开关（审计 P0-1：模型不可关闭红线）', () => {
    for (const tool of tools.values()) {
      const properties = (tool.parameters as { properties: Record<string, unknown> }).properties
      expect(properties.redactDisabled).toBeUndefined()
      expect(properties.dataInterception).toBeUndefined()
    }
  })

  it('systemPrompt 注入模板引导 + 新口径数据可见性', () => {
    expect(promptSections).toHaveLength(1)
    const text = promptSections[0]?.text || ''
    expect(text).toContain('标准输出范例')
    expect(text).toContain('RT01 标准')
    expect(text).toContain('DM Status Report')
    expect(text).toContain('数据可见性')
    expect(text).toContain('doc/ 需求材料')
    expect(text).toContain('全量可读')
    expect(text).toContain('元数据')
    expect(text).toContain('通用工具（shell/文件读写）触碰数据集文件会被部署方拒绝')
    expect(text).toContain('environmentHint')
    expect(text).toContain('_layout')
    expect(text).toContain('_skip_default_template')
    expect(text).toContain('enterprise_listing_run_code')
    expect(text).toContain('唯一交付路径')
    expect(text).toContain('中间/临时文件随意')
    expect(text).toContain('执行面不受限')
    expect(text).not.toContain('redactDisabled')
  })

  it('服务未装配时 fail-closed：旗标恒为 true', async () => {
    const exec = { agent: {}, signal: new AbortController().signal }
    await tools.get('enterprise_listing_inspect')?.execute({ project: '/study', scenario: 'medical' }, exec)
    expect(requests[0]).toMatchObject({ dataInterception: true })
  })

  it('宿主开关接线：isEnabled()=false → 旗标 false；读取抛错 → 仍 true', async () => {
    const off = makeContext({ isEnabled: () => false })
    apply(off.ctx)
    const exec = { agent: {}, signal: new AbortController().signal }
    await off.tools.get('enterprise_listing_inspect')?.execute({ project: '/study' }, exec)
    await off.tools.get('enterprise_listing_run_code')?.execute({ project: '/study', code: 'outputs = {}' }, exec)
    expect(requests[0]).toMatchObject({ dataInterception: false })
    expect(requests[1]).toMatchObject({ dataInterception: false })

    requests.length = 0
    const broken = makeContext({ isEnabled: () => { throw new Error('config unreadable') } })
    apply(broken.ctx)
    await broken.tools.get('enterprise_listing_inspect')?.execute({ project: '/study' }, exec)
    expect(requests[0]).toMatchObject({ dataInterception: true })
  })

  it('宿主扩展名单单源下发（审计 B-3）：getDatasetExtensions() 进请求；抛错则不下发', async () => {
    const withExtensions = makeContext({
      isEnabled: () => true,
      getDatasetExtensions: () => ['.sas7bdat', '.xpt'],
    })
    apply(withExtensions.ctx)
    const exec = { agent: {}, signal: new AbortController().signal }
    await withExtensions.tools.get('enterprise_listing_inspect')?.execute({ project: '/study' }, exec)
    expect(requests[0]).toMatchObject({ datasetExtensions: ['.sas7bdat', '.xpt'] })

    requests.length = 0
    const broken = makeContext({
      isEnabled: () => true,
      getDatasetExtensions: () => { throw new Error('unreadable') },
    })
    apply(broken.ctx)
    await broken.tools.get('enterprise_listing_inspect')?.execute({ project: '/study' }, exec)
    expect(requests[0].datasetExtensions).toBeUndefined()   // worker 回落内置默认
  })

  it('publish 请求携带部署配置的 coverLabels（审计 C-9：申办方名不写死代码）', async () => {
    const withConfig = makeContext()
    apply(withConfig.ctx, { reportCoverLabels: ['申办方：\nSponsor:'] })
    const exec = { agent: {}, signal: new AbortController().signal }
    await withConfig.tools.get('enterprise_listing_publish')?.execute({ project: '/study', scenario: 'report' }, exec)
    expect(requests.at(-1)).toMatchObject({ coverLabels: ['申办方：\nSponsor:'] })
  })

  it('按 Agent 隔离并转发 inspect → run_code → publish', async () => {
    const exec = { agent: {}, signal: new AbortController().signal }
    await tools.get('enterprise_listing_inspect')?.execute({ project: '/study', scenario: 'medical' }, exec)
    const run = await tools.get('enterprise_listing_run_code')?.execute({ project: '/study', code: 'outputs = {"AE": datasets["AE"]}' }, exec)
    const publish = await tools.get('enterprise_listing_publish')?.execute(
      { project: '/study', scenario: 'medical', trackChanges: false }, exec)
    expect(run).toEqual({ outputCount: 2, publishReady: true })
    expect(publish).toMatchObject({ format: 'single-workbook-multi-sheet-xlsx' })
    expect(requests.map(item => item.operation)).toEqual(['listing_inspect', 'listing_run_code', 'listing_publish'])
  })

  it('卸载插件时释放已经创建的 Worker', async () => {
    const made = makeContext()
    const disposeHook = vi.fn()
    const ctx = {
      ...made.ctx,
      effect(fn: () => () => void) { cleanup = fn(); disposeHook(); return cleanup },
    } as unknown as Context
    apply(ctx)
    const exec = { agent: {}, signal: new AbortController().signal }
    await made.tools.get('enterprise_listing_inspect')?.execute({ project: '/study' }, exec)
    cleanup?.()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
