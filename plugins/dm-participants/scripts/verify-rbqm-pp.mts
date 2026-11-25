/** 验收读回（只读）：PP 布局/配置/登记/源表的真实状态。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';

type Json = Record<string, unknown>;
const parseDotEnv = (text: string): Record<string, string> => {
  const bag: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) bag[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return bag;
};
const envs = parseDotEnv(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const client = new RbqmClient({
  apiBase: 'http://localhost:3333/api/v1',
  uploadBase: 'http://10.111.6.155:2222',
  userName: envs['RBQM_INTRANET_USER'] ?? '',
  password: envs['RBQM_INTRANET_PASSWORD'] ?? '',
});
await client.login();
await client.enterEnvironment('215');
const anyClient = client as unknown as { json: (p: string, o?: Json) => Promise<Json> };

const layout = (await client.getLayout(2, 1)) as Json;
const items = ((layout?.data ?? layout) as Json[]) ?? [];
console.log('PP layout items:', Array.isArray(items) ? items.length : 'n/a');
for (const item of Array.isArray(items) ? items : []) {
  console.log(`  id=${String(item.id)} i=${String(item.i)} chartType=${String(item.chartType)} name=${String(item.chartName)} x=${String(item.x)} y=${String(item.y)} w=${String(item.w)} h=${String(item.h)}`);
}
const list = await anyClient.json('/csm/getChartConfigList', { method: 'POST', body: { pageNo: 1, pageSize: 50, chartName: 'VIZ-PT', type: 2 } });
const rows = (((list.data as Json)?.data ?? []) as Json[]);
console.log('PP configs (type=2):', rows.length, rows.map((r) => `${String(r.id)}:${String(r.name ?? r.chartName)}`).join(' | '));
const registry = await client.getPatientRegistry();
console.log('patient registry rows:', registry.length);
const cols = await anyClient.json('/dynamicData/getDynamicDataColumn?dynamicDataTableId=3829');
const colRows = (((cols.data as Json)?.data ?? []) as Json[]);
console.log('PT_PATIENTS columns:', colRows.map((c) => String(c.lable ?? c.label)).join(','));