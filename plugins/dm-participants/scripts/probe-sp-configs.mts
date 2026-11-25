/** 只读：env204 里系统 SP-* PP 配置的真实形态（类型/槽位/option 摘要）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('204');
const cfg = await any.json('/csm/getChartConfigList', { method: 'POST', body: { pageNo: 1, pageSize: 50, chartName: 'SP-', type: 2 } });
const rows = (((cfg.data as Json)?.data ?? []) as Json[]);
for (const r of rows.slice(0, 4)) {
  const detail = await any.json('/csm/getCsmChartDetail?id=' + String(r.id));
  const p = ((detail.data as Json)?.data ?? {}) as Json;
  const fl = (p.fieldList ?? {}) as Json;
  const cnt = (k: string) => (Array.isArray(fl[k]) ? (fl[k] as unknown[]).length : 0);
  console.log(`${String(r.name)} type=${String(r.chartType)} file=${String((p.fileObj as Json)?.name)} num=${cnt('number')} dim=${cnt('dimension')} col=${cnt('column')} pat=${cnt('patient')} other=${cnt('otherInfo')}`);
}
