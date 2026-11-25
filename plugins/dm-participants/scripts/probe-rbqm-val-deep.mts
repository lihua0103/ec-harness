/** 探测（只读）：CKD-DEMO-301 DEV（env 10）PP 参考形态深读——配置明细/布局/患者行/Demo_Study 的 PP SQL 脚本。 */
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
const rawUrl = (envs['RBQM_VAL_URL'] ?? '').replace(/\/+$/, '');
const host = rawUrl.replace(/^https?:\/\//, '').split('/')[0]!;
const apiBase = 'https://rbqmapival.' + host.split('.').slice(1).join('.') + '/api/v1';
const client = new RbqmClient({
  apiBase,
  uploadBase: 'https://rbqmuploadval.' + host.split('.').slice(1).join('.'),
  userName: envs['RBQM_VAL_USER'] ?? '',
  password: envs['RBQM_VAL_PASSWORD'] ?? '',
});
await client.login();
const anyClient = client as unknown as { token: string };
const headers = (): Json => ({
  'content-type': 'application/json',
  'RBQM-language': 'en',
  Authorization: 'Bearer ' + anyClient.token,
});
const get = async (path: string): Promise<Json> => (await fetch(apiBase + path, { headers: headers() }).then((r) => r.json())) as Json;
const post = async (path: string, body: unknown): Promise<Json> =>
  (await fetch(apiBase + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) }).then((r) => r.json())) as Json;
const rowOf = (body: Json): Json => (((body.data as Json | undefined)?.data ?? {}) as Json);

// A. CKD-DEMO-301 DEV：PP 配置明细
await client.enterEnvironment('10');
const configs = await post('/csm/getChartConfigList', { pageNo: 1, pageSize: 30, type: 2 });
const configRows = ((configs.data as Json | undefined)?.data ?? []) as Json[];
console.log('=== CKD-DEMO-301 DEV PP configs:', configRows.length);
for (const row of configRows.slice(0, 4)) {
  const detail = await get('/csm/getCsmChartDetail?id=' + String(row['id']));
  const payload = rowOf(detail);
  const fieldList = (payload['fieldList'] ?? {}) as Json;
  const brief = (bucket: string): string =>
    ((fieldList[bucket] ?? []) as Json[]).map((f) => String(f['name'] ?? f['id'])).join('|');
  console.log(`-- id=${String(row['id'])} name=${String(row['name']).slice(0, 44)} chartType=${String(row['chartType'])}`);
  console.log(`   fileObj=${JSON.stringify(payload['fileObj'])}`);
  console.log(`   patient=[${brief('patient')}] column=[${brief('column')}] dimension=[${brief('dimension')}] number=[${brief('number')}]`);
  console.log(`   chartInfo.state=${JSON.stringify((payload['chartInfo'] as Json | undefined)?.['state'])} styleKeys=${Object.keys((payload['style'] ?? {}) as Json).join(',')}`);
}

// B. PP 布局形状
const layout = await client.getLayout(2, 1);
const layoutRows = ((layout as Json | undefined)?.data ?? []) as Json[];
console.log('=== PP layout items:', layoutRows.length);
for (const item of layoutRows.slice(0, 5)) console.log('  ', JSON.stringify(item).slice(0, 220));

// C. 患者登记行形状（前 3 行截断）
const patients = await get('/patientProfile/getPatientProfile');
const pData = patients.data as Json | undefined;
const patientRows = ((Array.isArray(pData) ? pData : (pData as Json | undefined)?.data) as Json[] | undefined) ?? [];
console.log('=== patient registry rows:', patientRows.length);
for (const row of patientRows.slice(0, 3)) console.log('  ', JSON.stringify(row).slice(0, 300));

// D. 患者登记的动态表来源：PP 配置的 fileObj 指向哪张表 + 数据树里的 PP 相关表
const tree = await client.listDatasetNames();
console.log('=== dynamic tables (count):', tree.length, '| names:', JSON.stringify(tree.filter((n) => /PATIENT|SUBJECT|PT_/i.test(n)).slice(0, 20)));

// E. Demo_Study DEV（env 4）唯一保存的 PatientProfile SQL 脚本——登记生成的活样本
await client.enterEnvironment('4');
const scripts = await get('/sqlScript/getSqlScriptList?diagramsKey=PatientProfile');
const scriptRows = ((scripts.data as Json | undefined)?.data ?? []) as Json[];
console.log('=== Demo_Study DEV PatientProfile sql scripts:', scriptRows.length);
for (const row of scriptRows.slice(0, 3)) {
  console.log('  remark:', String(row['rEMARK'] ?? row['remark'] ?? '').slice(0, 80));
  console.log('  sql:', String(row['sQL_SCRIPT'] ?? row['sql'] ?? '').replace(/\s+/g, ' ').slice(0, 1200));
}

// F. Demo_Study DEV 患者行形状对照
const patients2 = await get('/patientProfile/getPatientProfile');
const p2 = patients2.data as Json | undefined;
const rows2 = ((Array.isArray(p2) ? p2 : (p2 as Json | undefined)?.data) as Json[] | undefined) ?? [];
console.log('=== Demo_Study DEV patient rows:', rows2.length);
for (const row of rows2.slice(0, 2)) console.log('  ', JSON.stringify(row).slice(0, 300));
