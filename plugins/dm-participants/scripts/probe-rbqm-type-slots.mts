/** 只读：读系统里既有 PP 配置与其自定义类型的 slots/panels/calculationMethod 形状。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('204');
const cfg = await any.json('/csm/getChartConfigList', { method: 'POST', body: { pageNo: 1, pageSize: 50, chartName: '', type: 2 } });
const rows = (((cfg.data as Json)?.data ?? []) as Json[]);
console.log('PP configs:', rows.map((r) => `${String(r.id)}:${String(r.name ?? r.chartName)}:type=${String(r.chartType)}`).join(' | '));
const target = rows.find((r) => Number(r.chartType) >= 100000) ?? rows[0];
if (target) {
  const detail = await any.json('/csm/getCsmChartDetail?id=' + String(target.id));
  const payload = ((detail.data as Json)?.data ?? {}) as Json;
  console.log('detail keys:', Object.keys(payload).join(','));
  console.log('fieldList:', JSON.stringify(payload.fieldList).slice(0, 700));
  console.log('calculationMethod:', JSON.stringify(payload.calculationMethod).slice(0, 700));
}
const types = await any.json('/chartType/getChartTypeList', { method: 'POST', body: { pageNo: 1, pageSize: 5, chartName: 'SP-' } });
const typeRows = (((types.data as Json)?.data ?? []) as Json[]);
for (const t of typeRows.slice(0, 2)) {
  console.log(`type ${String(t.chartName)} code=${String(t.typeCode)} slots=`, JSON.stringify(t.slots).slice(0, 500));
  console.log('  panels=', JSON.stringify(t.panels).slice(0, 400));
}
