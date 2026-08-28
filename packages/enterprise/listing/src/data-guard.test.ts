import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PythonWorker } from './worker.js'

const temporaryProjects: string[] = []

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map(project => rm(project, { recursive: true, force: true })))
})

async function guardProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-guard-'))
  temporaryProjects.push(root)
  await writeFile(join(root, 'AE.csv'), 'USUBJID,AETERM\nSUBJ-777,Headache\nSUBJ-888,Nausea\n')
  const docDir = join(root, 'doc')
  await mkdir(docDir)
  // 200 字窗口外的需求标记：doc/ 文本全量直通（R1），默认也必须可见
  await writeFile(join(docDir, 'spec.txt'), `head\n${'X'.repeat(400)}\nREQUIREMENT-TAIL-MARKER`)
  return root
}

function writeAls(path: string, withSecretSheet: boolean) {
  const script = withSecretSheet
    ? `
import sys
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = "ALS"
ws.append(["Dataset Name", "Variable Name", "Label"])
ws.append(["AE", "AETERM", "Adverse Event Term"])
ws.append(["AE", "USUBJID", "Subject"])
notes = wb.create_sheet("Notes")
notes.append(["note"])
for _ in range(3): notes.append(["padding"])
notes.append(["SECRET-CELL-42"])
wb.save(sys.argv[1])
`
    : `
import sys
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = "ALS"
ws.append(["Dataset Name", "Variable Name", "Label"])
ws.append(["AE", "AETERM", "Adverse Event Term"])
wb.save(sys.argv[1])
`
  const make = spawnSync('python', ['-c', script, path], { encoding: 'utf8' })
  expect(make.status, make.stderr).toBe(0)
}

describe('数据拦截（ADR-0007：单规则 + 宿主开关 + doc/ 零拦截）', () => {
  it('场景①：SAS/CSV 数据集元数据出、行值不出（开关开）', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const result = await worker.request({ operation: 'listing_inspect', project: root }, 30_000)
      expect(result.ok).toBe(true)
      const payload = JSON.stringify(result)
      expect(payload).not.toContain('SUBJ-777')
      expect(payload).not.toContain('SUBJ-888')
      const inspection = result.inspection as {
        dataInterception?: boolean
        datasets: Array<{ name: string; columns: string[]; rowCount: number; sample?: unknown }>
        documents: Array<{ content?: string }>
      }
      expect(inspection.dataInterception).toBe(true)
      expect(inspection.datasets[0]).toMatchObject({ name: 'AE', columns: ['USUBJID', 'AETERM'], rowCount: 2 })
      expect(inspection.datasets[0].sample).toBeUndefined()          // 构建期节流：根本没建
      expect(inspection.datasets[0].dtypes).toBeDefined()
      expect(inspection.datasets[0].nullCount).toBeDefined()
    } finally { worker.dispose() }
  }, 30_000)

  it('R1：doc/ 文本全量读（含 200 字窗外内容，行为反转）', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const result = await worker.request({ operation: 'listing_inspect', project: root }, 30_000)
      const doc = (result.inspection as { documents: Array<{ content?: string; type?: string }> })
        .documents.find(item => item.type === 'text')
      expect(doc?.content).toContain('REQUIREMENT-TAIL-MARKER')
      expect(doc?.content).toHaveLength(5 + 400 + 1 + 'REQUIREMENT-TAIL-MARKER'.length)  // head\n + X400 + \n + 标记
    } finally { worker.dispose() }
  }, 30_000)

  it('ADR-0007：doc/ 辅助 Excel 零拦截——单元格值全量直通（开关开也直通）', async () => {
    const root = await guardProject()
    writeAls(join(root, 'doc', 'als.xlsx'), true)
    const worker = new PythonWorker()
    try {
      const result = await worker.request({ operation: 'listing_inspect', project: root }, 30_000)
      const als = (result.inspection as { documents: Array<Record<string, unknown>> })
        .documents.find(doc => (doc as { type?: string }).type === 'als')
      expect(als).toBeDefined()
      expect(als?.structure).toBeDefined()
      expect(als?.mappings).toEqual([
        { datasetName: 'AE', sourceColumn: 'AETERM', label: 'Adverse Event Term' },
        { datasetName: 'AE', sourceColumn: 'USUBJID', label: 'Subject' },
      ])
      expect(als?.rows).toBeDefined()                                  // doc/ 零拦截：整表值在回执
      expect(JSON.stringify(result)).toContain('SECRET-CELL-42')
    } finally { worker.dispose() }
  }, 30_000)

  it('R3：run_code 的 stdout 原样回执（其他一律不碰）', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const result = await worker.request({
        operation: 'listing_run_code', project: root,
        code: 'print(datasets["AE"].iloc[0]["AETERM"])\nout = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"Subject"}\noutputs={"AE":out}',
      }, 30_000)
      expect(result).toMatchObject({ ok: true, receipt: { stdout: 'Headache\n' } })
    } finally { worker.dispose() }
  }, 30_000)

  it('R4：开关关闭（dataInterception=false）零拦截——样本/rows/全文全部放行', async () => {
    const root = await guardProject()
    writeAls(join(root, 'doc', 'als.xlsx'), true)
    const worker = new PythonWorker()
    try {
      const result = await worker.request(
        { operation: 'listing_inspect', project: root, dataInterception: false }, 30_000)
      expect(result.ok).toBe(true)
      const payload = JSON.stringify(result)
      expect(payload).toContain('SUBJ-777')
      expect(payload).toContain('SECRET-CELL-42')
      const inspection = result.inspection as {
        datasets: Array<{ sample?: Record<string, unknown[]> }>
        documents: Array<{ content?: string; rows?: unknown }>
      }
      expect(inspection.datasets[0].sample?.USUBJID).toContain('SUBJ-777')
      const textDoc = inspection.documents.find(doc => (doc as { type?: string }).type === 'text')
      expect(textDoc?.content).toContain('REQUIREMENT-TAIL-MARKER')
      expect(inspection.documents.find(doc => doc.rows)).toBeDefined()
    } finally { worker.dispose() }
  }, 30_000)

  it('fail-closed：请求不带旗标 → 按开处理（元数据投影生效）', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const result = await worker.request({ operation: 'listing_inspect', project: root }, 30_000)
      expect(JSON.stringify(result)).not.toContain('SUBJ-777')
      expect((result.inspection as { datasets: Array<{ sample?: unknown }> }).datasets[0].sample).toBeUndefined()
    } finally { worker.dispose() }
  }, 30_000)

  it('ADR-0009：执行面全开且不受开关影响', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const roundtrip = join(root, 'adr0009-roundtrip.csv')
      const code = [
        'import os',
        `with open(${JSON.stringify(join(root, 'AE.csv'))}, encoding='utf-8') as fh:`,
        '    header = fh.readline().strip()',
        `pd.DataFrame({'A': [1, 2]}).to_csv(${JSON.stringify(roundtrip)}, index=False)`,
        `back = pd.read_csv(${JSON.stringify(roundtrip)})`,
        `outputs = {'ADR0009': pd.DataFrame({`,
        "    'rowCount': [len(back)],",
        "    'openOk': [header == 'USUBJID,AETERM'],",
        "    'importOk': [os.name in ('nt', 'posix')],",
        '})}',
      ].join('\n')
      const result = await worker.request(
        { operation: 'listing_run_code', project: root, code, dataInterception: false }, 30_000)
      expect(result).toMatchObject({ ok: true, receipt: { outputCount: 1, publishReady: true } })
    } finally { worker.dispose() }
  }, 30_000)

  it('穿越围栏：scan_excel_structures("../x") 抛错', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const result = await worker.request({
        operation: 'listing_run_code', project: root,
        code: 's = scan_excel_structures("../outside.xlsx")',
      }, 30_000)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).toContain('ESCAPE_PROJECT_ROOT')
    } finally { worker.dispose() }
  }, 30_000)
})
