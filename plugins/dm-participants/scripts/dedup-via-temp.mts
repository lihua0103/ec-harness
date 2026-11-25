/** 通过临时表去重：服务端「建临时表→执行SQL→BulkCopy回真实表」，
 *  所以在 #PatientProfile 上做去重，BulkCopy 会把结果写回 PATIENT_PROFILE。
 *  保留每组最小 ID（按 PATIENT 分组），只影响 STUDY_ID=215。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const snapshot = async (tag: string) => {
  const r = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT) SELECT LEFT('rows=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10)) + '|distinct=' + CAST((SELECT COUNT(DISTINCT PATIENT) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10)), 40)`)) as Json;
  console.log(tag, String(((((r.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
};
await snapshot('before:');
// 临时表里按 PATIENT 去重：保留每组第一行（临时表已按 ID 排序，见服务端 ORDER BY ID）
const sql = `DELETE FROM #PatientProfile WHERE PATIENT IN (
  SELECT PATIENT FROM #PatientProfile GROUP BY PATIENT HAVING COUNT(*) > 1
) AND PATIENT NOT IN (SELECT PATIENT FROM #PatientProfile GROUP BY PATIENT HAVING COUNT(*) = 0)`;
// 更稳的写法：用 ROW_NUMBER 保留每组第一行
const dedup = `WITH ranked AS (
  SELECT PATIENT, ROW_NUMBER() OVER (PARTITION BY PATIENT ORDER BY PATIENT) AS rn
  FROM #PatientProfile
)
DELETE FROM ranked WHERE rn > 1`;
const res = (await c.saveDiagramsData('PatientProfile', dedup)) as Json;
console.log('save:', String((res as Json).message ?? '').slice(0, 80));
await snapshot('after :');
