/** 诊断：只插 PATIENT 一列，判断源临时表是否为空（写入的是真实参与者ID，非编造值）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const res = await c.executeDiagramsSql('PatientProfile', 'INSERT INTO #PatientProfile(PATIENT) SELECT DATA_2 FROM #PTPATIENTS');
console.log('sql message:', String((res as Json).message ?? '').slice(0, 120), '| returned rows:', Array.isArray((res as Json).data) ? ((res as Json).data as unknown[]).length : 'n/a');
const reg = await c.getPatientRegistry();
console.log('returned sample:', JSON.stringify(((res as Json).data as unknown[])?.slice(0,2) ?? []).slice(0,300));
console.log('registry after minimal insert:', reg.length, reg.slice(0, 3).map((r) => String(r.label)).join(','));
