import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const reg = await c.getPatientRegistry();
const counts = new Map<string, number>();
for (const r of reg) counts.set(String(r.label), (counts.get(String(r.label)) ?? 0) + 1);
console.log('registry rows:', reg.length, '| distinct labels:', counts.size);
console.log('duplicated:', [...counts.entries()].filter(([, n]) => n > 1).slice(0, 5).map(([l, n]) => `${l}x${n}`).join(' '));
const res = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT)
SELECT 'rows=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))
 + '|distinct=' + CAST((SELECT COUNT(DISTINCT PATIENT) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))
 + '|idRange=' + ISNULL((SELECT CAST(MIN(ID) AS varchar(20)) + '-' + CAST(MAX(ID) AS varchar(20)) FROM PATIENT_PROFILE WHERE STUDY_ID=215),'null')`)) as Json;
console.log('db:', String(((((res.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
