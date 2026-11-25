/** 8 张单人图 rebuild 后的标准系列形态（判断能否用 _dataMap 注入）。 */
import { ptCtx } from '../src/participant-page.js';
import { rebuildCustomOption } from '../src/participant-rebuild.js';
import { ptOption } from '../src/participant-charts.js';
const ctx = ptCtx();
const ids = ['pt1p0', 'pt1p4', 'pt2p0', 'pt2p2', 'pt3p1', 'pt3p3', 'pt4p0', 'pt4p1'];
for (const id of ids) {
  const custom = ['pt1p4', 'pt2p0', 'pt2p2', 'pt3p2', 'pt3p3', 'pt4p0', 'pt4p1'].includes(id);
  const o = (custom ? rebuildCustomOption(id, ctx.M[id as keyof typeof ctx.M]) : ptOption(id, ctx, 504)) as Record<string, unknown>;
  const series = (o.series ?? []) as Record<string, unknown>[];
  const x = o.xAxis as Record<string, unknown> | undefined;
  const y = o.yAxis as Record<string, unknown> | undefined;
  console.log(`${id}${custom ? '(rebuilt)' : ''}: series=${series.length} [${series.map((s) => `${String(s.name ?? '')}:${String(s.type)}`).join(', ')}]`);
  console.log(`   xAxis=${String(x?.type)} data=${Array.isArray(x?.data) ? (x!.data as unknown[]).length : 0} | yAxis=${String(y?.type)} data=${Array.isArray(y?.data) ? (y!.data as unknown[]).length : 0}`);
}
