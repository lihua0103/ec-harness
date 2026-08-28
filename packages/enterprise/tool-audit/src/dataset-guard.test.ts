import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DATASET_EXTENSIONS,
  buildDatasetPattern,
  datasetDenyReason,
  findDatasetReference,
  guardFlags,
  registerDatasetGuard,
  type GuardContext,
  type PreToolDecisionLike,
  type ToolExecutionLike,
  UNSCANNABLE_ARGUMENTS,
} from './dataset-guard.ts'

const pattern = buildDatasetPattern(DEFAULT_DATASET_EXTENSIONS)
const next = (): Promise<PreToolDecisionLike> => Promise.resolve({ kind: 'allow' })
const toolExec = (name: string, args: unknown): ToolExecutionLike => ({ name, arguments: args })

function waterfallHarness(service?: GuardContext['dataSecurityService']) {
  const listeners: Array<(exec: ToolExecutionLike, next: () => Promise<PreToolDecisionLike>) => Promise<PreToolDecisionLike>> = []
  const dispose = vi.fn()
  const ctx: GuardContext = {
    on: (_event, listener) => { listeners.push(listener); return dispose },
    dataSecurityService: service,
  }
  const disposer = registerDatasetGuard(ctx)
  return { listeners, dispose, disposer }
}

function guardHarness(service?: GuardContext['dataSecurityService']) {
  const listeners: Array<(exec: ToolExecutionLike, next: () => Promise<PreToolDecisionLike>) => Promise<PreToolDecisionLike>> = []
  const ctx: GuardContext = { on: (_e, l) => { listeners.push(l); return () => undefined }, dataSecurityService: service }
  registerDatasetGuard(ctx)
  return listeners[0]
}

describe('buildDatasetPattern / findDatasetReference', () => {
  it('匹配命令字符串里的数据集文件引用（含 Windows 反斜杠路径与大小写）', () => {
    expect(findDatasetReference({ command: "python -c \"import pandas; pandas.read_sas('raw/dm.sas7bdat')\"" }, pattern))
      .toBe('raw/dm.sas7bdat')
    // Windows 路径在 JSON 序列化文本里反斜杠会翻倍，断言只锚定扩展名 token
    expect(findDatasetReference({ command: 'Get-Content G:\\data\\AE.XPT' }, pattern))
      .toMatch(/AE\.XPT$/i)
    expect(findDatasetReference({ path: '/study/dm.csv' }, pattern)).toBe('/study/dm.csv')
    expect(findDatasetReference({ command: 'type lab.CSV' }, pattern)).toBe('lab.CSV')
  })

  it('不误伤：无扩展名引用 / 相似后缀 / 参数里没有数据集', () => {
    expect(findDatasetReference({ command: 'cat readme.md notes.txt' }, pattern)).toBeUndefined()
    expect(findDatasetReference({ command: 'cat report.csv.md' }, pattern)).toBeUndefined()   // 扩展名必须在 token 尾
    expect(findDatasetReference({ command: 'cat x.csvx' }, pattern)).toBeUndefined()
    expect(findDatasetReference({}, pattern)).toBeUndefined()
    expect(findDatasetReference(undefined, pattern)).toBeUndefined()
    expect(findDatasetReference({ code: 'outputs = datasets["AE"].copy()' }, pattern)).toBeUndefined()
  })

  it('空扩展名表 = 永不匹配（零拦截语义由上层开关决定）', () => {
    expect(findDatasetReference({ command: 'cat dm.csv' }, buildDatasetPattern([]))).toBeUndefined()
  })

  it('参数不可 JSON 序列化 → 返回哨兵值（无法证明安全即命中护栏）', () => {
    const cyclic: { command: string; self?: unknown } = { command: 'cat dm.csv' }
    cyclic.self = cyclic
    expect(findDatasetReference(cyclic, pattern)).toBe(UNSCANNABLE_ARGUMENTS)
  })

  it('自定义扩展名表生效（宿主单源配置）', () => {
    const custom = buildDatasetPattern(['.parquet'])
    expect(findDatasetReference({ command: 'cat dm.parquet' }, custom)).toBe('dm.parquet')
    expect(findDatasetReference({ command: 'cat dm.csv' }, custom)).toBeUndefined()
  })
})

describe('datasetDenyReason', () => {
  it('拒绝理由引导回 listing 车道并指出部署方开关', () => {
    const reason = datasetDenyReason('raw/dm.sas7bdat')
    expect(reason).toContain('raw/dm.sas7bdat')
    expect(reason).toContain('enterprise_listing_run_code')
    expect(reason).toContain('enterprise_listing_inspect')
    expect(reason).toContain('/settings/enterprise')
  })
})

describe('guardFlags（fail-closed）', () => {
  it('服务未装配 → 开 + 内置默认扩展名', () => {
    expect(guardFlags({} as GuardContext)).toEqual({ enabled: true, extensions: DEFAULT_DATASET_EXTENSIONS })
  })

  it('服务抛错 → 按开（fail-closed）；正常时透传扩展名表', () => {
    const broken = { isEnabled: () => { throw new Error('unreadable') } }
    expect(guardFlags({ dataSecurityService: broken } as unknown as GuardContext).enabled).toBe(true)
    const healthy = { isEnabled: () => true, getDatasetExtensions: () => ['.parquet'] }
    expect(guardFlags({ dataSecurityService: healthy } as unknown as GuardContext))
      .toEqual({ enabled: true, extensions: ['.parquet'] })
  })
})

describe('registerDatasetGuard（pre-execute waterfall）', () => {
  it('shell 引用数据集 → deny；理由含车道引导', async () => {
    const { listeners } = waterfallHarness()
    const decision = await listeners[0](toolExec('pwsh', { command: 'python read dm.sas7bdat' }), next)
    expect(decision).toMatchObject({ kind: 'deny' })
    expect((decision as { reason?: string }).reason).toContain('enterprise_listing_run_code')
  })

  it('不含数据集引用 → allow（next 放行）', async () => {
    const { listeners } = waterfallHarness()
    await expect(listeners[0](toolExec('pwsh', { command: 'ls doc/' }), next)).resolves.toEqual({ kind: 'allow' })
  })

  it('参数不可序列化 → fail-closed deny', async () => {
    const { listeners } = waterfallHarness()
    const cyclic: { command: string; self?: unknown } = { command: 'cat dm.csv' }
    cyclic.self = cyclic
    const decision = await listeners[0](toolExec('pwsh', cyclic), next)
    expect(decision).toMatchObject({ kind: 'deny' })
    expect((decision as { reason?: string }).reason).toContain('参数无法安全检查')
  })

  it('enterprise_* 自有车道豁免（listing 回执有自己的投影出口）', async () => {
    const { listeners } = waterfallHarness()
    await expect(listeners[0](toolExec('enterprise_listing_run_code', { project: '/p', code: "x = 'dm.sas7bdat'" }), next))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('宿主开关关闭 → 零拦截（deny 语义整体旁路）', async () => {
    const { listeners } = waterfallHarness({ isEnabled: () => false })
    await expect(listeners[0](toolExec('pwsh', { command: 'cat dm.sas7bdat' }), next)).resolves.toEqual({ kind: 'allow' })
  })

  it('返回的 disposer 即事件退订（可卸载）', () => {
    const { disposer, dispose } = waterfallHarness()
    expect(disposer).toBe(dispose)
  })
})

describe('FP 专项：合法工作流不误伤（2026-08-28 收口）', () => {
  it('常规命令全放行：ls/git add -A/mkdir/python 计算/文档写入', async () => {
    const guard = guardHarness()
    for (const args of [
      { command: 'ls -la doc/' },
      { command: 'git add -A && git commit -m "listings"' },
      { command: 'mkdir -p output/report' },
      { command: 'python -c "print(1+1)"' },
      { path: 'notes/README.md', content: '# 说明\n流程见 inspect 回执。' },
    ]) {
      await expect(guard(toolExec('pwsh', args), next)).resolves.toEqual({ kind: 'allow' })
    }
  })

  it('纯写出型工具豁免：写文档提及数据集文件名不拦（名字来自元数据，非内容）', async () => {
    const guard = guardHarness()
    await expect(guard(toolExec('Write', { path: 'notes/dm-notes.md', content: '数据源: raw/dm.sas7bdat,见 inspect 元数据' }), next))
      .resolves.toEqual({ kind: 'allow' })
    await expect(guard(toolExec('edit', { file_path: 'x.py', old_string: 'a', new_string: "p='dm.csv'" }), next))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('带空格文件名仍命中（勘误 V-5:token 逐段匹配,空格不构成绕过）', async () => {
    const guard = guardHarness()
    const decision = await guard(toolExec('pwsh', { command: 'cat "my data.csv"' }), next)
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('读取型工具引用数据集仍然拒绝（豁免只针对纯写出）', async () => {
    const guard = guardHarness()
    await expect(guard(toolExec('pwsh', { command: 'python read dm.sas7bdat' }), next))
      .resolves.toMatchObject({ kind: 'deny' })
    await expect(guard(toolExec('Read', { file_path: 'raw/dm.csv' }), next))
      .resolves.toMatchObject({ kind: 'deny' })
  })
})
