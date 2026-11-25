/** 探测：全量列表搜 LABS/PT 关键词（只读）。 */
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
const list = (await fetch('http://localhost:3333/api/v1/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=300', { headers }).then((r) => r.json())) as { data?: { data?: Array<Record<string, unknown>> } };
let hits = 0;
for (const row of list.data?.data ?? []) {
  const name = String(row['fileName'] ?? '');
  if (/lab|(^|[^a-z])pt|cohort/i.test(name)) { hits++; console.log('hit:', name, 'status=', String(row['fileStatus']), 'created=', String(row['creatTime'])); }
}
console.log('total hits:', hits);
// 顺便看 13:00 之后今天的全部记录
for (const row of list.data?.data ?? []) {
  const created = String(row['creatTime'] ?? '');
  if (created.startsWith('2026-11-16')) console.log('today:', String(row['fileName']), 'status=', String(row['fileStatus']), 'created=', created);
}
