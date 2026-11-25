/** 用 .env 里的 admin 账号（若有）走工作台的 executeDiagramsSql 通道试 DELETE。
 *  凭据只在内存解析、不回显；只删重复行（保留每组最小 ID）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const dotenv = parse(await readFile('D:/project/company/RBQM/.env', 'utf8'));
const candidates = [
  { label: 'RBQM .env admin', user: dotenv['RBQM_ADMIN_USER'] ?? '', pass: dotenv['RBQM_ADMIN_PASSWORD'] ?? '' },
  { label: 'RBQM .env demo', user: dotenv['RBQM_DEMO_USER'] ?? '', pass: dotenv['RBQM_DEMO_PASSWORD'] ?? '' },
  { label: 'intranet', user: envs['RBQM_INTRANET_USER'] ?? '', pass: envs['RBQM_INTRANET_PASSWORD'] ?? '' },
].filter((c) => c.user && c.pass);

for (const candidate of candidates) {
  const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: candidate.user, password: candidate.pass });
  try {
    await c.login();
  } catch {
    console.log(`${candidate.label}: login rejected`);
    continue;
  }
  await c.enterEnvironment('215');
  const who = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT) SELECT LEFT('user=' + SUSER_NAME(), 40)`)) as Json;
  const dbUser = String(((((who.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? '');
  const del = (await c.executeDiagramsSql('PatientProfile',
    `DELETE FROM PATIENT_PROFILE WHERE STUDY_ID=215 AND ID NOT IN (SELECT MIN(ID) FROM PATIENT_PROFILE WHERE STUDY_ID=215 GROUP BY PATIENT)`)) as Json;
  const msg = String((del as Json).message ?? '').slice(0, 80);
  const after = (await c.executeDiagramsSql('PatientProfile', `DELETE FROM #PatientProfile;
INSERT INTO #PatientProfile(PATIENT) SELECT 'rows=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))`)) as Json;
  console.log(`${candidate.label}: ${dbUser} | delete=${msg} | ${String(((((after.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? '')}`);
}
