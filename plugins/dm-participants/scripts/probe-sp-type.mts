/** 只读：SP-* 用的系统类型（701/201/101）的 defaultOption 形态。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('204');
const list = await any.json('/chartType/getChartTypeList', { method: 'POST', body: { pageNo: 1, pageSize: 500, chartName: '' } });
const rows = (((list.data as Json)?.data ?? []) as Json[]);
console.log('total types:', rows.length, '| codes:', rows.slice(0, 12).map((r) => `${String(r.typeCode)}:${String(r.chartName)}`).join(' '));
for (const code of ['701', '201', '101', '100001']) {
  const t = rows.find((r) => String(r.typeCode) === code || String(r.id) === code);
  if (!t) { console.log(code, 'not found'); continue; }
  const opt = String(t.defaultOption ?? '');
  console.log(`${code} ${String(t.chartName)} baseType=${String(t.baseType)} optLen=${opt.length}`);
  console.log('  head:', opt.slice(0, 300));
}
