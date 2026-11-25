/**
 * 参与者档案确定性合成数据模型（SYNTHETIC 设计夹具）。
 *
 * 移植自设计稿 csm-functions-v5-en/participant-charts.js + rbqm-theme.js：
 * FNV-1a 种子扰动、24 名参与者、5 项检验分级、4 个评审域信号。
 * 用途只有两个：设计稿配对验收的夹具，以及 builder 的参考输入。
 * 生产数据通道是「各家 EDC rawdata → 统一清洗 → Excel → 数据集 → builder」，
 * 本文件的合成值不得进入生产数据；演示分级阈值未经临床批准。
 */

export const PT_THEME = {
  blue: '#1f5fa8',
  purple: '#a577bd',
  teal: '#007b82',
  pale: '#8fa6c4',
  red: '#c23b45',
  amber: '#9c6d1c',
  green: '#286746',
  gray: '#9aa3b2',
  unknown: '#e4e9ed',
  ink: '#153847',
  secondary: '#536d78',
  grid: '#e6edf0',
  surface: '#ffffff',
  page: '#f4f7f7',
} as const;

export const PT_STATUS = {
  high: { color: PT_THEME.red, bg: '#fbeaec', symbol: '!' },
  warning: { color: PT_THEME.amber, bg: '#fbf2df', symbol: '△' },
  normal: { color: PT_THEME.green, bg: '#f0f7f3', symbol: '✓' },
  unknown: { color: PT_THEME.secondary, bg: '#edf0f3', symbol: '—' },
} as const;

export type PtState = 'high' | 'warning' | 'normal' | 'unknown' | 'notdue';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const short = (s: unknown, n = 18): string => {
  const text = String(s);
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
};

/** FNV-1a 种子扰动，与设计稿逐位一致。 */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}
const jit = (id: string, k: string, amp: number): number => (hash(id + k) - 0.5) * 2 * amp;

export const SITES = ['Site 101', 'Site 102', 'Site 103', 'Site 104', 'Site 105', 'Site 106'];
export const VISITS = [4, 12, 24, 48];
export const LABW = [0, 4, 12, 24, 48];
export const CUTOFF_WK = 56;
export const ENROLL: Record<number, number> = { 1: 0, 2: 8, 3: 16, 4: 24 };
export const CRIT = ['eGFR ≥ 30', 'Hb ≥ 90', 'Washout ≥ 14 d', 'BP ≤ 160/100', 'Age 18–75', 'No active infection'];
export const DOMAIN = ['Medical safety', 'Protocol compliance', 'Data integrity', 'IP exposure'];
export const DCOL = [PT_THEME.red, PT_THEME.purple, PT_THEME.amber, PT_THEME.teal];

export interface LabDef {
  key: 'egfr' | 'k' | 'hb' | 'alt' | 'uacr';
  name: string;
  unit: string;
  lo: number;
  hi: number;
  base: [number, number];
  dir: 'low' | 'high' | 'both';
}

export const LABS: LabDef[] = [
  { key: 'egfr', name: 'eGFR', unit: 'mL/min/1.73m²', lo: 60, hi: 120, base: [58, 95], dir: 'low' },
  { key: 'k', name: 'Serum K', unit: 'mmol/L', lo: 3.5, hi: 5.0, base: [3.7, 4.6], dir: 'both' },
  { key: 'hb', name: 'Haemoglobin', unit: 'g/L', lo: 120, hi: 160, base: [124, 150], dir: 'low' },
  { key: 'alt', name: 'ALT', unit: 'U/L', lo: 0, hi: 40, base: [14, 34], dir: 'high' },
  { key: 'uacr', name: 'UACR', unit: 'mg/g', lo: 0, hi: 30, base: [6, 24], dir: 'high' },
];
export const labByKey: Record<string, LabDef> = Object.fromEntries(LABS.map((l) => [l.key, l]));

/** 演示分级阈值（未经临床批准）。 */
export function grade(key: string, v: unknown): number | null {
  if (!isNum(v)) return null;
  switch (key) {
    case 'egfr': return v >= 90 ? 0 : v >= 60 ? 1 : v >= 45 ? 2 : v >= 30 ? 3 : 4;
    case 'hb': return v >= 120 ? 0 : v >= 100 ? 1 : v >= 80 ? 2 : v >= 65 ? 3 : 4;
    case 'k': return (v >= 3.5 && v <= 5.0) ? 0 : (v >= 3.0 && v <= 5.5) ? 1 : (v >= 2.5 && v <= 6.0) ? 2 : (v >= 2.0 && v <= 6.5) ? 3 : 4;
    case 'alt': return v <= 40 ? 0 : v <= 120 ? 1 : v <= 200 ? 2 : v <= 400 ? 3 : 4;
    case 'uacr': return v < 30 ? 0 : v <= 300 ? 1 : v <= 1000 ? 2 : 3;
    default: return null;
  }
}
/** 最重分级 → 状态旗标（unknown/normal/warning/high）。 */
export const flagOf = (g: number | null): PtState => (g == null ? 'unknown' : g === 0 ? 'normal' : g >= 3 ? 'high' : 'warning');

export type EproState = 'full' | 'partial' | 'missed' | 'notdue';
export interface VisitRec { state: 'done' | 'missed' | 'notdue'; dev?: number }
export interface DoseSeg { from: number; to: number; state: 'full' | 'reduced' | 'held' }
export interface AeRec { wk: number; grade: number; serious: boolean; term: string }
export interface EligRec { c: number; s: 'violated' | 'waiver' }
export interface LabPoint { wk: number; v: number | null; g: number | null; flag: PtState }

export interface Participant {
  id: string;
  n: number;
  site: number | string;
  cohort: number | string;
  arm: string;
  weeks: number;
  status: 'active' | 'completed' | 'withdrawn';
  exitWk: number | null;
  consentGap: number;
  procBefore: boolean;
  screen: number;
  elig: EligRec[];
  visits: Record<number, VisitRec>;
  aes: AeRec[];
  adherence: number;
  doseSegs: DoseSeg[];
  pills: { dispensed: number; returned: number; diary: number };
  queries: { open: number; oldest: number };
  epro: EproState[];
  endpoint: Record<number, 'missing' | 'unknown'>;
  unknownDomains: string[];
  lab: Record<string, LabPoint[]>;
  labCrit: boolean;
  medHigh: boolean;
  sig: [number, number, number, number];
  total: number;
}

interface MkOptions {
  status?: Participant['status'];
  exitWk?: number | null;
  consentGap?: number;
  procBefore?: boolean;
  screen?: number;
  elig?: EligRec[];
  visits?: Record<number, VisitRec>;
  aes?: AeRec[];
  adherence?: number;
  doseSegs?: DoseSeg[] | null;
  pills?: { dispensed: number; returned: number; diary: number } | null;
  queries?: { open: number; oldest: number };
  epro?: EproState[] | null;
  endpoint?: Record<number, 'missing' | 'unknown'>;
  unknownDomains?: string[];
}

const LAB_OV: Record<string, Record<string, Array<number | null>>> = {
  'P-014': { egfr: [52, 48, 40, 28, null], k: [4.2, 4.6, 5.6, 6.1, null], alt: [28, 35, 60, 90, null] },
  'P-009': { k: [4.0, 3.6, 3.2, 2.9, null], egfr: [78, 76, 72, 70, null] },
  'P-020': { alt: [30, 45, 120, 210, null], k: [4.1, 4.2, 4.4, 4.3, null] },
  'P-003': { uacr: [20, 45, 120, 320, null], egfr: [70, 66, 60, 55, null] },
  'P-007': { hb: [128, 120, 110, 98, null], k: [3.9, 3.7, 3.4, 3.2, null] },
  'P-016': { egfr: [62, 60, 58, 56, null] },
  'P-011': { alt: [36, 50, 80, 130, null] },
  'P-023': { uacr: [26, 40, 90, 260, null], hb: [122, 116, 108, 100, null] },
};

function mk(n: number, site: number, cohort: number, arm: string, o: MkOptions = {}): Participant {
  return generateParticipant('P-' + String(n).padStart(3, '0'), n, site, cohort, arm, o);
}

/** 按指定 ID 生成一名**演示**参与者：同一 id 恒定得到同一套数值（hash 派生，可复现）。
 *  用途是把图表绑定到目标系统里已登记的参与者标签（例如 RBQM PATIENT_PROFILE 的 label），
 *  这些数值是生成的演示数据、不是真实测量值——交付里必须如实标明。 */
export function generateParticipant(id: string, n: number, site: number, cohort: number, arm: string, o: MkOptions = {}): Participant {
  const weeks = o.exitWk != null ? o.exitWk : CUTOFF_WK - ENROLL[cohort]!;
  const p: Participant = {
    id,
    n,
    site,
    cohort,
    arm,
    weeks,
    status: o.status ?? 'active',
    exitWk: o.exitWk ?? null,
    consentGap: o.consentGap ?? 7 + Math.round(hash(id + 'g') * 14),
    procBefore: !!o.procBefore,
    screen: o.screen ?? Math.round((40 + hash(id + 's') * 30) * 10) / 10,
    elig: o.elig ?? [],
    visits: {},
    aes: o.aes ?? [],
    adherence: o.adherence ?? Math.round(90 + hash(id + 'a') * 18),
    doseSegs: o.doseSegs ?? null!,
    pills: o.pills ?? null!,
    queries: o.queries ?? { open: Math.round(hash(id + 'q') * 3), oldest: Math.round(hash(id + 'o') * 12) },
    epro: o.epro ?? null!,
    endpoint: o.endpoint ?? {},
    unknownDomains: o.unknownDomains ?? [],
    lab: {},
    labCrit: false,
    medHigh: false,
    sig: [0, 0, 0, 0],
    total: 0,
  };
  for (const w of VISITS) {
    const due = p.weeks >= w;
    const ov = (o.visits ?? {})[w];
    if (!due) p.visits[w] = { state: 'notdue' };
    else if (ov) p.visits[w] = ov;
    else p.visits[w] = { state: 'done', dev: Math.round(jit(id, 'v' + w, 4)) };
  }
  if (!p.doseSegs) p.doseSegs = [{ from: 0, to: Math.min(p.weeks, 48), state: 'full' }];
  if (!p.pills) {
    const d = 168;
    const r = 18 + Math.round(hash(id + 'p') * 8);
    p.pills = { dispensed: d, returned: r, diary: d - r + Math.round(jit(id, 'd', 4)) };
  }
  if (!p.epro) {
    const dueW = Math.min(12, Math.max(0, p.weeks - 36));
    p.epro = Array.from({ length: 12 }, (_, i) => (i < 12 - dueW ? 'notdue' : hash(id + 'e' + i) > 0.92 ? 'partial' : 'full'));
  }
  for (const l of LABS) {
    const ov = (LAB_OV[id] ?? {})[l.key];
    const baseline = ov
      ? ov[0]!
      : Math.round((l.base[0] + hash(id + l.key) * (l.base[1] - l.base[0])) * 10) / 10;
    p.lab[l.key] = LABW.map((wk, idx) => {
      const due = wk <= p.weeks;
      const missed = wk > 0 && p.visits[wk] && p.visits[wk].state === 'missed';
      let v: number | null = null;
      if (due && !missed) {
        if (ov) v = ov[idx]!;
        else if (idx === 0) v = baseline;
        else v = Math.round(baseline * (1 + jit(id, l.key + idx, 0.04)) * 10) / 10;
      }
      const g = grade(l.key, v);
      return { wk, v, g, flag: due ? (missed ? 'high' : flagOf(g)) : 'notdue' };
    });
  }
  return p;
}

/** 演示队列的不良事件术语池（演示用，非医学编码字典）。 */
const DEMO_AE_TERMS = [
  'Nausea', 'Headache', 'Dizziness', 'Rash', 'Vomiting', 'Diarrhoea', 'Fatigue',
  'Hypokalaemia', 'Hyperkalaemia', 'AKI', 'Hypertension', 'Urinary tract infection', 'Anaemia',
];

const pickOf = <T,>(list: readonly T[], u: number): T => list[Math.min(list.length - 1, Math.floor(u * list.length))]!;
const clampTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** 给登记驱动的演示参与者补一套**临床形态**的确定性数据（全部为演示值，不是测量值）：
 *  肾进展/AKI、高钾、肝酶升高、贫血、AE（含 3/4 级与 SAE）、超窗/漏访、ePRO 缺失簇、
 *  剂量调整、依从性低带。每名参与者由 label 的 FNV 哈希决定分型，同一 label 恒定复现。
 *  只作用于演示队列；夹具（fixtureParticipants）与真实导入路径不受影响。 */
export function enrichDemoParticipant(p: Participant, label: string): void {
  const r = (k: string) => hash(label + k);

  // 退出（约 8%）：退出后访视/化验按 not due 处理
  if (r('wd') > 0.92) {
    p.status = 'withdrawn';
    p.exitWk = pickOf([16, 20, 24, 32], r('wdx'));
    p.weeks = Math.min(p.weeks, p.exitWk);
  }

  // 访视执行：多数按时，约 16% 一次超窗，约 6% 一次漏访
  for (const wk of VISITS) {
    if (wk > p.weeks) {
      p.visits[wk] = { state: 'notdue' };
      continue;
    }
    const miss = r('vmiss' + wk);
    const out = r('vout' + wk);
    if (miss > 0.94) p.visits[wk] = { state: 'missed' };
    else if (out > 0.84) {
      const dir = r('vdir' + wk) > 0.5 ? 1 : -1;
      p.visits[wk] = { state: 'done', dev: dir * (8 + Math.round(r('vdev' + wk) * 7)) };
    } else p.visits[wk] = { state: 'done', dev: Math.round((r('vdev' + wk) - 0.5) * 6) };
  }

  // 分型（同一 label 恒定）
  const aki = r('aki') > 0.88;          // 急性肾损伤事件
  const decline = r('decl') > 0.62;     // CKD 缓慢进展
  const hyperK = r('hk') > 0.86;        // 高钾
  const liver = r('li') > 0.9;          // 肝酶升高
  const anemia = r('an') > 0.82;        // 贫血
  const placebo = p.arm === 'Placebo';
  const eventWk = r('akiw') > 0.5 ? 12 : 24;

  // 化验轨迹：活性组有轻度初始下降后回升；安慰剂组缓慢下降；分型叠加事件
  for (const l of LABS) {
    const points = p.lab[l.key] ?? [];
    const base = points[0]?.v ?? null;
    for (const pt of points) {
      const wk = pt.wk;
      const missed = p.visits[wk]?.state === 'missed';
      if (wk > p.weeks || missed) {
        pt.v = null;
        pt.g = null;
        pt.flag = wk > p.weeks ? 'notdue' : 'high';
        continue;
      }
      if (wk === 0 || base === null) {
        pt.g = grade(l.key, pt.v);
        pt.flag = flagOf(pt.g);
        continue;
      }
      const t = wk / 48;
      let v = base;
      if (l.key === 'egfr') {
        v = placebo ? base - (1.5 + 2.5 * r('egdecl')) * (wk / 12) : base - 0.8 * (wk / 12) - (wk === 4 ? 2 + 3 * r('egdip') : 0);
        if (decline) v -= (4 + 8 * r('egprog')) * t;
        if (aki) v -= wk === eventWk ? 16 + 14 * r('akid') : wk > eventWk ? 5 + 4 * r('akires') : 0;
        v = clampTo(round1(v + (r('egj' + wk) - 0.5) * 3), 8, 140);
      } else if (l.key === 'k') {
        v += (r('kj' + wk) - 0.5) * 0.3;
        if (hyperK && wk >= 12) v += 0.9 + 0.7 * r('hkd') - (wk >= 24 ? 0.3 : 0);
        v = clampTo(round1(v), 2.6, 6.6);
      } else if (l.key === 'hb') {
        v -= 1.5 * (wk / 12) + (r('hbj' + wk) - 0.5) * 3;
        if (anemia) v -= (10 + 14 * r('and')) * t;
        v = clampTo(Math.round(v), 70, 175);
      } else if (l.key === 'alt') {
        v *= 1 + (r('altj' + wk) - 0.5) * 0.15;
        if (liver) v *= wk === eventWk ? 2.5 + 2 * r('lid') : wk > eventWk ? 1.4 : 1;
        v = clampTo(Math.round(v), 8, 260);
      } else {
        v *= 1 + 0.18 * (wk / 12) + (r('uaj' + wk) - 0.5) * 0.15;
        if (decline) v *= 1 + 0.5 * t;
        if (aki && wk === eventWk) v *= 2.2;
        v = clampTo(Math.round(v), 4, 650);
      }
      pt.v = v;
      pt.g = grade(l.key, v);
      pt.flag = flagOf(pt.g);
    }
  }

  // AE：约 70% 有 1–3 个事件；多数 1–2 级，约 20% 3 级，少数 4 级/SAE
  if (r('ae') > 0.3) {
    const count = 1 + Math.floor(r('aen') * 3);
    const dueWeeks = VISITS.filter((w) => w <= p.weeks);
    p.aes = Array.from({ length: count }, (_, i) => {
      const g = r('aeg' + i) > 0.8 ? 4 : 1 + Math.floor(r('aegb' + i) * 3);
      return {
        wk: pickOf(dueWeeks, r('aew' + i)),
        grade: g,
        serious: g >= 4 || r('aes' + i) > 0.94,
        term: pickOf(DEMO_AE_TERMS, r('aet' + i)),
      };
    }).sort((a, b) => a.wk - b.wk);
  }

  // ePRO：按依从质量分三档（好/中/差），中期可有连续缺失簇
  const dueCount = Math.min(12, Math.max(0, Math.floor(p.weeks / 4)));
  const quality = r('epq');
  const cluster = Math.floor(r('epc') * 8);
  p.epro = Array.from({ length: 12 }, (_, i): 'full' | 'partial' | 'missed' | 'notdue' => {
    if (i >= dueCount) return 'notdue';
    const u = r('ep' + i);
    if (quality > 0.45) return u > 0.9 ? 'missed' : u > 0.78 ? 'partial' : 'full';
    if (quality > 0.2) {
      const inCluster = i >= cluster && i < cluster + 2;
      return inCluster ? (u > 0.5 ? 'missed' : 'partial') : u > 0.92 ? 'missed' : u > 0.8 ? 'partial' : 'full';
    }
    return u > 0.62 ? 'missed' : u > 0.42 ? 'partial' : 'full';
  });

  // 依从性：72–108%，约 18% 低于 80%
  p.adherence = Math.round(72 + r('ad') * 36 - (r('adlow') > 0.82 ? 12 : 0));

  // 未关闭质疑
  const open = Math.floor(r('q') * 9);
  p.queries = { open, oldest: open ? 3 + Math.round(r('qo') * 42) : 0 };

  // 剂量调整：约一半、且研究时长足够的参与者有 4–10 周减量/暂停
  if (p.weeks > 16 && r('dose') > 0.5) {
    const cut = Math.min(p.weeks - 4, 12 + Math.round(r('dc') * 12));
    const len = 4 + Math.round(r('dl') * 6);
    p.doseSegs = ([
      { from: 0, to: cut, state: 'full' },
      { from: cut, to: Math.min(p.weeks, cut + len), state: r('ds') > 0.55 ? 'reduced' : 'held' },
      { from: Math.min(p.weeks, cut + len), to: p.weeks, state: 'full' },
    ] satisfies DoseSeg[]).filter((segment) => segment.to > segment.from);
  } else {
    p.doseSegs = [{ from: 0, to: Math.min(p.weeks, 48), state: 'full' }];
  }

  // 药片：清点与日记数据围绕依从性生成，允许少量抄写差异
  const dispensed = 168;
  const taken = Math.round(dispensed * Math.min(1, p.adherence / 100));
  const returned = Math.max(0, dispensed - taken + Math.round((r('pr') - 0.5) * 8));
  p.pills = { dispensed, returned, diary: Math.max(0, taken + Math.round((r('pd') - 0.5) * 8)) };

  // 入选标准偏离：约 40% 有 1–2 条 waiver/violated（标准取自 CRIT）
  if (r('elig') > 0.6) {
    const count = 1 + Math.round(r('eligc'));
    const picks: number[] = [];
    for (let draw = 0; picks.length < count && draw < 24; draw++) {
      const c = Math.floor(hash(label + 'eligw' + draw) * CRIT.length);
      if (!picks.includes(c)) picks.push(c);
    }
    p.elig = picks.map((c, i): EligRec => ({
      c,
      s: hash(label + 'eligs' + i) > 0.4 ? 'violated' : 'waiver',
    }));
  }
}

/** 为一组既有参与者标签生成演示队列（中心/ cohort / 臂按序位确定分配，可复现）。
 *  标签原样作为 id：上传数据的 PATIENT 列 = 目标系统登记 label = 图表过滤键，三处同源。
 *  四个域都要有可渲染的数据，因此化验轨迹 / AE / 访视 / ePRO / 剂量调整均按 id 确定性派生——
 *  全部是演示值，不是真实测量。 */
export function generateCohortForLabels(labels: string[]): Participant[] {
  return labels.map((label, index) => {
    const participant = generateParticipant(
      label,
      index + 1,
      index % SITES.length,
      (Math.floor(index / SITES.length) % 4) + 1,
      index % 2 === 0 ? 'Active' : 'Placebo',
    );
    enrichDemoParticipant(participant, label);
    derive(participant);
    return participant;
  });
}

export function fixtureParticipants(): Participant[] {
  return [
    mk(1, 0, 1, 'Active', { status: 'completed', exitWk: 50 }),
    mk(2, 0, 1, 'Placebo', { status: 'completed', exitWk: 50 }),
    mk(3, 1, 1, 'Active', { adherence: 128, pills: { dispensed: 168, returned: 4, diary: 142 }, elig: [{ c: 2, s: 'violated' }], aes: [{ wk: 12, grade: 2, serious: false, term: 'Nausea' }] }),
    mk(4, 1, 1, 'Placebo', { status: 'withdrawn', exitWk: 30, visits: { 24: { state: 'done', dev: 9 } } }),
    mk(5, 0, 1, 'Active', { status: 'completed', exitWk: 50 }),
    mk(6, 1, 1, 'Active'),
    mk(7, 0, 2, 'Active', { consentGap: 2, visits: { 12: { state: 'done', dev: 9 }, 24: { state: 'done', dev: 12 } }, adherence: 78, queries: { open: 5, oldest: 22 }, elig: [{ c: 4, s: 'waiver' }], aes: [{ wk: 16, grade: 1, serious: false, term: 'Headache' }], pills: { dispensed: 168, returned: 8, diary: 140 } }),
    mk(8, 2, 2, 'Placebo'),
    mk(9, 1, 2, 'Active', { elig: [{ c: 1, s: 'waiver' }], aes: [{ wk: 6, grade: 2, serious: false, term: 'Dizziness' }, { wk: 20, grade: 3, serious: false, term: 'Hypokalaemia' }], doseSegs: [{ from: 0, to: 20, state: 'full' }, { from: 20, to: 48, state: 'reduced' }] }),
    mk(10, 2, 3, 'Placebo', { status: 'withdrawn', exitWk: 22, visits: { 12: { state: 'done', dev: 8 }, 24: { state: 'missed' } }, queries: { open: 2, oldest: 18 }, endpoint: { 24: 'missing' } }),
    mk(11, 2, 2, 'Active', { adherence: 121, elig: [{ c: 0, s: 'waiver' }], aes: [{ wk: 20, grade: 1, serious: false, term: 'Rash' }] }),
    mk(12, 3, 2, 'Placebo', { consentGap: 35 }),
    mk(13, 2, 3, 'Active', { screen: 30.6 }),
    mk(14, 2, 3, 'Active', { consentGap: 0, procBefore: true, screen: 29.4, elig: [{ c: 0, s: 'violated' }], visits: { 12: { state: 'done', dev: 11 }, 24: { state: 'missed' } }, aes: [{ wk: 14, grade: 3, serious: false, term: 'AKI' }, { wk: 18, grade: 3, serious: true, term: 'AKI hospitalisation' }], adherence: 64, doseSegs: [{ from: 0, to: 14, state: 'full' }, { from: 14, to: 20, state: 'reduced' }, { from: 20, to: 26, state: 'held' }, { from: 26, to: 40, state: 'full' }], queries: { open: 9, oldest: 38 }, endpoint: { 24: 'missing' }, epro: ['full', 'full', 'partial', 'missed', 'missed', 'full', 'missed', 'partial', 'missed', 'full', 'missed', 'partial'] }),
    mk(15, 2, 3, 'Placebo', { screen: 31.1 }),
    mk(16, 3, 3, 'Active', { screen: 30.8, visits: { 24: { state: 'done', dev: -8 } }, aes: [{ wk: 8, grade: 1, serious: false, term: 'Headache' }] }),
    mk(17, 3, 4, 'Placebo'),
    mk(18, 3, 4, 'Active', { screen: 31.2, elig: [{ c: 0, s: 'waiver' }] }),
    mk(19, 4, 4, 'Active'),
    mk(20, 4, 4, 'Placebo', { elig: [{ c: 3, s: 'violated' }], aes: [{ wk: 28, grade: 2, serious: true, term: 'Syncope' }], doseSegs: [{ from: 0, to: 28, state: 'full' }, { from: 28, to: 32, state: 'held' }, { from: 32, to: 40, state: 'full' }] }),
    mk(21, 4, 2, 'Active', { status: 'withdrawn', exitWk: 10, visits: { 4: { state: 'done', dev: 6 }, 12: { state: 'missed' } }, aes: [{ wk: 8, grade: 2, serious: false, term: 'Vomiting' }], queries: { open: 3, oldest: 34 }, endpoint: { 12: 'missing' }, epro: ['full', 'partial', 'missed', 'notdue', 'notdue', 'notdue', 'notdue', 'notdue', 'notdue', 'notdue', 'notdue', 'notdue'] }),
    mk(22, 5, 4, 'Placebo', { unknownDomains: ['lab'], endpoint: { 24: 'unknown' } }),
    mk(23, 5, 4, 'Active', { elig: [{ c: 5, s: 'violated' }], queries: { open: 6, oldest: 31 }, epro: ['full', 'missed', 'missed', 'full', 'missed', 'partial', 'full', 'missed', 'full', 'partial', 'full', 'missed'], pills: { dispensed: 150, returned: 12, diary: 138 } }),
    mk(24, 5, 4, 'Active'),
  ];
}

// ---------------------------------------------------------------------------
// 参与者级派生量（与设计稿一致；生产通道里这些由 builder 从数据集计算）。

export function worstG(p: Participant, key: string): number {
  return (p.lab[key] ?? []).reduce((m, x) => (x.g != null && x.g > m ? x.g : m), 0);
}
export function baseG(p: Participant, key: string): number | null {
  return p.lab[key]?.[0]?.g ?? null;
}
export function worstVal(p: Participant, key: string): number | null {
  const l = labByKey[key];
  if (!l) return null;
  const vs = (p.lab[key] ?? []).filter((x) => isNum(x.v)).map((x) => x.v as number);
  if (!vs.length) return null;
  if (l.dir === 'low') return Math.min(...vs);
  if (l.dir === 'high') return Math.max(...vs);
  const mid = (l.lo + l.hi) / 2;
  return vs.reduce((a, b) => (Math.abs(b - mid) > Math.abs(a - mid) ? b : a));
}
export function labMeanSD(p: Participant, key: string): { mean: number; sd: number; n: number } | null {
  const vs = (p.lab[key] ?? []).filter((x) => isNum(x.v)).map((x) => x.v as number);
  if (vs.length < 2) return null;
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
  return { mean: Math.round(mean * 10) / 10, sd: Math.round(sd * 100) / 100, n: vs.length };
}

function signals(p: Participant): [number, number, number, number] {
  const s: [number, number, number, number] = [0, 0, 0, 0];
  s[0] = LABS.filter((l) => worstG(p, l.key) >= 1).length + p.aes.filter((a) => a.grade >= 3 || a.serious).length;
  s[1] =
    (p.procBefore ? 1 : 0) +
    (p.consentGap === 0 ? 1 : 0) +
    (p.consentGap > 28 ? 1 : 0) +
    p.elig.filter((e) => e.s === 'violated' || e.s === 'waiver').length +
    VISITS.filter((w) => p.visits[w].state === 'missed' || (p.visits[w].state === 'done' && Math.abs(p.visits[w].dev ?? 0) > 7)).length;
  const epMiss = VISITS.filter((w) => p.endpoint[w] === 'missing').length;
  const missVisit = VISITS.filter((w) => p.visits[w].state === 'missed').length;
  const eproMiss = p.epro.filter((x) => x === 'missed').length;
  const taken = p.pills.dispensed - p.pills.returned;
  const mm = Math.abs(taken - p.pills.diary) / Math.max(1, taken);
  s[2] = epMiss + missVisit + (p.queries.open >= 5 ? 1 : 0) + (p.queries.oldest > 30 ? 1 : 0) + (eproMiss >= 3 ? 1 : 0) + (mm > 0.1 ? 1 : 0);
  s[3] = (p.adherence < 80 || p.adherence > 120 ? 1 : 0) + (p.doseSegs.some((x) => x.state === 'held') ? 1 : 0);
  return s;
}

/** 参与者级派生量：分级旗标、四域信号计数、总负担。fixtures 与真实数据共用。 */
export function derive(p: Participant): void {
  p.labCrit = LABS.some((l) => worstG(p, l.key) >= 3);
  p.medHigh = p.labCrit || p.aes.some((a) => a.grade >= 3 || a.serious);
  p.sig = signals(p);
  p.total = p.sig.reduce((a, b) => a + b, 0);
}

export function cellState(p: Participant, d: number): PtState {
  if (d === 0 && p.unknownDomains.includes('lab')) return 'unknown';
  if (d === 0) return p.medHigh ? 'high' : p.sig[0] > 0 ? 'warning' : 'normal';
  return p.sig[d] >= 2 ? 'high' : p.sig[d] === 1 ? 'warning' : 'normal';
}

// ---------------------------------------------------------------------------
// 作用域（默认全量）与 18 张图的行模型。

export interface PtScope {
  site: number | string;
  cohort: number | string;
  status: 'all' | Participant['status'];
  domain: 'all' | number;
  q: string;
  sort: 'burden' | 'id' | 'site' | 'adherence' | 'lab';
  highOnly: boolean;
}

export const DEFAULT_SCOPE: PtScope = { site: 'all', cohort: 'all', status: 'all', domain: 'all', q: '', sort: 'burden', highOnly: false };

export interface PtModels {
  pt0p0: { rows: Participant[] };
  pt0p1: { rows: Participant[] };
  pt1p0: { rows: Participant[]; analyte: string };
  pt1p1: { rows: Participant[]; analyte: string };
  pt1p2: { rows: Participant[] };
  pt1p3: { rows: Array<{ p: Participant; g12: number; g3: number; g4: number; sae: boolean }> };
  pt1p4: { rows: Participant[]; escalation: number };
  pt2p0: { rows: Participant[] };
  pt2p1: { rows: Participant[] };
  pt2p2: { rows: Participant[] };
  pt3p0: { rows: Participant[] };
  pt3p1: { rows: Participant[] };
  pt3p2: { rows: Participant[] };
  pt3p3: { rows: Participant[] };
  pt3p4: { rows: Array<{ p: Participant; ms: { mean: number; sd: number; n: number } }> };
  pt4p0: { rows: Participant[]; lo: number; hi: number };
  pt4p1: { rows: Participant[] };
  pt4p2: { points: Array<{ id: string; count: number; diary: number }> };
}

/**
 * 设计稿的策展观察面板：设计作者手工钉选的 12 名参与者（非派生量）。
 * 只属于 fixtures/设计稿配对；真实数据通道的面板由调用方显式传入
 * （PtCuration.panel），缺省取范围内负担前 12，绝不回退到这里。
 */
export const PANEL_IDS = ['P-014', 'P-009', 'P-003', 'P-007', 'P-020', 'P-023', 'P-011', 'P-016', 'P-021', 'P-010', 'P-005', 'P-022'];

/** 策展输入（观察面板与矩阵钉选）；缺省全部数据驱动。 */
export interface PtCuration {
  /** 策展观察面板（参与者 ID，按展示顺序）；缺省：范围内负担前 12（total 降序、n 升序）。 */
  panel?: string[];
  /** pt0p0 矩阵在负担前 12 之外追加钉选的参与者；缺省不追加（设计稿把 P-005 钉进矩阵）。 */
  matrixPins?: string[];
}

export function isDefaultScope(scope: PtScope): boolean {
  return scope.site === 'all' && scope.cohort === 'all' && scope.status === 'all' && scope.domain === 'all' && !scope.q && !scope.highOnly;
}

/** 全量参与者（固定顺序），派生量就绪。 */
export function allParticipants(): Participant[] {
  const list = fixtureParticipants();
  for (const p of list) derive(p);
  return list;
}

export function filterParticipants(list: Participant[], scope: PtScope): Participant[] {
  const a = list.filter(
    (p) =>
      (scope.site === 'all' || p.site === scope.site) &&
      (scope.cohort === 'all' || p.cohort === scope.cohort) &&
      (scope.status === 'all' || p.status === scope.status) &&
      (scope.domain === 'all' || p.sig[scope.domain] > 0) &&
      (!scope.q || p.id.toLowerCase().includes(scope.q.toLowerCase())) &&
      (!scope.highOnly || p.total >= 2),
  );
  const s = scope.sort;
  a.sort((x, y) =>
    s === 'id'
      ? x.n - y.n
      : s === 'site'
        ? (typeof x.site === 'number' && typeof y.site === 'number'
          ? x.site - y.site
          : String(x.site).localeCompare(String(y.site), 'en', { numeric: true })) || x.n - y.n
        : s === 'adherence'
          ? x.adherence - y.adherence
          : s === 'lab'
            ? worstG(y, 'egfr') - worstG(x, 'egfr') || x.n - y.n
            : y.total - x.total || x.n - y.n,
  );
  return a;
}

/** 18 张图的行模型；默认作用域 + 设计稿策展（PtCuration）下与设计稿逐项一致。 */
export function buildPtModels(
  list: Participant[],
  scope: PtScope = DEFAULT_SCOPE,
  labSel: Record<string, string> = { pt1p0: 'egfr', pt1p1: 'egfr' },
  curation: PtCuration = {},
): PtModels {
  const byId: Record<string, Participant> = Object.fromEntries(list.map((p) => [p.id, p]));
  const F0 = filterParticipants(list, scope);
  const ids = new Set(F0.map((p) => p.id));
  const ranked = [...F0].sort((a, b) => b.total - a.total || a.n - b.n);
  const matRows = ranked.slice(0, 12);
  if (isDefaultScope(scope)) {
    for (const pid of curation.matrixPins ?? []) {
      const pinned = byId[pid];
      if (pinned && !matRows.some((p) => p.id === pid)) matRows.push(pinned);
    }
  }
  const aeP = F0.filter((p) => p.aes.length)
    .map((p) => ({
      p,
      g12: p.aes.filter((a) => a.grade <= 2 && !a.serious).length,
      g3: p.aes.filter((a) => a.grade === 3 && !a.serious).length,
      g4: p.aes.filter((a) => a.grade >= 4 && !a.serious).length,
      sae: p.aes.some((a) => a.serious),
    }))
    .sort((a, b) => b.g3 * 2 + b.g4 * 3 + b.g12 + (b.sae ? 3 : 0) - (a.g3 * 2 + a.g4 * 3 + a.g12 + (a.sae ? 3 : 0)));
  const panelIds = curation.panel ?? ranked.slice(0, 12).map((p) => p.id);
  const panel = panelIds.filter((id) => ids.has(id)).map((id) => byId[id]!);
  return {
    pt0p0: { rows: matRows },
    pt0p1: { rows: ranked.filter((p) => p.total > 0).slice(0, 10) },
    pt1p0: { rows: [...F0].sort((a, b) => worstG(b, labSel.pt1p0 ?? 'egfr') - worstG(a, labSel.pt1p0 ?? 'egfr') || a.n - b.n).slice(0, 8), analyte: labSel.pt1p0 ?? 'egfr' },
    pt1p1: { analyte: labSel.pt1p1 ?? 'egfr', rows: F0 },
    pt1p2: { rows: [...F0].sort((a, b) => Number(b.labCrit) - Number(a.labCrit) || b.sig[0] - a.sig[0] || a.n - b.n).slice(0, 12) },
    pt1p3: { rows: aeP.slice(0, 8) },
    pt1p4: { rows: aeP.slice(0, 8).map((x) => x.p), escalation: 14 },
    pt2p0: { rows: [...F0].sort((a, b) => a.consentGap - b.consentGap) },
    pt2p1: { rows: F0.filter((p) => p.elig.length) },
    pt2p2: { rows: panel },
    pt3p0: { rows: panel },
    pt3p1: { rows: F0 },
    pt3p2: { rows: [...F0].filter((p) => p.queries.open > 0).sort((a, b) => b.queries.open - a.queries.open || b.queries.oldest - a.queries.oldest).slice(0, 10) },
    pt3p3: { rows: panel.slice(0, 10) },
    pt3p4: { rows: F0.map((p) => ({ p, ms: labMeanSD(p, 'egfr') })).filter((x): x is { p: Participant; ms: { mean: number; sd: number; n: number } } => !!x.ms) },
    pt4p0: { rows: [...F0].sort((a, b) => a.adherence - b.adherence), lo: 80, hi: 120 },
    pt4p1: { rows: panel.slice(0, 10) },
    pt4p2: { points: F0.map((p) => ({ id: p.id, count: p.pills.dispensed - p.pills.returned, diary: p.pills.diary })) },
  };
}

export const ptShort = short;
