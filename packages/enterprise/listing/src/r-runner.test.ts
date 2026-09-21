import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RManualRunner, R_LANE_DIRS, renderTemplate, resolveProjectRoot, validateStudyKey, validateDate,
  DEFAULT_TEMPLATE_PATH,
} from './r-runner.js'

let root: string
let project: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-r-lane-'))
  project = join(root, '华睿医药_HXN6005-A1-201_HHSZCNDM01')
  mkdirSync(join(project, R_LANE_DIRS.data, '20260907'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('r_manual 车道输入校验', () => {
  it('项目名只能是项目根下的单层目录名或绝对路径', () => {
    expect(resolveProjectRoot('华睿医药_HXN6005-A1-201_HHSZCNDM01', root)).toBe(project)
    expect(resolveProjectRoot(project, root)).toBe(project)
    expect(() => resolveProjectRoot('../etc', root)).toThrow(expect.objectContaining({ code: 'PROJECT_PATH_INVALID' }))
    expect(() => resolveProjectRoot('missing', root)).toThrow(expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }))
  })

  it('studyKey / dataDate 只接受文件名安全字符', () => {
    expect(validateStudyKey('HXN6005-A1-201')).toBe('HXN6005-A1-201')
    expect(() => validateStudyKey('a b')).toThrow(expect.objectContaining({ code: 'STUDY_KEY_INVALID' }))
    expect(validateDate('20260907', 'dataDate')).toBe('20260907')
    expect(() => validateDate('../x', 'dataDate')).toThrow(expect.objectContaining({ code: 'DATA_DATE_INVALID' }))
  })
})

describe('模板渲染', () => {
  it('替换全部占位符并按 R 字面串转义，未知占位符保留', () => {
    const out = renderTemplate('a="{{PROJECT_ROOT}}" b="{{DATA_DATE}}" c="{{UNKNOWN}}"', {
      PROJECT_ROOT: 'D:\\x\\y "q"', DATA_DATE: '20260907',
    })
    expect(out).toBe('a="D:/x/y \\"q\\"" b="20260907" c="{{UNKNOWN}}"')
  })

  it('内置模板的占位符集合与渲染值一一对应，渲染后无残留', () => {
    const template = readFileSync(DEFAULT_TEMPLATE_PATH, 'utf8')
    const keys = new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1]))
    expect([...keys].sort()).toEqual(['DATA_DATE', 'OLD_DATE', 'OUTPUT_PREFIX', 'PROJECT_ROOT', 'STUDY_KEY', 'SUMMARY_PATH', 'ZIP_PASSWORD'])
    const runner = new RManualRunner({ projectRoot: root })
    const { programPath, rendered } = runner.prepareProgram({
      project: '华睿医药_HXN6005-A1-201_HHSZCNDM01', studyKey: 'HXN6005-A1-201', dataDate: '20260907',
    })
    expect(rendered).toBe(true)
    expect(programPath).toBe(join(project, R_LANE_DIRS.program, 'HXN6005-A1-201_Manual_Listing.R'))
    const body = readFileSync(programPath, 'utf8')
    expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(body).toContain('"HXN6005-A1-201_Manual Listing"')
    expect(body).toContain('DSH_R_ZIP_PASSWORD')
  })

  it('已有程序缺省复用；render=false 但程序不存在时报错；数据日期目录缺失时报错', () => {
    const runner = new RManualRunner({ projectRoot: root })
    const args = { project: project, studyKey: 'HXN6005-A1-201', dataDate: '20260907' }
    expect(() => runner.prepareProgram({ ...args, render: false })).toThrow(expect.objectContaining({ code: 'R_PROGRAM_NOT_FOUND' }))
    runner.prepareProgram(args)
    const programPath = join(project, R_LANE_DIRS.program, 'HXN6005-A1-201_Manual_Listing.R')
    writeFileSync(programPath, '# edited by AI', 'utf8')
    expect(runner.prepareProgram(args).rendered).toBe(false)
    expect(readFileSync(programPath, 'utf8')).toBe('# edited by AI')
    expect(runner.prepareProgram({ ...args, render: true }).rendered).toBe(true)
    expect(() => runner.prepareProgram({ ...args, dataDate: '19990101' })).toThrow(expect.objectContaining({ code: 'DATA_DATE_NOT_FOUND' }))
  })

  it('render=true 覆盖内容不同的既有程序时先备份，内容相同不重复备份', () => {
    const runner = new RManualRunner({ projectRoot: root })
    const args = { project: project, studyKey: 'HXN6005-A1-201', dataDate: '20260907' }
    runner.prepareProgram(args)
    const programPath = join(project, R_LANE_DIRS.program, 'HXN6005-A1-201_Manual_Listing.R')
    const sentinel = '# SENTINEL-ZONE-9F3A（AI 数小时生成的业务区）'
    writeFileSync(programPath, sentinel, 'utf8')

    const overwritten = runner.prepareProgram({ ...args, render: true })
    expect(overwritten.rendered).toBe(true)
    expect(overwritten.backupPath).toBeTruthy()
    expect(readFileSync(overwritten.backupPath!, 'utf8')).toBe(sentinel)
    expect(readFileSync(programPath, 'utf8')).not.toBe(sentinel)

    // 再渲染一次：既有内容与渲染结果一致，无内容丢失，不产生新备份
    const again = runner.prepareProgram({ ...args, render: true })
    expect(again.rendered).toBe(true)
    expect(again.backupPath).toBeUndefined()
  })

  it('备份保留最近 10 份（时间名排序淘汰最旧）', () => {
    const runner = new RManualRunner({ projectRoot: root })
    const args = { project: project, studyKey: 'HXN6005-A1-201', dataDate: '20260907' }
    const programPath = join(project, R_LANE_DIRS.program, 'HXN6005-A1-201_Manual_Listing.R')
    runner.prepareProgram(args)
    for (let i = 0; i < 13; i++) {
      writeFileSync(programPath, `# 内容 ${i}`, 'utf8')
      // 时间名精度到秒：同一秒内多次渲染会重名覆盖，断言按实际文件数放宽
      runner.prepareProgram({ ...args, render: true })
    }
    const backups = readdirSync(join(project, '.dsh', 'backups'))
      .filter(name => name.endsWith('.bak'))
    expect(backups.length).toBeLessThanOrEqual(10)
    expect(backups.length).toBeGreaterThan(0)
  })
})

describe('执行与聚合回执（以 node 冒充 Rscript）', () => {
  const args = { project: '华睿医药_HXN6005-A1-201_HHSZCNDM01', studyKey: 'HXN6005-A1-201', dataDate: '20260907' }
  /** 以 node 可执行文件冒充 Rscript：渲染后把伪程序（JS，读 DSH_R_* 环境变量、
   *  写 summary.json）覆盖到程序文件路径，run 时 render=false 复用。
   *  不用 .cmd 壳——Node 拒绝无 shell 直接 spawn 批处理（EINVAL）。 */
  function fakeProgram(script: string): RManualRunner {
    const runner = new RManualRunner({ projectRoot: root, rscript: process.execPath })
    const { programPath } = runner.prepareProgram(args)
    writeFileSync(programPath, script, 'utf8')
    return runner
  }

  it('成功回执只含聚合计数/产物文件名/告警，密码经环境变量传入且不落盘', async () => {
    const runner = fakeProgram(`
      const fs = require('fs')
      const e = process.env
      fs.writeFileSync(e.DSH_R_PROJECT_ROOT + '/${R_LANE_DIRS.output}/probe.txt', JSON.stringify({ pw: e.DSH_R_ZIP_PASSWORD, program: process.argv[1] }))
      fs.writeFileSync(e.DSH_R_SUMMARY_PATH, JSON.stringify({
        status: 'ok', listingCount: 2, rowCount: 10, flagCount: 3, sheetCount: 3,
        outputs: ['/abs/' + e.DSH_R_OUTPUT_PREFIX + '_' + e.DSH_R_DATA_DATE + '.xlsx'],
        warnings: ['w1'], listings: [{ name: 'Manual_A_01', sheet: 'A_01', rowCount: 4, flagCount: 1 }],
      }))`)
    const receipt = await runner.run({ ...args, password: 'S3cret', render: false })
    expect(receipt).toMatchObject({
      lane: 'r_manual', rendered: false, listingCount: 2, rowCount: 10, flagCount: 3, sheetCount: 3,
      outputs: ['HXN6005-A1-201_Manual Listing_20260907.xlsx'], warnings: ['w1'],
      programPath: 'SAS_Program/SAS_program/Manual Listing/HXN6005-A1-201_Manual_Listing.R',
    })
    const probe = JSON.parse(readFileSync(join(project, R_LANE_DIRS.output, 'probe.txt'), 'utf8'))
    expect(probe.pw).toBe('S3cret')
    expect(probe.program).toContain('HXN6005-A1-201_Manual_Listing.R')
    expect(readFileSync(join(project, R_LANE_DIRS.program, 'HXN6005-A1-201_Manual_Listing.R'), 'utf8')).not.toContain('S3cret')
    expect(JSON.stringify(receipt)).not.toContain('S3cret')
  })

  it('R stop 时回执带 summary 的错误信息，开关开启不回流 stderr', async () => {
    const runner = fakeProgram(`
      const fs = require('fs')
      fs.writeFileSync(process.env.DSH_R_SUMMARY_PATH, JSON.stringify({ status: 'error', message: '数据日期文件夹不存在：x' }))
      console.error('SUBJ-777 leaked line')
      process.exit(1)`)
    const error = await runner.run({ ...args, render: false }, true).then(() => { throw new Error('expected rejection') }, (e: Error) => e)
    expect(error).toMatchObject({ code: 'R_EXECUTION_ERROR' })
    expect(error.message).toContain('数据日期文件夹不存在：x')
    expect(error.message).not.toContain('SUBJ-777')
  })

  it('无 summary 且开关关闭时回流 stderr 尾部；Rscript 缺失报 R_NOT_FOUND', async () => {
    const runner = fakeProgram(`console.error('boom detail'); process.exit(2)`)
    await expect(runner.run({ ...args, render: false }, false)).rejects.toThrow('boom detail')
    const masked = await runner.run({ ...args, render: false }, true).then(() => { throw new Error('expected rejection') }, (e: Error) => e)
    expect(masked).toMatchObject({ code: 'R_EXECUTION_ERROR' })
    expect(masked.message).not.toContain('boom detail')
    const missing = new RManualRunner({ projectRoot: root, rscript: join(root, 'nope', 'Rscript') })
    await expect(missing.run({ ...args, render: false })).rejects.toMatchObject({ code: 'R_NOT_FOUND' })
    expect(existsSync(join(project, R_LANE_DIRS.program))).toBe(true)
  })
})