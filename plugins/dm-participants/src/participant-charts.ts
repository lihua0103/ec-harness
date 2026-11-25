/**
 * 参与者档案 18 张图表的构建器（数据驱动）：设计稿 participant-charts.js 的逐行 TS 移植。
 *
 * 输入是参与者行模型（buildPtModels 的产物），不是写死的静态数据；同一构建器
 * 既服务合成夹具（设计对齐验收），也服务「EDC rawdata→清洗→Excel→数据集」
 * 生产通道里的真实数据。option 数值只来自模型，不另行编造。
 */
import {
  CRIT,
  DCOL,
  DOMAIN,
  LABS,
  LABW,
  PT_THEME,
  PT_STATUS,
  VISITS,
  baseG,
  cellState,
  flagOf,
  labByKey,
  ptShort,
  worstG,
  worstVal,
  type Participant,
  type PtModels,
} from './participant-model.js';

type Json = Record<string, any>;
const C = PT_THEME;
const ST = PT_STATUS;
const short = ptShort;

const txt = { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, color: C.ink };
const vAxis = (name = ''): Json => ({ type: 'value', name, nameTextStyle: { color: C.secondary, fontSize: 11 }, nameLocation: 'middle', nameGap: 34, axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: C.grid } } });
const cAxis = (data: unknown[]): Json => ({ type: 'category', data, axisLabel: { color: C.secondary, fontSize: 11, hideOverlap: true, formatter: (v: unknown) => short(v, 20) }, axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false } });

function base(): Json {
  return {
    animation: false,
    backgroundColor: '#fff',
    color: [C.blue, C.purple, C.pale, C.gray, C.teal],
    textStyle: txt,
    aria: { enabled: true, label: { description: 'Synthetic participant analysis chart. Use the evidence table for accessible values.' } },
    tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
    grid: { left: 14, right: 26, top: 42, bottom: 30, containLabel: true },
    legend: { top: 4, type: 'scroll', textStyle: { color: C.secondary, fontSize: 11 }, itemWidth: 13, itemHeight: 8 },
    xAxis: vAxis(),
    yAxis: cAxis([]),
  };
}

interface MatrixCell { row: number; col: number; state: string; text: string; desc: string }

function statusMatrix(o: { rows: string[]; cols: string[]; cells: MatrixCell[]; rotate?: number }): Json {
  const b = base();
  delete b.legend;
  b.grid = { left: 12, right: 12, top: 40, bottom: 30, containLabel: true };
  b.xAxis = cAxis(o.cols);
  b.xAxis.position = 'top';
  b.xAxis.axisLabel.interval = 0;
  b.xAxis.axisLabel.rotate = o.rotate || 0;
  b.xAxis.axisLabel.formatter = (v: unknown) => short(v, 14);
  b.yAxis = cAxis(o.rows);
  b.yAxis.inverse = true;
  b.series = [
    {
      type: 'heatmap',
      data: o.cells.map((c) => ({
        value: [c.col, c.row, 0],
        t: c.text,
        desc: c.desc,
        itemStyle: {
          color: c.state === 'unknown' || c.state === 'notdue' ? C.unknown : (ST as any)[c.state].bg,
          borderColor: c.state === 'high' ? C.red : c.state === 'warning' ? C.amber : '#fff',
          borderWidth: c.state === 'high' || c.state === 'warning' ? 1.5 : 2,
        },
      })),
      label: { show: true, color: C.ink, fontSize: 11, formatter: (p: any) => p.data.t },
      emphasis: { itemStyle: { borderColor: C.teal, borderWidth: 2 } },
      tooltip: { formatter: (p: any) => p.data.desc },
    },
  ];
  return b;
}

export const F: Record<string, (m: any, w: number) => Json> = {};

// pt0p0 参与者 × 临床域信号矩阵
F.pt0p0 = (m, w) => {
  const cells: MatrixCell[] = [];
  m.rows.forEach((p: Participant, r: number) =>
    DOMAIN.forEach((d, c) => {
      const st = cellState(p, c);
      const sym = st === 'high' ? '! ' : st === 'warning' ? '△ ' : st === 'unknown' ? '? ' : '✓ ';
      cells.push({ row: r, col: c, state: st, text: sym + (st === 'unknown' ? '' : p.sig[c]), desc: `${p.id} · ${d}: ${st === 'unknown' ? 'unknown' : p.sig[c] + ' signal(s)'}` });
    }),
  );
  return statusMatrix({ rows: m.rows.map((p: Participant) => p.id), cols: DOMAIN, cells, rotate: w < 560 ? 25 : 0 });
};

// pt0p1 信号构成（按评审域堆叠）
F.pt0p1 = (m) => {
  const b = base();
  b.yAxis = cAxis(m.rows.map((p: Participant) => p.id));
  b.yAxis.inverse = true;
  b.xAxis = vAxis('Open signals');
  b.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, renderMode: 'richText', confine: true };
  b.series = DOMAIN.map((d, i) => ({ name: d, type: 'bar', stack: 'sig', barMaxWidth: 18, itemStyle: { color: DCOL[i] }, emphasis: { focus: 'series' }, data: m.rows.map((p: Participant) => p.sig[i] || null) }));
  return b;
};

// pt1p0 安全检验轨迹（8 名高风险 + 正常范围带）
F.pt1p0 = (m) => {
  const l = labByKey[m.analyte];
  const b = base();
  b.xAxis = cAxis(LABW.map((w) => 'W' + w));
  b.yAxis = vAxis(l.name + ' (' + l.unit + ')');
  b.tooltip = { trigger: 'axis', renderMode: 'richText', confine: true };
  const cols = [C.red, C.blue, C.purple, C.teal, C.amber, '#587d9f', C.gray, '#b98a8e'];
  b.series = m.rows.map((p: Participant, i: number) => ({
    name: p.id,
    type: 'line',
    symbol: 'circle',
    symbolSize: 6,
    connectNulls: false,
    lineStyle: { width: 2, color: cols[i % cols.length] },
    itemStyle: { color: cols[i % cols.length] },
    data: p.lab[m.analyte].map((x) => ({ value: x.v, g: x.g, itemStyle: x.g != null && x.g >= 3 ? { color: C.red, borderColor: '#fff', borderWidth: 1 } : undefined })),
    tooltip: { formatter: (pr: any) => `${p.id} · ${pr.name}: ${pr.value == null ? 'not collected' : pr.value + ' ' + l.unit}${pr.data && pr.data.g >= 3 ? ' · critical (!)' : ''}` },
  }));
  b.series.push({
    name: 'Normal range',
    type: 'line',
    data: [],
    markArea: { silent: true, itemStyle: { color: 'rgba(40,103,70,0.07)' }, label: { show: true, position: 'insideTop', color: C.green, fontSize: 10, formatter: 'normal ' + l.lo + '–' + l.hi }, data: [[{ yAxis: l.lo }, { yAxis: l.hi }]] },
  });
  return b;
};

// pt1p1 基线→最重毒性等级迁移表
F.pt1p1 = (m) => {
  const N = 5;
  const grid: number[][] = Array.from({ length: N }, () => Array(N).fill(0));
  let paired = 0;
  let unpaired = 0;
  m.rows.forEach((p: Participant) => {
    const bg = baseG(p, m.analyte);
    const wg = worstG(p, m.analyte);
    const hasFu = p.lab[m.analyte].some((x, i) => i > 0 && x.g != null);
    if (bg == null || !hasFu) {
      unpaired++;
      return;
    }
    paired++;
    grid[bg]![wg]!++;
  });
  const b = base();
  delete b.legend;
  b.grid = { left: 12, right: 12, top: 40, bottom: 34, containLabel: true };
  b.xAxis = cAxis(['0', '1', '2', '3', '4'].map((g) => 'Worst ' + g));
  b.xAxis.position = 'top';
  b.yAxis = cAxis(['0', '1', '2', '3', '4'].map((g) => 'Base ' + g));
  b.yAxis.inverse = true;
  const max = Math.max(1, ...grid.flat());
  const cells: Json[] = [];
  grid.forEach((row, r) =>
    row.forEach((v, c) => {
      if (!v) return;
      const worse = c > r;
      const better = c < r;
      const t = v / max;
      cells.push({
        value: [c, r, v],
        itemStyle: { color: worse ? `rgba(194,59,69,${0.15 + t * 0.6})` : better ? `rgba(31,95,168,${0.12 + t * 0.5})` : '#eef1f4', borderColor: '#fff', borderWidth: 2 },
        desc: `${labByKey[m.analyte].name}: base grade ${r} → worst ${c}: ${v} participants${worse ? ' (worsening)' : better ? ' (improving)' : ''}`,
      });
    }),
  );
  b.series = [{ type: 'heatmap', data: cells, label: { show: true, color: C.ink, fontSize: 12, formatter: (p: any) => p.value[2] }, tooltip: { formatter: (p: any) => p.data.desc } }];
  b.graphic = [{ type: 'text', right: 14, top: 8, style: { text: `${paired} paired · ${unpaired} unpaired`, fill: C.secondary, fontSize: 10 } }];
  return b;
};

// pt1p2 临床显著检验矩阵（参与者 × 分析物）
F.pt1p2 = (m, w) => {
  const cells: MatrixCell[] = [];
  m.rows.forEach((p: Participant, r: number) =>
    LABS.forEach((l, c) => {
      const wg = worstG(p, l.key);
      const due = p.lab[l.key].some((x) => x.flag !== 'notdue');
      const st = !due ? 'notdue' : p.unknownDomains.includes('lab') ? 'unknown' : flagOf(wg);
      const wv = worstVal(p, l.key);
      const sym = st === 'high' ? '! ' : st === 'warning' ? '△ ' : st === 'normal' ? '✓ ' : st === 'notdue' ? '— ' : '? ';
      cells.push({ row: r, col: c, state: st, text: sym + (wv == null ? '' : wv), desc: `${p.id} · ${l.name}: worst grade ${wg} (${st})${wv == null ? '' : ', worst ' + wv + ' ' + l.unit}` });
    }),
  );
  return statusMatrix({ rows: m.rows.map((p: Participant) => p.id), cols: LABS.map((l) => l.name), cells, rotate: w < 560 ? 25 : 0 });
};

// pt1p3 AE 负荷（等级带堆叠 + SAE 菱形）
F.pt1p3 = (m) => {
  const b = base();
  b.yAxis = cAxis(m.rows.map((x: any) => x.p.id));
  b.yAxis.inverse = true;
  b.xAxis = vAxis('AE events');
  b.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, renderMode: 'richText', confine: true };
  b.series = [
    { name: 'Grade 1–2', type: 'bar', stack: 'ae', barMaxWidth: 18, itemStyle: { color: C.pale }, data: m.rows.map((x: any) => x.g12 || null) },
    { name: 'Grade 3', type: 'bar', stack: 'ae', barMaxWidth: 18, itemStyle: { color: C.amber }, data: m.rows.map((x: any) => x.g3 || null) },
    { name: 'Grade 4', type: 'bar', stack: 'ae', barMaxWidth: 18, itemStyle: { color: C.red }, data: m.rows.map((x: any) => x.g4 || null) },
    {
      name: 'SAE (any)',
      type: 'scatter',
      symbol: 'diamond',
      symbolSize: 11,
      itemStyle: { color: C.red, borderColor: '#fff', borderWidth: 1 },
      data: m.rows.map((x: any, i: number) => (x.sae ? { value: [x.g12 + x.g3 + x.g4 + 0.4, i], desc: x.p.id + ' has a serious AE' } : null)),
      tooltip: { formatter: (p: any) => p.data.desc },
    },
  ];
  return b;
};

// pt1p4 AE 发生 vs 给药时间线（custom renderItem）
F.pt1p4 = (m) => {
  const b = base();
  delete b.legend;
  b.yAxis = cAxis(m.rows.map((p: Participant) => p.id));
  b.yAxis.inverse = true;
  b.xAxis = vAxis('Weeks on study');
  b.xAxis.max = 48;
  b.series = [
    {
      type: 'custom',
      renderItem: (params: any, api: any) => {
        const i = api.value(0);
        const p: Participant = m.rows[i];
        const y = api.coord([0, i])[1];
        const x0 = api.coord([0, i])[0];
        const xe = api.coord([Math.min(p.weeks, 48), i])[0];
        const ch: Json[] = [{ type: 'rect', shape: { x: x0, y: y - 7, width: xe - x0, height: 14 }, style: { fill: 'rgba(31,95,168,0.07)' } }];
        for (const a of p.aes) {
          const x = api.coord([a.wk, i])[0];
          const r = 3 + a.grade * 2;
          ch.push({ type: 'circle', shape: { cx: x, cy: y, r }, style: { fill: a.grade >= 3 ? C.amber : C.pale, stroke: a.serious ? C.red : '#fff', lineWidth: a.serious ? 2.5 : 1 } });
        }
        return { type: 'group', children: ch };
      },
      data: m.rows.map((p: Participant, i: number) => ({ value: [i, p.weeks], desc: `${p.id}: ${p.aes.map((a) => `wk${a.wk} G${a.grade}${a.serious ? ' SAE' : ''} ${a.term}`).join(' · ')}` })),
      encode: { x: 1, y: 0 },
      tooltip: { formatter: (p: any) => p.data.desc },
    },
    {
      type: 'custom',
      silent: true,
      renderItem: (params: any, api: any) => {
        const a = api.coord([m.escalation, 0]);
        const z = api.coord([m.escalation, m.rows.length - 1]);
        return {
          type: 'group',
          children: [
            { type: 'line', shape: { x1: a[0], y1: a[1] - 10, x2: z[0], y2: z[1] + 10 }, style: { stroke: C.gray, lineDash: [4, 3], lineWidth: 1 } },
            { type: 'text', style: { x: a[0] + 4, y: a[1] - 12, text: 'dose escalation (demo)', fill: C.secondary, fontSize: 9 } },
          ],
        };
      },
      data: [[m.escalation]],
      encode: { x: 0 },
      tooltip: { show: false },
    },
  ];
  return b;
};

// pt2p0 知情同意→随机化间隔（custom 哑铃）
F.pt2p0 = (m) => {
  const b = base();
  delete b.legend;
  b.yAxis = cAxis(m.rows.map((p: Participant) => p.id));
  b.yAxis.inverse = true;
  b.xAxis = vAxis('Days from randomization');
  b.xAxis.max = 2;
  b.xAxis.min = -40;
  b.grid.right = 40;
  const flag = (p: Participant) => (p.procBefore || p.consentGap === 0 ? 'high' : p.consentGap > 28 ? 'warning' : 'normal');
  b.series = [
    {
      type: 'custom',
      renderItem: (params: any, api: any) => {
        const i = api.value(0);
        const start = api.value(1);
        const st = api.value(3);
        const a = api.coord([start, i]);
        const z = api.coord([0, i]);
        const col = st === 2 ? C.red : st === 1 ? C.amber : C.pale;
        return {
          type: 'group',
          children: [
            { type: 'line', shape: { x1: a[0], y1: a[1], x2: z[0], y2: z[1] }, style: { stroke: col, lineWidth: 3 } },
            { type: 'circle', shape: { cx: a[0], cy: a[1], r: 4 }, style: { fill: col, stroke: '#fff', lineWidth: 1 } },
            { type: 'polygon', shape: { points: [[z[0], z[1] - 5], [z[0] + 5, z[1]], [z[0], z[1] + 5], [z[0] - 5, z[1]]] }, style: { fill: C.blue, stroke: '#fff', lineWidth: 1 } },
          ],
        };
      },
      data: m.rows.map((p: Participant, i: number) => ({
        value: [i, -p.consentGap, 0, flag(p) === 'high' ? 2 : flag(p) === 'warning' ? 1 : 0],
        desc: `${p.id}: consent ${p.consentGap} d before randomization${p.procBefore ? ' · procedure before consent (!)' : ''}${p.consentGap === 0 ? ' · same-day (!)' : ''}${p.consentGap > 28 ? ' · >28 d re-consent (△)' : ''}`,
      })),
      encode: { x: [1, 2], y: 0 },
      tooltip: { formatter: (p: any) => p.data.desc },
    },
  ];
  b.dataZoom = [
    { type: 'slider', yAxisIndex: 0, right: 0, width: 10, start: 0, end: Math.min(100, (12 / m.rows.length) * 100), filterMode: 'none', showDetail: false },
    { type: 'inside', yAxisIndex: 0, filterMode: 'none' },
  ];
  return b;
};

// pt2p1 入选标准偏离矩阵
F.pt2p1 = (m, w) => {
  const cells: MatrixCell[] = [];
  m.rows.forEach((p: Participant, r: number) =>
    CRIT.forEach((cr, c) => {
      const e = p.elig.find((x) => x.c === c);
      const st = !e ? 'normal' : e.s === 'violated' ? 'high' : e.s === 'waiver' ? 'warning' : 'unknown';
      const sym = st === 'high' ? '! ' : st === 'warning' ? '△ ' : st === 'unknown' ? '? ' : '✓ ';
      const label = !e ? 'Met' : e.s === 'violated' ? 'Violated' : e.s === 'waiver' ? 'Waiver' : 'N/A';
      cells.push({ row: r, col: c, state: st, text: sym + label, desc: `${p.id} · ${cr}: ${label}` });
    }),
  );
  return statusMatrix({ rows: m.rows.map((p: Participant) => p.id), cols: CRIT, cells, rotate: w < 620 ? 35 : 0 });
};

// pt2p2 访问轨迹泳道（custom）
F.pt2p2 = (m) => {
  const b = base();
  b.yAxis = cAxis(m.rows.map((p: Participant) => p.id));
  b.yAxis.inverse = true;
  b.xAxis = vAxis('Weeks on study');
  b.xAxis.max = 52;
  delete b.legend;
  b.series = [
    {
      type: 'custom',
      renderItem: (params: any, api: any) => {
        const i = api.value(0);
        const p: Participant = m.rows[i];
        const y = api.coord([0, i])[1];
        const end = api.coord([Math.min(p.weeks, 52), i])[0];
        const x0 = api.coord([0, i])[0];
        const ch: Json[] = [{ type: 'line', shape: { x1: x0, y1: y, x2: end, y2: y }, style: { stroke: p.status === 'withdrawn' ? C.gray : C.unknown, lineWidth: 3 } }];
        for (const wk of VISITS) {
          const v = p.visits[wk]!;
          if (v.state === 'notdue') continue;
          const x = api.coord([wk, i])[0];
          if (v.state === 'missed') {
            ch.push({ type: 'line', shape: { x1: x - 4, y1: y - 4, x2: x + 4, y2: y + 4 }, style: { stroke: C.red, lineWidth: 2 } });
            ch.push({ type: 'line', shape: { x1: x - 4, y1: y + 4, x2: x + 4, y2: y - 4 }, style: { stroke: C.red, lineWidth: 2 } });
          } else if (v.state === 'done') {
            const oow = Math.abs(v.dev ?? 0) > 7;
            ch.push({ type: 'circle', shape: { cx: x, cy: y, r: 4.5 }, style: { fill: oow ? C.amber : C.blue, stroke: '#fff', lineWidth: 1 } });
          } else {
            ch.push({ type: 'circle', shape: { cx: x, cy: y, r: 4.5 }, style: { fill: '#fff', stroke: C.pale, lineWidth: 1.5 } });
          }
        }
        if (p.status === 'withdrawn') ch.push({ type: 'line', shape: { x1: end, y1: y - 7, x2: end, y2: y + 7 }, style: { stroke: C.gray, lineWidth: 2 } });
        return { type: 'group', children: ch };
      },
      data: m.rows.map((p: Participant, i: number) => ({ value: [i, p.weeks], desc: `${p.id} · ${p.status} · ${VISITS.filter((w) => p.visits[w]!.state === 'done').length} done, ${VISITS.filter((w) => p.visits[w]!.state === 'missed').length} missed${p.status === 'withdrawn' ? ' · withdrew week ' + p.exitWk : ''}` })),
      encode: { x: 1, y: 0 },
      tooltip: { formatter: (p: any) => p.data.desc },
    },
  ];
  return b;
};

// pt3p0 关键评估完成度矩阵
F.pt3p0 = (m) => {
  const cells: MatrixCell[] = [];
  m.rows.forEach((p: Participant, r: number) =>
    VISITS.forEach((wk, c) => {
      const v = p.visits[wk]!;
      let st: string;
      let label: string;
      if (v.state === 'notdue') {
        st = 'notdue';
        label = '— Not due';
      } else if (p.endpoint[wk] === 'missing' || v.state === 'missed') {
        st = 'high';
        label = '! Missing';
      } else if (p.endpoint[wk] === 'unknown') {
        st = 'unknown';
        label = '? Unknown';
      } else {
        st = 'normal';
        label = '✓ Done';
      }
      cells.push({ row: r, col: c, state: st, text: label, desc: `${p.id} · Week ${wk} key assessment: ${label}` });
    }),
  );
  return statusMatrix({ rows: m.rows.map((p: Participant) => p.id), cols: VISITS.map((v) => 'Week ' + v), cells });
};

// pt3p1 缺失关键检验（分析物 × 访问）
F.pt3p1 = (m) => {
  const b = base();
  delete b.legend;
  b.grid = { left: 12, right: 12, top: 40, bottom: 34, containLabel: true };
  b.xAxis = cAxis(VISITS.map((w) => 'Week ' + w));
  b.xAxis.position = 'top';
  b.yAxis = cAxis(LABS.map((l) => l.name));
  b.yAxis.inverse = true;
  const cells: Json[] = [];
  let max = 1;
  LABS.forEach((l, r) =>
    VISITS.forEach((wk, c) => {
      const dueP = m.rows.filter((p: Participant) => p.weeks >= wk);
      const miss = dueP.filter((p: Participant) => {
        const x = p.lab[l.key].find((z) => z.wk === wk);
        return !x || x.v == null;
      }).length;
      max = Math.max(max, miss);
      cells.push({ value: [c, r, miss], due: dueP.length, desc: `${l.name} · Week ${wk}: ${miss}/${dueP.length} due missing` });
    }),
  );
  b.series = [
    {
      type: 'heatmap',
      data: cells.map((c) => ({ ...c, itemStyle: { color: c.value[2] === 0 ? '#f0f7f3' : `rgba(156,109,28,${0.15 + ((c.value[2] as number) / max) * 0.6})`, borderColor: '#fff', borderWidth: 2 } })),
      label: { show: true, color: C.ink, fontSize: 11, formatter: (p: any) => p.data.value[2] + '/' + p.data.due },
      tooltip: { formatter: (p: any) => p.data.desc },
    },
  ];
  return b;
};

// pt3p2 未关闭质疑负担与老化（custom 棒棒糖）
F.pt3p2 = (m) => {
  const b = base();
  delete b.legend;
  b.yAxis = cAxis(m.rows.map((p: Participant) => p.id));
  b.yAxis.inverse = true;
  b.xAxis = vAxis('Open queries');
  b.grid.right = 70;
  const ageCol = (p: Participant) => (p.queries.oldest > 30 ? C.red : p.queries.oldest > 14 ? C.amber : C.pale);
  b.series = [
    {
      type: 'custom',
      silent: true,
      renderItem: (params: any, api: any) => {
        const i = api.value(0);
        const v = api.value(1);
        const a = api.coord([0, i]);
        const z = api.coord([v, i]);
        return { type: 'line', shape: { x1: a[0], y1: a[1], x2: z[0], y2: z[1] }, style: { stroke: C.unknown, lineWidth: 2 } };
      },
      data: m.rows.map((p: Participant, i: number) => [i, p.queries.open]),
      encode: { x: 1, y: 0 },
    },
    {
      type: 'scatter',
      symbolSize: 11,
      data: m.rows.map((p: Participant, i: number) => ({ value: [p.queries.open, i], itemStyle: { color: ageCol(p) }, desc: `${p.id}: ${p.queries.open} open · oldest ${p.queries.oldest} d` })),
      label: { show: true, position: 'right', fontSize: 10, color: C.secondary, formatter: (p: any) => `${m.rows[p.dataIndex].queries.open} · ${m.rows[p.dataIndex].queries.oldest}d` },
      tooltip: { formatter: (p: any) => p.data.desc },
    },
  ];
  return b;
};

// pt3p3 ePRO 日记完成度 · 最近 12 周（custom 方块）
F.pt3p3 = (m) => {
  const b = base();
  b.yAxis = cAxis(m.rows.map((p: Participant) => p.id));
  b.yAxis.inverse = true;
  b.xAxis = vAxis('Due week (last 12)');
  b.xAxis.min = -0.5;
  b.xAxis.max = 11.5;
  b.xAxis.axisLabel = { show: false };
  b.xAxis.splitLine = { show: false };
  b.legend.data = ['Complete', 'Partial', 'Missed', 'Not due'];
  const col: Record<string, string> = { full: C.blue, partial: C.amber, missed: '#fff', notdue: C.unknown };
  b.series = [
    {
      type: 'custom',
      renderItem: (params: any, api: any) => {
        const i = api.value(0);
        const p: Participant = m.rows[i];
        const y = api.coord([0, i])[1];
        const ch: Json[] = [];
        p.epro.forEach((s, k) => {
          const x = api.coord([k, i])[0];
          ch.push({ type: 'rect', shape: { x: x - 6, y: y - 6, width: 12, height: 12, r: 2 }, style: { fill: col[s], stroke: s === 'missed' ? C.red : '#fff', lineWidth: s === 'missed' ? 1.5 : 1 } });
        });
        return { type: 'group', children: ch };
      },
      data: m.rows.map((p: Participant, i: number) => ({ value: [i, 0], desc: `${p.id}: ${p.epro.filter((x) => x === 'full').length} complete · ${p.epro.filter((x) => x === 'missed').length} missed` })),
      encode: { x: 1, y: 0 },
      tooltip: { formatter: (p: any) => p.data.desc },
    },
    ...['full', 'partial', 'missed', 'notdue'].map((s, i) => ({
      name: ['Complete', 'Partial', 'Missed', 'Not due'][i],
      type: 'bar',
      data: [] as unknown[],
      itemStyle: { color: col[s], borderColor: s === 'missed' ? C.red : undefined, borderWidth: s === 'missed' ? 1 : 0 },
    })),
  ];
  return b;
};

// pt3p4 eGFR 均值 vs 组内 SD（离群/过稳审查）
F.pt3p4 = (m) => {
  const b = base();
  delete b.legend;
  b.xAxis = vAxis('Within-participant SD of eGFR');
  b.yAxis = vAxis('Mean eGFR');
  b.grid.left = 52;
  const sds = m.rows.map((x: any) => x.ms.sd);
  const med = [...sds].sort((a: number, c: number) => a - c)[Math.floor(sds.length / 2)] || 1;
  const inlier = med * 0.25;
  b.series = [
    {
      type: 'scatter',
      symbolSize: 9,
      data: m.rows.map((x: any) => ({
        value: [x.ms.sd, x.ms.mean],
        itemStyle: { color: x.ms.sd < inlier ? C.amber : x.ms.sd > med * 2.5 ? C.red : C.blue },
        desc: `${x.p.id}: mean eGFR ${x.ms.mean}, SD ${x.ms.sd} (n=${x.ms.n})${x.ms.sd < inlier ? ' · unusually low variance, inlier review (△)' : x.ms.sd > med * 2.5 ? ' · high variance (!)' : ''}`,
      })),
      tooltip: { formatter: (p: any) => p.data.desc },
      markLine: { silent: true, symbol: 'none', label: { formatter: 'demo inlier limit', fontSize: 9, color: C.amber }, lineStyle: { color: C.amber, type: 'dashed' }, data: [{ xAxis: inlier }] },
    },
  ];
  return b;
};

// pt4p0 依从性 vs 可接受带（custom 子弹图）
F.pt4p0 = (m) => {
  const b = base();
  delete b.legend;
  b.yAxis = cAxis(m.rows.map((p: Participant) => p.id));
  b.yAxis.inverse = true;
  b.xAxis = vAxis('Adherence (%)');
  b.xAxis.max = 140;
  b.grid.right = 40;
  b.series = [
    {
      type: 'custom',
      renderItem: (params: any, api: any) => {
        const i = api.value(0);
        const adh = api.value(1);
        const y = api.coord([0, i])[1];
        const x0 = api.coord([0, i])[0];
        const xa = api.coord([adh, i])[0];
        const bl = api.coord([m.lo, i])[0];
        const bh = api.coord([m.hi, i])[0];
        const out = adh < m.lo || adh > m.hi;
        const col = adh < m.lo ? C.red : adh > m.hi ? C.amber : C.pale;
        return {
          type: 'group',
          children: [
            { type: 'rect', shape: { x: bl, y: y - 8, width: bh - bl, height: 16 }, style: { fill: 'rgba(40,103,70,0.08)' } },
            { type: 'rect', shape: { x: x0, y: y - 4, width: Math.max(0, xa - x0), height: 8 }, style: { fill: col } },
            { type: 'line', shape: { x1: xa, y1: y - 8, x2: xa, y2: y + 8 }, style: { stroke: out ? col : C.blue, lineWidth: 2 } },
          ],
        };
      },
      data: m.rows.map((p: Participant, i: number) => ({ value: [i, p.adherence], desc: `${p.id}: ${p.adherence}%${p.adherence < m.lo ? ' · under-exposure (!)' : p.adherence > m.hi ? ' · above band (△)' : ' · within band'}` })),
      encode: { x: 1, y: 0 },
      tooltip: { formatter: (p: any) => p.data.desc },
    },
  ];
  b.dataZoom = [
    { type: 'slider', yAxisIndex: 0, right: 0, width: 10, start: 0, end: Math.min(100, (12 / m.rows.length) * 100), filterMode: 'none', showDetail: false },
    { type: 'inside', yAxisIndex: 0, filterMode: 'none' },
  ];
  return b;
};

// pt4p1 剂量调整史（custom 分段甘特）
F.pt4p1 = (m) => {
  const b = base();
  b.yAxis = cAxis(m.rows.map((p: Participant) => p.id));
  b.yAxis.inverse = true;
  b.xAxis = vAxis('Weeks on study');
  b.xAxis.max = 48;
  b.legend.data = ['Full dose', 'Reduced', 'Held'];
  const segCol: Record<string, string> = { full: C.blue, reduced: C.amber, held: '#b98a8e' };
  b.series = [
    {
      type: 'custom',
      renderItem: (params: any, api: any) => {
        const i = api.value(0);
        const p: Participant = m.rows[i];
        const y = api.coord([0, i])[1];
        const ch: Json[] = [];
        for (const s of p.doseSegs) {
          const a = api.coord([s.from, i])[0];
          const z = api.coord([Math.min(s.to, 48), i])[0];
          ch.push({ type: 'rect', shape: { x: a, y: y - 6, width: Math.max(1, z - a), height: 12 }, style: { fill: segCol[s.state], stroke: '#fff', lineWidth: 1 } });
        }
        return { type: 'group', children: ch };
      },
      data: m.rows.map((p: Participant, i: number) => ({ value: [i, 0], desc: `${p.id}: ${p.doseSegs.map((s) => `${s.state} wk${s.from}–${s.to}`).join(' · ')}` })),
      encode: { x: 1, y: 0 },
      tooltip: { formatter: (p: any) => p.data.desc },
    },
    ...['full', 'reduced', 'held'].map((s, i) => ({
      name: ['Full dose', 'Reduced', 'Held'][i],
      type: 'bar',
      data: [] as unknown[],
      itemStyle: { color: segCol[s] },
    })),
  ];
  return b;
};

// pt4p2 药片清点 vs 日记对账
F.pt4p2 = (m) => {
  const b = base();
  delete b.legend;
  b.xAxis = vAxis('Pill-count taken');
  b.yAxis = vAxis('Diary-reported taken');
  b.grid.left = 52;
  const xs = [100, 180];
  b.series = [
    { type: 'line', silent: true, showSymbol: false, lineStyle: { color: C.gray, type: 'dashed', width: 1 }, data: xs.map((x) => [x, x]), tooltip: { show: false } },
    { type: 'line', silent: true, showSymbol: false, lineStyle: { color: C.grid, width: 1 }, data: xs.map((x) => [x, 0.9 * x]), tooltip: { show: false } },
    { type: 'line', silent: true, showSymbol: false, lineStyle: { color: C.grid, width: 1 }, data: xs.map((x) => [x, 1.1 * x]), tooltip: { show: false } },
    {
      type: 'scatter',
      symbolSize: 9,
      data: m.points.map((p: { id: string; count: number; diary: number }) => {
        const dev = Math.abs(p.count - p.diary) / Math.max(1, p.count);
        return { value: [p.count, p.diary], itemStyle: { color: dev > 0.1 ? C.red : C.blue }, desc: `${p.id}: count ${p.count} vs diary ${p.diary} · ${Math.round(dev * 100)}% discrepancy${dev > 0.1 ? ' (!)' : ''}` };
      }),
      tooltip: { formatter: (p: any) => p.data.desc },
    },
  ];
  return b;
};

export const PT_CHART_IDS = ['pt0p0', 'pt0p1', 'pt1p0', 'pt1p1', 'pt1p2', 'pt1p3', 'pt1p4', 'pt2p0', 'pt2p1', 'pt2p2', 'pt3p0', 'pt3p1', 'pt3p2', 'pt3p3', 'pt3p4', 'pt4p0', 'pt4p1', 'pt4p2'] as const;
export type PtChartId = (typeof PT_CHART_IDS)[number];

// 每张图的说明 / 状态 / 证据表（设计稿 META 的移植）
export interface PtMetaCtx { M: PtModels; P: Participant[] }

export const META: Record<PtChartId, { cap: (ctx: PtMetaCtx) => string; state: (ctx: PtMetaCtx) => 'high' | 'warning'; ev: (m: any, ctx: PtMetaCtx) => { h: string[]; rows: unknown[][] } }> = {
  pt0p0: {
    cap: (c) => `${c.M.pt0p0.rows.length} of 24 participants · 4 clinical review domains`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', ...DOMAIN, 'Total'], rows: m.rows.map((p: Participant) => [p.id, ...p.sig, p.total]) }),
  },
  pt0p1: {
    cap: (c) => `${c.M.pt0p1.rows.length} participants with open signals · counts by domain, no composite score`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', ...DOMAIN], rows: m.rows.map((p: Participant) => [p.id, ...p.sig]) }),
  },
  pt1p0: {
    cap: (c) => `${labByKey[c.M.pt1p0.analyte].name} trajectories · 8 highest-risk · green band = normal range`,
    state: (c) => (c.P.some((p) => p.labCrit) ? 'high' : 'warning'),
    ev: (m, c) => ({ h: ['Participant', 'Baseline', 'Worst', 'Worst grade'], rows: m.rows.map((p: Participant) => [p.id, p.lab[m.analyte][0]!.v, worstVal(p, m.analyte), worstG(p, m.analyte)]) }),
  },
  pt1p1: {
    cap: (c) => `${labByKey[c.M.pt1p1.analyte].name} baseline→worst grade shift · paired only`,
    state: () => 'warning',
    ev: (m, c) => ({ h: ['Participant', 'Base grade', 'Worst grade'], rows: m.rows.filter((p: Participant) => baseG(p, c.M.pt1p1.analyte) != null).map((p: Participant) => [p.id, baseG(p, c.M.pt1p1.analyte), worstG(p, c.M.pt1p1.analyte)]) }),
  },
  pt1p2: {
    cap: (c) => `${c.M.pt1p2.rows.length} participants × 5 analytes · worst on-treatment flag`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', ...LABS.map((l) => l.name + ' grade')], rows: m.rows.map((p: Participant) => [p.id, ...LABS.map((l) => worstG(p, l.key))]) }),
  },
  pt1p3: {
    cap: (c) => `${c.M.pt1p3.rows.length} highest-load participants · ${c.P.filter((p) => p.aes.some((a) => a.serious)).length} with SAE study-wide`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', 'G1–2', 'G3', 'G4', 'SAE'], rows: m.rows.map((x: any) => [x.p.id, x.g12, x.g3, x.g4, x.sae ? 'Yes' : 'No']) }),
  },
  pt1p4: {
    cap: (c) => `${c.M.pt1p4.rows.length} participants · dose-escalation reference week 14 (demo)`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', 'Onsets'], rows: m.rows.map((p: Participant) => [p.id, p.aes.map((a) => `w${a.wk} G${a.grade}${a.serious ? ' SAE' : ''}`).join(', ')]) }),
  },
  pt2p0: {
    cap: (c) => `24 participants · ${c.P.filter((p) => p.procBefore || p.consentGap === 0).length} same-day/procedure flag · ${c.P.filter((p) => p.consentGap > 28).length} >28 d`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', 'Consent gap (d)', 'Flag'], rows: m.rows.map((p: Participant) => [p.id, p.consentGap, p.procBefore || p.consentGap === 0 ? '! same-day/procedure' : p.consentGap > 28 ? '△ >28 d' : '✓']) }),
  },
  pt2p1: {
    cap: (c) => `${c.M.pt2p1.rows.length} participants with exceptions · 6 criteria · waived ≠ violated`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', 'Criterion', 'State'], rows: m.rows.flatMap((p: Participant) => p.elig.map((e) => [p.id, CRIT[e.c]!, e.s])) }),
  },
  pt2p2: {
    cap: (c) => `${c.M.pt2p2.rows.length} trajectories · ${c.P.filter((p) => p.status === 'withdrawn').length} withdrawals study-wide · × = missed`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', 'Status', 'Done', 'Missed', 'Out-of-window'], rows: m.rows.map((p: Participant) => [p.id, p.status, VISITS.filter((w) => p.visits[w]!.state === 'done').length, VISITS.filter((w) => p.visits[w]!.state === 'missed').length, VISITS.filter((w) => p.visits[w]!.state === 'done' && Math.abs(p.visits[w]!.dev ?? 0) > 7).length]) }),
  },
  pt3p0: {
    cap: (c) => `${c.M.pt3p0.rows.length} participants × 4 key visits · not due ≠ missing`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', ...VISITS.map((w) => 'W' + w)], rows: m.rows.map((p: Participant) => [p.id, ...VISITS.map((w) => (p.visits[w]!.state === 'notdue' ? '— not due' : p.endpoint[w] === 'missing' || p.visits[w]!.state === 'missed' ? '! missing' : p.endpoint[w] === 'unknown' ? '? unknown' : '✓ done'))]) }),
  },
  pt3p1: {
    cap: () => `Missing key labs · cell = missing/due · amber intensity = burden`,
    state: () => 'warning',
    ev: (m) => ({ h: ['Analyte', ...VISITS.map((w) => 'W' + w + ' miss/due')], rows: LABS.map((l) => [l.name, ...VISITS.map((wk) => { const due = m.rows.filter((p: Participant) => p.weeks >= wk); const miss = due.filter((p: Participant) => { const x = p.lab[l.key].find((z) => z.wk === wk); return !x || x.v == null; }).length; return miss + '/' + due.length; })]) }),
  },
  pt3p2: {
    cap: (c) => `${c.M.pt3p2.rows.length} participants with open queries · colour = oldest age band`,
    state: () => 'warning',
    ev: (m) => ({ h: ['Participant', 'Open', 'Oldest (d)'], rows: m.rows.map((p: Participant) => [p.id, p.queries.open, p.queries.oldest]) }),
  },
  pt3p3: {
    cap: (c) => `${c.M.pt3p3.rows.length} participants · last 12 due weeks · one square = one week`,
    state: () => 'warning',
    ev: (m) => ({ h: ['Participant', 'Complete', 'Partial', 'Missed', 'Not due'], rows: m.rows.map((p: Participant) => [p.id, p.epro.filter((x) => x === 'full').length, p.epro.filter((x) => x === 'partial').length, p.epro.filter((x) => x === 'missed').length, p.epro.filter((x) => x === 'notdue').length]) }),
  },
  pt3p4: {
    cap: (c) => `${c.M.pt3p4.rows.length} participants · eGFR mean vs within-person SD · low SD = inlier review`,
    state: () => 'warning',
    ev: (m) => ({ h: ['Participant', 'Mean eGFR', 'SD', 'n'], rows: m.rows.map((x: any) => [x.p.id, x.ms.mean, x.ms.sd, x.ms.n]) }),
  },
  pt4p0: {
    cap: (c) => `24 participants · ${c.P.filter((p) => p.adherence < 80).length} below 80% · ${c.P.filter((p) => p.adherence > 120).length} above 120% (demo band)`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', 'Adherence %', 'Band'], rows: m.rows.map((p: Participant) => [p.id, p.adherence, p.adherence < 80 ? '! below' : p.adherence > 120 ? '△ above' : '✓ within']) }),
  },
  pt4p1: {
    cap: (c) => `${c.M.pt4p1.rows.length} participants · ${c.P.filter((p) => p.doseSegs.some((s) => s.state !== 'full')).length} with dose modifications`,
    state: () => 'warning',
    ev: (m) => ({ h: ['Participant', 'Dose states'], rows: m.rows.map((p: Participant) => [p.id, p.doseSegs.map((s) => `${s.state} ${s.from}–${s.to}`).join('; ')]) }),
  },
  pt4p2: {
    cap: (c) => `24 participants · ${c.M.pt4p2.points.filter((p: { count: number; diary: number }) => Math.abs(p.count - p.diary) / p.count > 0.1).length} outside ±10% agreement`,
    state: () => 'high',
    ev: (m) => ({ h: ['Participant', 'Count', 'Diary', 'Discrepancy'], rows: m.points.map((p: { id: string; count: number; diary: number }) => [p.id, p.count, p.diary, Math.round((Math.abs(p.count - p.diary) / p.count) * 100) + '%']) }),
  },
};

/** 设计稿 option(id, w) 包装的移植：宽度分支、超长类目滚动、空态。 */
export function ptOption(id: string, ctx: PtMetaCtx, w: number): Json | null {
  const f = F[id];
  if (!f) return null;
  const o = f(ctx.M[id as keyof PtModels], w);
  if (o.xAxis?.type === 'value') o.xAxis.splitNumber = w < 480 ? 3 : 5;
  if (o.yAxis?.type === 'category' && (o.yAxis.data?.length ?? 0) > 12 && !o.dataZoom) {
    const n = o.yAxis.data.length;
    o.dataZoom = [
      { type: 'slider', yAxisIndex: 0, right: 0, width: 10, start: 0, end: Math.min(100, (12 / n) * 100), filterMode: 'none', showDetail: false },
      { type: 'inside', yAxisIndex: 0, filterMode: 'none' },
    ];
    o.grid.right = Math.max(o.grid.right || 0, 45);
  }
  if (w < 480 && o.legend) {
    o.legend = { ...o.legend, type: 'plain', width: Math.max(140, w - 24), left: 6, itemGap: 8, itemWidth: 9, itemHeight: 6, textStyle: { ...o.legend.textStyle, fontSize: 9 }, formatter: (n: unknown) => short(n, 12) };
    o.grid.top = Math.max(o.grid.top || 0, 54);
  }
  const m = ctx.M[id as PtChartId];
  const empty = (m && 'rows' in m && m.rows && !m.rows.length) || (m && 'points' in m && m.points && !m.points.length);
  if (empty) {
    o.series = [];
    o.graphic = [{ type: 'text', left: 'center', top: 'middle', style: { text: 'No participants match the current filters', fill: C.secondary, fontSize: 12 } }];
  }
  return o;
}
