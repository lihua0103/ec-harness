/** 探测（只读）：PP 患者登记（getPatientProfile）现状——study 92/环境 215 下有哪些患者、ID 形态。 */
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
const response = await fetch('http://localhost:3333/api/v1/patientProfile/getPatientProfile', {
  headers: { 'RBQM-language': 'en', Authorization: 'Bearer ' + anyClient.token },
});
const body = (await response.json()) as Json;
const data = body.data as Json | undefined;
const rows = (Array.isArray(data) ? data : ((data as Json | undefined)?.data as Json[] | undefined)) ?? [];
console.log('patient registry rows:', rows.length, '| code:', String(body.code), 'syscode:', String(body.syscode));
for (const row of rows.slice(0, 12)) {
  console.log(' ', JSON.stringify(row));
}
