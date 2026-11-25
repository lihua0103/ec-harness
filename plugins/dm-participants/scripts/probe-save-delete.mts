/** 验证：走 saveDiagramsData（工作台「保存」通道）执行 DELETE 是否能真正删行。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const count = async () => {
  const r = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT) SELECT 'rows=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))`)) as Json;
  return String(((((r.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? '');
};
console.log('before:', await count());
// 工作台「保存」通道：DELETE 不会被 BulkCopy 覆盖，但服务端会先建临时表再执行整段 SQL
const res = (await c.saveDiagramsData('PatientProfile',
  `DELETE FROM PATIENT_PROFILE WHERE STUDY_ID=215 AND ID NOT IN (SELECT MIN(ID) FROM PATIENT_PROFILE WHERE STUDY_ID=215 GROUP BY PATIENT)`)) as Json;
console.log('saveDiagramsData:', String((res as Json).message ?? '').slice(0, 80));
console.log('after:', await count());
