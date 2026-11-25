/** 输出设计稿 18 张图的 option 摘要（类型/系列数/结构），判断能否直接落成动态图。 */
import { ptCtx } from '../src/participant-page.js';
import { ptOption } from '../src/participant-charts.js';
import { PT_CHART_IDS } from '../src/participant-charts.js';
const ctx = ptCtx();
for (const id of PT_CHART_IDS) {
  const o = ptOption(id, ctx, 504) as Record<string, unknown>;
  const series = (o.series ?? []) as Record<string, unknown>[];
  const types = [...new Set(series.map((s) => String(s.type)))].join('+') || '(none)';
  const first = series[0] ?? {};
  const hasRenderItem = JSON.stringify(o).includes('renderItem');
  const hasFormatter = JSON.stringify(o).includes('formatter');
  console.log(`${id}: series=${series.length} type=${types} renderItem=${hasRenderItem} formatter=${hasFormatter} keys=${Object.keys(o).slice(0, 8).join(',')}`);
}
