/**
 * 7 张 custom renderItem 图 → 标准系列等价物（平台 JSON 配置持久化用）。
 *
 * 平台保存的图表配置是纯 JSON，不能携带 renderItem/回调函数；直接 JSON 化
 * custom option 会得到无法渲染的残缺系列。这里按 dm-viz custom-rebuild 的
 * keepFrame 先例，把 custom 视觉改写为标准系列等价物：坐标/数据/色义不变，
 * 视觉形态近似（点/条/热力格），不等于 custom 的逐像素形态——故结果标注
 * rebuilt=true，仅用于平台配置候选，验收配对仍以 custom 原样（live bundle）为准。
 */
import { PT_THEME, VISITS, type Participant } from './participant-model.js';

type Json = Record<string, any>;
const C = PT_THEME;

/** 保留 custom option 的框架（坐标/主题/工具提示），仅替换 series。 */
function keepFrame(b: Json): Json {
  return {
    animation: false,
    backgroundColor: b.backgroundColor,
    textStyle: b.textStyle,
    color: b.color,
    tooltip: b.tooltip,
    grid: b.grid,
    xAxis: b.xAxis,
    yAxis: b.yAxis,
    legend: b.legend,
    dataZoom: b.dataZoom,
    aria: b.aria,
    series: [],
  };
}

const catRows = (m: any): string[] => m.rows.map((p: Participant) => p.id);

export const REBUILD: Record<string, (m: any) => Json> = {
  // pt1p4 AE 发生 vs 给药时间线 → 散点（等级点）+ markLine 参考周
  pt1p4: (m) => {
    const b = keepFrame({
      backgroundColor: '#fff',
      textStyle: { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, color: C.ink },
      color: [C.blue, C.purple, C.pale, C.gray, C.teal],
      tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
      grid: { left: 14, right: 26, top: 42, bottom: 30, containLabel: true },
      xAxis: { type: 'value', name: 'Weeks on study', max: 48, nameTextStyle: { color: C.secondary, fontSize: 11 }, nameLocation: 'middle', nameGap: 34, axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true }, splitLine: { lineStyle: { color: C.grid } } },
      yAxis: { type: 'category', data: catRows(m), inverse: true },
    });
    delete b.legend;
    b.series = m.rows.map((p: Participant, i: number) => ({
      name: p.id,
      type: 'scatter',
      symbolSize: 9,
      data: p.aes.map((a) => ({
        value: [a.wk, i],
        symbolSize: 3 + a.grade * 2,
        itemStyle: { color: a.grade >= 3 ? C.amber : C.pale, borderColor: a.serious ? C.red : '#fff', borderWidth: a.serious ? 2.5 : 1 },
        desc: `wk${a.wk} G${a.grade}${a.serious ? ' SAE' : ''} ${a.term}`,
      })),
      tooltip: { formatter: undefined },
      z: 3,
    }));
    b.series.push({
      name: 'Dose escalation (demo)',
      type: 'line',
      data: [],
      markLine: { silent: true, symbol: 'none', label: { formatter: 'dose escalation (demo)', fontSize: 9, color: C.secondary }, lineStyle: { color: C.gray, type: 'dashed' }, data: [{ xAxis: m.escalation }] },
    });
    return b;
  },

  // pt2p0 同意→随机化间隔 → 细条连接 + 两端散点（dm-viz b3p1 先例）
  pt2p0: (m) => {
    const b = keepFrame({});
    b.backgroundColor = '#fff';
    b.textStyle = { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, color: C.ink };
    b.color = [C.blue, C.purple, C.pale, C.gray, C.teal];
    b.tooltip = { trigger: 'item', renderMode: 'richText', confine: true };
    b.grid = { left: 14, right: 40, top: 42, bottom: 30, containLabel: true };
    b.xAxis = { type: 'value', name: 'Days from randomization', min: -40, max: 2, nameTextStyle: { color: C.secondary, fontSize: 11 }, nameLocation: 'middle', nameGap: 34, axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true }, splitLine: { lineStyle: { color: C.grid } } };
    b.yAxis = { type: 'category', data: catRows(m), inverse: true };
    delete b.legend;
    const flagCol = (p: Participant) => (p.procBefore || p.consentGap === 0 ? C.red : p.consentGap > 28 ? C.amber : C.pale);
    b.series = [
      {
        name: 'Interval',
        type: 'bar',
        barWidth: 3,
        itemStyle: { color: C.gray },
        data: m.rows.map((p: Participant, i: number) => ({ value: [i, -p.consentGap], itemStyle: { color: flagCol(p) }, desc: `${p.id}: consent ${p.consentGap} d before randomization` })),
        encode: { x: 1, y: 0 },
      },
      {
        name: 'Consent',
        type: 'scatter',
        symbolSize: 8,
        data: m.rows.map((p: Participant, i: number) => ({ value: [-p.consentGap, i], itemStyle: { color: flagCol(p) }, desc: `${p.id} consent` })),
        encode: { x: 0, y: 1 },
      },
      {
        name: 'Randomization',
        type: 'scatter',
        symbol: 'diamond',
        symbolSize: 9,
        itemStyle: { color: C.blue },
        data: m.rows.map((_: Participant, i: number) => [0, i]),
        encode: { x: 0, y: 1 },
      },
    ];
    return b;
  },

  // pt2p2 访问轨迹 → 按状态分列散点（done/missed/upcoming + 退出竖线用 markPoint 简化）
  pt2p2: (m) => {
    const b = keepFrame({});
    b.backgroundColor = '#fff';
    b.textStyle = { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, color: C.ink };
    b.color = [C.blue, C.purple, C.pale, C.gray, C.teal];
    b.tooltip = { trigger: 'item', renderMode: 'richText', confine: true };
    b.grid = { left: 14, right: 26, top: 42, bottom: 30, containLabel: true };
    b.xAxis = { type: 'value', name: 'Weeks on study', max: 52, nameTextStyle: { color: C.secondary, fontSize: 11 }, nameLocation: 'middle', nameGap: 34, axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true }, splitLine: { lineStyle: { color: C.grid } } };
    b.yAxis = { type: 'category', data: catRows(m), inverse: true };
    b.legend = { top: 4, type: 'scroll', textStyle: { color: C.secondary, fontSize: 11 }, itemWidth: 13, itemHeight: 8 };
    const done: Json[] = [];
    const oow: Json[] = [];
    const missed: Json[] = [];
    const upcoming: Json[] = [];
    m.rows.forEach((p: Participant, i: number) => {
      for (const wk of VISITS) {
        const v = p.visits[wk]!;
        if (v.state === 'notdue') continue;
        if (v.state === 'missed') missed.push({ value: [wk, i], desc: `${p.id} Week ${wk} missed` });
        else if (v.state === 'done') (Math.abs(v.dev ?? 0) > 7 ? oow : done).push({ value: [wk, i], desc: `${p.id} Week ${wk} done${v.dev ? ` (${(v.dev ?? 0) > 0 ? '+' : ''}${v.dev} d)` : ''}` });
        else upcoming.push({ value: [wk, i], desc: `${p.id} Week ${wk} upcoming` });
      }
    });
    b.series = [
      { name: 'Completed in window', type: 'scatter', symbolSize: 9, itemStyle: { color: C.blue }, data: done },
      { name: 'Completed out of window', type: 'scatter', symbolSize: 9, itemStyle: { color: C.amber }, data: oow },
      { name: 'Missed', type: 'scatter', symbol: 'rect', symbolRotate: 45, symbolSize: 8, itemStyle: { color: C.red }, data: missed },
      { name: 'Upcoming', type: 'scatter', symbolSize: 9, itemStyle: { color: '#fff', borderColor: C.pale, borderWidth: 1.5 }, data: upcoming },
    ];
    return b;
  },

  // pt3p2 未关闭质疑 → 水平细条 + 端点散点带标签
  pt3p2: (m) => {
    const b = keepFrame({});
    b.backgroundColor = '#fff';
    b.textStyle = { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, color: C.ink };
    b.color = [C.blue, C.purple, C.pale, C.gray, C.teal];
    b.tooltip = { trigger: 'item', renderMode: 'richText', confine: true };
    b.grid = { left: 14, right: 70, top: 42, bottom: 30, containLabel: true };
    b.xAxis = { type: 'value', name: 'Open queries', nameTextStyle: { color: C.secondary, fontSize: 11 }, nameLocation: 'middle', nameGap: 34, axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true }, splitLine: { lineStyle: { color: C.grid } } };
    b.yAxis = { type: 'category', data: catRows(m), inverse: true };
    delete b.legend;
    const ageCol = (p: Participant) => (p.queries.oldest > 30 ? C.red : p.queries.oldest > 14 ? C.amber : C.pale);
    b.series = [
      { name: 'Open queries', type: 'bar', barWidth: 2, itemStyle: { color: C.unknown }, data: m.rows.map((p: Participant, i: number) => ({ value: [p.queries.open, i], desc: `${p.id}: ${p.queries.open} open · oldest ${p.queries.oldest} d` })), encode: { x: 0, y: 1 } },
      {
        name: 'Oldest query',
        type: 'scatter',
        symbolSize: 11,
        data: m.rows.map((p: Participant, i: number) => ({ value: [p.queries.open, i], itemStyle: { color: ageCol(p) }, desc: `${p.id}: ${p.queries.open} open · oldest ${p.queries.oldest} d` })),
        encode: { x: 0, y: 1 },
        label: { show: true, position: 'right', fontSize: 10, color: C.secondary, formatter: undefined },
      },
    ];
    return b;
  },

  // pt3p3 ePRO 完成度方块 → 标准热力格（周 × 参与者，静态色）
  pt3p3: (m) => {
    const b = keepFrame({});
    b.backgroundColor = '#fff';
    b.textStyle = { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, color: C.ink };
    b.color = [C.blue, C.purple, C.pale, C.gray, C.teal];
    b.tooltip = { trigger: 'item', renderMode: 'richText', confine: true };
    b.grid = { left: 14, right: 26, top: 42, bottom: 30, containLabel: true };
    b.xAxis = { type: 'category', data: Array.from({ length: 12 }, (_, k) => String(k)), axisLabel: { show: false }, splitLine: { show: false } };
    b.yAxis = { type: 'category', data: catRows(m), inverse: true };
    b.legend = { top: 4, type: 'scroll', textStyle: { color: C.secondary, fontSize: 11 }, itemWidth: 13, itemHeight: 8 };
    const col: Record<string, string> = { full: C.blue, partial: C.amber, missed: '#fff', notdue: C.unknown };
    const data: Json[] = [];
    m.rows.forEach((p: Participant, i: number) =>
      p.epro.forEach((s, k) => data.push({ value: [k, i, s], itemStyle: { color: col[s], borderColor: s === 'missed' ? C.red : '#fff', borderWidth: s === 'missed' ? 1.5 : 2 }, desc: `${p.id} week ${k}: ${s}` })),
    );
    b.series = [
      { name: 'Week state', type: 'heatmap', data, label: { show: false }, tooltip: { formatter: undefined } },
      ...['full', 'partial', 'missed', 'notdue'].map((s, i) => ({ name: ['Complete', 'Partial', 'Missed', 'Not due'][i], type: 'bar', data: [], itemStyle: { color: col[s], borderColor: s === 'missed' ? C.red : undefined, borderWidth: s === 'missed' ? 1 : 0 } })),
    ];
    return b;
  },

  // pt4p0 依从性子弹图 → 参考带 markArea + 依从条 + 值刻度
  pt4p0: (m) => {
    const b = keepFrame({});
    b.backgroundColor = '#fff';
    b.textStyle = { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, color: C.ink };
    b.color = [C.blue, C.purple, C.pale, C.gray, C.teal];
    b.tooltip = { trigger: 'item', renderMode: 'richText', confine: true };
    b.grid = { left: 14, right: 40, top: 42, bottom: 30, containLabel: true };
    b.xAxis = { type: 'value', name: 'Adherence (%)', max: 140, nameTextStyle: { color: C.secondary, fontSize: 11 }, nameLocation: 'middle', nameGap: 34, axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true }, splitLine: { lineStyle: { color: C.grid } } };
    b.yAxis = { type: 'category', data: catRows(m), inverse: true };
    delete b.legend;
    const col = (p: Participant) => (p.adherence < m.lo ? C.red : p.adherence > m.hi ? C.amber : C.pale);
    b.series = [
      {
        name: 'Acceptance band',
        type: 'line',
        data: [],
        markArea: { silent: true, itemStyle: { color: 'rgba(40,103,70,0.08)' }, data: [[{ xAxis: m.lo }, { xAxis: m.hi }]] },
      },
      {
        name: 'Adherence',
        type: 'bar',
        barWidth: 8,
        data: m.rows.map((p: Participant, i: number) => ({ value: [p.adherence, i], itemStyle: { color: col(p) }, desc: `${p.id}: ${p.adherence}%${p.adherence < m.lo ? ' · under-exposure (!)' : p.adherence > m.hi ? ' · above band (△)' : ' · within band'}` })),
        encode: { x: 0, y: 1 },
      },
      {
        name: 'Value tick',
        type: 'scatter',
        symbol: 'rect',
        symbolSize: [2, 16],
        data: m.rows.map((p: Participant, i: number) => ({ value: [p.adherence, i], desc: `${p.id}: ${p.adherence}%` })),
        encode: { x: 0, y: 1 },
        z: 3,
      },
    ];
    return b;
  },

  // pt4p1 剂量甘特 → 按状态×段序分槽的堆叠条
  pt4p1: (m) => {
    const b = keepFrame({});
    b.backgroundColor = '#fff';
    b.textStyle = { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, color: C.ink };
    b.color = [C.blue, C.purple, C.pale, C.gray, C.teal];
    b.tooltip = { trigger: 'item', renderMode: 'richText', confine: true };
    b.grid = { left: 14, right: 26, top: 42, bottom: 30, containLabel: true };
    b.xAxis = { type: 'value', name: 'Weeks on study', max: 48, nameTextStyle: { color: C.secondary, fontSize: 11 }, nameLocation: 'middle', nameGap: 34, axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true }, splitLine: { lineStyle: { color: C.grid } } };
    b.yAxis = { type: 'category', data: catRows(m), inverse: true };
    b.legend = { top: 4, type: 'scroll', textStyle: { color: C.secondary, fontSize: 11 }, itemWidth: 13, itemHeight: 8 };
    const segCol: Record<string, string> = { full: C.blue, reduced: C.amber, held: '#b98a8e' };
    const slots = new Map<string, Json[]>();
    m.rows.forEach((p: Participant, i: number) => {
      const perState: Record<string, number> = {};
      for (const s of p.doseSegs) {
        const k = `${s.state}#${perState[s.state] ?? 0}`;
        perState[s.state] = (perState[s.state] ?? 0) + 1;
        let arr = slots.get(k);
        if (!arr) {
          arr = Array(m.rows.length).fill(null);
          slots.set(k, arr);
        }
        arr[i] = { value: [Math.max(1, Math.min(s.to, 48) - s.from), i], desc: `${p.id}: ${s.state} wk${s.from}–${s.to}` };
      }
    });
    b.series = [...slots.entries()].map(([k, data]) => {
      const [state, occ] = k.split('#');
      return {
        name: occ === '0' ? { full: 'Full dose', reduced: 'Reduced', held: 'Held' }[state!] : `_${k}`,
        type: 'bar',
        stack: 'dose',
        barMaxWidth: 12,
        itemStyle: { color: segCol[state!] },
        data,
        encode: { y: 1, x: 0 },
      };
    });
    return b;
  },
};

export const REBUILD_IDS = Object.keys(REBUILD);
export function rebuildCustomOption(id: string, m: any): Json {
  const f = REBUILD[id];
  if (!f) throw new Error(`CUSTOM_REBUILD_UNSUPPORTED: ${id}`);
  return f(m);
}
