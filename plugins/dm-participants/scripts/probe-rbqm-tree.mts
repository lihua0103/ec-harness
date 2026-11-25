/** 探测（只读）：查 PT_PATIENTS 是否入树 + 最近导入队列状态。 */
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
const names = await client.listDatasetNames();
console.log('tree names matching pat/viz:', JSON.stringify(names.filter((n) => /PT_/i.test(n))));
const anyClient = client as unknown as { token: string };
const r = await fetch('http://localhost:3333/api/v1/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=50', {
  headers: { 'RBQM-language': 'en', Authorization: 'Bearer ' + anyClient.token },
});
const body = (await r.json()) as Json;
const rows = (((body.data as Json | undefined)?.data ?? []) as Json[]) as Array<Record<string, unknown>>;
for (const row of rows.filter(r => String(Object.values(r)[0] ?? '').includes('PT') || String(r['fILE_NAME'] ?? r['fileName'] ?? '').includes('PT')).slice(-8)) {
  console.log(
    'file:',
    String(row['fILE_NAME'] ?? row['fileName'] ?? '?'),
    '| status:',
    String(row['fILE_STATUS'] ?? row['fileStatus'] ?? '?'),
    '| time:',
    String(row['cREATE_TM'] ?? row['createTm'] ?? '?').slice(0, 19),
  );
}
