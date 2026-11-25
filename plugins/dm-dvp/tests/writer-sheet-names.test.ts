// 写簿模板旋钮 dynamicSheetName：与 fieldLevelSheetName 同款（默认名、表头覆盖随配置名、非法名硬拒）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDvpWorkbook } from '../src/write.js';

const doc = (template: Record<string, unknown>) => JSON.stringify({
  dynamic: [{ id: 'DYN_01', formName: 'F', fieldName: 'X', type: 'Dynamic Field' }],
  template,
});

test('dynamicSheetName renames the Dynamic sheet; the default name is unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dvp-writer-sheet-'));
  try {
    const renamed = writeDvpWorkbook(dir, 'renamed.xlsx', doc({ dynamicSheetName: 'Dynamics' }));
    assert.equal(renamed.sheets.filter((sheet) => sheet.name === 'Dynamics').length, 1, 'dynamicSheetName=Dynamics 应生效');
    assert.equal(renamed.sheets.some((sheet) => sheet.name === 'Dynamic'), false, '旧名不再出现');
    const dflt = writeDvpWorkbook(dir, 'default.xlsx', doc({}));
    assert.equal(dflt.sheets.filter((sheet) => sheet.name === 'Dynamic').length, 1, '缺省仍为 Dynamic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dynamicSheetName rejects the same illegal names as fieldLevelSheetName', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dvp-writer-sheet-bad-'));
  try {
    assert.throws(() => writeDvpWorkbook(dir, 'bad.xlsx', doc({ dynamicSheetName: 'a/b' })), /INVALID_SHEET_NAME/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
