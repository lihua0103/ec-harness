/**
 * 参与者档案 · 18 张图（设计稿 participants-preview 的图表选型 + 单人视图适配）。
 *
 * 设计稿是队列级（24 人同屏），RBQM PP 页是单人级（type=2 强制 patient 槽位，
 * 后端按 `AND 患者列='该患者'` 过滤）。因此保留设计稿的**图表形态与视觉语言**，
 * 把数据维度从「24 人」改成「1 人 × 多时间点 / 多分析物 / 多标准」。
 *
 * 全部走系统自定义图表（saveChartType），不引入系统内置类型。
 * option 必须纯 JSON（无函数），设计稿的 custom renderItem 用等价内置系列重建：
 *   statusMatrix  → heatmap 类别矩阵（单元格色 + 数值）
 *   swimlane      → scatter 散点（按状态着色，视觉映射）
 *   哑铃/棒棒糖    → 两点连线 / 点图（line/scatter，不画柱）
 *   子弹图        → 横向 bar + markArea 可接受带 + scatter 指针
 *   甘特          → 周条带 heatmap 矩阵
 * 数值由 `_bypassBuilder + _dataMap` 按列名从数据集注入，切换参与者即刷新。
 * 后端 ChartDynamicBuilder 只按 Number 列拆系列、Dimension[0] 取类目，
 * 所以跨列形状（热力图三元组、散点坐标）必须显式写 `_dataMap.series[].shape`。
 */
import { CRIT, LABS, VISITS, type Participant } from './participant-model.js';

type Json = Record<string, unknown>;
type Rows = Array<Record<string, unknown>>;

const C = {
  blue: '#1f5fa8', purple: '#a577bd', teal: '#007b82', pale: '#8fa6c4',
  red: '#c23b45', amber: '#9c6d1c', green: '#286746', gray: '#9aa3b2',
  unknown: '#e4e9ed', ink: '#153847', secondary: '#536d78', grid: '#e6edf0',
  deepRed: '#8f1d28',
};
const PALETTE = [C.blue, C.purple, C.pale, C.gray, C.teal];
const LAB_NAMES = LABS.map((l) => l.name.replace(/\s+/g, ''));
const DOMAINS = ['Medical safety', 'Protocol compliance', 'Data integrity', 'IP exposure'];

function frame(extra: Json = {}): Json {
  return {
    _bypassBuilder: true,
    animation: false,
    backgroundColor: '#fff',
    color: PALETTE,
    textStyle: { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, color: C.ink },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
    grid: { left: 14, right: 26, top: 42, bottom: 30, containLabel: true },
    legend: { top: 4, type: 'scroll', textStyle: { color: C.secondary, fontSize: 11 }, itemWidth: 13, itemHeight: 8 },
    ...extra,
  };
}
const catAxis = (name: string, extra: Json = {}): Json => ({
  type: 'category', data: [], name,
  nameTextStyle: { color: C.secondary, fontSize: 11 }, nameLocation: 'middle', nameGap: 30,
  axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true },
  axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false }, ...extra,
});
const valAxis = (name: string, extra: Json = {}): Json => ({
  type: 'value', name,
  nameTextStyle: { color: C.secondary, fontSize: 11 }, nameLocation: 'middle', nameGap: 34,
  axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true },
  axisLine: { show: false }, axisTick: { show: false },
  splitLine: { lineStyle: { color: C.grid } }, ...extra,
});

/** 连续色阶（计数/等级矩阵）：把 0..max 映射到 正常→高危 的语义色。 */
const gradeScale = (min: number, max: number, colors: string[]): Json => ({
  type: 'continuous', min, max, calculable: false, orient: 'horizontal', left: 'center', bottom: 0,
  inRange: { color: colors }, textStyle: { color: C.secondary, fontSize: 10 }, itemWidth: 12, itemHeight: 90,
});
/** 分段色阶（状态矩阵）：value → 标签 + 颜色，保证数据全覆盖（fitVisualMap 不会退化）。 */
const stateScale = (pieces: Array<[number, string, string]>): Json => ({
  type: 'piecewise', pieces: pieces.map(([value, label, color]) => ({ value, label, color })),
  orient: 'horizontal', left: 'center', bottom: 0,
  itemWidth: 11, itemHeight: 10, textStyle: { color: C.secondary, fontSize: 10 },
});

/** 类别矩阵（设计稿 statusMatrix / 5×5 热力图的等价重建）。
 *  数据由 scatterTuple 注入 [X_IDX, Y_IDX, 值]；烘焙的轴标签保持设计文案。 */
function matrixOption(
  xLabels: string[], yLabels: string[], seriesName: string, valueCol: string, visualMap: Json,
  extra: Json = {}, coords: [string, string] = ['X_IDX', 'Y_IDX'],
): Json {
  return frame({
    _dataMap: { series: [{ match: seriesName, shape: 'scatterTuple', cols: [coords[0], coords[1], valueCol] }] },
    tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
    grid: { left: 12, right: 16, top: 46, bottom: 40, containLabel: true },
    xAxis: {
      type: 'category', data: xLabels, position: 'top',
      axisLabel: { color: C.secondary, fontSize: 10, interval: 0, rotate: xLabels.some((l) => l.length > 9) ? 24 : 0 },
      axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false },
    },
    yAxis: {
      type: 'category', data: yLabels, inverse: true,
      axisLabel: { color: C.secondary, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    visualMap,
    series: [{
      name: seriesName, type: 'heatmap', data: [],
      label: { show: true, color: C.ink, fontSize: 11 },
      itemStyle: { borderColor: '#fff', borderWidth: 2 },
    }],
    ...extra,
  });
}

export interface SingleChart {
  key: string;
  /** 设计稿图 id（pt0p0…pt4p2），逐图对照用。 */
  designId: string;
  title: string;
  section: string;
  option: Json;
  /** 数据集列（第一列必须是 PATIENT）。 */
  columns: string[];
  scope: { dimensionColumn: string; numberColumns: string[] };
  /** 从参与者模型生成宽表行（不含表头）。 */
  buildRows(participants: Participant[], source: Record<string, Rows>): Array<Array<string | number>>;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => String(v ?? '').trim();

/** 化验长表 → 按 (参与者, 周) 聚合的 {analyte: value} 索引。 */
function labIndex(source: Record<string, Rows>) {
  const map = new Map<string, Map<string, number>>();
  for (const row of source['labs'] ?? []) {
    const patient = str(row.participantId);
    const week = num(row.week);
    const value = num(row.value);
    const analyte = str(row.analyte).toLowerCase();
    const def = LABS.find((l) => l.key === analyte || l.name.toLowerCase() === analyte || l.name.replace(/\s+/g, '').toLowerCase() === analyte);
    if (!patient || week === null || value === null || !def) continue;
    const key = patient + '|' + week;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key)!.set(def.key, value);
  }
  return map;
}

const worstGrade = (p: Participant, key: string): number | null => {
  const grades = (p.lab?.[key] ?? []).map((x) => x.g).filter((g): g is number => g !== null && g !== undefined);
  return grades.length ? Math.max(...grades) : null;
};

const HEAT = ['#eef8f3', '#d8ecdf', '#fbf2df', '#f2c9bd', '#c23b45'];

export const SINGLE_CHARTS: SingleChart[] = [
  // ── ① 分诊 ────────────────────────────────────────────────────────────
  {
    // 设计稿 pt0p0：参与者 × 4 临床域的状态矩阵（✓/△/!）。
    // 单人视图：1 行 × 4 域，信号数决定单元格色深。
    key: 'triage', designId: 'pt0p0', title: '临床域信号矩阵', section: '① 分诊',
    columns: ['PATIENT', 'DOMAIN', 'SIGNALS', 'X_IDX', 'Y_IDX'],
    scope: { dimensionColumn: 'DOMAIN', numberColumns: ['SIGNALS', 'X_IDX', 'Y_IDX'] },
    option: matrixOption(DOMAINS, ['Current participant'], 'SIGNALS', 'SIGNALS', gradeScale(0, 4, HEAT)),
    buildRows: (ps) => ps.flatMap((p) => DOMAINS.map((d, i) => [p.id, d, p.sig?.[i] ?? 0, i, 0])),
  },
  {
    // 设计稿 pt0p1：横向堆叠条（每个域一段，无总分）。
    key: 'signals', designId: 'pt0p1', title: '信号构成', section: '① 分诊',
    columns: ['PATIENT', 'SAFETY', 'PROTOCOL', 'DATA', 'IP'],
    scope: { dimensionColumn: 'PATIENT', numberColumns: ['SAFETY', 'PROTOCOL', 'DATA', 'IP'] },
    option: frame({
      _dataMap: { axis: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, renderMode: 'richText', confine: true },
      xAxis: valAxis('Open signals', { minInterval: 1 }),
      yAxis: catAxis('Participant', { axisLabel: { color: C.ink, fontSize: 11 } }),
      legend: { top: 2, type: 'scroll', textStyle: { color: C.secondary, fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
      series: [
        { name: 'SAFETY', type: 'bar', stack: 'sig', data: [], barMaxWidth: 26, itemStyle: { color: C.red } },
        { name: 'PROTOCOL', type: 'bar', stack: 'sig', data: [], barMaxWidth: 26, itemStyle: { color: C.purple } },
        { name: 'DATA', type: 'bar', stack: 'sig', data: [], barMaxWidth: 26, itemStyle: { color: C.amber } },
        { name: 'IP', type: 'bar', stack: 'sig', data: [], barMaxWidth: 26, itemStyle: { color: C.teal } },
      ],
    }),
    buildRows: (ps) => ps.map((p) => [p.id, p.sig?.[0] ?? 0, p.sig?.[1] ?? 0, p.sig?.[2] ?? 0, p.sig?.[3] ?? 0]),
  },

  // ── ② 医学安全 ────────────────────────────────────────────────────────
  {
    // 设计稿 pt1p0：分析物轨迹线 + 正常范围带（markArea）。
    key: 'labs', designId: 'pt1p0', title: '安全检验轨迹', section: '② 安全性',
    columns: ['PATIENT', 'WEEK', ...LAB_NAMES],
    scope: { dimensionColumn: 'WEEK', numberColumns: LAB_NAMES },
    option: frame({
      _dataMap: { axis: true },
      xAxis: catAxis('Week'),
      yAxis: valAxis('Value'),
      series: LAB_NAMES.map((name, i) => ({
        name, type: 'line', data: [], symbol: 'circle', symbolSize: 6, connectNulls: false,
        lineStyle: { width: 2, color: PALETTE[i] }, itemStyle: { color: PALETTE[i] },
      })),
    }),
    buildRows: (ps, source) => {
      const index = labIndex(source);
      const out: Array<Array<string | number>> = [];
      for (const p of ps) {
        const weeks = new Set<number>();
        for (const key of index.keys()) if (key.startsWith(p.id + '|')) weeks.add(Number(key.split('|')[1]));
        for (const week of [...weeks].sort((a, b) => a - b)) {
          const values = index.get(p.id + '|' + week) ?? new Map<string, number>();
          out.push([p.id, week, ...LABS.map((l) => values.get(l.key) ?? '')]);
        }
      }
      return out;
    },
  },
  {
    // 设计稿 pt1p1：基线→最重等级的 5×5 热力图。
    // 单人视图：分析物 × (Baseline, Worst) 的等级矩阵，色深即等级。
    key: 'toxshift', designId: 'pt1p1', title: '基线→最重毒性等级', section: '② 安全性',
    columns: ['PATIENT', 'ANALYTE', 'SIDE_IDX', 'ANALYTE_IDX', 'GRADE'],
    scope: { dimensionColumn: 'ANALYTE', numberColumns: ['SIDE_IDX', 'ANALYTE_IDX', 'GRADE'] },
    option: matrixOption(['Baseline', 'Worst'], LABS.map((l) => l.name), 'GRADE', 'GRADE', gradeScale(0, 4, HEAT), {}, ['SIDE_IDX', 'ANALYTE_IDX']),
    buildRows: (ps) => ps.flatMap((p) => LABS.flatMap((l, y) => {
      const points = p.lab?.[l.key] ?? [];
      const base = points[0]?.g ?? null;
      const worst = worstGrade(p, l.key);
      const rows: Array<Array<string | number>> = [];
      if (base !== null) rows.push([p.id, l.name, 0, y, base]);
      if (worst !== null) rows.push([p.id, l.name, 1, y, worst]);
      return rows;
    })),
  },
  {
    // 设计稿 pt1p2：参与者 × 分析物的最重旗标矩阵。
    // 单人视图：1 行 × 5 分析物，单元格值为最重等级。
    key: 'labsig', designId: 'pt1p2', title: '临床显著检验', section: '② 安全性',
    columns: ['PATIENT', 'ANALYTE', 'GRADE', 'X_IDX', 'Y_IDX'],
    scope: { dimensionColumn: 'ANALYTE', numberColumns: ['GRADE', 'X_IDX', 'Y_IDX'] },
    option: matrixOption(LABS.map((l) => l.name), ['Current participant'], 'GRADE', 'GRADE', gradeScale(0, 4, HEAT)),
    buildRows: (ps) => ps.flatMap((p) => LABS.flatMap((l, x) => {
      const worst = worstGrade(p, l.key);
      return worst === null ? [] : [[p.id, l.name, worst, x, 0]];
    })),
  },
  {
    // 设计稿 pt1p3：AE 负荷横向堆叠条（G1–2 / G3 / G4 / SAE）。
    key: 'aeburden', designId: 'pt1p3', title: 'AE 负荷', section: '② 安全性',
    columns: ['PATIENT', 'G12', 'G3', 'G4', 'SAE'],
    scope: { dimensionColumn: 'PATIENT', numberColumns: ['G12', 'G3', 'G4', 'SAE'] },
    option: frame({
      _dataMap: { axis: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, renderMode: 'richText', confine: true },
      xAxis: valAxis('AE events', { minInterval: 1 }),
      yAxis: catAxis('Participant', { axisLabel: { color: C.ink, fontSize: 11 } }),
      legend: { top: 2, type: 'scroll', textStyle: { color: C.secondary, fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
      series: [
        { name: 'G12', type: 'bar', stack: 'ae', data: [], barMaxWidth: 26, itemStyle: { color: C.pale } },
        { name: 'G3', type: 'bar', stack: 'ae', data: [], barMaxWidth: 26, itemStyle: { color: C.amber } },
        { name: 'G4', type: 'bar', stack: 'ae', data: [], barMaxWidth: 26, itemStyle: { color: C.red } },
        { name: 'SAE', type: 'bar', stack: 'ae', data: [], barMaxWidth: 26, itemStyle: { color: C.deepRed } },
      ],
    }),
    buildRows: (ps) => ps.map((p) => {
      const aes = p.aes ?? [];
      return [
        p.id,
        aes.filter((a) => a.grade <= 2 && !a.serious).length,
        aes.filter((a) => a.grade === 3 && !a.serious).length,
        aes.filter((a) => a.grade >= 4 && !a.serious).length,
        aes.filter((a) => a.serious).length,
      ];
    }),
  },
  {
    // 设计稿 pt1p4：AE 时间线泳道（圆点按等级着色）。
    // 单人视图：周 × CTCAE 等级散点，等级色阶（视觉映射），不画柱。
    key: 'aetl', designId: 'pt1p4', title: 'AE 与给药时间线', section: '② 安全性',
    columns: ['PATIENT', 'WEEK', 'GRADE'],
    scope: { dimensionColumn: 'WEEK', numberColumns: ['WEEK', 'GRADE'] },
    option: frame({
      _dataMap: { series: [{ match: 'GRADE', shape: 'scatterTuple', cols: ['WEEK', 'GRADE'] }] },
      tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
      xAxis: valAxis('Week on study', { min: 0, max: 56 }),
      yAxis: valAxis('CTCAE grade', { min: 1, max: 5, minInterval: 1 }),
      legend: { show: false },
      visualMap: {
        dimension: 1, type: 'piecewise', orient: 'horizontal', left: 'center', bottom: 0,
        itemWidth: 10, itemHeight: 9, textStyle: { color: C.secondary, fontSize: 10 },
        pieces: [
          { value: 1, label: 'G1', color: C.pale },
          { value: 2, label: 'G2', color: C.blue },
          { value: 3, label: 'G3', color: C.amber },
          { value: 4, label: 'G4', color: C.red },
          { value: 5, label: 'G5', color: C.deepRed },
        ],
      },
      series: [{ name: 'GRADE', type: 'scatter', data: [], symbolSize: 16, itemStyle: { borderColor: '#fff', borderWidth: 1 } }],
    }),
    buildRows: (ps, source) => ps.flatMap((p) => (source['aes'] ?? [])
      .filter((r) => str(r.participantId) === p.id)
      .map((r) => [p.id, num(r.week) ?? '', num(r.grade) ?? ''])
      .filter((row) => row[1] !== '' && row[2] !== '')),
  },

  // ── ③ 方案依从 ────────────────────────────────────────────────────────
  {
    // 设计稿 pt2p0：知情→随机化的哑铃（连线 + 两端口）。
    // 单人视图：两个里程碑的两点连线（横向），端点为圆点。
    key: 'consent', designId: 'pt2p0', title: '知情→随机化间隔', section: '③ 方案依从',
    columns: ['PATIENT', 'MILESTONE', 'DAYS'],
    scope: { dimensionColumn: 'MILESTONE', numberColumns: ['DAYS'] },
    option: frame({
      _dataMap: { axis: true },
      tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
      xAxis: valAxis('Days from randomization', { min: -45, max: 5 }),
      yAxis: catAxis('Milestone', { axisLabel: { color: C.ink, fontSize: 11 } }),
      legend: { show: false },
      series: [{
        name: 'DAYS', type: 'line', data: [], symbol: 'circle', symbolSize: 11,
        lineStyle: { width: 3, color: C.gray }, itemStyle: { color: C.blue, borderColor: '#fff', borderWidth: 1 },
        label: { show: true, position: 'right', color: C.ink, fontSize: 10 },
      }],
    }),
    buildRows: (ps) => ps.flatMap((p) => [
      [p.id, 'Consent', -(p.consentGap ?? 0)],
      [p.id, 'Randomization', 0],
    ]),
  },
  {
    // 设计稿 pt2p1：参与者 × 6 入选标准的状态矩阵（Met / Waiver / Violated）。
    key: 'elig', designId: 'pt2p1', title: '入选标准偏离', section: '③ 方案依从',
    columns: ['PATIENT', 'CRITERION', 'STATUS', 'X_IDX', 'Y_IDX'],
    scope: { dimensionColumn: 'CRITERION', numberColumns: ['STATUS', 'X_IDX', 'Y_IDX'] },
    option: matrixOption(CRIT, ['Current participant'], 'STATUS', 'STATUS',
      stateScale([[0, 'Met', '#eef8f3'], [1, 'Waiver', '#fbf2df'], [2, 'Violated', '#fff0f1']])),
    buildRows: (ps) => ps.flatMap((p) => CRIT.map((criterion, i) => {
      const hit = (p.elig ?? []).find((e) => e.c === i);
      const status = !hit ? 0 : hit.s === 'violated' ? 2 : 1;
      return [p.id, criterion, status, i, 0];
    })),
  },
  {
    // 设计稿 pt2p2：访视泳道（圆点=按时/超窗，× = 漏访）。
    // 单人视图：周 × 偏差天数散点，状态用视觉映射着色，漏访落在 0 线上。
    key: 'visits', designId: 'pt2p2', title: '访视执行轨迹', section: '③ 方案依从',
    columns: ['PATIENT', 'WEEK', 'DEVIATION', 'STATE'],
    scope: { dimensionColumn: 'WEEK', numberColumns: ['WEEK', 'DEVIATION', 'STATE'] },
    option: frame({
      _dataMap: { series: [{ match: 'DEVIATION', shape: 'scatterTuple', cols: ['WEEK', 'DEVIATION', 'STATE'] }] },
      tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
      xAxis: valAxis('Week on study', { min: 0, max: 56, minInterval: 4 }),
      yAxis: valAxis('Deviation (days)', { min: -15, max: 15 }),
      legend: { show: false },
      visualMap: {
        dimension: 2, type: 'piecewise', orient: 'horizontal', left: 'center', bottom: 0,
        itemWidth: 10, itemHeight: 9, textStyle: { color: C.secondary, fontSize: 10 },
        pieces: [
          { value: 0, label: 'In window', color: C.blue },
          { value: 1, label: 'Out of window', color: C.amber },
          { value: 2, label: 'Missed', color: C.red },
        ],
      },
      series: [{ name: 'DEVIATION', type: 'scatter', data: [], symbolSize: 15, itemStyle: { borderColor: '#fff', borderWidth: 1 } }],
    }),
    buildRows: (ps, source) => ps.flatMap((p) => VISITS.flatMap((week) => {
      const row = (source['visits'] ?? []).find((r) => str(r.participantId) === p.id && num(r.week) === week);
      if (!row) return [];
      const state = str(row.state).toLowerCase();
      const dev = num(row.deviationDays);
      if (state === 'missed') return [[p.id, week, 0, 2]];
      if (state !== 'done' || dev === null) return [];
      return [[p.id, week, dev, Math.abs(dev) > 7 ? 1 : 0]];
    })),
  },

  // ── ④ 数据质量 ────────────────────────────────────────────────────────
  {
    // 设计稿 pt3p0：参与者 × 关键访视的状态矩阵（Done / Missing / Not due）。
    key: 'assess', designId: 'pt3p0', title: '关键评估完成度', section: '④ 数据质量',
    columns: ['PATIENT', 'WEEK', 'X_IDX', 'Y_IDX', 'STATE'],
    scope: { dimensionColumn: 'WEEK', numberColumns: ['X_IDX', 'Y_IDX', 'STATE'] },
    option: matrixOption(VISITS.map((w) => 'Week ' + w), ['Current participant'], 'STATE', 'STATE',
      stateScale([[0, 'Done', '#eef8f3'], [1, 'Missing', '#fff0f1'], [2, 'Not due', '#edf0f4']])),
    buildRows: (ps, source) => ps.flatMap((p) => VISITS.map((week, x) => {
      const row = (source['visits'] ?? []).find((r) => str(r.participantId) === p.id && num(r.week) === week);
      const state = str(row?.state).toLowerCase();
      const code = !row || state === 'notdue' ? 2 : state === 'missed' ? 1 : 0;
      return [p.id, String(week), x, 0, code];
    })),
  },
  {
    // 设计稿 pt3p1：分析物 × 访视的缺失热力图；单人视图是真交叉等级矩阵（5 × 4）。
    key: 'labmatrix', designId: 'pt3p1', title: '检验等级矩阵', section: '④ 数据质量',
    columns: ['PATIENT', 'VISIT', 'ANALYTE', 'X_IDX', 'Y_IDX', 'GRADE'],
    scope: { dimensionColumn: 'VISIT', numberColumns: ['X_IDX', 'Y_IDX', 'GRADE'] },
    option: matrixOption(VISITS.map((w) => 'Week ' + w), LABS.map((l) => l.name), 'GRADE', 'GRADE', gradeScale(0, 4, HEAT)),
    buildRows: (ps, source) => {
      const index = labIndex(source);
      const out: Array<Array<string | number>> = [];
      for (const p of ps) {
        LABS.forEach((l, y) => {
          VISITS.forEach((week, x) => {
            const value = index.get(p.id + '|' + week)?.get(l.key);
            if (value === undefined) return;
            const g = l.key === 'egfr' ? (value < 30 ? 4 : value < 45 ? 3 : value < 60 ? 2 : value < 90 ? 1 : 0)
              : l.key === 'hb' ? (value < 80 ? 4 : value < 100 ? 3 : value < 120 ? 2 : 0)
              : l.key === 'k' ? (value > 6 ? 4 : value > 5.5 ? 3 : value > 5 ? 2 : value < 3 ? 3 : 0)
              : l.key === 'alt' ? (value > 200 ? 4 : value > 120 ? 3 : value > 80 ? 2 : value > 40 ? 1 : 0)
              : (value > 300 ? 4 : value > 100 ? 3 : value > 30 ? 2 : 0);
            out.push([p.id, 'Week ' + week, l.name, x, y, g]);
          });
        });
      }
      return out;
    },
  },
  {
    // 设计稿 pt3p2：开放质疑的棒棒糖（点 + 数值标签）。
    // 单人视图：指标 × 数值的点图（无柱）。
    key: 'queries', designId: 'pt3p2', title: '未关闭质疑负担', section: '④ 数据质量',
    columns: ['PATIENT', 'METRIC', 'VALUE'],
    scope: { dimensionColumn: 'METRIC', numberColumns: ['VALUE'] },
    option: frame({
      _dataMap: { axis: true },
      tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
      xAxis: valAxis('Count / days', { min: 0 }),
      yAxis: catAxis('Query metric', { axisLabel: { color: C.ink, fontSize: 11 } }),
      legend: { show: false },
      series: [{
        name: 'VALUE', type: 'scatter', data: [], symbolSize: 14,
        itemStyle: { color: C.purple, borderColor: '#fff', borderWidth: 1 },
        label: { show: true, position: 'right', color: C.ink, fontSize: 11 },
      }],
    }),
    buildRows: (ps) => ps.flatMap((p) => [
      [p.id, 'Open queries', p.queries?.open ?? 0],
      [p.id, 'Oldest (days)', p.queries?.oldest ?? 0],
    ]),
  },
  {
    // 设计稿 pt3p3：ePRO 的 12 周方块矩阵（一个方块 = 一周）。
    key: 'epro', designId: 'pt3p3', title: 'ePRO 日记完成度', section: '④ 数据质量',
    columns: ['PATIENT', 'WEEK', 'X_IDX', 'Y_IDX', 'STATE'],
    scope: { dimensionColumn: 'WEEK', numberColumns: ['X_IDX', 'Y_IDX', 'STATE'] },
    option: matrixOption(
      Array.from({ length: 12 }, (_, i) => 'W' + (i + 1)), ['Diary'], 'STATE', 'STATE',
      stateScale([[0, 'Complete', '#e7eef7'], [1, 'Partial', '#fbf2df'], [2, 'Missed', '#fff0f1'], [3, 'Not due', '#edf0f4']]),
    ),
    buildRows: (ps) => ps.flatMap((p) => (p.epro ?? []).map((state, i) => {
      const code = state === 'full' ? 0 : state === 'partial' ? 1 : state === 'missed' ? 2 : 3;
      return [p.id, i + 1, i, 0, code];
    })),
  },
  {
    // 设计稿 pt3p4：eGFR 均值 vs 院内 SD 散点（含 inlier 线）。
    // 单人视图：周 × eGFR 散点 + 正常下限参考线，相对基线变化量决定点色。
    key: 'egfr', designId: 'pt3p4', title: 'eGFR 轨迹与波动', section: '④ 数据质量',
    columns: ['PATIENT', 'WEEK', 'EGFR', 'DEVIATION'],
    scope: { dimensionColumn: 'WEEK', numberColumns: ['WEEK', 'EGFR', 'DEVIATION'] },
    option: frame({
      _dataMap: { series: [{ match: 'EGFR', shape: 'scatterTuple', cols: ['WEEK', 'EGFR', 'DEVIATION'] }] },
      tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
      xAxis: valAxis('Week on study', { min: 0, max: 56, minInterval: 4 }),
      yAxis: valAxis('eGFR (mL/min/1.73m²)', { min: 0 }),
      legend: { show: false },
      visualMap: {
        dimension: 2, type: 'piecewise', orient: 'horizontal', left: 'center', bottom: 0,
        itemWidth: 10, itemHeight: 9, textStyle: { color: C.secondary, fontSize: 10 },
        pieces: [
          { lt: -15, label: 'Drop >15', color: C.red },
          { gte: -15, lte: -5, label: 'Drop 5–15', color: C.amber },
          { gt: -5, lte: 5, label: 'Stable', color: C.teal },
          { gt: 5, label: 'Rise', color: C.blue },
        ],
      },
      series: [{
        name: 'EGFR', type: 'scatter', data: [], symbolSize: 13,
        itemStyle: { borderColor: '#fff', borderWidth: 1 },
        markLine: {
          silent: true, symbol: 'none', lineStyle: { color: C.grid, type: 'dashed' },
          label: { color: C.secondary, fontSize: 9 },
          data: [{ yAxis: 90, name: '90' }, { yAxis: 60, name: '60' }, { yAxis: 30, name: '30' }],
        },
      }],
    }),
    buildRows: (ps, source) => {
      const index = labIndex(source);
      return ps.flatMap((p) => {
        const weeks = [...index.keys()].filter((k) => k.startsWith(p.id + '|')).map((k) => Number(k.split('|')[1])).sort((a, b) => a - b);
        const base = weeks.length ? index.get(p.id + '|' + weeks[0])?.get('egfr') ?? null : null;
        return weeks.flatMap((week) => {
          const value = index.get(p.id + '|' + week)?.get('egfr') ?? null;
          if (value === null) return [];
          const dev = base !== null ? Math.round((value - base) * 10) / 10 : 0;
          return [[p.id, week, value, dev] as Array<string | number>];
        });
      });
    },
  },

  // ── ⑤ 用药与 IP ───────────────────────────────────────────────────────
  {
    // 设计稿 pt4p0：依从性子弹图（可接受带 + 条形 + 指针）。
    key: 'adherence', designId: 'pt4p0', title: '依从性 vs 可接受带', section: '⑤ 用药与IP',
    columns: ['PATIENT', 'ADHERENCE'],
    scope: { dimensionColumn: 'PATIENT', numberColumns: ['ADHERENCE'] },
    option: frame({
      _dataMap: { axis: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, renderMode: 'richText', confine: true },
      xAxis: valAxis('Adherence (%)', { min: 0, max: 140 }),
      yAxis: catAxis('Participant', { axisLabel: { color: C.ink, fontSize: 11 } }),
      legend: { show: false },
      series: [{
        name: 'ADHERENCE', type: 'bar', data: [], barWidth: 12,
        itemStyle: { color: C.teal },
        label: { show: true, position: 'right', color: C.ink, fontSize: 11 },
        markArea: {
          silent: true, itemStyle: { color: 'rgba(40,103,70,0.10)' },
          label: { show: true, position: 'insideTop', color: C.green, fontSize: 10, formatter: 'acceptable 80–120%' },
          data: [[{ xAxis: 80 }, { xAxis: 120 }]],
        },
      }, {
        name: 'ADHERENCE', type: 'scatter', data: [], symbolSize: 10,
        itemStyle: { color: C.ink, borderColor: '#fff', borderWidth: 1 },
      }],
    }),
    buildRows: (ps) => ps.map((p) => [p.id, p.adherence ?? 0]),
  },
  {
    // 设计稿 pt4p1：剂量调整甘特（Full/Reduced/Held 段）。
    // 单人视图：周条带矩阵，每 4 周一格，颜色即剂量状态（甘特段的等价重建）。
    key: 'dose', designId: 'pt4p1', title: '剂量调整史', section: '⑤ 用药与IP',
    columns: ['PATIENT', 'WEEK', 'X_IDX', 'Y_IDX', 'STATE'],
    scope: { dimensionColumn: 'WEEK', numberColumns: ['X_IDX', 'Y_IDX', 'STATE'] },
    option: matrixOption(
      Array.from({ length: 13 }, (_, i) => 'W' + i * 4), ['Dose'], 'STATE', 'STATE',
      stateScale([[0, 'Full dose', '#1f5fa8'], [1, 'Reduced', '#9c6d1c'], [2, 'Held', '#b98a8e']]),
    ),
    buildRows: (ps, source) => ps.flatMap((p) => {
      const segments = (source['dose'] ?? []).filter((r) => str(r.participantId) === p.id);
      const maxWeek = Math.min(48, Math.max(0, ...segments.map((s) => num(s.toWeek) ?? 0)));
      const out: Array<Array<string | number>> = [];
      for (let week = 0; week <= maxWeek; week += 4) {
        const segment = segments.find((s) => {
          const from = num(s.fromWeek);
          const to = num(s.toWeek);
          return from !== null && to !== null && week >= from && week < to;
        });
        if (!segment) continue;
        const state = str(segment.state).toLowerCase();
        const code = state === 'reduced' ? 1 : state === 'held' ? 2 : 0;
        out.push([p.id, week, week / 4, 0, code]);
      }
      return out;
    }),
  },
  {
    // 设计稿 pt4p2：药片清点 vs 日记的散点（±10% 一致性线）。
    // 单人视图：4 个药片指标的数值点图（清点/退回/已服/日记）。
    key: 'pills', designId: 'pt4p2', title: '药片清点 vs 日记', section: '⑤ 用药与IP',
    columns: ['PATIENT', 'METRIC', 'COUNT'],
    scope: { dimensionColumn: 'METRIC', numberColumns: ['COUNT'] },
    option: frame({
      _dataMap: { axis: true },
      tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
      xAxis: valAxis('Tablets', { min: 0 }),
      yAxis: catAxis('Pill metric', { axisLabel: { color: C.ink, fontSize: 11 } }),
      legend: { show: false },
      series: [{
        name: 'COUNT', type: 'scatter', data: [], symbolSize: 14,
        itemStyle: { color: C.blue, borderColor: '#fff', borderWidth: 1 },
        label: { show: true, position: 'right', color: C.ink, fontSize: 11 },
      }],
    }),
    buildRows: (ps) => ps.flatMap((p) => {
      const dispensed = p.pills?.dispensed ?? 0;
      const returned = p.pills?.returned ?? 0;
      const diary = p.pills?.diary ?? 0;
      return [
        [p.id, 'Dispensed', dispensed],
        [p.id, 'Returned', returned],
        [p.id, 'Taken (count)', Math.max(0, dispensed - returned)],
        [p.id, 'Diary', diary],
      ];
    }),
  },
];