/** 探测：读取失败文件完整 failReason（只读，凭据不回显）。 */
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
  data?: { data?: Array<Record<string, unknown>> };
};
const rows = list.data?.data ?? [];
for (const row of rows) {
  if (Number(row['fileStatus'] ?? row['fILE_STATUS']) === 5) {
    console.log('---', String(row['fileName']), 'id=', String(row['id']), 'created=', String(row['creatTime']));
    console.log(JSON.stringify(row['failureFileList'], null, 1));
  }
}
