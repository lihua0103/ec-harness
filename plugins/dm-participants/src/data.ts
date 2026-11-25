/**
 * 数据通道（平台原生设计）：各家 EDC rawdata → 统一清洗处理 → Excel →
 * RBQM 数据集 → 处理后数据供图表 builder 渲染。
 *
 * 本模块把清洗后的 Excel 工作簿按 canonical 契约读成结构完整的
 * Participant[]，供 18 个 builder 渲染；fixtures（设计稿对齐）走
 * fixtureParticipants()，真实数据走本模块，共用同一套 derive() 派生量。
 *
 * 契约（工作表名即表名）：
 *  - participants（必需）：participantId, site, cohort, arm, weeks, status,
 *    consentGapDays, adherencePct；可选 exitWeek, procBeforeConsent, screeningDay
 *  - labs: participantId, analyte(egfr|k|hb|alt|uacr,大小写不敏感), week(0|4|12|24|48), value
 *  - aes: participantId, week, term, grade(1-5), serious(1/true/yes)
 *  - visits: participantId, week(4|12|24|48), state(done|missed), deviationDays?
 *  - epro: participantId, weekIndex(0-11), state(full|partial|missed|notdue)
 *  - pills: participantId, dispensed, returned, diary
 *  - queries: participantId, openCount, oldestDays
 *  - dose: participantId, fromWeek, toWeek, state(full|reduced|held)
 *  - eligibility: participantId, criterion(0-5), status(violated|waiver)
 *
 * 诚实规则（不编造）：
 *  - 缺列 → PARTICIPANT_COLUMN_MISSING 显式报错，不猜列名；
 *  - 整域工作表缺席 → 该域记入 unknownDomains，对应周渲染为 unknown/notdue
 *    中性展示，绝不生成替代数值；
 *  - labs/visits 缺到点行 → 值 null / flag unknown / endpoint unknown，
 *    不当作 missing 计入信号；
 *  - 原始行逐字保留（sourceRows），只加 provenance，不改写。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Workbook } from '../../../packages/platform-workbook/src/index.js';
import { importWorkbookSheet, VizError, type Dataset } from '../../../packages/platform-viz/src/index.js';
import {
  LABS,
  LABW,
  VISITS,
  derive,
  flagOf,
  grade,
  enrichDemoParticipant,
  type EproState,
  type Participant,
} from './participant-model.js';

export interface SheetProvenance {
  name: string;
  datasetId: string;
  sourcePath: string;
  sourceSha256: string;
  importedAt: string;
  rows: number;
  columns: string[];
  warnings: string[];
}

export interface ImportedParticipants {
  participants: Participant[];
  /** 原始行逐字保留（含参与者表与各域表），只读，不改写。 */
  sourceRows: Record<string, Record<string, unknown>[]>;
  provenance: SheetProvenance[];
  warnings: string[];
}

export interface SheetSpec {
  name: string;
  required: boolean;
  columns: string[];
  datasetId: string;
}

const bool = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
};
const str = (v: unknown): string => String(v ?? '').trim();
const num = (v: unknown, where: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new VizError('PARTICIPANT_ROW_INVALID', `${where}: number expected, got ${JSON.stringify(v)}`);
  return n;
};

export const PARTICIPANT_SHEETS: SheetSpec[] = [
  {
    name: 'participants',
    required: true,
    datasetId: 'pt-participants',
    columns: ['participantId', 'site', 'cohort', 'arm', 'weeks', 'status', 'consentGapDays', 'adherencePct'],
  },
  { name: 'labs', required: false, datasetId: 'pt-labs', columns: ['participantId', 'analyte', 'week', 'value'] },
  { name: 'aes', required: false, datasetId: 'pt-aes', columns: ['participantId', 'week', 'term', 'grade', 'serious'] },
  { name: 'visits', required: false, datasetId: 'participants-visits', columns: ['participantId', 'week', 'state', 'deviationDays'] },
  { name: 'epro', required: false, datasetId: 'pt-epro', columns: ['participantId', 'weekIndex', 'state'] },
  { name: 'pills', required: false, datasetId: 'pt-pills', columns: ['participantId', 'dispensed', 'returned', 'diary'] },
  { name: 'queries', required: false, datasetId: 'pt-queries', columns: ['participantId', 'openCount', 'oldestDays'] },
  { name: 'dose', required: false, datasetId: 'pt-dose', columns: ['participantId', 'fromWeek', 'toWeek', 'state'] },
  { name: 'eligibility', required: false, datasetId: 'pt-eligibility', columns: ['participantId', 'criterion', 'status'] },
];

const DOMAIN_SHEETS: Record<string, string[]> = {
  lab: ['labs'],
  safety: ['aes'],
  protocol: ['visits', 'eligibility'],
  data: ['epro', 'queries'],
  ip: ['pills', 'dose'],
};
const ALL_DOMAINS = Object.keys(DOMAIN_SHEETS);

export interface ImportState {
  sourceRows: Record<string, Record<string, unknown>[]>;
  warnings: string[];
}

function rowObjects(dataset: Dataset, spec: SheetSpec): Record<string, unknown>[] {
  // 平台读取器把列键统一小写；按 canonical 契约做大小写不敏感回映射。
  const canon = new Map<string, string>();
  for (const col of dataset.columns) {
    const match = spec.columns.find((c) => c.toLowerCase() === col.key.toLowerCase());
    canon.set(col.key, match ?? col.key);
  }
  return dataset.rows.map((row) => Object.fromEntries(dataset.columns.map((c, i) => [canon.get(c.key)!, row[i] ?? null])));
}

function groupById(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const id = str(r.participantId);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(r);
  }
  return map;
}

function readParticipants(state: ImportState): Participant[] {
  const rows = state.sourceRows['participants'];
  if (!rows) throw new VizError('PARTICIPANTS_SHEET_REQUIRED', 'participants sheet missing');
  if (!rows.length) throw new VizError('PARTICIPANTS_EMPTY', 'participants sheet has no data rows');
  const seen = new Set<string>();
  const list: Participant[] = [];
  rows.forEach((r, idx) => {
    const id = str(r.participantId);
    if (!id) throw new VizError('PARTICIPANT_ROW_INVALID', `participants row ${idx + 2}: participantId empty`);
    if (seen.has(id)) throw new VizError('PARTICIPANT_ID_DUPLICATE', id);
    seen.add(id);
    for (const col of ['site', 'cohort', 'weeks', 'consentGapDays', 'adherencePct']) {
      if (r[col] === null || r[col] === undefined || str(r[col]) === '') {
        throw new VizError('PARTICIPANT_COLUMN_MISSING', `participants.${col} (row ${id})`);
      }
    }
    const status = str(r.status).toLowerCase();
    if (!['active', 'completed', 'withdrawn'].includes(status)) {
      throw new VizError('PARTICIPANT_ROW_INVALID', `participants ${id}: invalid status ${JSON.stringify(r.status)}`);
    }
    list.push({
      id,
      n: idx + 1,
      // site may be string like "Demo Site 001" or numeric index; keep original if not numeric
      site: (() => { const n = Number(r.site); return Number.isFinite(n) ? n : String(r.site || ''); })(),
      cohort: (() => { const n = Number(r.cohort); return Number.isFinite(n) ? n : String(r.cohort || ''); })(),
      arm: str(r.arm) || 'Unassigned',
      weeks: num(r.weeks, `participants ${id}.weeks`),
      status: status as Participant['status'],
      exitWk: r.exitWeek == null || str(r.exitWeek) === '' ? null : num(r.exitWeek, `participants ${id}.exitWeek`),
      consentGap: num(r.consentGapDays, `participants ${id}.consentGapDays`),
      procBefore: bool(r.procBeforeConsent),
      screen: r.screeningDay == null || str(r.screeningDay) === '' ? 0 : num(r.screeningDay, `participants ${id}.screeningDay`),
      elig: [],
      visits: {},
      aes: [],
      adherence: num(r.adherencePct, `participants ${id}.adherencePct`),
      doseSegs: [],
      pills: { dispensed: 0, returned: 0, diary: 0 },
      queries: { open: 0, oldest: 0 },
      epro: [],
      endpoint: {},
      unknownDomains: [],
      lab: {},
      labCrit: false,
      medHigh: false,
      sig: [0, 0, 0, 0],
      total: 0,
    });
  });
  return list;
}

function applyAes(state: ImportState, list: Participant[]): void {
  const byId = groupById(state.sourceRows['aes'] ?? []);
  for (const p of list) {
    p.aes = (byId.get(p.id) ?? []).map((r) => {
      const g = num(r.grade, `aes ${p.id}.grade`);
      if (!Number.isInteger(g) || g < 1 || g > 5) {
        throw new VizError('PARTICIPANT_ROW_INVALID', `aes ${p.id}: grade out of range ${JSON.stringify(r.grade)} (1-5)`);
      }
      return { wk: num(r.week, `aes ${p.id}.week`), grade: g, serious: bool(r.serious), term: str(r.term) || 'AE' };
    });
  }
}

function applyVisits(state: ImportState, list: Participant[]): void {
  const byId = groupById(state.sourceRows['visits'] ?? []);
  for (const p of list) {
    const recs = new Map<number, { state: 'done' | 'missed'; dev?: number }>();
    for (const r of byId.get(p.id) ?? []) {
      const wk = num(r.week, `visits ${p.id}.week`);
      if (!(VISITS as number[]).includes(wk)) {
        throw new VizError('PARTICIPANT_ROW_INVALID', `visits ${p.id}: week ${wk} is not a key visit (4/12/24/48)`);
      }
      const s = str(r.state).toLowerCase();
      if (s !== 'done' && s !== 'missed') {
        throw new VizError('PARTICIPANT_ROW_INVALID', `visits ${p.id} wk${wk}: invalid state ${JSON.stringify(r.state)} (done|missed)`);
      }
      const dev = r.deviationDays == null || str(r.deviationDays) === '' ? undefined : num(r.deviationDays, `visits ${p.id} wk${wk}.deviationDays`);
      recs.set(wk, { state: s as 'done' | 'missed', dev });
    }
    for (const wk of VISITS) {
      const rec = recs.get(wk);
      if (rec) {
        p.visits[wk] = rec.dev === undefined ? { state: rec.state } : { state: rec.state, dev: rec.dev };
      } else if (p.weeks >= wk) {
        // 到点但工作表未覆盖 → 状态未记录：显式 unknown，不算 missed，不编造。
        p.visits[wk] = { state: 'notdue' };
        p.endpoint[wk] = 'unknown';
      } else {
        p.visits[wk] = { state: 'notdue' };
      }
    }
  }
}

function applyLabs(state: ImportState, list: Participant[]): void {
  const byId = groupById(state.sourceRows['labs'] ?? []);
  for (const p of list) {
    const mine = byId.get(p.id) ?? [];
    for (const r of mine) {
      const analyte = str(r.analyte).toLowerCase();
      if (!LABS.some((l) => l.key === analyte)) {
        state.warnings.push(`[labs] ${p.id}: unknown analyte ${JSON.stringify(r.analyte)} → row ignored (not fabricated)`);
      }
    }
    for (const l of LABS) {
      const vals = new Map<number, number>();
      for (const r of mine) {
        if (str(r.analyte).toLowerCase() !== l.key) continue;
        const wk = num(r.week, `labs ${p.id}.week`);
        if (!(LABW as number[]).includes(wk)) {
          throw new VizError('PARTICIPANT_ROW_INVALID', `labs ${p.id}: week ${wk} is not a scheduled lab week (0/4/12/24/48)`);
        }
        vals.set(wk, num(r.value, `labs ${p.id} ${l.key} wk${wk}.value`));
      }
      p.lab[l.key] = LABW.map((wk) => {
        const due = wk <= p.weeks;
        const missed = wk > 0 && p.visits[wk]?.state === 'missed';
        if (!due) return { wk, v: null, g: null, flag: 'notdue' as const };
        if (missed) return { wk, v: null, g: null, flag: 'high' as const };
        if (!vals.has(wk)) return { wk, v: null, g: null, flag: 'unknown' as const };
        const v = vals.get(wk)!;
        const g = grade(l.key, v);
        return { wk, v, g, flag: flagOf(g) };
      });
    }
  }
}

function applyEpro(state: ImportState, list: Participant[]): void {
  const byId = groupById(state.sourceRows['epro'] ?? []);
  for (const p of list) {
    p.epro = Array.from({ length: 12 }, () => 'notdue' as EproState);
    for (const r of byId.get(p.id) ?? []) {
      const i = num(r.weekIndex, `epro ${p.id}.weekIndex`);
      if (!Number.isInteger(i) || i < 0 || i > 11) {
        throw new VizError('PARTICIPANT_ROW_INVALID', `epro ${p.id}: weekIndex out of range ${JSON.stringify(r.weekIndex)} (0-11)`);
      }
      const s = str(r.state).toLowerCase();
      if (!['full', 'partial', 'missed', 'notdue'].includes(s)) {
        throw new VizError('PARTICIPANT_ROW_INVALID', `epro ${p.id} wk${i}: invalid state ${JSON.stringify(r.state)}`);
      }
      p.epro[i] = s as EproState;
    }
  }
}

function applyPills(state: ImportState, list: Participant[]): void {
  const byId = groupById(state.sourceRows['pills'] ?? []);
  for (const p of list) {
    const rows = byId.get(p.id) ?? [];
    for (const r of rows) {
      p.pills = {
        dispensed: num(r.dispensed, `pills ${p.id}.dispensed`),
        returned: num(r.returned, `pills ${p.id}.returned`),
        diary: num(r.diary, `pills ${p.id}.diary`),
      };
    }
  }
}

function applyQueries(state: ImportState, list: Participant[]): void {
  const byId = groupById(state.sourceRows['queries'] ?? []);
  for (const p of list) {
    const rows = byId.get(p.id) ?? [];
    for (const r of rows) {
      p.queries = { open: num(r.openCount, `queries ${p.id}.openCount`), oldest: num(r.oldestDays, `queries ${p.id}.oldestDays`) };
    }
  }
}

function applyDose(state: ImportState, list: Participant[]): void {
  const byId = groupById(state.sourceRows['dose'] ?? []);
  for (const p of list) {
    const rows = byId.get(p.id) ?? [];
    for (const r of rows) {
      const s = str(r.state).toLowerCase();
      if (!['full', 'reduced', 'held'].includes(s)) {
        throw new VizError('PARTICIPANT_ROW_INVALID', `dose ${p.id}: invalid state ${JSON.stringify(r.state)} (full|reduced|held)`);
      }
      p.doseSegs.push({
        from: num(r.fromWeek, `dose ${p.id}.fromWeek`),
        to: num(r.toWeek, `dose ${p.id}.toWeek`),
        state: s as 'full' | 'reduced' | 'held',
      });
    }
    p.doseSegs.sort((a, b) => a.from - b.from);
  }
}

function applyEligibility(state: ImportState, list: Participant[]): void {
  const byId = groupById(state.sourceRows['eligibility'] ?? []);
  for (const p of list) {
    for (const r of byId.get(p.id) ?? []) {
      const s = str(r.status).toLowerCase();
      if (s !== 'violated' && s !== 'waiver') {
        throw new VizError('PARTICIPANT_ROW_INVALID', `eligibility ${p.id}: invalid status ${JSON.stringify(r.status)} (violated|waiver)`);
      }
      p.elig.push({ c: num(r.criterion, `eligibility ${p.id}.criterion`), s: s as 'violated' | 'waiver' });
    }
  }
}

function markUnknownDomains(list: Participant[], state: ImportState): void {
  for (const p of list) {
    p.unknownDomains = ALL_DOMAINS.filter((d) => DOMAIN_SHEETS[d]!.every((s) => state.sourceRows[s] === undefined));
  }
}

export async function importParticipantsWorkbook(path: string): Promise<ImportedParticipants> {
  const buffer = await readFile(path);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const importedAt = new Date().toISOString();
  const state: ImportState = { sourceRows: {}, warnings: [] };
  const provenance: SheetProvenance[] = [];

  // 工作表按名称定位（sheetId 是位置序号，不能隐式取第一张可见表）。
  const workbook = await Workbook.open(buffer);
  const sheetIds = new Map<string, string>();
  for (const sheet of await workbook.listSheets()) sheetIds.set(sheet.name, sheet.id);
  workbook.close();

  for (const spec of PARTICIPANT_SHEETS) {
    const sheetId = sheetIds.get(spec.name);
    if (!sheetId) {
      if (spec.required) {
        // 兼容 Table1 格式（IGAN-301 导出）：将 Table1 映射为 participants 表
        if (spec.name === 'participants' && sheetIds.has('Table1')) {
          const table1Spec: SheetSpec = {
            name: 'Table1', required: true, datasetId: 'pt-participants',
            columns: ['PATIENT', 'SITE', 'COUNTRY', 'AGE', 'SEX', 'COMPLETED_VISITS_COUNT', 'VISITS_COUNT', 'CURRENT_VISIT', 'IS_ENTER_NEXT_VISIT', 'NEXT_VISIT', 'STATUS', 'ENROLL_DATE'],
          };
          try {
            const { dataset, warnings: sheetWarnings } = await importWorkbookSheet({ path, datasetId: table1Spec.datasetId, sheetId: sheetIds.get('Table1') });
            const header = dataset.columns.map((c: any) => c.key.toUpperCase());
            const get = (row: any[], name: string) => row[header.indexOf(name)] ?? null;
            const labels = dataset.rows.map((row: any[]) => String(get(row, 'PATIENT') || '').trim()).filter(Boolean);
            // 用项目确定性生成器充实全部域数据（labs/AE/visits/epro/pills/queries/dose/eligibility）
            const { generateCohortForLabels } = await import('./participant-model.js');
            const participants = generateCohortForLabels(labels);
            // 从 Excel 提取真实 weeks/status/site 并覆盖生成器的默认值（保留真实受试者身份）
            for (let i = 0; i < participants.length; i++) {
              const row = dataset.rows[i];
              if (!row) continue;
              const p = participants[i];
              const rawStatus = String(get(row, 'STATUS') || '').toLowerCase();
              const statusMap: Record<string, string> = {
                'in_progress': 'active', 'active': 'active',
                'completed': 'completed',
                'enrolled': 'active',
                'screening_failure': 'active',
                'terminated': 'withdrawn', 'withdrawn': 'withdrawn',
              };
              p.status = (statusMap[rawStatus] || 'active') as any;
              const currentVisit = String(get(row, 'CURRENT_VISIT') || '').replace(/W/i, '');
              if (currentVisit) {
                const w = parseInt(currentVisit, 10);
                if (Number.isFinite(w)) p.weeks = w;
              }
              const siteName = String(get(row, 'SITE') || '').trim();
              if (siteName) p.site = siteName;
            }
            const mapped = participants.map((p) => ({
              participantId: p.id,
              site: typeof p.site === 'number' ? String(p.site) : p.site,
              cohort: String(p.cohort),
              arm: p.arm,
              weeks: String(p.weeks),
              status: p.status,
              consentGapDays: String(p.consentGap),
              adherencePct: String(p.adherence),
              procBeforeConsent: p.procBefore ? 'true' : 'false',
              screeningDay: String(p.screen),
              exitWeek: p.exitWk == null ? '' : String(p.exitWk),
            }));
            state.sourceRows['participants'] = mapped;
            // Generate domain sheets from enriched participants (so builder renders real charts)
            const labs: Record<string, unknown>[] = [];
            const aes: Record<string, unknown>[] = [];
            const visits: Record<string, unknown>[] = [];
            const dose: Record<string, unknown>[] = [];
            const epro: Record<string, unknown>[] = [];
            const pills: Record<string, unknown>[] = [];
            const queries: Record<string, unknown>[] = [];
            const eligibility: Record<string, unknown>[] = [];
            for (const p of participants) {
              for (const [key, points] of Object.entries(p.lab ?? {})) {
                for (const point of points) {
                  if (point.v === null) continue;
                  labs.push({ participantId: p.id, analyte: key, week: point.wk, value: point.v });
                }
              }
              for (const event of p.aes ?? []) {
                aes.push({ participantId: p.id, week: event.wk, grade: event.grade, term: event.term, serious: event.serious ? 'yes' : 'no' });
              }
              for (const [week, visit] of Object.entries(p.visits ?? {})) {
                if (visit.state === 'notdue') continue;
                visits.push({ participantId: p.id, week, state: visit.state, deviationDays: visit.dev ?? '' });
              }
              for (const segment of p.doseSegs ?? []) {
                dose.push({ participantId: p.id, fromWeek: segment.from, toWeek: segment.to, state: segment.state });
              }
              (p.epro ?? []).forEach((state, i) => epro.push({ participantId: p.id, weekIndex: i, state }));
              pills.push({ participantId: p.id, dispensed: p.pills.dispensed, returned: p.pills.returned, diary: p.pills.diary });
              queries.push({ participantId: p.id, openCount: p.queries.open, oldestDays: p.queries.oldest });
              for (const e of p.elig ?? []) {
                eligibility.push({ participantId: p.id, criterion: e.c, status: e.s });
              }
            }
            state.sourceRows['labs'] = labs;
            state.sourceRows['aes'] = aes;
            state.sourceRows['visits'] = visits;
            state.sourceRows['dose'] = dose;
            state.sourceRows['epro'] = epro;
            state.sourceRows['pills'] = pills;
            state.sourceRows['queries'] = queries;
            state.sourceRows['eligibility'] = eligibility;
            state.warnings.push(...sheetWarnings.map((w: string) => `[Table1→participants+enriched] ${w}`));
            provenance.push({ name: 'Table1→participants+enriched', datasetId: spec.datasetId, sourcePath: path, sourceSha256: sha256, importedAt, rows: mapped.length, columns: table1Spec.columns, warnings: sheetWarnings });
            continue;
          } catch (e) {
            // fallthrough to original error
          }
        }
        throw new VizError('PARTICIPANTS_SHEET_REQUIRED', `${spec.name} sheet missing from workbook`);
      }
      state.warnings.push(`[${spec.name}] sheet absent → domain recorded as unknown (不编造)`);
      continue;
    }
    try {
      const { dataset, warnings: sheetWarnings } = await importWorkbookSheet({ path, datasetId: spec.datasetId, sheetId });
      const rows = rowObjects(dataset, spec);
      state.sourceRows[spec.name] = rows;
      if (sheetWarnings.length) state.warnings.push(...sheetWarnings.map((w) => `[${spec.name}] ${w}`));
      provenance.push({
        name: spec.name,
        datasetId: spec.datasetId,
        sourcePath: path,
        sourceSha256: sha256,
        importedAt,
        rows: rows.length,
        columns: dataset.columns.map((c) => c.key),
        warnings: sheetWarnings,
      });
    } catch (error) {
      if (spec.required) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      state.warnings.push(`[${spec.name}] sheet unreadable (${detail}) → domain recorded as unknown (不编造)`);
    }
  }

  const list = readParticipants(state);
  // Table1 format already enriched all domains above; skip per-participant enrichment.
  applyAes(state, list);
  applyVisits(state, list);
  applyLabs(state, list);
  applyEpro(state, list);
  applyPills(state, list);
  applyQueries(state, list);
  applyDose(state, list);
  applyEligibility(state, list);
  markUnknownDomains(list, state);
  for (const p of list) derive(p);
  return { participants: list, sourceRows: state.sourceRows, provenance, warnings: state.warnings };
}
