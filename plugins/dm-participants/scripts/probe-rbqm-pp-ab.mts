/** 前后对照：插入前/后统计 PATIENT_PROFILE，判断服务端 BulkCopy 是否真的执行。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const stats = async (tag: string) => {
  const sql = `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT)
SELECT 'all=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE) AS varchar(12))
 + '|s215=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(12))
 + '|nullPat=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE PATIENT IS NULL) AS varchar(12))
 + '|s21=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE PATIENT LIKE 'S-21%') AS varchar(12))`;
  const res = (await c.executeDiagramsSql('PatientProfile', sql)) as Json;
  const row = (((res.data ?? []) as Json[])[0] ?? {}) as Json;
  console.log(tag, String(row.patient ?? ''));
};
await stats('before:');
const info = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT)
SELECT 'db=' + DB_NAME() + '|recent=' + ISNULL(CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE CREATE_TM > DATEADD(hour,-3,GETDATE())) AS varchar(10)),'NULL')
 + '|recentPat=' + ISNULL((SELECT TOP 3 ISNULL(PATIENT,'null') + '@' + CAST(STUDY_ID AS varchar(10)) + ' ' FROM PATIENT_PROFILE WHERE CREATE_TM > DATEADD(hour,-3,GETDATE()) ORDER BY ID DESC FOR XML PATH('')),'NULL')`)) as Json;
console.log('channel:', String(((((info.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
const ins = (await c.executeDiagramsSql('PatientProfile', 'INSERT INTO #PatientProfile(PATIENT) SELECT DATA_2 FROM #PTPATIENTS')) as Json;
console.log('insert rows returned:', ((ins.data ?? []) as Json[]).length);
await stats('after :');
