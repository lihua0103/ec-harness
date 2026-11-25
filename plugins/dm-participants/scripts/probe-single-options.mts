/** 8 张单人图的数据需求：每张图的轴/系列结构（判断需要什么形状的数据集）。 */
import { ptCtx } from '../src/participant-page.js';
import { ptOption } from '../src/participant-charts.js';
const ctx = ptCtx();
const ids = ['pt1p0', 'pt1p4', 'pt2p0', 'pt2p2', 'pt3p1', 'pt3p3', 'pt4p0', 'pt4p1'];
for (const id of ids) {
  const o = ptOption(id, ctx, 504) as Record<string, unknown>;
  const series = (o.series ?? []) as Record<string, unknown>[];
  const x = o.xAxis as Record<string, unknown> | undefined;
  const y = o.yAxis as Record<string, unknown> | undefined;
  const xd = Array.isArray(x?.data) ? (x!.data as unknown[]).length : 0;
  const yd = Array.isArray(y?.data) ? (y!.data as unknown[]).length : 0;
  const dataPts = series.reduce((n, s) => n + (Array.isArray(s.data) ? (s.data as unknown[]).length : 0), 0);
  console.log(`${id}: series=${series.length} types=${[...new Set(series.map((s) => String(s.type)))].join('+')} xData=${xd} yData=${yd} points=${dataPts}`);
}
