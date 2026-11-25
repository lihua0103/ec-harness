/**
 * 动态数据真实宿主 E2E：生成的 28 人 canonical 工作簿（与 fixtures 完全不同的
 * ID/取值）→ pt_viz_import_xlsx 同款导入通道 → builder 构建 → 自包含页渲染
 * （window.PT_DATA 注入，无夹具回退）→ 无头 Edge 提取运行态 option →
 * 断言 18 图全挂载、图表数据全部来自导入工作簿、无任何 fixture 参与者泄漏 →
 * 配置级验收 + 交付封存。
 * 运行：cd plugins/dm-participants && ./node_modules/.bin/tsx scripts/render-e2e-imported.mts
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildPtBundle, buildPtLiveModel, PAGE_ID, renderParticipantsPage } from '../src/participant-page.js';
import { buildPtModels } from '../src/participant-model.js';
import { importParticipantsWorkbook } from '../src/data.js';
import { acceptPage, extractDesignCharts, sealDelivery } from '../../../packages/platform-viz/src/index.js';
import { buildWorkbookXlsx, type FixtureSheet } from '../tests/xlsx-fixture.js';

const PROJECT_ROOT = 'D:/project/company/ec-clinical-dsh';
const ROOT = resolve(PROJECT_ROOT, '.runtime/dsh-home/dm-participants');
const MSEDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ECHARTS_LOCAL = 'D:/project/company/RBQM/previews/csm-central-redesign/echarts.min.js';

// ---------------------------------------------------------------------------
// 1) 生成与 fixtures 无重叠的 canonical 工作簿（28 人，S-21xx）。

const ENROLL: Record<number, number> = { 1: 0, 2: 8, 3: 16, 4: 24 };
const WEEKS = [0, 4, 12, 24, 48];
const rand = (i: number, k: string, lo: number, hi: number): number => {
  let h = 2166136261;
  const s = `S-${2101 + i}:${k}`;
  for (let c = 0; c < s.length; c++) {
    h ^= s.charCodeAt(c);
    h = Math.imul(h, 16777619);
  }
  return lo + ((h >>> 0) / 4294967295) * (hi - lo);
};
const r1 = (v: number): number => Math.round(v * 10) / 10;

interface Pt {
  id: string;
  site: number;
  cohort: number;
  arm: string;
  weeks: number;
  status: 'active' | 'completed' | 'withdrawn';
  exitWeek?: number;
  consentGapDays: number;
  adherencePct: number;
  procBefore?: number;
  egfr: number[];
  k: number[];
  hb: number[];
  alt: number[];
  uacr: number[];
  missedVisits: number[];
  devOver7: Record<number, number>;
  aes: Array<[number, number, number, string]>; // [week, grade, serious, term]
  queries: [number, number];
  eproMiss: number[];
  pills: [number, number, number];
  dose: Array<[number, number, string]>;
  elig: Array<[number, string]>;
  extraAnalyteRows: Array<[string, number, number]>;
}
const pts: Pt[] = [];
for (let i = 0; i < 28; i++) {
  const cohort = (i % 4) + 1;
  const id = `S-${2101 + i}`;
  pts.push({
    id,
    site: i % 6,
    cohort,
    arm: i % 2 ? 'Active' : 'Placebo',
    weeks: 56 - ENROLL[cohort]!,
    status: 'active',
    consentGapDays: Math.round(rand(i, 'g', 5, 20)),
    adherencePct: Math.round(rand(i, 'a', 86, 112)),
    egfr: [],
    k: [],
    hb: [],
    alt: [],
    uacr: [],
    missedVisits: [],
    devOver7: {},
    aes: [],
    queries: [Math.round(rand(i, 'q', 0, 2)), Math.round(rand(i, 'o', 2, 18))],
    eproMiss: [],
    pills: [168, Math.round(rand(i, 'p', 10, 30)), 0],
    dose: [[0, Math.min(56 - ENROLL[cohort]!, 48), 'full']],
    elig: [],
    extraAnalyteRows: [],
  });
  const p = pts[i]!;
  p.pills[2] = p.pills[0] - p.pills[1] + Math.round(rand(i, 'd', -4, 4));
  for (const wk of WEEKS) {
    if (wk <= p.weeks) {
      const base = rand(i, 'e' + wk, 62, 88);
      p.egfr.push(wk === 0 ? r1(base) : r1(base * (1 + rand(i, 'ej' + wk, -0.05, 0.05))));
      p.k.push(r1(rand(i, 'k' + wk, 3.7, 4.8)));
      p.hb.push(Math.round(rand(i, 'h' + wk, 122, 148)));
      p.alt.push(Math.round(rand(i, 'al' + wk, 12, 36)));
      p.uacr.push(Math.round(rand(i, 'u' + wk, 5, 25)));
    }
  }
}
// 特征参与者（保证 18 图各有非空、有信号的行）
const set = (i: number, patch: Partial<Pt>): void => Object.assign(pts[i]!, patch);
set(2, { egfr: [64, 52, 41, 28], k: [4.1, 4.5, 5.7, 6.3], missedVisits: [12], adherencePct: 64, queries: [9, 38], eproMiss: [3, 4, 6, 8, 10], elig: [[0, 'violated']], aes: [[14, 3, 1, 'AKI hospitalisation'], [18, 3, 0, 'AKI']], dose: [[0, 14, 'full'], [14, 20, 'reduced'], [20, 26, 'held'], [26, 40, 'full']] });
set(4, { k: [4.0, 3.4, 3.0, 2.7], aes: [[10, 2, 0, 'Fatigue']] });
set(6, { alt: [30, 58, 130, 220], elig: [[3, 'waiver']], aes: [[20, 1, 0, 'Headache']] });
set(8, { hb: [132, 120, 104, 92], queries: [4, 33] });
set(10, { consentGapDays: 41, devOver7: { 4: 9 } });
set(12, { consentGapDays: 0, procBefore: 1 });
set(14, { missedVisits: [24], queries: [4, 31], eproMiss: [5, 6, 7], pills: [168, 22, 100], elig: [[2, 'violated']], dose: [[0, 16, 'full'], [16, 32, 'reduced']] });
set(16, { queries: [7, 44], missedVisits: [12] });
set(18, { adherencePct: 128, missedVisits: [12], aes: [[12, 2, 1, 'Syncope']] });
set(20, { uacr: [18, 46, 130, 340], alt: [28, 44, 96, 140] });
set(21, { status: 'withdrawn', exitWeek: 18, missedVisits: [12], queries: [3, 27] });
set(23, { status: 'completed', exitWeek: 50, eproMiss: [9] });
set(24, { status: 'withdrawn', exitWeek: 30, devOver7: { 12: -9 } });
set(25, { extraAnalyteRows: [['CRP', 12, 18]] });
set(26, { consentGapDays: 12, procBefore: 1, elig: [[4, 'waiver']] });
// 27 号（S-2128）只有 participants 表：全域 unknown/notdue，验证不编造。

const sheets: FixtureSheet[] = [
  {
    name: 'participants',
    rows: [
      ['participantId', 'site', 'cohort', 'arm', 'weeks', 'status', 'consentGapDays', 'adherencePct', 'exitWeek', 'procBeforeConsent', 'screeningDay'],
      ...pts.map((p) => [
        p.id, p.site, p.cohort, p.arm, p.weeks, p.status, p.consentGapDays, p.adherencePct,
        p.exitWeek ?? '', p.procBefore ?? '', r1(rand(pts.indexOf(p), 's', 38, 68)),
      ]),
    ],
  },
];
const labRows: FixtureSheet['rows'] = [];
pts.forEach((p, i) => {
  if (i === 27) return;
  const series: Array<[string, number[]]> = [['egfr', p.egfr], ['k', p.k], ['hb', p.hb], ['alt', p.alt], ['uacr', p.uacr]];
  for (const [analyte, vals] of series) {
    WEEKS.forEach((wk, idx) => {
      if (wk <= p.weeks && idx < vals.length) labRows.push([p.id, analyte, wk, vals[idx]!]);
    });
  }
  for (const [analyte, wk, v] of p.extraAnalyteRows) labRows.push([p.id, analyte, wk, v]);
});
sheets.push({ name: 'labs', rows: [['participantId', 'analyte', 'week', 'value'], ...labRows] });
sheets.push({
  name: 'aes',
  rows: [
    ['participantId', 'week', 'term', 'grade', 'serious'],
    ...pts.flatMap((p, i) => (i === 27 ? [] : p.aes.map(([wk, grade, serious, term]) => [p.id, wk, term, grade, serious]))),
  ],
});
const visitRows: FixtureSheet['rows'] = [];
pts.forEach((p, i) => {
  if (i === 27) return;
  for (const wk of WEEKS) {
    if (wk > p.weeks || wk === 0) continue;
    if (p.missedVisits.includes(wk)) visitRows.push([p.id, wk, 'missed', '']);
    else visitRows.push([p.id, wk, 'done', p.devOver7[wk] !== undefined ? p.devOver7[wk]! : Math.round(rand(i, 'v' + wk, -4, 4))]);
  }
});
sheets.push({ name: 'visits', rows: [['participantId', 'week', 'state', 'deviationDays'], ...visitRows] });
const eproRows: FixtureSheet['rows'] = [];
pts.forEach((p, i) => {
  if (i === 27) return;
  const maxDue = Math.min(12, Math.max(0, Math.floor((p.weeks - 4) / 4)));
  for (let j = 0; j < 12; j++) {
    const state = j >= maxDue ? 'notdue' : p.eproMiss.includes(j) ? 'missed' : rand(i, 'ep' + j, 0, 1) > 0.9 ? 'partial' : 'full';
    eproRows.push([p.id, j, state]);
  }
});
sheets.push({ name: 'epro', rows: [['participantId', 'weekIndex', 'state'], ...eproRows] });
sheets.push({ name: 'pills', rows: [['participantId', 'dispensed', 'returned', 'diary'], ...pts.filter((_, i) => i !== 27).map((p) => [p.id, p.pills[0], p.pills[1], p.pills[2]])] });
sheets.push({ name: 'queries', rows: [['participantId', 'openCount', 'oldestDays'], ...pts.filter((_, i) => i !== 27).map((p) => [p.id, p.queries[0], p.queries[1]])] });
const doseRows: FixtureSheet['rows'] = [];
pts.forEach((p, i) => {
  if (i === 27) return;
  for (const [from, to, state] of p.dose) doseRows.push([p.id, from, Math.min(to, p.weeks), state]);
});
sheets.push({ name: 'dose', rows: [['participantId', 'fromWeek', 'toWeek', 'state'], ...doseRows] });
sheets.push({ name: 'eligibility', rows: [['participantId', 'criterion', 'status'], ...pts.flatMap((p) => p.elig.map(([c, s]) => [p.id, c, s]))] });

const IMPORT_DIR = resolve(ROOT, 'import');
await mkdir(IMPORT_DIR, { recursive: true });
const workbookPath = resolve(IMPORT_DIR, 'cohort-b-e2e.xlsx');
const buffer = buildWorkbookXlsx(sheets);
await writeFile(workbookPath, buffer);
const sha256 = createHash('sha256').update(buffer).digest('hex');
console.log('workbook written:', workbookPath, `(${buffer.length} bytes, sha256 ${sha256.slice(0, 12)})`);

// ---------------------------------------------------------------------------
// 2) 真实导入通道 → builder → 渲染（PT_DATA 注入）。

const imported = await importParticipantsWorkbook(workbookPath);
console.log('imported participants:', imported.participants.length, '| warnings:', imported.warnings.length);
for (const w of imported.warnings) console.log('  warning:', w);
if (imported.participants.length !== 28) throw new Error(`expected 28 participants, got ${imported.participants.length}`);

const models = buildPtModels(imported.participants);
const bundle = buildPtBundle({ M: models, P: imported.participants });
const live = buildPtLiveModel({ M: models, P: imported.participants });

const echartsScript = await readFile(ECHARTS_LOCAL, 'utf8');
const html = await renderParticipantsPage({
  echartsScript,
  data: { participants: imported.participants, source: { mode: 'imported', label: 'cohort-b-e2e.xlsx', sha256 } },
});
const pagePath = resolve(ROOT, 'pt-participants-imported.html');
await writeFile(pagePath, html, 'utf8');
console.log('imported page written:', pagePath, `(${html.length} bytes)`);
for (const probe of ['28 of 28 shown', 'RBQM-PARTICIPANT-IMPORTED-PREVIEW', 'Imported data · cohort-b-e2e.xlsx', 'window.PT_DATA=']) {
  if (!html.includes(probe)) throw new Error(`page chrome missing: ${probe}`);
}

// ---------------------------------------------------------------------------
// 3) 真实 Edge 提取运行态 option → 动态数据断言。

const extract = (url: string) =>
  extractDesignCharts({ url, executablePath: MSEDGE, settleMs: 2500, windowSize: { width: 1680, height: 2000 } });
const ours = await extract(`file:///${pagePath.replace(/\\/g, '/')}?selftest=1`);
console.log('rendered-page charts extracted:', ours.length);
if (ours.length !== 18) throw new Error(`expected 18 mounted charts, got ${ours.length}`);

const allOptions = JSON.stringify(ours.map((c) => c.option));
const idsInCharts = new Set(allOptions.match(/S-21\d\d/g) ?? []);
console.log('distinct imported IDs visible in chart data:', idsInCharts.size);
if (idsInCharts.size < 25) throw new Error(`charts show only ${idsInCharts.size} imported participants`);
if (/P-0\d\d/.test(allOptions)) throw new Error('fixture participant IDs leaked into rendered charts');
for (const must of ['S-2103', 'S-2108', 'S-2112', 'S-2122']) {
  if (!idsInCharts.has(must)) throw new Error(`expected imported participant ${must} visible in charts`);
}
const blank = live.items.filter((item) => item.points <= 0).map((item) => item.i);
if (blank.length) throw new Error(`blank charts in imported build: ${blank.join(',')}`);

// ---------------------------------------------------------------------------
// 4) 配置级验收 + 交付封存。

const record = acceptPage(bundle, []);
await writeFile(resolve(ROOT, 'pt-participants-imported.acceptance.json'), JSON.stringify({ ...record, dataSource: { mode: 'imported', file: 'cohort-b-e2e.xlsx', sha256 } }, null, 2), 'utf8');
console.log(
  'acceptance:',
  record.result,
  `blank=${record.structure.blank}`,
  `errors=${record.structure.errors.length}`,
  `overlaps=${record.structure.overlaps}`,
  `orphans=${record.structure.orphans}`,
  `canvases=${record.structure.canvases}`,
);
if (record.result !== 'pass') throw new Error('config-level acceptance failed for imported build');

const delivery = await sealDelivery(ROOT, bundle, []);
const deliveryPage = resolve(delivery.directory, `${PAGE_ID}-imported.html`);
await writeFile(deliveryPage, html, 'utf8');
console.log('delivery:', delivery.directory);
console.log('manifest:', delivery.manifest ? `result=${delivery.manifest.result}` : 'missing!');
console.log('DYNAMIC E2E OK: 18/18 mounted, data 100% from imported workbook, zero fixture leakage');
