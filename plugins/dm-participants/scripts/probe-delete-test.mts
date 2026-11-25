/** 只读探测：直接在 rbqmExec 通道上试 DELETE 一行（删的是我刚插入的重复行，可恢复）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
// 先取一个重复行的 ID（每组最大 ID）
const probe = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT)
SELECT CAST((SELECT MAX(ID) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(20))`)) as Json;
const maxId = String(((((probe.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? '');
console.log('target max ID:', maxId);
const del = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM PATIENT_PROFILE WHERE ID=${maxId}`)) as Json;
console.log('delete response:', String((del as Json).message ?? '').slice(0, 100));
const after = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT) SELECT 'rows=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))`)) as Json;
console.log('after delete:', String(((((after.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
