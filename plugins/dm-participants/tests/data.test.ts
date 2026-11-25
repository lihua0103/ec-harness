/** 数据通道验收：canonical 多表工作簿 → Participant[]，诚实规则与 provenance。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importParticipantsWorkbook } from '../src/data.js';
import { DEFAULT_SCOPE, filterParticipants } from '../src/participant-model.js';
import { VizError } from '../../../packages/platform-viz/src/errors.js';
import { buildWorkbookXlsx, type FixtureSheet, type SheetCell } from './xlsx-fixture.js';

async function withWorkbook(sheets: FixtureSheet[], fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dm-pt-data-'));
  const path = join(dir, 'participants.xlsx');
  try {
    await writeFile(path, buildWorkbookXlsx(sheets));
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const head = (...cells: string[]): SheetCell[] => cells;
const row = (...cells: SheetCell[]): SheetCell[] => cells;

function happySheets(): FixtureSheet[] {
  const eproRows: SheetCell[][] = [head('participantId', 'weekIndex', 'state')];
  for (let i = 0; i < 12; i++) eproRows.push(row('P-101', i, i >= 4 && i <= 7 ? 'missed' : 'full'));
  return [
    {
      name: 'participants',
      rows: [
        head('participantId', 'site', 'cohort', 'arm', 'weeks', 'status', 'consentGapDays', 'adherencePct'),
        row('P-101', 101, 2, 'Active', 56, 'active', 34, 95),
        row('P-102', 102, 1, 'Placebo', 10, 'withdrawn', 12, 82),
      ],
    },
    {
      name: 'labs',
      rows: [
        head('participantId', 'analyte', 'week', 'value'),
        row('P-101', 'eGFR', 0, 52),
        row('P-101', 'EGFR', 48, 20),
        row('P-101', 'k', 0, 3.9),
        row('P-102', 'crp', 0, 5),
      ],
    },
    { name: 'aes', rows: [head('participantId', 'week', 'term', 'grade', 'serious'), row('P-101', 20, 'Headache', 2, 0)] },
    {
      name: 'visits',
      rows: [head('participantId', 'week', 'state', 'deviationDays'), row('P-101', 4, 'done', 2), row('P-101', 12, 'missed', null)],
    },
    { name: 'epro', rows: eproRows },
    { name: 'pills', rows: [head('participantId', 'dispensed', 'returned', 'diary'), row('P-101', 280, 20, 300)] },
    { name: 'queries', rows: [head('participantId', 'openCount', 'oldestDays'), row('P-101', 2, 45)] },
    {
      name: 'dose',
      rows: [head('participantId', 'fromWeek', 'toWeek', 'state'), row('P-101', 0, 24, 'full'), row('P-101', 24, 48, 'held')],
    },
    { name: 'eligibility', rows: [head('participantId', 'criterion', 'status'), row('P-101', 5, 'violated')] },
  ];
}

test('导入：九表全量 → 派生量、旗标与 provenance', async () => {
  await withWorkbook(happySheets(), async (path) => {
    const imported = await importParticipantsWorkbook(path);
    assert.equal(imported.participants.length, 2);
    const [a, b] = imported.participants;

    // P-101：eGFR 最重 G4 → labCrit/medHigh；总负担 9（1 医疗 + 3 方案 + 4 数据 + 1 暴露）。
    assert.equal(a.id, 'P-101');
    assert.equal(a.labCrit, true);
    assert.equal(a.medHigh, true);
    assert.deepEqual(a.sig, [1, 3, 4, 1]);
    assert.equal(a.total, 9);
    assert.deepEqual(a.unknownDomains, []);
    const egfr = a.lab['egfr']!.map((x) => x.flag);
    assert.deepEqual(egfr, ['warning', 'unknown', 'high', 'unknown', 'high']);
    assert.equal(a.lab['egfr']![0]!.v, 52);
    assert.equal(a.lab['k']![0]!.flag, 'normal');
    assert.equal(a.endpoint['24'], 'unknown');
    assert.equal(a.endpoint['48'], 'unknown');
    assert.equal(a.visits['12']!.state, 'missed');
    assert.equal(a.epro.filter((s) => s === 'missed').length, 4);
    assert.deepEqual(a.pills, { dispensed: 280, returned: 20, diary: 300 });
    assert.deepEqual(a.queries, { open: 2, oldest: 45 });
    assert.deepEqual(a.doseSegs.map((s) => s.state), ['full', 'held']);
    assert.deepEqual(a.elig, [{ c: 5, s: 'violated' }]);
    assert.deepEqual(a.aes, [{ wk: 20, grade: 2, serious: false, term: 'Headache' }]);

    // P-102：labs 缺到点行 → unknown；未覆盖到点 → endpoint unknown；无编造信号。
    assert.equal(b.total, 0);
    assert.equal(b.labCrit, false);
    assert.equal(b.endpoint['4'], 'unknown');
    assert.deepEqual(
      b.lab['egfr']!.map((x) => x.flag),
      ['unknown', 'unknown', 'notdue', 'notdue', 'notdue'],
    );
    assert.deepEqual(b.epro, Array.from({ length: 12 }, () => 'notdue'));
    assert.deepEqual(b.pills, { dispensed: 0, returned: 0, diary: 0 });

    // provenance 与原始行保留。
    assert.equal(imported.provenance.length, 9);
    for (const p of imported.provenance) assert.match(p.sourceSha256, /^[0-9a-f]{64}$/);
    const participantsSheet = imported.provenance.find((p) => p.name === 'participants')!;
    assert.equal(participantsSheet.rows, 2);
    assert.equal(imported.sourceRows['participants']![0]!['participantId'], 'P-101');
    assert.ok(imported.warnings.some((w) => w.includes('unknown analyte') && w.includes('P-102')));
  });
});

test('诚实规则：可选域整表缺席 → unknownDomains + 警告，不编造', async () => {
  const only = happySheets().filter((s) => s.name === 'participants');
  await withWorkbook(only, async (path) => {
    const imported = await importParticipantsWorkbook(path);
    for (const sheet of ['labs', 'aes', 'visits', 'eligibility', 'epro', 'queries', 'pills', 'dose']) {
      assert.ok(imported.warnings.some((w) => w.startsWith(`[${sheet}] sheet absent`)), sheet);
    }
    for (const p of imported.participants) assert.deepEqual(p.unknownDomains.sort(), ['data', 'ip', 'lab', 'protocol', 'safety']);
    const p = imported.participants.find((x) => x.id === 'P-101')!;
    assert.equal(p.total, 1, 'consent-gap (34d > 28) stands alone without any domain sheet');
    const q = imported.participants.find((x) => x.id === 'P-102')!;
    assert.equal(q.total, 0);
    assert.equal(p.lab['egfr']![0]!.flag, 'unknown');
    assert.equal(p.epro.every((s) => s === 'notdue'), true);
    assert.ok(imported.provenance.every((s) => s.name === 'participants'));
  });
});

test('诚实规则：缺列显式报错、重复 ID、越界分级、必需表缺席', async () => {
  const broken = happySheets().map((s) =>
    s.name === 'participants'
      ? { name: s.name, rows: [s.rows[0]!.filter((c) => c !== 'adherencePct'), s.rows[1]!.slice(0, -1), s.rows[2]!] }
      : s,
  );
  await withWorkbook(broken, async (path) => {
    await assert.rejects(
      importParticipantsWorkbook(path),
      (e: unknown) => e instanceof VizError && e.code === 'PARTICIPANT_COLUMN_MISSING',
    );
  });

  const dup = happySheets().map((s) =>
    s.name === 'participants' ? { name: s.name, rows: [...s.rows, s.rows[1]!] } : s,
  );
  await withWorkbook(dup, async (path) => {
    await assert.rejects(
      importParticipantsWorkbook(path),
      (e: unknown) => e instanceof VizError && e.code === 'PARTICIPANT_ID_DUPLICATE',
    );
  });

  const badGrade = happySheets().map((s) =>
    s.name === 'aes' ? { name: s.name, rows: [s.rows[0]!, row('P-101', 8, 'SAE', 9, 1)] } : s,
  );
  await withWorkbook(badGrade, async (path) => {
    await assert.rejects(
      importParticipantsWorkbook(path),
      (e: unknown) => e instanceof VizError && e.code === 'PARTICIPANT_ROW_INVALID',
    );
  });

  const noParticipants: FixtureSheet[] = happySheets().filter((s) => s.name === 'labs');
  await withWorkbook(noParticipants, async (path) => {
    await assert.rejects(
      importParticipantsWorkbook(path),
      (e: unknown) => e instanceof VizError && e.code === 'PARTICIPANTS_SHEET_REQUIRED',
    );
  });
});


test('导入：文本中心/队列保留，筛选与中心排序支持混合标识', async () => {
  const sheets = happySheets().filter((s) => s.name === 'participants');
  sheets[0].rows[1][1] = 'Demo Site 10';
  sheets[0].rows[1][2] = 'Cohort A';
  sheets[0].rows[2][1] = 'Demo Site 2';
  await withWorkbook(sheets, async (path) => {
    const imported = await importParticipantsWorkbook(path);
    const list = imported.participants;
    assert.equal(list[0].site, 'Demo Site 10');
    assert.equal(list[0].cohort, 'Cohort A');
    assert.equal(list[1].cohort, 1);
    assert.equal(imported.sourceRows.participants[0].site, 'Demo Site 10');
    assert.deepEqual(filterParticipants(list, { ...DEFAULT_SCOPE, site: 'Demo Site 10', cohort: 'Cohort A' }).map(p => p.id), ['P-101']);
    assert.deepEqual(filterParticipants(list, { ...DEFAULT_SCOPE, sort: 'site' }).map(p => p.id), ['P-102', 'P-101']);
    list[0].site = 10;
    list[1].site = 2;
    assert.deepEqual(filterParticipants(list, { ...DEFAULT_SCOPE, sort: 'site' }).map(p => p.id), ['P-102', 'P-101']);
    list[0].site = 'Demo Site 10';
    assert.equal(filterParticipants(list, { ...DEFAULT_SCOPE, sort: 'site' }).length, 2);
  });
});
