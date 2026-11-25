/** 探测（只读）：按 type=1/type=2 分别查 VIZ-PT 图表配置清单，验证「缺 type=2 过滤」假设。 */
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
const anyClient = client as unknown as { token: string };
const headers = (): Json => ({
  'content-type': 'application/json',
  'RBQM-language': 'en',
  Authorization: 'Bearer ' + anyClient.token,
});

const listConfigs = async (type: number | undefined): Promise<Json> => {
  const response = await fetch('http://localhost:3333/api/v1/csm/getChartConfigList', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ pageNo: 1, pageSize: 50, chartName: 'VIZ-PT', ...(type !== undefined ? { type } : {}) }),
  });
  return (await response.json()) as Json;
};

for (const type of [undefined, 1, 2]) {
  const body = await listConfigs(type);
  const rows = (((body.data as Json | undefined)?.data ?? []) as Json[]).filter(
    (row) => String(row['name'] ?? row['chartName'] ?? '').includes('VIZ-PT'),
  );
  console.log(`list type=${String(type)}: matched=${rows.length}`, rows.map((row) => `id=${String(row['id'])} name=${String(row['name'] ?? row['chartName'])} chartType=${String(row['chartType'] ?? '')}`).join(' | '));
}

const layout = await client.getLayout(2, 1);
console.log('PP layout (type=2, pageType=1):', JSON.stringify(layout).slice(0, 400));
