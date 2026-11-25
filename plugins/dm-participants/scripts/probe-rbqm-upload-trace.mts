/** 探测（只读）：完整扫描导入队列，找 PT_PATIENTS 去向；打印原始键名与最近条目。 */
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
const get = async (path: string): Promise<Json> =>
  (await fetch('http://localhost:3333/api/v1' + path, {
    headers: { 'RBQM-language': 'en', Authorization: 'Bearer ' + anyClient.token },
  }).then((r) => r.json())) as Json;

const all: Json[] = [];
let total = 0;
for (let page = 1; page <= 6; page++) {
  const body = await get(`/dynamicdata/getDynamicDataFileList?pageNo=${page}&pageSize=100`);
  const data = (body.data ?? {}) as Json;
  total = Number(data.total ?? total);
  const rows = (data.data ?? []) as Json[];
  if (page === 1 && rows[0]) console.log('row keys:', Object.keys(rows[0]).join(','));
  all.push(...rows);
  if (all.length >= total || rows.length === 0) break;
}
console.log('queue total:', total, '| collected:', all.length);
const nameOf = (r: Json): string => String(r.fileName ?? r.fILE_NAME ?? r['fILE_NAME'] ?? '');
const statusOf = (r: Json): string => String(r.fileStatus ?? r.fILE_STATUS ?? '');
const timeOf = (r: Json): string => String(r.creatTime ?? r.createTm ?? '').slice(0, 19);
console.log('PATIENT matches:', all.filter((r) => /PATIENT/i.test(nameOf(r))).map((r) => `${nameOf(r)} st=${statusOf(r)} ${timeOf(r)}`).join(' | ') || '(none)');
console.log('PT matches:', all.filter((r) => /PT_/i.test(nameOf(r))).map((r) => `${nameOf(r)} st=${statusOf(r)} ${timeOf(r)}`).join(' | ') || '(none)');
console.log('first 5 rows:', all.slice(0, 5).map((r) => `${nameOf(r)} st=${statusOf(r)} ${timeOf(r)}`).join(' | '));
console.log('last 5 rows:', all.slice(-5).map((r) => `${nameOf(r)} st=${statusOf(r)} ${timeOf(r)}`).join(' | '));
const recent = all.filter((r) => timeOf(r).startsWith('2026-11-16'));
console.log('today rows:', recent.length, recent.slice(0, 12).map((r) => `${nameOf(r)} st=${statusOf(r)} ${timeOf(r)}`).join(' | '));
console.log('tree PT_:', (await client.listDatasetNames()).filter((n) => /PT_/i.test(n)).join(' | '));