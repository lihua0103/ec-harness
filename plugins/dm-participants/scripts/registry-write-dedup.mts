/** 一次完成：写入登记 + 临时表去重（BulkCopy 回真实表时只留每组一行）。
 *  为什么需要：saveDiagramsData 的替换语义依赖真实表 DELETE，而 rbqmExec 无该权限，
 *  所以重复保存会累积。在 #PatientProfile 上做 ROW_NUMBER 去重，BulkCopy 会把结果写回。 */
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
// 只去重、不新增：保留每组第一行
const dedup = `WITH ranked AS (
  SELECT PATIENT, ROW_NUMBER() OVER (PARTITION BY PATIENT ORDER BY PATIENT) AS rn
  FROM #PatientProfile
)
DELETE FROM ranked WHERE rn > 1`;
const res = (await c.saveDiagramsData('PatientProfile', dedup)) as Json;
console.log('dedup:', String((res as Json).message ?? '').slice(0, 80));
await snapshot('after :');
const reg = await c.getPatientRegistry();
const labels = reg.map((x) => String(x.label));
console.log('dropdown:', reg.length, 'rows | distinct:', new Set(labels).size, '| has S-2101:', labels.includes('S-2101'));
