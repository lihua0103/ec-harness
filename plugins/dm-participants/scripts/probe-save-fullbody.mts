/** 按工作台真实请求体（含 tableIds/pageNo/pageSize）走 saveDiagramsData。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json>; token: string };
await c.login();
await c.enterEnvironment('215');
// 取 PT_PATIENTS 的表 id（工作台勾选源数据表时传的 tableIds）
const tree = await any.json('/dynamicdata/getdynamicdatatree');
const ids: string[] = [];
const walk = (n: unknown): void => {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return void n.forEach(walk);
  const r = n as Json;
  if (String(r.name ?? '') === 'PT_PATIENTS' && r.id !== undefined) ids.push(String(r.id));
  for (const v of Object.values(r)) if (v && typeof v === 'object') walk(v);
};
walk(tree.data);
console.log('PT_PATIENTS id:', ids.join(','));
const sql = `DELETE FROM PATIENT_PROFILE WHERE STUDY_ID=215 AND ID NOT IN (SELECT MIN(ID) FROM PATIENT_PROFILE WHERE STUDY_ID=215 GROUP BY PATIENT)`;
const body = { diagramsKey: 'PatientProfile', sql, tableIds: ids, pageNo: 1, pageSize: 20 };
const res = await fetch('http://localhost:3333/api/v1/sqlScript/saveDiagramsData', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'RBQM-language': 'en', Authorization: 'Bearer ' + any.token },
  body: JSON.stringify(body),
}).then((r) => r.json()) as Json;
console.log('response:', String(res.code), String(res.syscode ?? 0), String(((res.data ?? {}) as Json).message ?? '').slice(0, 140));
const after = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT) SELECT 'rows=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))`)) as Json;
console.log('after:', String(((((after.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
