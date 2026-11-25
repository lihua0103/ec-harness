import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const r = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT)
SELECT LEFT('all=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE) AS varchar(10))
 + '|s215=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))
 + '|d215=' + CAST((SELECT COUNT(DISTINCT PATIENT) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))
 + '|maxId=' + CAST((SELECT MAX(ID) FROM PATIENT_PROFILE) AS varchar(20)), 60)`)) as Json;
console.log(String(((((r.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
const reg = await c.getPatientRegistry();
console.log('dropdown rows:', reg.length, '| distinct labels:', new Set(reg.map((x) => String(x.label))).size);
