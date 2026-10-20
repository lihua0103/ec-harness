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
    if (req.operation === 'listing_run_code' && req.code === 'hint') {
      return {
        ok: false,
        code: 'CODE_EXECUTION_ERROR',
        reason: '代码执行失败；详细诊断保留在 Worker 进程内',
        retryable: true,
        diagnostics: { errorType: 'NameError', outputsDefined: false, stage: 'execute' },
        environmentHint: '命名空间: datasets, pd, np, outputs(须自行定义)',
        failures: [{ path: 'aux/bad.xlsx', stage: 'read-aux', code: 'PARSE_FAILED' }],
      }
    }
    if (req.operation === 'listing_run_code') return { ok: true, receipt: { outputCount: 2, publishReady: true } }
    if (req.operation === 'listing_analyze') {
      const receipt = req.analyzeOperation === 'run_status'
        ? { analyzeOperation: 'run_status', hasSuccessfulRun: false, outputCount: 0, snapshotId: 'snap-test' }
        : { analyzeOperation: req.analyzeOperation, totalRowCount: 2, uniqueConclusion: 'unique', snapshotId: 'snap-test' }
      return { ok: true, receipt }
    }
    if (req.operation === 'listing_publish') return { ok: true, receipt: { format: 'single-workbook-multi-sheet-xlsx' } }
    if (req.operation === 'listing_scan_text') {
      if (String(req.text).includes('FORBIDDEN_VALUE')) return { ok: false, code: 'SCAN_ENGINE_ERROR' }
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

  it('声明正式 JSON Schema 并注册九个模型工具（含受控分析 / 场景知识库 / r_manual / r_pk 车道）', () => {
    expect(inject).toEqual(['tools', 'systemPrompt', 'credentials'])
    expect([...tools.keys()]).toEqual([
      'enterprise_listing_inspect',
      'enterprise_listing_read_metadata',
      'enterprise_listing_analyze',
      'enterprise_listing_read_document',
      'enterprise_listing_run_code',
      'enterprise_listing_publish',
      'enterprise_listing_kb',
      'enterprise_listing_run_r',
      'enterprise_listing_run_pk',
    ])
    for (const tool of tools.values()) expect(tool.output?.schema).toMatchObject({ type: 'object' })
  })

  it('analyze 工具按受控合同透传结构化参数并返回计数回执（T06）', async () => {
    const exec = { agent: {}, signal: new AbortController().signal }
    const receipt = await tools.get('enterprise_listing_analyze')?.execute({
      project: STUDY, analyzeOperation: 'key_check', input: 'AE', keys: ['USUBJID'],
    }, exec) as Record<string, unknown>
    expect(receipt).toMatchObject({ analyzeOperation: 'key_check', uniqueConclusion: 'unique' })
    expect(requests.at(-1)).toMatchObject({
      operation: 'listing_analyze', analyzeOperation: 'key_check', input: 'AE',
    })
    await expect(tools.get('enterprise_listing_analyze')?.execute({
      project: STUDY, analyzeOperation: 'run_status',
    }, exec)).resolves.toMatchObject({ hasSuccessfulRun: expect.anything() })
  })

  it('注册场景知识库工具与五场景路由 section（order 116）', async () => {
    const section = promptSections.find(item => item.name === 'knowledge:listing-scenarios')
    expect(section?.order).toBe(116)
    expect(section?.text).toContain('enterprise_listing_kb')
    expect(section?.text).toContain('pk-mapping')
    expect(section?.text).toContain('禁止猜场景')
    const tool = tools.get('enterprise_listing_kb')
    const properties = tool?.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(properties.required).toEqual(['scenario'])
    expect(properties.properties.scenario).toMatchObject({ enum: ['router', 'manual', 'pk-mapping', 'medical', 'rbqm', 'report'] })
    const result = await tool?.execute(
      { scenario: 'manual' },
      { agent: {}, signal: new AbortController().signal },
    ) as { scenario: string; topic: string; content: string }
    expect(result.scenario).toBe('manual')
    expect(result.content).toContain('G1 医学编码')
    const deep = await tool?.execute(
      { scenario: 'manual', topic: 'pitfalls' },
      { agent: {}, signal: new AbortController().signal },
    ) as { content: string }
    expect(deep.content).toContain('预防索引')
    await expect(tool?.execute(
      { scenario: 'manual', topic: 'nope' },
      { agent: {}, signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'KB_TOPIC_INVALID' })
    await expect(tool?.execute(
      { scenario: 'nope' },
      { agent: {}, signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'KB_SCENARIO_INVALID' })
  })

  it('工具 schema 不暴露拦截开关或扩展名配置', () => {
    for (const tool of tools.values()) {
      const properties = (tool.parameters as { properties: Record<string, unknown> }).properties
      expect(properties.redactDisabled).toBeUndefined()
      expect(properties.dataInterception).toBeUndefined()
      expect(properties.datasetExtensions).toBeUndefined()
    }
  })

  it('systemPrompt 注入 r_manual 车道引导（order 117，项目输入由用户提供）', () => {
    const section = promptSections.find(item => item.name === 'tool:enterprise-listing-r')
    expect(section?.order).toBe(117)
    expect(section?.text).toContain('enterprise_listing_run_r')
    expect(section?.text).toContain('不要猜测或从其他材料推断')
    expect(section?.text).toContain('render=false')
    expect(section?.text).toContain('/mnt/project')
    const tool = tools.get('enterprise_listing_run_r')
    const properties = (tool?.parameters as { properties: Record<string, unknown>; required: string[] })
    expect(properties.required).toEqual(['project', 'studyKey', 'dataDate'])
  })

  it('systemPrompt 注入 r_pk 车道引导（order 118，双盲口径与目录契约）', () => {
    const section = promptSections.find(item => item.name === 'tool:enterprise-listing-pk')
    expect(section?.order).toBe(118)
    expect(section?.text).toContain('enterprise_listing_run_pk')
    expect(section?.text).toContain('02_Raw_csv/PK Mapping')
    expect(section?.text).toContain('01_Raw_sas/PK Mapping')
    expect(section?.text).toContain('SAS_Program/SAS_program/PK Mapping')
    expect(section?.text).toContain('blindMode=blinded')
    expect(section?.text).toContain('LISTING_PK_MAPPING_DESIGN.md')
    const tool = tools.get('enterprise_listing_run_pk')
    const properties = (tool?.parameters as { properties: Record<string, unknown>; required: string[] })
    expect(properties.required).toEqual(['project', 'studyKey', 'dataDate'])
    expect(properties.properties.redactDisabled).toBeUndefined()
  })

  it('run_r 不经过 Python Worker，且项目根来自部署配置', async () => {
    const made = makeContext()
    apply(made.ctx, { rListing: { projectRoot: 'D:/deploy/projects' } })
    const section = made.promptSections.find(item => item.name === 'tool:enterprise-listing-r')
    expect(section?.text).toContain('D:/deploy/projects')
    await expect(made.tools.get('enterprise_listing_run_r')?.execute(
      { project: 'nope', studyKey: 'X-1', dataDate: '20260907' },
      { agent: {}, signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    expect(requests).toHaveLength(0)
  })

  it('systemPrompt 注入模板引导与宿主数据安全边界', () => {
    expect(promptSections).toHaveLength(4)
    const text = promptSections[0]?.text || ''
    expect(text).toContain('标准输出范例')
    expect(text).toContain('RT01 标准')
    expect(text).toContain('DM Status Report')
    expect(text).toContain('doc/ 全目录')
    expect(text).toContain('完整进入 requirementDocuments 分片')
    expect(text).toContain('不必整本读入上下文')
    expect(text).toContain('unreadRequirementChunkCount')
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

  it('失败回执透传 environmentHint 与 failures 到模型可见消息（P0/T03）', async () => {
    await expect(tools.get('enterprise_listing_run_code')?.execute({ project: STUDY, code: 'hint' }, {
      agent: {}, signal: new AbortController().signal,
    })).rejects.toSatisfy((error: Error) => {
      expect(error.message).toContain('stage=execute')
      expect(error.message).toContain('环境提示：命名空间: datasets')
      expect(error.message).toContain('输入失败：')
      expect(error.message).toContain('aux/bad.xlsx: PARSE_FAILED')
      expect((error as unknown as { failures?: unknown[] }).failures).toHaveLength(1)
      return true
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
      { isError: false, value: 'FORBIDDEN_VALUE', content: [] },
      async () => ({ kind: 'accept', value: 'FORBIDDEN_VALUE' }),
    )
    expect(failed).toMatchObject({ kind: 'block' })
    expect(JSON.stringify(failed)).not.toContain('FORBIDDEN_VALUE')
  })

  it('扫描基础设施故障分类回执，不再与真实命中共用"受保护数据"文案（P0/T03）', async () => {
    const agent = {}
    await tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, {
      agent, signal: new AbortController().signal,
    })
    const failed = await postListeners[0]?.(
      { name: 'read', agent },
      { isError: false, value: 'FORBIDDEN_VALUE', content: [] },
      async () => ({ kind: 'accept' }),
    )
    expect(failed).toMatchObject({ kind: 'block' })
    const text = JSON.stringify(failed)
    expect(text).toContain('SCAN_FAILED')
    expect(text).toContain('基础设施故障')
    expect(text).toContain('不是检测到数据')
    expect(text).not.toContain('受保护临床数据值')
  })

  it('真实命中仍使用"受保护数据"口径并保持扣留', async () => {
    const agent = {}
    await tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, {
      agent, signal: new AbortController().signal,
    })
    const hit = await postListeners[0]?.(
      { name: 'read', agent },
      { isError: false, value: 'SUBJ-777', content: [] },
      async () => ({ kind: 'accept' }),
    )
    expect(hit).toMatchObject({ kind: 'block' })
    expect(JSON.stringify(hit)).toContain('受保护临床数据值')
  })

  it('交付目录豁免只认路径参数：结果文本含 Output/04_Out 不再整体放行（P0/T02）', async () => {
    const agent = {}
    await tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, {
      agent, signal: new AbortController().signal,
    })
    // 旧逻辑：结果文本任意位置出现 Output\04_Out 即整体放行（绕过面）。
    const blocked = await postListeners[0]?.(
      { name: 'read', agent },
      { isError: false, value: 'report copied from Output\\04_Out for SUBJ-777', content: [] },
      async () => ({ kind: 'accept' }),
    )
    expect(blocked).toMatchObject({ kind: 'block' })
  })

  it('路径参数命中交付目录仍放行（过渡期读取已生成交付物）', async () => {
    const agent = {}
    await tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, {
      agent, signal: new AbortController().signal,
    })
    const accepted = await postListeners[0]?.(
      { name: 'read', agent, arguments: { file_path: 'D:/study/Output/04_Out/report.xlsx' } },
      { isError: false, value: 'SUBJ-777', content: [] },
      async () => ({ kind: 'accept', value: 'SUBJ-777' }),
    )
    expect(accepted).toMatchObject({ kind: 'accept', value: 'SUBJ-777' })
  })

  it('additionalContexts 两侧拼接面都扫描（P0 修复单侧 ?? 漏扫）', async () => {
    const agent = {}
    await tools.get('enterprise_listing_inspect')?.execute({ project: STUDY }, {
      agent, signal: new AbortController().signal,
    })
    // 决策侧上下文干净、原结果侧上下文携带受保护值：旧逻辑 ?? 只取决策侧 → 漏扫放行。
    const blocked = await postListeners[0]?.(
      { name: 'read', agent },
      {
        isError: false, value: 'clean', content: [],
        additionalContexts: [{ type: 'text', text: 'hidden ctx SUBJ-777' }],
      },
      async () => ({
        kind: 'accept',
        additionalContexts: [{ type: 'text', text: 'clean decision ctx' }],
      }),
    )
    expect(blocked).toMatchObject({ kind: 'block' })
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
