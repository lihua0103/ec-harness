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

describe('PythonWorker Multi-Sheet runtime', () => {
  it('在持久会话内执行两张 Listing 并由统一 Writer 发布', async () => {
    const project = await mkdtemp(join(tmpdir(), 'dsh-listing-'))
    temporaryProjects.push(project)
    await mkdir(join(project, 'doc'))
    await writeFile(join(project, 'AE.csv'), 'USUBJID,AETERM\n01,Headache\n02,Nausea\n')
    const worker = new PythonWorker()

    try {
      const inspection = await worker.request({ operation: 'listing_inspect', project })
      expect(inspection.ok).toBe(true)

      const run = await worker.request({
        operation: 'listing_run_code',
        project,
        code: [
          'ae = datasets["AE"].copy()',
          'ae.attrs["labels"] = {"USUBJID": "Subject Identifier", "AETERM": "Adverse Event Term"}',
          'outputs = {',
          '    "Serious AE": ae.iloc[:1],',
          '    "All AE": ae,',
          '}',
        ].join('\n'),
      })
      expect(run).toMatchObject({
        ok: true,
        receipt: { outputCount: 2, publishReady: true },
      })

      const publish = await worker.request({
        operation: 'listing_publish', project, scenario: 'medical', trackChanges: false,
      })
      expect(publish).toMatchObject({
        ok: true,
        receipt: {
          format: 'single-workbook-multi-sheet-xlsx',
          statistics: {
            sheetNames: ['Content', 'Serious AE', 'All AE'],
            listingSheetCount: 2,
            totalSheets: 3,
            totalRows: 3,
          },
        },
      })

      const rbqmPublish = await worker.request({
        operation: 'listing_publish', project, scenario: 'rbqm', trackChanges: false,
      })
      expect(rbqmPublish).toMatchObject({
        ok: true,
        receipt: { statistics: { standardStructureApplied: false, rbqmStructureFlexible: true } },
      })

      const workbook = join(project, '.clinical-listing', 'output', 'medical', 'MEDICAL_LISTINGS.xlsx')
      const rbqmWorkbook = join(project, '.clinical-listing', 'output', 'rbqm', 'RBQM_LISTINGS.xlsx')
      const verificationScript = `
import json
import sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1], data_only=False)
rbqm = load_workbook(sys.argv[2], data_only=False)
content = wb["Content"]
ws = wb["Serious AE"]
print(json.dumps({
    "sheets": wb.sheetnames,
    "content_rows": content.max_row,
    "content_columns": [cell.value for cell in content[2]],
    "content_widths": [content.column_dimensions[column].width for column in "ABCDEFG"],
    "content_freeze": content.freeze_panes,
    "content_gridlines": content.sheet_view.showGridLines,
    "content_title": {"value": content["A1"].value, "font": content["A1"].font.name,
                      "size": content["A1"].font.sz, "bold": content["A1"].font.bold,
                      "fill": content["A1"].fill.fgColor.rgb},
    "content_link": content["B3"].value,
    "content_link_style": {"color": content["B3"].font.color.rgb,
                           "underline": content["B3"].font.underline},
    "freeze": ws.freeze_panes,
    "gridlines": ws.sheet_view.showGridLines,
    "filter": ws.auto_filter.ref,
    "label": {"value": ws["A2"].value, "font": ws["A2"].font.name, "size": ws["A2"].font.sz,
              "bold": ws["A2"].font.bold, "wrap": ws["A2"].alignment.wrap_text,
              "fill": ws["A2"].fill.fgColor.rgb, "row_height": ws.row_dimensions[2].height},
    "data": {"font": ws["A3"].font.name, "size": ws["A3"].font.sz,
             "fill": ws["A3"].fill.fgColor.rgb,
             "borders": [ws["A3"].border.left.style, ws["A3"].border.right.style,
                         ws["A3"].border.top.style, ws["A3"].border.bottom.style]},
    "rbqm_label_fill": rbqm["Serious AE"]["A2"].fill.fgColor.rgb,
    "back_link": ws["A1"].value,
    "back_link_style": {"color": ws["A1"].font.color.rgb,
                        "underline": ws["A1"].font.underline},
}))
`
      const verification = spawnSync('python', ['-c', verificationScript, workbook, rbqmWorkbook], { encoding: 'utf8' })
      expect(verification.status, verification.stderr).toBe(0)
      expect(JSON.parse(verification.stdout)).toEqual({
        sheets: ['Content', 'Serious AE', 'All AE'],
        content_rows: 4,
        content_columns: ['Listing Seq.', 'Form Name', 'New/Modified ?', 'Total', 'New', 'Modified', 'Old'],
        content_widths: [16.7109375, 50.7109375, 18.7109375, 9.7109375, 8.7109375, 12.7109375, 8.7109375],
        content_freeze: 'A3',
        content_gridlines: false,
        content_title: { value: 'Comparison Summary', font: 'Times New Roman', size: 16, bold: true, fill: 'FFEDF2F9' },
        content_link: '=HYPERLINK("#\'Serious AE\'!A1","Serious AE")',
        content_link_style: { color: 'FF0000FF', underline: 'single' },
        freeze: 'A3',
        gridlines: false,
        filter: 'A2:G3',
        label: { value: 'Subject Identifier', font: 'Times New Roman', size: 13, bold: true, wrap: true, fill: 'FFEDF2F9', row_height: 60 },
        data: { font: 'Times New Roman', size: 13, fill: 'FFFFFFFF', borders: ['thin', 'thin', 'thin', 'thin'] },
        rbqm_label_fill: 'FFEDF2F9',
        back_link: '=HYPERLINK("#\'Content\'!A1","Go back")',
        back_link_style: { color: 'FF0000FF', underline: null },
      })
    } finally {
      worker.dispose()
    }
  }, 30_000)

  it('按 DM Status Report 范例生成固定封面和单层表头业务页', async () => {
    const project = await mkdtemp(join(tmpdir(), 'dsh-report-'))
    temporaryProjects.push(project)
    await writeFile(join(project, 'REPORT.csv'), 'Site Name,Site Number,Subject Number\nSite A,001,001-001\n')
    const worker = new PythonWorker()

    try {
      expect(await worker.request({ operation: 'listing_inspect', project })).toMatchObject({ ok: true })
      expect(await worker.request({
        operation: 'listing_run_code',
        project,
        code: [
          'report = datasets["REPORT"].copy()',
          'report.attrs["report_metadata"] = {',
          '    "sponsor": "Example Sponsor",',
          '    "protocol_no": "CGB3002-RT01",',
          '    "project_id": "PROJECT-01",',
          '    "report_date": "2026-08-27",',
          '}',
          'outputs = {"Missing Page": report}',
        ].join('\n'),
      })).toMatchObject({ ok: true, receipt: { outputCount: 1, publishReady: true } })

      expect(await worker.request({
        operation: 'listing_publish', project, scenario: 'report', trackChanges: false,
      })).toMatchObject({
        ok: true,
        receipt: {
          statistics: {
            sheetNames: ['Cover Page', 'Missing Page'],
            reportStructureApplied: true,
            standardStructureApplied: false,
          },
        },
      })

      const workbook = join(project, '.clinical-listing', 'output', 'report', 'REPORT_LISTINGS.xlsx')
      const script = `
import json
import sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1], data_only=False)
cover = wb["Cover Page"]
report = wb["Missing Page"]
print(json.dumps({
    "sheets": wb.sheetnames,
    "cover_title": cover["A1"].value,
    "cover_merges": sorted(str(item) for item in cover.merged_cells.ranges),
    "cover_title_style": [cover["A1"].font.name, cover["A1"].font.sz,
                          cover["A1"].font.bold, cover["A1"].fill.fgColor.rgb,
                          cover["A1"].border.right.style, cover["A1"].border.bottom.style],
    "cover_label_border": [cover["A3"].border.right.style, cover["A3"].border.top.style,
                           cover["A3"].border.bottom.style],
    "cover_labels": [cover.cell(row, 1).value for row in range(3, 7)],
    "cover_values": [cover.cell(row, 2).value for row in range(3, 7)],
    "cover_heights": [cover.row_dimensions[row].height for row in range(1, 7)],
    "headers": [cell.value for cell in report[1]],
    "header_style": [report["A1"].font.name, report["A1"].font.sz,
                     report["A1"].font.bold, report["A1"].fill.fgColor.rgb,
                     report["A1"].alignment.horizontal, report["A1"].alignment.wrap_text],
    "header_height": report.row_dimensions[1].height,
    "widths": [report.column_dimensions[column].width for column in "ABC"],
    "freeze": report.freeze_panes,
    "filter": report.auto_filter.ref,
    "gridlines": report.sheet_view.showGridLines,
    "first_data": [cell.value for cell in report[2]],
}))
`
      const verification = spawnSync('python', ['-c', script, workbook], { encoding: 'utf8' })
      expect(verification.status, verification.stderr).toBe(0)
      expect(JSON.parse(verification.stdout)).toEqual({
        sheets: ['Cover Page', 'Missing Page'],
        cover_title: '数据管理状态报告\nDM Status Report',
        cover_merges: ['A1:G1', 'B3:G3', 'B4:G4', 'B5:G5', 'B6:G6'],
        cover_title_style: ['宋体', 16, true, 'FFD9D9D9', 'medium', 'medium'],
        cover_label_border: ['thin', 'thin', 'thin'],
        cover_labels: ['申办方：\nSponsor:', '方案编号：\nProtocol No:', '项目编号：\nProject ID:', '最新报告生成日期：'],
        cover_values: ['Example Sponsor', 'CGB3002-RT01', 'PROJECT-01', '2026-08-27'],
        cover_heights: [75, 12.6, 54, 47.25, 54, 39.75],
        headers: ['Site Name', 'Site Number', 'Subject Number'],
        header_style: ['Calibri', 12, true, 'FFC5D9F1', 'center', true],
        header_height: 31.5,
        widths: [59.7109375, 13.7109375, 17.140625],
        freeze: 'A2',
        filter: 'A1:C2',
        gridlines: null,
        first_data: ['Site A', 1, '001-001'],
      })
    } finally {
      worker.dispose()
    }
  }, 30_000)

  })



