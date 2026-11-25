/** 用前端 SQL 工作台的通道（saveSqlScript + batchExecuteSql）清掉 env215 的重复登记行。
 *  只删重复：保留每组最小 ID，删除同 STUDY_ID 同 PATIENT 的其余行。
 *  该通道走存储过程（SqlScriptOperate/SqlExecuteSetOperate），不是 rbqmExec。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('215');

const sql = `DELETE FROM PATIENT_PROFILE WHERE STUDY_ID=215 AND ID NOT IN (SELECT MIN(ID) FROM PATIENT_PROFILE WHERE STUDY_ID=215 GROUP BY PATIENT)`;
const saved = await any.json('/sqlScript/saveSqlScript', {
  method: 'POST',
  body: { diagramsKey: 'PatientProfile', sql, tableIds: [], remark: 'dedup registry (keep min ID per patient)' },
});
console.log('saveSqlScript:', String(saved.code), String(saved.syscode ?? 0), String(((saved.data ?? {}) as Json).message ?? '').slice(0, 120));
const run = await any.json('/sqlScript/batchExecuteSql', { method: 'POST', body: {} });
console.log('batchExecuteSql:', String(run.code), String(run.syscode ?? 0), String(((run.data ?? {}) as Json).message ?? '').slice(0, 120));

const after = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT)
SELECT LEFT('rows=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))
 + '|distinct=' + CAST((SELECT COUNT(DISTINCT PATIENT) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10)), 40)`)) as Json;
console.log('after:', String(((((after.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
