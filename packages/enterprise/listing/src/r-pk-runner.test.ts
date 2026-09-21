import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPKRunner, PK_LANE_DIRS, PK_TEMPLATE_PATH, validateBlindMode, rscriptInvocation } from './r-runner.js'

describe('Rscript/Rterm 调用形态翻译', () => {
  it('Rscript 直传程序路径；Rterm 自动加 --vanilla --no-echo --file=', () => {
    expect(rscriptInvocation('Rscript.exe', 'D:/p/prog.R'))
      .toEqual({ command: 'Rscript.exe', args: ['D:/p/prog.R'] })
    expect(rscriptInvocation('D:\\package\\R-4.5.0\\bin\\x64\\Rterm.exe', 'D:/p/prog.R'))
      .toEqual({ command: 'D:\\package\\R-4.5.0\\bin\\x64\\Rterm.exe',
                 args: ['--vanilla', '--no-echo', '--file=D:/p/prog.R'] })
    expect(rscriptInvocation('/usr/bin/Rterm', '/tmp/prog.R'))
      .toEqual({ command: '/usr/bin/Rterm', args: ['--vanilla', '--no-echo', '--file=/tmp/prog.R'] })
  })
})

let root: string
let project: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-r-pk-lane-'))
  project = join(root, '示例申办方_400311_DEMO01')
  mkdirSync(join(project, PK_LANE_DIRS.dataCsv, '20260909'), { recursive: true })
  mkdirSync(join(project, PK_LANE_DIRS.dataSas, '20260909'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('r_pk 车道输入校验', () => {
  it('blindMode 只接受 blinded/unblinded，缺省盲态', () => {
    expect(validateBlindMode(undefined)).toBe('blinded')
    expect(validateBlindMode('unblinded')).toBe('unblinded')
    expect(() => validateBlindMode('partial')).toThrow(expect.objectContaining({ code: 'BLIND_MODE_INVALID' }))
  })

  it('双数据目录任一缺失分别报错（csv 与 sas 独立校验）', () => {
    const runner = new RPKRunner({ projectRoot: root })
    const args = { project, studyKey: '400311', dataDate: '20260909' }
    expect(runner.prepareProgram(args).rendered).toBe(true)
    rmSync(join(project, PK_LANE_DIRS.dataCsv, '20260909'), { recursive: true, force: true })
    expect(() => runner.prepareProgram({ ...args, render: false }))
      .toThrow(expect.objectContaining({ code: 'PK_CSV_DATE_NOT_FOUND' }))
    mkdirSync(join(project, PK_LANE_DIRS.dataCsv, '20260909'), { recursive: true })
    rmSync(join(project, PK_LANE_DIRS.dataSas, '20260909'), { recursive: true, force: true })
    expect(() => runner.prepareProgram({ ...args, render: false }))
      .toThrow(expect.objectContaining({ code: 'PK_SAS_DATE_NOT_FOUND' }))
  })
})

describe('r_pk 模板渲染', () => {
  it('占位符集合与渲染值一一对应（含 BLIND_MODE），渲染后无残留', () => {
    const template = readFileSync(PK_TEMPLATE_PATH, 'utf8')
    const keys = new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1]))
    expect([...keys].sort()).toEqual(
      ['BLIND_MODE', 'DATA_DATE', 'OLD_DATE', 'OUTPUT_PREFIX', 'PROJECT_ROOT', 'STUDY_KEY', 'SUMMARY_PATH', 'ZIP_PASSWORD'])
    const runner = new RPKRunner({ projectRoot: root })
    const { programPath, rendered } = runner.prepareProgram({
      project, studyKey: '400311', dataDate: '20260909', blindMode: 'blinded',
    })
    expect(rendered).toBe(true)
    expect(programPath).toBe(join(project, PK_LANE_DIRS.program, '400311_PK_Mapping.R'))
    const body = readFileSync(programPath, 'utf8')
    expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(body).toContain('"400311_PK Mapping"')
    expect(body).toContain('"blinded"')
    expect(body).toContain('Project_Data/02_Raw_csv/PK Mapping')
    expect(body).toContain('Project_Data/01_Raw_sas/PK Mapping')
    expect(body).toContain('Output/04_Out/PK Mapping')
    expect(body).toContain('DSH_R_BLIND_MODE')
  })

  it('unblinded 渲染值进文件；已有程序缺省复用', () => {
    const runner = new RPKRunner({ projectRoot: root })
    const args = { project, studyKey: '400311', dataDate: '20260909', blindMode: 'unblinded' as const }
    runner.prepareProgram(args)
    const programPath = join(project, PK_LANE_DIRS.program, '400311_PK_Mapping.R')
    expect(readFileSync(programPath, 'utf8')).toContain('"unblinded"')
    writeFileSync(programPath, '# edited', 'utf8')
    expect(runner.prepareProgram({ ...args, render: false }).rendered).toBe(false)
    expect(readFileSync(programPath, 'utf8')).toBe('# edited')
  })
})

describe('r_pk 执行与聚合回执（以 node 冒充 Rscript）', () => {
  /** beforeEach 重建 root/project 后取新值（describe 体求值早于 beforeEach） */
  const args = () => ({ project, studyKey: '400311', dataDate: '20260909' })
  function fakeProgram(script: string): RPKRunner {
    const runner = new RPKRunner({ projectRoot: root, rscript: process.execPath })
    const { programPath } = runner.prepareProgram(args())
    writeFileSync(programPath, script, 'utf8')
    return runner
  }

  it('成功回执 lane=r_pk 带盲态标记，密码经环境变量且不落盘', async () => {
    const runner = fakeProgram(`
      const fs = require('fs')
      const e = process.env
      fs.writeFileSync(e.DSH_R_SUMMARY_PATH, JSON.stringify({
        status: 'ok', lane: 'r_pk', blindMode: e.DSH_R_BLIND_MODE,
        listingCount: 4, rowCount: 120, flagCount: 2, sheetCount: 5,
        outputs: ['/abs/' + e.DSH_R_OUTPUT_PREFIX + '_' + e.DSH_R_DATA_DATE + ' (blinded).xlsx'],
        warnings: ['w1'], listings: [{ name: 'PK_Mapping', sheet: 'PK_Mapping', rowCount: 118, flagCount: 0 }],
      }))`)
    const receipt = await runner.run({ ...args(), password: 'S3cret', render: false })
    expect(receipt).toMatchObject({
      lane: 'r_pk', rendered: false, blindMode: 'blinded',
      listingCount: 4, rowCount: 120, flagCount: 2, sheetCount: 5,
      outputs: ['400311_PK Mapping_20260909 (blinded).xlsx'], warnings: ['w1'],
      programPath: 'SAS_Program/SAS_program/PK Mapping/400311_PK_Mapping.R',
    })
    expect(readFileSync(join(project, PK_LANE_DIRS.program, '400311_PK_Mapping.R'), 'utf8')).not.toContain('S3cret')
    expect(JSON.stringify(receipt)).not.toContain('S3cret')
  })

  it('blindMode=unblinded 经 DSH_R_BLIND_MODE 传给 R 程序', async () => {
    const runner = fakeProgram(`
      const fs = require('fs')
      fs.writeFileSync(process.env.DSH_R_SUMMARY_PATH, JSON.stringify({
        status: 'ok', listingCount: 4, rowCount: 1, flagCount: 0, sheetCount: 5,
        outputs: [], warnings: [], listings: [],
      }))
      const probe = JSON.stringify({ bm: process.env.DSH_R_BLIND_MODE })
      fs.writeFileSync(process.env.DSH_R_PROJECT_ROOT + '/${PK_LANE_DIRS.output}/probe.txt', probe)`)
    const receipt = await runner.run({ ...args(), blindMode: 'unblinded', render: false })
    expect(receipt.blindMode).toBe('unblinded')
    expect(JSON.parse(readFileSync(join(project, PK_LANE_DIRS.output, 'probe.txt'), 'utf8')).bm).toBe('unblinded')
  })
})
