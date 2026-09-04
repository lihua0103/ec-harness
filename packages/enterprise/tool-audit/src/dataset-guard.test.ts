import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUXILIARY_EXCEL_EXTENSIONS,
  DEFAULT_DATASET_EXTENSIONS,
  UNSCANNABLE_ARGUMENTS,
  classifyReference,
  datasetDenyReason,
  findProtectedReference,
  interceptionEnabled,
  inspectToolExecution,
  registerDatasetGuard,
  type GuardContext,
  type ToolExecutionLike,
} from './dataset-guard.ts'

const temporaryProjects: string[] = []

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map(project => rm(project, { recursive: true, force: true })))
})

async function makeProject(kind: 'protected' | 'ordinary' | 'doc-only' | 'output-only'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-audit-${kind}-`))
  temporaryProjects.push(root)
  await mkdir(join(root, 'doc'), { recursive: true })
  if (kind === 'protected') {
    await writeFile(join(root, 'AE.csv'), 'ID\n1\n')
    await writeFile(join(root, 'aux.xlsx'), 'excel')
    await writeFile(join(root, 'raw.zip'), 'zip')
    await mkdir(join(root, '.clinical-listing', 'output'), { recursive: true })
    await writeFile(join(root, '.clinical-listing', 'output', 'published.xlsx'), 'excel')
  }
  if (kind === 'ordinary') await writeFile(join(root, 'README.md'), 'doc')
  if (kind === 'doc-only') await writeFile(join(root, 'doc', 'spec.csv'), 'Requirement\nDOC-CELL-99\n')
  if (kind === 'output-only') {
    await mkdir(join(root, '.clinical-listing', 'output'), { recursive: true })
    await writeFile(join(root, '.clinical-listing', 'output', 'published.xlsx'), 'excel')
  }
  await writeFile(join(root, 'doc', 'spec.txt'), 'requirement')
  return root
}

function toolExec(name: string, args: unknown, cwd?: string): ToolExecutionLike {
  return {
    name,
    arguments: args,
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  }
}

function guardHarness(dataSecurityService?: { isEnabled(): boolean }) {
  const guards: Array<(execution: Readonly<ToolExecutionLike>) => string | undefined> = []
  const records: unknown[] = []
  const context: GuardContext = {
    tools: { guard(guard) { guards.push(guard); return () => undefined } },
    dataSecurityService,
    audit: record => records.push(record),
  }
  registerDatasetGuard(context)
  return { guard: guards[0], records }
}

describe('路径角色分类', () => {
  it('doc 与系统输出必须锚定当前项目根', async () => {
    const root = await makeProject('protected')
    expect(classifyReference('doc/als.xlsx', root)).toBe('spec-document')
    expect(classifyReference(join(root, 'doc', 'AE.csv'), root)).toBe('spec-document')
    expect(classifyReference('nested/doc/AE.csv', root)).toBe('dataset')
    expect(classifyReference(resolve(root, '..', 'outside', 'doc', 'AE.csv'), root)).toBe('dataset')
    expect(classifyReference(join(root, '.clinical-listing', 'output', 'report.xlsx'), root)).toBe('generated-output')
    expect(classifyReference(join(root, 'output', 'report.xlsx'), root)).toBe('aux-excel')
    expect(classifyReference(join(root, 'raw.zip'), root)).toBe('protected-archive')
    expect(classifyReference(join(root, 'README.md'), root)).toBe('ordinary')
  })

  it('固定扩展名不受宿主或请求配置影响', () => {
    expect(DEFAULT_DATASET_EXTENSIONS).toEqual(['.sas7bdat', '.xpt', '.csv'])
    expect(AUXILIARY_EXCEL_EXTENSIONS).toEqual(['.xlsx', '.xls', '.xlsm'])
  })
})

describe('findProtectedReference', () => {
  it('数据集、doc 外辅助 Excel 与归档命中；doc 与系统输出不命中', async () => {
    const root = await makeProject('protected')
    expect(findProtectedReference({ command: 'python read raw/dm.sas7bdat' }, root))
      .toMatchObject({ pathClass: 'dataset' })
    expect(findProtectedReference({ path: 'aux/ALS.xlsx' }, root))
      .toMatchObject({ pathClass: 'aux-excel' })
    expect(findProtectedReference({ path: 'archives/raw.zip' }, root))
      .toMatchObject({ pathClass: 'protected-archive' })
    expect(findProtectedReference({ path: 'doc/als.xlsx' }, root)).toBeUndefined()
    expect(findProtectedReference({ path: 'doc/AE.csv' }, root)).toBeUndefined()
    expect(findProtectedReference({
      path: join(root, '.clinical-listing', 'output', 'report.xlsx'),
    }, root)).toBeUndefined()
  })

  it('项目外同名 doc 目录不能豁免数据集', async () => {
    const root = await makeProject('ordinary')
    const outside = resolve(root, '..', 'outside', 'doc', 'AE.csv')
    expect(findProtectedReference({ path: outside }, root)).toMatchObject({ pathClass: 'dataset' })
  })

  it('参数不可序列化时 fail-closed', () => {
    const cyclic: { path: string; self?: unknown } = { path: 'AE.csv' }
    cyclic.self = cyclic
    expect(findProtectedReference(cyclic, '/study')).toBe(UNSCANNABLE_ARGUMENTS)
  })
})

describe('inspectToolExecution', () => {
  it('显式读取数据集/辅助 Excel/归档被拒并给改道指引；doc 与输出放行', async () => {
    const root = await makeProject('protected')
    const denied = inspectToolExecution(toolExec('read', { path: 'raw/AE.csv' }, root))
    expect(typeof denied).toBe('string')
    expect(denied as string).toContain('AE.csv')
    expect(typeof inspectToolExecution(toolExec('read', { path: 'aux/ALS.xlsx' }, root))).toBe('string')
    expect(typeof inspectToolExecution(toolExec('read', { path: 'raw/data.zip' }, root))).toBe('string')
    expect(inspectToolExecution(toolExec('read', { path: 'doc/als.xlsx' }, root))).toBeUndefined()
    expect(inspectToolExecution(toolExec('read', {
      path: '.clinical-listing/output/report.xlsx',
    }, root))).toBeUndefined()
  })

  it('写出型工具提及受保护文件名不构成读取泄露', async () => {
    const root = await makeProject('protected')
    expect(inspectToolExecution(toolExec('write', {
      path: 'notes.md', content: 'source: raw/AE.csv',
    }, root))).toBeUndefined()
    expect(inspectToolExecution(toolExec('edit', {
      file_path: 'script.py', old_string: 'x', new_string: "x = 'raw/AE.csv'",
    }, root))).toBeUndefined()
  })

  it('无 cwd 时按路径形态启发：doc 父目录放行，裸数据集引用仍拒绝', () => {
    expect(inspectToolExecution(toolExec('read', { path: 'doc/AE.csv' }))).toBeUndefined()
    expect(typeof inspectToolExecution(toolExec('read', { path: 'raw/AE.csv' }))).toBe('string')
  })

  it('enterprise listing 车道自有投影出口，不吃通用护栏', async () => {
    const root = await makeProject('protected')
    expect(inspectToolExecution(toolExec('enterprise_listing_run_code', {
      project: root, code: "print(open('raw/AE.csv').read())",
    }, root))).toBeUndefined()
  })

  it('受保护项目中的普通执行通道不因数据存在而拦截', async () => {
    const protectedRoot = await makeProject('protected')
    expect(inspectToolExecution(toolExec('bash', { command: 'ls' }, protectedRoot))).toBeUndefined()
    expect(inspectToolExecution(toolExec('custom_runner', { script: 'print(1)' }, protectedRoot))).toBeUndefined()
  })

  it('普通项目、doc-only 项目与输出-only 项目不因内容策略误伤命令', async () => {
    for (const kind of ['ordinary', 'doc-only', 'output-only'] as const) {
      const root = await makeProject(kind)
      expect(inspectToolExecution(toolExec('pwsh', { command: 'python -c "print(1+1)"' }, root))).toBeUndefined()
    }
  })

  it('无项目根的普通执行也不因缺少路径而拦截', () => {
    expect(inspectToolExecution(toolExec('bash', { command: 'ls' }))).toBeUndefined()
  })

  it('宿主关闭开关后完全零拦截', async () => {
    const root = await makeProject('protected')
    expect(inspectToolExecution(
      toolExec('read', { path: 'raw/AE.csv' }, root), false,
    )).toBeUndefined()
    expect(inspectToolExecution(
      toolExec('bash', { command: 'python read raw/dm.sas7bdat' }, root), false,
    )).toBeUndefined()
    expect(inspectToolExecution(toolExec('bash', { command: 'ls' }), false)).toBeUndefined()
    const { guard, records } = guardHarness({ isEnabled: () => false })
    expect(guard(toolExec('read', { path: 'raw/AE.csv' }, root))).toBeUndefined()
    expect(records).toHaveLength(0)
  })

  it('开关服务未装配或读取失败时按开启处理', () => {
    expect(interceptionEnabled({})).toBe(true)
    expect(interceptionEnabled({ dataSecurityService: { isEnabled: () => false } })).toBe(false)
    expect(interceptionEnabled({
      dataSecurityService: { isEnabled: () => { throw new Error('unavailable') } },
    })).toBe(true)
  })

  it('拒绝理由引导回 listing 车道并说明宿主开关', () => {
    const reason = datasetDenyReason('raw/dm.sas7bdat')
    expect(reason).toContain('raw/dm.sas7bdat')
    expect(reason).toContain('enterprise_listing_run_code')
    expect(reason).toContain('enterprise_listing_read_document')
    expect(reason).toContain('关闭数据安全开关')
  })

  it('拒绝审计只含路径与结构字段，不含业务值', async () => {
    const root = await makeProject('protected')
    const { guard, records } = guardHarness()
    const decision = guard(toolExec('read', { path: join(root, 'raw', 'AE.csv') }, root))
    expect(typeof decision).toBe('string')
    expect(records).toHaveLength(0)
  })
})
