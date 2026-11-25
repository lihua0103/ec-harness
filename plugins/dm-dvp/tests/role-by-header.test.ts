/** 角色按表头修正：旧版模板把 Rave 字段级规格放在名为 "Edit Checks Rave" 的 sheet 里。
 *  实物（2020 版 V1.0）：按名字判成跨字段规则后 5 列找不到，529 行整页规则全空，且排在第一页。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overviewDvpWorkbook, parseDvpWorkbook } from '../src/parse.js';
import { makeWorkbook } from './fixtures/make-xlsx.js';

const V1_SHEETS = [
  { name: 'Edit Checks Rave', rows: [
    ['Add/Delete/Update(applied for Rave edit checks only)', 'FormOID', 'Form Name', 'FieldOID', 'PreText', 'ControlType', 'DataFormat', 'Is Required(True/False)', 'Query Future Date(True/False)', 'Query Non-Conformance(True/False)', 'Test Subject Number', 'Pass / Fail?', 'DM Comments', 'DBD Comments'],
    ['', 'SUBJ', '受试者登记', 'SUBNUM', '受试者编号', 'Text', '$3', 'TRUE', 'FALSE', 'FALSE', '', '', '', ''],
    ['', 'SV', '访视日期', 'VISDAT', '访视日期', 'DateTime', 'dd MMM yyyy', 'TRUE', 'TRUE', 'TRUE', '', '', '', ''],
  ] },
  { name: 'Edit Checks', rows: [
    ['Unique ID', 'Add/ Delete/ Update', 'Visit(s) Applied To', 'FormName', 'Query Targeted Field', 'Query Related Field', 'Query Type', 'Discrepancy Text Message', 'Logic'],
    ['IC_01', '', 'ALL', '知情同意', '筛选开始日期', '签署日期', 'Custom', '合成核查说明一。', '筛选开始日期-签署日期<0'],
    ['EG_01', '', 'ALL', '心电图', '检查日期', '是否检查', 'Custom', '合成核查说明二。', '检查日期<签署日期'],
  ] },
];

const dirs: string[] = [];
function withWorkbook(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dm-dvp-role-'));
  dirs.push(directory);
  writeFileSync(join(directory, 'dvp.xlsx'), makeWorkbook(V1_SHEETS));
  return directory;
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('overview 只读名字（不读内容）："Edit Checks Rave" 仍标 crossField，解析时再按表头修正', async () => {
  const o = await overviewDvpWorkbook(withWorkbook(), 'dvp.xlsx');
  assert.equal(o.sheets.find((s) => s.name === 'Edit Checks Rave')?.role, 'crossField');
});

test('parse：名字像跨字段规则、表头是字段级规格的 sheet 归入 fieldLevel，规则不再为空', async () => {
  const { document, stats } = await parseDvpWorkbook(withWorkbook(), 'dvp.xlsx');
  assert.equal(document.fieldLevel.length, 2, 'Rave 行进入字段级规格');
  assert.deepEqual(document.fieldLevel.map((r) => `${r.formOid}.${r.fieldOid}`), ['SUBJ.SUBNUM', 'SV.VISDAT']);
  assert.equal(document.fieldLevel[0]?.isRequired, true);
  assert.equal(document.crossField.length, 2, '跨字段规则只来自 Edit Checks');
  assert.ok(document.crossField.every((r) => r.id && r.targetField && r.logic), `跨字段规则字段齐全: ${JSON.stringify(document.crossField.map((r) => [r.id, r.targetField, r.logic]))}`);
  const rave = stats.sheets.find((s) => s.name === 'Edit Checks Rave');
  assert.equal(rave?.role, 'fieldLevel');
  assert.match(rave?.note ?? '', /ROLE_BY_HEADER/);
  assert.equal(rave?.records, 2);
  assert.ok(!JSON.stringify(rave).includes('COLUMN_NOT_FOUND:targetField'), '不再报找不到目标字段列');
  assert.equal(document.sheets.find((s) => s.name === 'Edit Checks Rave')?.role, 'fieldLevel');
  assert.equal((stats.sections.fieldLevel?.total ?? 0), 2);
  assert.equal((stats.sections.crossField?.total ?? 0), 2);
});

test('名字与表头一致的 sheet 不受影响', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dm-dvp-role-'));
  dirs.push(directory);
  writeFileSync(join(directory, 'dvp.xlsx'), makeWorkbook([
    { name: 'Edit Checks(Field Level)', rows: V1_SHEETS[0].rows },
    { name: 'Edit Checks', rows: V1_SHEETS[1].rows },
  ]));
  const { document, stats } = await parseDvpWorkbook(directory, 'dvp.xlsx');
  assert.equal(document.fieldLevel.length, 2);
  assert.equal(document.crossField.length, 2);
  assert.ok(stats.sheets.every((s) => !s.note?.includes('ROLE_BY_HEADER')));
});
