import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json>; token: string };
await c.login();
await c.enterEnvironment('215');
const get = async (path: string): Promise<Json> => {
  const r = await fetch('http://localhost:3333/api/v1' + path, { headers: { Authorization: 'Bearer ' + any.token, 'RBQM-language': 'en' } });
  const text = await r.text();
  console.log(path, '->', r.status, text.slice(0, 120).replace(/\s+/g, ' '));
  try { return JSON.parse(text) as Json; } catch { return {}; }
};
await get('/sqlScript/getDiagramsList?diagramsKey=PatientProfile');
await get('/patientProfile/getPatientProfile?patient=S-2101');
await get('/patientProfile/getPatientSitCountry');
