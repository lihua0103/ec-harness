/** 只读：登录后不切环境，指纹识别「默认环境」是哪一个研究/环境，并报告其登记与 PP 图表现状。 */
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
const anyClient = client as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await client.login(); // 故意不 enterEnvironment：看服务端默认落在哪
const files = await anyClient.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=5');
const fileData = (files.data ?? {}) as Json;
const registry = await client.getPatientRegistry();
const layout = (await client.getLayout(2, 1)) as Json;
const layoutRows = ((layout?.data ?? []) as Json[]) ?? [];
const configs = await anyClient.json('/csm/getChartConfigList', { method: 'POST', body: { pageNo: 1, pageSize: 50, chartName: '', type: 2 } });
const configRows = (((configs.data as Json)?.data ?? []) as Json[]);
const names = await client.listDatasetNames();
console.log('DEFAULT env fingerprint: queue total =', String(fileData.total));
console.log('  newest files:', ((fileData.data ?? []) as Json[]).slice(0, 3).map((f) => `${String(f.fileName)} ${String(f.creatTime).slice(0, 19)}`).join(' | '));
console.log('  registry rows:', registry.length, registry.slice(0, 3).map((r) => `${String(r.label)}/${String(r.site)}/${String(r.country)}`).join(' | '));
console.log('  PP layout items:', Array.isArray(layoutRows) ? layoutRows.length : 0, '| PP configs:', configRows.length);
console.log('  tables (first 12):', names.slice(0, 12).join(', '));