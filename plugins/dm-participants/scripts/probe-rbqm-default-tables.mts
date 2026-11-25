/** 只读：默认环境（不切环境）的数据树与导入文件清单——看有哪些表可用于 PP 图表。 */
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
await client.login();
const tree = await anyClient.json('/dynamicdata/getdynamicdatatree');
console.log('tree raw (first 900):', JSON.stringify(tree).slice(0, 900));
const files = await anyClient.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=30');
const rows = (((files.data as Json)?.data ?? []) as Json[]);
console.log('files:', rows.map((f) => `${String(f.fileName)} st=${String(f.fileStatus)}`).join(' | '));
const registry = await client.getPatientRegistry();
console.log('registry sample:', registry.slice(0, 3).map((r) => JSON.stringify(r)).join(' | '));
console.log('registry count:', registry.length);