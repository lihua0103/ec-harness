/** 决定性探针：与 place 同路径上传 PT_LABS.xlsx，打印完整响应体（无凭据内容）。 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importParticipantsWorkbook } from '../src/data.js';
import { buildXlsx, RbqmClient } from '../../../packages/platform-viz/src/index.js';

const parseDotEnv = (text: string): Record<string, string> => {
  const bag: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) bag[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return bag;
};
const toNumber = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const WORKBOOK = resolve('D:/project/company/ec-clinical-dsh/.runtime/dsh-home/dm-participants/import/cohort-b-e2e.xlsx');
const imported = await importParticipantsWorkbook(WORKBOOK);
const out: Array<Array<string | number>> = [['PATIENT', 'CATEGORY', 'TEST', 'VALUE']];
for (const row of imported.sourceRows['labs'] ?? []) {
  const value = toNumber(row.value);
  if (value === null || !String(row.participantId ?? '').trim()) continue;
  out.push([String(row.participantId).trim(), String(row.week ?? '').trim(), String(row.analyte ?? '').trim(), value]);
}
const xlsx = buildXlsx(out, 'PT_LABS');
console.log('xlsx bytes:', xlsx.length, 'rows:', out.length - 1);

const envs = parseDotEnv(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const client = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await client.login();
await client.enterEnvironment('215');
// @ts-expect-error 私有 token
const headers = { 'X-Requested-With': 'XMLHttpRequest', 'RBQM.language': 'en', Authorization: 'Bearer ' + client.token };

const form = new FormData();
form.append('file', new Blob([new Uint8Array(xlsx)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'PT_LABS.xlsx');
const response = await fetch('http://10.111.6.155:2222/api/file/uplaod?uploadType=1&id=0', { method: 'POST', headers, body: form });
console.log('http status:', response.status);
const text = await response.text();
console.log('response body:', text.slice(0, 600));
