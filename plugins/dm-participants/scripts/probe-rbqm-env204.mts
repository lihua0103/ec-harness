/** 只读：DYDR-524-0516/DEV(env204) 的登记、数据树与 PP 现状。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('204');
const reg = await c.getPatientRegistry();
console.log('registry:', reg.length, reg.slice(0, 4).map((r) => `${String(r.label)}/${String(r.site)}`).join(' | '));
const names = await c.listDatasetNames();
console.log('tables:', names.length, names.slice(0, 25).join(', '));
const layout = await any.json('/csm/getChartLayoutInfo?type=2&pageType=1');
console.log('PP layout:', JSON.stringify(layout).slice(0, 300));
const cfg = await any.json('/csm/getChartConfigList', { method: 'POST', body: { pageNo: 1, pageSize: 50, chartName: '', type: 2 } });
console.log('PP configs:', (((cfg.data as Json)?.data ?? []) as Json[]).length);
