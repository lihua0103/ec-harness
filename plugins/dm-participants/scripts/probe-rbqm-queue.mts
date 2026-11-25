/** 探测（只读）：查 PT_LABS20261116142147 的列结构 + 完整导入队列（确认 PT_PATIENTS 上传去向）。 */
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
const headers = (): Json => ({ 'RBQM-language': 'en', Authorization: 'Bearer ' + anyClient.token });

// 1. 时间戳表的真实列（13 列主数据 or 4 列 labs？）
const tree = await fetch('http://localhost:3333/api/v1/dynamicdata/getdynamicdatatree', { headers: headers() }).then((r) => r.json()) as Json;
const ids: Array<{ id: string; name: string }> = [];
const walk = (node: unknown): void => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return void node.forEach(walk);
  const record = node as Json;
  const name = String(record.name ?? '');
  if (/^PT_/.test(name) && record.id !== undefined) ids.push({ id: String(record.id), name });
  for (const value of Object.values(record)) if (value && typeof value === 'object') walk(value);
};
walk(tree.data);
console.log('PT_ tables:', ids.map((t) => `${t.name}#${t.id}`).join(' | '));
for (const table of ids) {
  const colBody = await fetch('http://localhost:3333/api/v1/dynamicData/getDynamicDataColumn?dynamicDataTableId=' + table.id, { headers: headers() }).then((r) => r.json()) as Json;
  const cols = (((colBody.data as Json | undefined)?.data ?? colBody.data ?? []) as Json[]).map((c) => String(c.lable ?? c.label ?? c['lABLE'] ?? '?'));
  console.log(`  ${table.name}: cols=${cols.join(',')}`);
}

// 2. 队列全部条目（page 大）
const list = await fetch('http://localhost:3333/api/v1/dynamicdata/getDynamicDataFileList?pageNo=2&pageSize=200', { headers: headers() }).then((r) => r.json()) as Json;
const rows = (((list.data as Json | undefined)?.data ?? []) as Json[]) as Array<Record<string, unknown>>;
console.log('queue total:', (list.data as Json | undefined)?.total, '| returned:', rows.length);
for (const row of rows.filter((r) => String(r['fILE_NAME'] ?? r['fileName'] ?? '').toUpperCase().includes('PT')).slice(0, 10)) {
  console.log('  file:', String(row['fILE_NAME'] ?? row['fileName'] ?? '?'), '| status:', String(row['fILE_STATUS'] ?? row['fileStatus'] ?? '?'));
}
