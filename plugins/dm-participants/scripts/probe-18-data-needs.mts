/** 18 张图各自需要的「单人视图」数据形状。 */
import { ptCtx } from '../src/participant-page.js';
import { ptOption } from '../src/participant-charts.js';
import { PT_CHART_IDS } from '../src/participant-charts.js';
const ctx = ptCtx();
for (const id of PT_CHART_IDS) {
  const o = ptOption(id, ctx, 504) as Record<string, any>;
  const s = (o.series ?? []) as Record<string, any>[];
  const t = [...new Set(s.map((x) => String(x.type)))].join('+');
  const xd = Array.isArray(o.xAxis?.data) ? o.xAxis.data.length : 0;
  const yd = Array.isArray(o.yAxis?.data) ? o.yAxis.data.length : 0;
  const pts = s.reduce((n, x) => n + (Array.isArray(x.data) ? x.data.length : 0), 0);
  console.log(`${id}: ${t} series=${s.length} x=${xd} y=${yd} pts=${pts}`);
}
