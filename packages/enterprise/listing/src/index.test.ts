import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject } from './index.js'

// 项目参数经 host 侧校验（存在目录的绝对路径），测试使用真实临时目录。
const STUDY = mkdtempSync(join(tmpdir(), 'dsh-listing-test-'))

const requests: Array<Record<string, unknown>> = []
// 扫描 Worker 是独立进程通道；其请求不计入主车道请求断言序列。
const scanRequests: Array<Record<string, unknown>> = []
const dispose = vi.fn()
vi.mock('./worker.js', () => ({ PythonWorker: class {
  async request(req: Record<string, unknown>): Promise<unknown> {
    if (req.operation === 'listing_scan_init') {
      scanRequests.push(req)
      return { ok: true, ready: true }
    }
    if (req.operation === 'listing_scan_text') scanRequests.push(req)
    else requests.push(req)
    if (req.operation === 'listing_inspect') {
      return {
        ok: true,
        inspection: {
          requirementDocuments: [{ documentId: 'doc-000001', totalChunks: 1 }],
          datasets: [{ name: 'AE', rowCount: 2 }],
        },
      }
    }
    if (req.operation === 'listing_read_document') {
      return {
        ok: true,
        document: { documentId: req.documentId, chunkIndex: req.chunkIndex, isFinal: true },
      }
    }
    if (req.operation === 'listing_run_code' && req.code === 'raise') {
      return {
        ok: false,
        code: 'CODE_EXECUTION_ERROR',
        reason: '代码执行失败；详细诊断保留在 Worker 进程内',
        retryable: true,
        diagnostics: { errorType: 'KeyError', outputsDefined: false },
      }
    }
    if (req.operation === 'listing_run_code') return { ok: true, receipt: { outputCount: 2, publishReady: true } }
    if (req.operation === 'listing_publish') return { ok: true, receipt: { format: 'single-workbook-multi-sheet-xlsx' } }
    if (req.operation === 'listing_scan_text') {
      if (String(req.text).includes('FAIL_SCAN')) return { ok: false, code: 'SCAN_FAILED' }
      return { ok: true, containsProtectedValue: String(req.text).includes('SUBJ-777') }
    }
    return { ok: false, reason: 'Unknown operation' }
  }
  dispose(): void { dispose() }
} }))

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown> }
  execute: (args: unknown, exec: { agent: object; signal: AbortSignal }) => Promise<unknown>
}

function makeContext() {
  const tools = new Map<string, ToolDefinition>()
  const promptSections: Array<{ name: string; order: number; text: string }> = []
  const effectCallbacks: Array<() => () => void> = []
  const postListeners: Array<{
    (exec: { name: string; agent: object }, result: unknown, next: () => Promise<unknown>): Promise<unknown>
  }> = []
  const ctx = {
    tools: { register(definition: ToolDefinition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section(section: { name: string; order: number; text: string }) { promptSections.push(section); return () => undefined } },
    effect(fn: () => () => void) { effectCallbacks.push(fn()); return () => undefined },
    on(name: 'tools/post-execute', listener: (typeof postListeners)[number]) {
      if (name === 'tools/post-execute') postListeners.push(listener)
      return () => undefined
    },
    logger: { info: vi.fn() },
  } as unknown as Context
  return { ctx, tools, promptSections, effectCallbacks, postListeners }
}

describe('enterprise-listing plugin', () => {
  let tools: Map<string, ToolDefinition>
  let promptSections: Array<{ name: string; order: number; text: string }>
  let postListeners: Array<{
    (exec: { name: string; agent: object }, result: unknown, next: () => Promise<unknown>): Promise<unknown>
  }>

  beforeEach(() => {
    requests.length = 0
    scanRequests.length = 0
    dispose.mockClear()
    const made = makeContext()
    tools = made.tools
    promptSections = made.promptSections
    postListeners = made.postListeners
    apply(made.ctx)
  })

  it('声明正式 JSON Schema 并注册五个模型工具', () => {
    expect(inject).toEqual(['tools', 'systemPrompt', 'credentials'])
    expect([...tools.keys()]).toEqual([
      'enterprise_listing_inspect',
      'enterprise_listing_read_metadata',
      'enterprise_listing_read_document',
      'enterprise_listing_run_code',
      'enterprise_listing_publish',
    ])
    for (const tool of tools.values()) expect(tool.output?.schema).toMatchObject({ type: 'object' })
  })

  it('工具 schema 不暴露拦截开关或扩展名配置', () => {
    for (const tool of tools.values()) {
      const properties = (tool.parameters as { properties: Record<string, unknown> }).properties
      expect(properties.redactDisabled).toBeUndefined()
      expect(properties.dataInterception).toBeUndefined()
      expect(properties.datasetExtensions).toBeUndefined()
    }
  })

  it('systemPrompt 注入模板引导与宿主数据安全边界', () => {
    expect(promptSections).toHaveLength(1)
    const text = promptSections[0]?.text || ''
    expect(text).toContain('标准输出范例')
    expect(text).toContain('RT01 标准')
    expect(text).toContain('DM Status Report')
    expect(text).toContain('doc/ 全目录')
    expect(text).toContain('完整进入 requirementDocuments 分片')
    expect(text).toContain('未读完不得 run_code')
    expect(text).toContain('doc/ 外 spec 需求辅助 Excel')
    expect(text).toContain('stdout/stderr 内容省略')
    expect(text).toContain('_layout')
    expect(text).toContain('_skip_default_template')
    expect(text).toContain('执行面不受限')
    expect(text).toContain('enterprise_listing_read_document')
    expect(text).toContain('唯一交付路径')
    expect(text).not.toContain('redactDisabled')
  })

  it('请求只下发宿主开关且不暴露模型可伪造字段', async () => {
    const exec = { agent: {}, signal: new AbortController().signal }
    await tools.get('enterprise_listing_inspect')?.execute({ project: STUDY, scenario: 'medical' }, exec)
    expect(requests[0]).toMatchObject({ hostDataInterception: true })
    expect(requests[0]).not.toHaveProperty('dataInterception')
    expect(requests[0]).not.toHaveProperty('datasetExtensions')
  })

  it('宿主关闭开关时下发内部关闭旗标且忽略扩展名', async () => {
    const legacy = makeContext()
    ;(legacy.ctx as unknown as Record<string, unknown>).dataSecurityService = {
      isEnabled: () => false,
      getDatasetExtensions: () => ['.parquet'],
    }
    apply(legacy.ctx)
    const exec = { agent: {}, signal: new AbortController().signal }
    await legacy.tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, exec)
    expect(requests[0]).toMatchObject({ hostDataInterception: false })
    expect(requests[0]).not.toHaveProperty('datasetExtensions')
    expect(requests[0]).not.toHaveProperty('dataInterception')
  })

  it('credentialRef 由宿主解析且明文密码不出现在模型请求字段', async () => {
    const made = makeContext()
    const expectedCredential = ['ARCHIVE', 'PASSWORD'].join('-')
    ;(made.ctx as unknown as Record<string, unknown>).credentials = {
      resolve: async (ref: string) => ({ value: ref === 'DSH_ARCHIVE_PASSWORD' ? expectedCredential : undefined }),
    }
    apply(made.ctx)
    await made.tools.get('enterprise_listing_inspect')?.execute({
      project: STUDY, credentialRef: 'DSH_ARCHIVE_PASSWORD',
    }, { agent: {}, signal: new AbortController().signal })
    expect(requests.at(-1)).toMatchObject({ credential: expectedCredential })
    expect(requests.at(-1)).not.toHaveProperty('credentialRef')
  })

  it('无效或未配置 credentialRef 不进入 Worker', async () => {
    await expect(tools.get('enterprise_listing_inspect')?.execute({
      project: STUDY, credentialRef: 'not a ref',
    }, { agent: {}, signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'ARCHIVE_CREDENTIAL_REF_INVALID',
    })
    expect(requests).toHaveLength(0)

    const made = makeContext()
    ;(made.ctx as unknown as Record<string, unknown>).credentials = {
      resolve: async () => undefined,
    }
    apply(made.ctx)
    await expect(made.tools.get('enterprise_listing_inspect')?.execute({
      project: STUDY, credentialRef: 'DSH_ARCHIVE_PASSWORD',
    }, { agent: {}, signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'ARCHIVE_CREDENTIAL_NOT_CONFIGURED',
    })
    expect(requests).toHaveLength(0)
  })

  it('宿主开关读取失败时按开启处理', async () => {
    const failing = makeContext()
    ;(failing.ctx as unknown as Record<string, unknown>).dataSecurityService = {
      isEnabled: () => { throw new Error('unavailable') },
    }
    apply(failing.ctx)
    const exec = { agent: {}, signal: new AbortController().signal }
    await failing.tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, exec)
    expect(requests[0]).toMatchObject({ hostDataInterception: true })
  })

  it('publish 请求携带部署配置的 coverLabels', async () => {
    const withConfig = makeContext()
    apply(withConfig.ctx, { reportCoverLabels: ['申办方：\nSponsor:'] })
    const exec = { agent: {}, signal: new AbortController().signal }
    await withConfig.tools.get('enterprise_listing_publish')?.execute(
      { project: STUDY, scenario: 'report' }, exec)
    expect(requests.at(-1)).toMatchObject({ coverLabels: ['申办方：\nSponsor:'] })
  })

  it('run_code 失败回传安全 errorType 与 outputsDefined 诊断', async () => {
    await expect(tools.get('enterprise_listing_run_code')?.execute({ project: STUDY, code: 'raise' }, {
      agent: {}, signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'CODE_EXECUTION_ERROR',
      diagnostics: { errorType: 'KeyError', outputsDefined: false },
      message: '代码执行失败；详细诊断保留在 Worker 进程内（errorType=KeyError，outputsDefined=false）',
    })
  })

  it('通用工具结果命中受保护数据值时 fail-closed 阻断', async () => {
    const agent = {}
    await tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, {
      agent, signal: new AbortController().signal,
    })
    const decision = await postListeners[0]?.(
      { name: 'read', agent },
      { isError: false, value: 'SUBJ-777', content: [] },
      async () => ({ kind: 'accept', value: 'SUBJ-777' }),
    )
    expect(decision).toMatchObject({ kind: 'block' })
    expect(JSON.stringify(decision)).not.toContain('SUBJ-777')
    expect(scanRequests.at(-1)).toMatchObject({ operation: 'listing_scan_text' })
  })

  it('通用工具安全结果正常放行，扫描失败仍阻断', async () => {
    const agent = {}
    await tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, {
      agent, signal: new AbortController().signal,
    })
    const accept = await postListeners[0]?.(
      { name: 'read', agent },
      { isError: false, value: 'ordinary output', content: [] },
      async () => ({ kind: 'accept', value: 'ordinary output' }),
    )
    expect(accept).toMatchObject({ kind: 'accept', value: 'ordinary output' })

    const failed = await postListeners[0]?.(
      { name: 'read', agent },
      { isError: false, value: 'FAIL_SCAN', content: [] },
      async () => ({ kind: 'accept', value: 'FAIL_SCAN' }),
    )
    expect(failed).toMatchObject({ kind: 'block' })
    expect(JSON.stringify(failed)).not.toContain('FAIL_SCAN')
  })

  it('宿主关闭开关后通用工具结果不做扫描或拦截', async () => {
    const made = makeContext()
    ;(made.ctx as unknown as Record<string, unknown>).dataSecurityService = { isEnabled: () => false }
    apply(made.ctx)
    const agent = {}
    await made.tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, {
      agent, signal: new AbortController().signal,
    })
    const scanCountBefore = requests.filter(item => item.operation === 'listing_scan_text').length
    const decision = await made.postListeners[0]?.(
      { name: 'read', agent },
      { isError: false, value: 'SUBJ-777', content: [] },
      async () => ({ kind: 'accept', value: 'SUBJ-777' }),
    )
    expect(decision).toMatchObject({ kind: 'accept', value: 'SUBJ-777' })
    expect(requests.filter(item => item.operation === 'listing_scan_text').length).toBe(scanCountBefore)
  })

  it('按 Agent 隔离并转发 inspect → read_document → run_code → publish', async () => {
    const exec = { agent: {}, signal: new AbortController().signal }
    const inspection = await tools.get('enterprise_listing_inspect')?.execute(
      { project: STUDY, scenario: 'medical' }, exec)
    const document = await tools.get('enterprise_listing_read_document')?.execute(
      { project: STUDY, documentId: 'doc-000001', chunkIndex: 0 }, exec)
    const run = await tools.get('enterprise_listing_run_code')?.execute(
      { project: STUDY, code: 'outputs = {"AE": datasets["AE"]}' }, exec)
    const publish = await tools.get('enterprise_listing_publish')?.execute(
      { project: STUDY, scenario: 'medical', trackChanges: false }, exec)
    expect(inspection).toMatchObject({ requirementDocuments: [{ documentId: 'doc-000001' }] })
    expect(document).toMatchObject({ documentId: 'doc-000001', isFinal: true })
    expect(run).toEqual({ outputCount: 2, publishReady: true })
    expect(publish).toMatchObject({ format: 'single-workbook-multi-sheet-xlsx' })
    expect(requests.map(item => item.operation)).toEqual([
      'listing_inspect', 'listing_read_document', 'listing_run_code', 'listing_publish',
    ])
  })

  it('Agent 生命周期释放对应 PythonWorker（主车道 + 专用扫描）', async () => {
    const made = makeContext()
    apply(made.ctx)
    const agentCleanups: Array<() => void> = []
    const agent = {
      ctx: { effect(fn: () => () => void) { agentCleanups.push(fn()); return () => undefined } },
    }
    const exec = { agent, signal: new AbortController().signal }
    await made.tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, exec)
    expect(agentCleanups).toHaveLength(2)
    for (const cleanup of agentCleanups) cleanup()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('插件卸载时释放仍存活的 Worker（主车道 + 专用扫描）', async () => {
    const made = makeContext()
    apply(made.ctx)
    const exec = { agent: {}, signal: new AbortController().signal }
    await made.tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, exec)
    expect(made.effectCallbacks).toHaveLength(2)
    for (const pluginCleanup of made.effectCallbacks) pluginCleanup()
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})
