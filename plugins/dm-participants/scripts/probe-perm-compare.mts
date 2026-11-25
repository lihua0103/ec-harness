/** 只读：对比 rbqmExec 在「系统表」与「动态数据表」上的权限，验证权限模型（不删任何数据）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const perm = async (table: string) => {
  const sql = `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT)
SELECT LEFT('${table}: ' + ISNULL((SELECT permission_name + ',' FROM fn_my_permissions('${table}','OBJECT') FOR XML PATH('')), 'none'), 90)`;
  const r = (await c.executeDiagramsSql('PatientProfile', sql)) as Json;
  return String(((((r.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? '');
};
console.log(await perm('PATIENT_PROFILE'));
// 动态数据表的存储表名形如 DYNAMIC_DATA_STORAGE_TABLE20
for (const t of ['DYNAMIC_DATA_STORAGE_TABLE20', 'DYNAMIC_DATA_STORAGE_TABLE40']) {
  try { console.log(await perm(t)); } catch (e) { console.log(`${t}: ${e instanceof Error ? e.message.slice(0, 90) : 'error'}`); }
}
