import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PythonWorker, type WorkerResponse } from './worker.js'

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
  await writeFile(join(docDir, 'spec.txt'), `head\n${'X'.repeat(400)}\nREQUIREMENT-TAIL-MARKER`)
  return root
}

function writeAls(path: string, marker: string): void {
  const script = `
import sys
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = "ALS"
ws.append(["Dataset Name", "Variable Name", "Label"])
ws.append(["AE", "AETERM", "Adverse Event Term"])
ws.append(["AE", "USUBJID", "Subject"])
notes = wb.create_sheet("Notes")
notes.append(["note"])
notes.append([sys.argv[2]])
wb.save(sys.argv[1])
`
  const make = spawnSync('python', ['-c', script, path, marker], { encoding: 'utf8' })
  expect(make.status, make.stderr).toBe(0)
}

interface DocumentManifest {
  documentId: string
  path: string
  totalChunks: number
  complete?: boolean
}

interface Inspection {
  requirementDocuments: DocumentManifest[]
  documentReadProtocol: { completeOnlyWhenAllChunksRead: boolean }
  auxiliaryDocuments: Array<{ path: string; mappings?: unknown[]; rows?: unknown }>
  datasets: Array<{ name: string; columns: string[]; rowCount: number; sample?: unknown }>
}

function inspectionOf(result: WorkerResponse): Inspection {
  expect(result.ok).toBe(true)
  return result.inspection as Inspection
}

async function readDocuments(
  worker: PythonWorker, root: string, inspection: Inspection,
): Promise<Array<Record<string, unknown>>> {
  const documents: Array<Record<string, unknown>> = []
  for (const manifest of inspection.requirementDocuments) {
    expect(manifest.totalChunks).toBeGreaterThan(0)
    const chunks: string[] = []
    for (let index = 0; index < manifest.totalChunks; index += 1) {
      const result = await worker.request({
        operation: 'listing_read_document', project: root,
        documentId: manifest.documentId, chunkIndex: index,
      }, 30_000)
      expect(result.ok, JSON.stringify(result)).toBe(true)
      const document = result.document as { content: string; isFinal: boolean; chunkIndex: number }
      expect(document.chunkIndex).toBe(index)
      expect(document.isFinal).toBe(index === manifest.totalChunks - 1)
      chunks.push(document.content)
    }
    documents.push(JSON.parse(chunks.join('')) as Record<string, unknown>)
  }
  return documents
}

describe('固定数据边界', () => {
  it('inspect 只给 doc manifest，同时封住两类数据值', async () => {
    const root = await guardProject()
    writeAls(join(root, 'aux.xlsx'), 'SECRET-CELL-42')
    writeAls(join(root, 'doc', 'als.xlsx'), 'DOC-CELL-99')
    await mkdir(join(root, '_work', 'nested'), { recursive: true })
    writeAls(join(root, '_work', 'nested', 'work.xlsx'), 'WORK-SECRET-88')
    await mkdir(join(root, '.clinical-listing', 'output'), { recursive: true })
    writeAls(join(root, '.clinical-listing', 'output', 'published.xlsx'), 'OUTPUT-CELL-77')

    const worker = new PythonWorker()
    try {
      const result = await worker.request({ operation: 'listing_inspect', project: root }, 30_000)
      const payload = JSON.stringify(result)
      expect(result.ok).toBe(true)
      expect(payload).not.toContain('SUBJ-777')
      expect(payload).not.toContain('SUBJ-888')
      expect(payload).not.toContain('SECRET-CELL-42')
      expect(payload).not.toContain('WORK-SECRET-88')
      expect(payload).not.toContain('REQUIREMENT-TAIL-MARKER')
      expect(payload).not.toContain('DOC-CELL-99')

      const inspection = inspectionOf(result)
      expect(inspection.documentReadProtocol.completeOnlyWhenAllChunksRead).toBe(true)
      expect(inspection.requirementDocuments.map(item => item.path)).toEqual(['als.xlsx', 'spec.txt'])
      expect(inspection.requirementDocuments.every(item => item.complete === false)).toBe(true)
      expect(inspection.datasets[0]).toMatchObject({
        name: 'AE', columns: ['USUBJID', 'AETERM'], rowCount: 2,
      })
      expect(inspection.datasets[0].sample).toBeUndefined()
      expect(inspection.auxiliaryDocuments.map(item => item.path)).toEqual([
        '_work/nested/work.xlsx', 'aux.xlsx',
      ])
      expect(inspection.auxiliaryDocuments.every(item => item.rows === undefined)).toBe(true)
      expect(inspection.auxiliaryDocuments[0].mappings).toHaveLength(2)

      const documents = await readDocuments(worker, root, inspection)
      const documentText = JSON.stringify(documents)
      expect(documentText).toContain('REQUIREMENT-TAIL-MARKER')
      expect(documentText).toContain('DOC-CELL-99')
      expect(documentText).not.toContain('SECRET-CELL-42')
      expect(documentText).not.toContain('WORK-SECRET-88')
    } finally { worker.dispose() }
  }, 30_000)

  it('伪造 dataInterception=false 不能放行数据值', async () => {
    const root = await guardProject()
    writeAls(join(root, 'notes.xlsx'), 'SECRET-CELL-42')
    const worker = new PythonWorker()
    try {
      const result = await worker.request(
        { operation: 'listing_inspect', project: root, dataInterception: false }, 30_000)
      const payload = JSON.stringify(result)
      expect(result.ok).toBe(true)
      expect(payload).not.toContain('SUBJ-777')
      expect(payload).not.toContain('SECRET-CELL-42')
      expect(payload).not.toContain('REQUIREMENT-TAIL-MARKER')
      const documents = await readDocuments(worker, root, inspectionOf(result))
      expect(JSON.stringify(documents)).toContain('REQUIREMENT-TAIL-MARKER')
    } finally { worker.dispose() }
  }, 30_000)

  it('doc 超过单片上限时按顺序无损分片', async () => {
    const root = await guardProject()
    await writeFile(join(root, 'doc', 'large.txt'), `${'Y'.repeat(270_000)}\nLARGE-DOC-TAIL`)
    const worker = new PythonWorker()
    try {
      const result = await worker.request({ operation: 'listing_inspect', project: root }, 30_000)
      const inspection = inspectionOf(result)
      const manifest = inspection.requirementDocuments.find(item => item.path === 'large.txt')
      expect(manifest?.totalChunks).toBeGreaterThan(1)
      const documents = await readDocuments(worker, root, inspection)
      const large = documents.find(item => item.path === 'large.txt') as { content: string }
      expect(large.content).toHaveLength(270_000 + 1 + 'LARGE-DOC-TAIL'.length)
      expect(large.content.endsWith('LARGE-DOC-TAIL')).toBe(true)
    } finally { worker.dispose() }
  }, 30_000)

  it('run_code stdout/stderr 内容不回流', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const inspection = inspectionOf(await worker.request({ operation: 'listing_inspect', project: root }, 30_000))
      await readDocuments(worker, root, inspection)
      const result = await worker.request({
        operation: 'listing_run_code', project: root,
        code: 'print(datasets["AE"].iloc[0]["AETERM"])\nout = datasets["AE"].copy()\nout.attrs["labels"]={"USUBJID":"Subject"}\noutputs={"AE":out}',
      }, 30_000)
      const payload = JSON.stringify(result)
      expect(payload).not.toContain('Headache')
      expect(result).toMatchObject({ ok: true, receipt: { stdoutOmitted: true, stderrOmitted: true } })
      expect(result.receipt).not.toHaveProperty('stdout')
      expect(result.receipt).not.toHaveProperty('stderr')
    } finally { worker.dispose() }
  }, 30_000)

  it('run_code 回执不返回模型可控输出名/列名', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const inspection = inspectionOf(await worker.request({ operation: 'listing_inspect', project: root }, 30_000))
      await readDocuments(worker, root, inspection)
      const result = await worker.request({
        operation: 'listing_run_code', project: root,
        code: 'df = datasets["AE"].copy()\ndf = df.rename(columns={"USUBJID": datasets["AE"].iloc[0]["USUBJID"]})\noutputs = {datasets["AE"].iloc[0]["AETERM"]: df}',
      }, 30_000)
      const payload = JSON.stringify(result)
      expect(result.ok).toBe(true)
      expect(payload).not.toContain('SUBJ-777')
      expect(payload).not.toContain('Headache')
      expect(result.receipt.outputCount).toBe(1)
      for (const output of result.receipt.outputs) {
        for (const column of output.columns) expect(column).not.toHaveProperty('name')
      }
    } finally { worker.dispose() }
  }, 30_000)

  it('listing sandbox 自己的执行面保持全开', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const inspection = inspectionOf(await worker.request({ operation: 'listing_inspect', project: root }, 30_000))
      await readDocuments(worker, root, inspection)
      const roundtrip = join(root, 'roundtrip.csv')
      const code = [
        'import os',
        `with open(${JSON.stringify(join(root, 'AE.csv'))}, encoding="utf-8") as fh:`,
        '    header = fh.readline().strip()',
        `pd.DataFrame({"A": [1, 2]}).to_csv(${JSON.stringify(roundtrip)}, index=False)`,
        `back = pd.read_csv(${JSON.stringify(roundtrip)})`,
        `outputs = {"ADR0010": pd.DataFrame({"rowCount": [len(back)], "openOk": [header == "USUBJID,AETERM"], "importOk": [os.name in ("nt", "posix")]})}`,
      ].join('\n')
      const result = await worker.request(
        { operation: 'listing_run_code', project: root, code, dataInterception: false }, 30_000)
      expect(result).toMatchObject({ ok: true, receipt: { outputCount: 1, publishReady: true } })
      expect(result.receipt.outputs[0].rowCount).toBe(1)
    } finally { worker.dispose() }
  }, 30_000)

  it('执行失败回执不回显动态异常文本', async () => {
    const root = await guardProject()
    const worker = new PythonWorker()
    try {
      const inspection = inspectionOf(await worker.request({ operation: 'listing_inspect', project: root }, 30_000))
      await readDocuments(worker, root, inspection)
      const result = await worker.request({
        operation: 'listing_run_code', project: root,
        code: 'raise ValueError(datasets["AE"].iloc[0]["AETERM"])',
      }, 30_000)
      expect(result).toMatchObject({ ok: false, code: 'CODE_EXECUTION_ERROR' })
      expect(JSON.stringify(result)).not.toContain('Headache')
    } finally { worker.dispose() }
  }, 30_000)
})
