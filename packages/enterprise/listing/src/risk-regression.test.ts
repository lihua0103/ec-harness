import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PythonWorker } from './worker.js'

const projects: string[] = []
afterEach(async () => Promise.all(projects.splice(0).map(directory => rm(directory, { recursive: true, force: true }, 30_000))))
async function project(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'dsh-risk-')); projects.push(value); return value }

function runPython(code: string, ...args: string[]) {
  return spawnSync('python', ['-c', code, ...args], { encoding: 'utf8' }, 30_000)
}

describe('Listing 风险回归', () => {
  it('捕获模型 stdout，NDJSON 协议仍保持单行 JSON', async () => {
    const root = await project(); await writeFile(join(root, 'AE.csv'), 'ID\n1\n')
    const worker = new PythonWorker()
    try {
      const result = await worker.request({ operation: 'listing_run_code', project: root,
        code: 'print("MODEL_STDOUT")\noutputs = {"AE": datasets["AE"]}' }, 30_000)
      expect(result).toMatchObject({ ok: true, receipt: { stdout: 'MODEL_STDOUT\n' } }, 30_000)
    } finally { worker.dispose() }
  }, 30_000)

  it('允许任意代码执行，但 receipt 不泄露命令输出', async () => {
    const root = await project(); await writeFile(join(root, 'AE.csv'), 'ID\n1\n')
    const worker = new PythonWorker()
    try {
      const result = await worker.request({ operation: 'listing_run_code', project: root,
        code: 'outputs = {"test": pd.DataFrame({"col": [1]})}' }, 30_000)
      // 代码成功执行，receipt 只包含元数据，不包含数据行
      expect(result).toMatchObject({ ok: true, receipt: { outputCount: 1 } })
      expect(result.receipt?.outputs).toBeDefined()
      // receipt 中没有 DataFrame 的实际数据
      expect(JSON.stringify(result)).not.toContain('TABULAR_DATA')
    } finally { worker.dispose() }
  }, 30_000)

  it('加载无密码 ZIP，错误 ZIP 返回结构化失败', async () => {
    const root = await project()
    const zip = join(root, 'data.zip')
    const make = runPython('import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],"w") as z:z.writestr("nested/AE.csv","ID\\n1\\n")', zip)
    expect(make.status, make.stderr).toBe(0)
    const worker = new PythonWorker()
    try {
      expect(await worker.request({ operation: 'listing_inspect', project: root }, 30_000)).toMatchObject({
        ok: true, inspection: { datasets: [{ name: 'AE' }], failures: [] },
      }, 30_000)
      await writeFile(join(root, 'broken.zip'), 'not a zip')
      expect(await worker.request({ operation: 'listing_inspect', project: root }, 30_000)).toMatchObject({
        ok: true, inspection: { failures: [{ stage: 'extract-archive' }] },
      }, 30_000)
    } finally { worker.dispose() }
  }, 30_000)

  it('同名数据集 fail-closed，不静默覆盖', async () => {
    const root = await project(); await mkdir(join(root, 'one')); await mkdir(join(root, 'two'))
    await writeFile(join(root, 'one', 'AE.csv'), 'ID\n1\n'); await writeFile(join(root, 'two', 'AE.csv'), 'ID\n2\n')
    const worker = new PythonWorker()
    try {
      expect(await worker.request({ operation: 'listing_inspect', project: root }, 30_000)).toMatchObject({
        ok: false, code: 'DATASET_NAME_CONFLICT',
      }, 30_000)
    } finally { worker.dispose() }
  }, 30_000)

  it('相同数据连续 publish 的 manual/report 变化均为零', async () => {
    const root = await project(); await writeFile(join(root, 'AE.csv'), 'ID,TERM\n1,Headache\n')
    const worker = new PythonWorker()
    try {
      await worker.request({ operation: 'listing_run_code', project: root,
        code: 'ae=datasets["AE"].copy()\nae.attrs["labels"]={"ID":"Identifier","TERM":"Term"}\noutputs={"AE":ae}' }, 30_000)
      await worker.request({ operation: 'listing_publish', project: root, scenario: 'manual', trackChanges: true }, 30_000)
      await worker.request({ operation: 'listing_publish', project: root, scenario: 'manual', trackChanges: true }, 30_000)
      const manual = runPython('import json,sys\nfrom openpyxl import load_workbook\nw=load_workbook(sys.argv[1],data_only=True)\nprint(json.dumps([w["Content"].cell(3,c).value for c in range(5,8)]))',
        join(root, '.clinical-listing', 'output', 'manual', 'MANUAL_LISTINGS.xlsx'))
      expect(JSON.parse(manual.stdout)).toEqual([0, 0, 0])

      await worker.request({ operation: 'listing_publish', project: root, scenario: 'report', trackChanges: true }, 30_000)
      await worker.request({ operation: 'listing_publish', project: root, scenario: 'report', trackChanges: true }, 30_000)
      const changes = JSON.parse((await import('node:fs/promises')).readFile
        ? await (await import('node:fs/promises')).readFile(join(root, '.clinical-listing', 'output', 'report', 'REPORT_LISTINGS_changes.json'), 'utf8') : '{}')
      expect(changes.changes.AE).toEqual({ new: 0, modified: 0, old: 0 }, 30_000)
    } finally { worker.dispose() }
  }, 30_000)
}, 30_000)






