/** 只读诊断：确认重复行分布（不删数据，删除需 DBA 或另有授权通道）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const res = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT)
SELECT LEFT('rows=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))
 + '|distinct=' + CAST((SELECT COUNT(DISTINCT PATIENT) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))
 + '|minMax=' + ISNULL((SELECT CAST(MIN(ID) AS varchar(20)) + '-' + CAST(MAX(ID) AS varchar(20)) FROM PATIENT_PROFILE WHERE STUDY_ID=215),'null'), 60)`)) as Json;
console.log(String(((((res.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
