/** 探测：定位 PT_/canary 导入文件记录与状态（只读，凭据不回显）。 */
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
const client = new RbqmClient({
  apiBase: 'http://localhost:3333/api/v1',
  uploadBase: 'http://10.111.6.155:2222',
  userName: envs['RBQM_INTRANET_USER'] ?? '',
  password: envs['RBQM_INTRANET_PASSWORD'] ?? '',
});
await client.login();
await client.enterEnvironment('215');
// @ts-expect-error token 是运行期私有值，探针仅本地使用
const headers = { 'RBQM-language': 'en', Authorization: 'Bearer ' + client.token };

const list = (await fetch('http://localhost:3333/api/v1/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=300', { headers }).then((r) => r.json())) as {
  data?: { data?: Array<Record<string, unknown>>; total?: number };
};
const rows = list.data?.data ?? [];
console.log('files fetched:', rows.length, 'of', list.data?.total);
for (const row of rows) {
  const name = String(row['fILE_NAME'] ?? row['fileName'] ?? '');
  if (/^PT_|canary/i.test(name)) {
    console.log('match:', JSON.stringify(row).slice(0, 320));
  }
}
