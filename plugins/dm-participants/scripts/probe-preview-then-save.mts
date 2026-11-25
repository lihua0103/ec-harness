/** 按工作台真实顺序执行：先 executeDiagramsSql（预览），再 saveDiagramsData（保存）。 */
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
const sql = `DELETE FROM PATIENT_PROFILE WHERE STUDY_ID=215 AND ID NOT IN (SELECT MIN(ID) FROM PATIENT_PROFILE WHERE STUDY_ID=215 GROUP BY PATIENT)`;
try {
  const preview = (await c.executeDiagramsSql('PatientProfile', sql)) as Json;
  console.log('preview:', String((preview as Json).message ?? '').slice(0, 80));
} catch (error) {
  console.log('preview failed:', error instanceof Error ? error.message.slice(0, 120) : String(error));
}
try {
  const saved = (await c.saveDiagramsData('PatientProfile', sql)) as Json;
  console.log('save:', String((saved as Json).message ?? '').slice(0, 80));
} catch (error) {
  console.log('save failed:', error instanceof Error ? error.message.slice(0, 120) : String(error));
}
console.log('after:', await count());
