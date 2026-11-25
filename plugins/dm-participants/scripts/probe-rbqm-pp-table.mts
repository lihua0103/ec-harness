/** 判定 PATIENT_PROFILE 是否真的落了库：
 *  executeDiagramsSql 的系统 SQL 先 `SELECT * INTO #PatientProfile FROM PATIENT_PROFILE WHERE STUDY_ID=…`，
 *  所以用一条无害的 user SQL（SELECT 1）就能把该研究的真实登记内容取回来，绕开读接口。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const res = (await c.executeDiagramsSql('PatientProfile', 'SELECT 1')) as Json;
const rows = (res.data ?? []) as Json[];
console.log('PATIENT_PROFILE snapshot rows:', rows.length);
console.log('sample:', JSON.stringify(rows.slice(0, 2)).slice(0, 400));
console.log('read API rows:', (await c.getPatientRegistry()).length);
