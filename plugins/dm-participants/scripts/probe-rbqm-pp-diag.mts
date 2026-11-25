/** 诊断（只改临时表，不碰真实表）：把 PATIENT_PROFILE 的表结构事实写进 #PatientProfile 再取回。
 *  目的：确认 ① 表是否叫这个名字 ② ID 是否 IDENTITY（决定 BulkCopy 后那条 DELETE 会不会清掉新行）
 *  ③ 该研究现有行数/最大 ID。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const sql = `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT)
SELECT 's21=' + ISNULL(CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE PATIENT LIKE 'S-21%') AS varchar(10)),'NULL')
 + '|byStudy=' + ISNULL((SELECT TOP 8 CAST(STUDY_ID AS varchar(10)) + ':' + CAST(COUNT(*) AS varchar(10)) + ' ' FROM PATIENT_PROFILE GROUP BY STUDY_ID ORDER BY STUDY_ID DESC FOR XML PATH('')),'NULL')`;
const res = (await c.executeDiagramsSql('PatientProfile', sql)) as Json;
console.log('diag:', JSON.stringify(((res.data ?? []) as Json[]).slice(0, 2)).slice(0, 600));
