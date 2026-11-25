/** 只读验证：saveDiagramsData 是否「先建临时表→执行SQL→BulkCopy 回真实表」，
 *  因此 DELETE 真实表会被随后的 BulkCopy 覆盖（行数不变）。不删任何真实数据。 */
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
INSERT INTO #PatientProfile(PATIENT) SELECT 's215=' + CAST((SELECT COUNT(*) FROM PATIENT_PROFILE WHERE STUDY_ID=215) AS varchar(10))`)) as Json;
  console.log(tag, String(((((r.data ?? []) as Json[])[0] ?? {}) as Json).patient ?? ''));
};
await snapshot('before:');
// 关键实验：只在临时表里删（不碰真实表），看 saveDiagramsData 是否把临时表内容写回真实表
try {
  const res = (await c.saveDiagramsData('PatientProfile', `DELETE FROM #PatientProfile WHERE PATIENT='S-2101'`)) as Json;
  console.log('save with temp-only delete:', String((res as Json).message ?? '').slice(0, 80));
} catch (e) {
  console.log('save failed:', e instanceof Error ? e.message.slice(0, 120) : String(e));
}
await snapshot('after :');
