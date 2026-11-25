/** 探测：原始列表头 8 行 + 总数（只读）。 */
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
const raw = await fetch('http://localhost:3333/api/v1/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=300', { headers }).then((r) => r.json());
const rows = raw?.data?.data ?? [];
console.log('total:', raw?.data?.total, 'rows:', rows.length, 'code:', raw?.code, 'syscode:', raw?.sysCode);
for (const row of rows.slice(0, 8)) {
  console.log('row:', String(row['fileName']), 'status=', String(row['fileStatus']), 'created=', String(row['creatTime']), 'study=', String(row['studyName'] ?? row['sTUDY_NAME'] ?? '?'));
}
