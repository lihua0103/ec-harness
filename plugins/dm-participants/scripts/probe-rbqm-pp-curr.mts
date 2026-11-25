/** 判定服务端「当前研究」的登记行数，并做写入前后对照。
 *  用户 SQL 在系统 SQL（SELECT * INTO #PatientProfile FROM PATIENT_PROFILE WHERE STUDY_ID=<curr>）之后执行，
 *  所以一开始就数 #PatientProfile 的行数 = 当前研究的真实登记行数。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await c.login();
await c.enterEnvironment('215');
const probe = async (tag: string) => {
  const res = (await c.executeDiagramsSql('PatientProfile',
    `DECLARE @c int = (SELECT COUNT(*) FROM #PatientProfile);
     DELETE FROM #PatientProfile;
     INSERT INTO #PatientProfile(PATIENT)
     SELECT '${tag} curr=' + CAST(@c AS varchar(10))
       + '|maxId=' + CAST((SELECT MAX(ID) FROM PATIENT_PROFILE) AS varchar(20))
       + '|identity=' + CAST(IDENT_CURRENT('PATIENT_PROFILE') AS varchar(20))
       + '|all=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE) AS varchar(12))`)) as Json;
  const row = (((res.data ?? []) as Json[])[0] ?? {}) as Json;
  console.log(String(row.patient ?? ''));
};
await probe('before');
const ins = (await c.executeDiagramsSql('PatientProfile', 'INSERT INTO #PatientProfile(PATIENT) SELECT DATA_2 FROM #PTPATIENTS')) as Json;
console.log('inserted rows:', ((ins.data ?? []) as Json[]).length);
await probe('after ');
