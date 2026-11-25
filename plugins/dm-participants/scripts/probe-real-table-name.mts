/** 只读：查 PatientProfile 这个系统图表配置的真实物理表名与临时表名。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('215');
// 1) diagrams 列表：看 PatientProfile 的 key/名称/表名
const list = await any.json('/sqlScript/getDiagramsList');
const rows = (((list.data as Json)?.data ?? []) as Json[]);
console.log('diagrams keys:', rows.map((r) => String(r.key ?? r.diagramsKey ?? '?')).join(' | '));
const pp = rows.find((r) => /patient/i.test(JSON.stringify(r)));
console.log('PatientProfile entry:', JSON.stringify(pp ?? {}).slice(0, 500));
// 2) 用临时表反查：系统 SQL 会 SELECT * INTO #PatientProfile FROM <真实表>
const probe = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT) SELECT LEFT('cols=' + CAST((SELECT COUNT(*) FROM sys.columns WHERE object_id=OBJECT_ID('PATIENT_PROFILE')) AS varchar(5)) + '|rows=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE) AS varchar(10)), 40)`)) as Json;
console.log('PATIENT_PROFILE probe:', String(((((probe.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
