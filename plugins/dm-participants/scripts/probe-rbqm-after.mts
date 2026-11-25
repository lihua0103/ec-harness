/** 探测：上传后查 PT_LABS 记录与树（只读）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
const parseDotEnv = (text: string): Record<string, string> => {
  const bag: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) bag[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return bag;
};
const envs = parseDotEnv(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const client = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await client.login();
await client.enterEnvironment('215');
// @ts-expect-error 私有 token
const headers = { 'RBQM-language': 'en', Authorization: 'Bearer ' + client.token };
const list = (await fetch('http://localhost:3333/api/v1/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=20', { headers }).then((r) => r.json())) as { data?: { data?: Array<Record<string, unknown>>; total?: number } };
console.log('total:', list.data?.total);
for (const row of (list.data?.data ?? []).slice(0, 6)) {
  console.log('file:', String(row['fileName']), 'status=', String(row['fileStatus']), 'created=', String(row['creatTime']));
}
const names = await client.listDatasetNames();
console.log('tree has PT_LABS:', names.includes('PT_LABS'), 'tables:', names.length);
