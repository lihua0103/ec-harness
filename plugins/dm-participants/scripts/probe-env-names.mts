/** 只读：把 env id 映射回「研究名 / 环境标签」。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
const list = await any.json('/study/getUserStudyList', { method: 'POST', body: { pageNo: 1, pageSize: 60 } });
const rows = (((list.data as Json)?.data ?? []) as Json[]);
const want = ['215', '204', '206', '205'];
for (const study of rows) {
  for (const env of ((study.studyEnvironment ?? []) as Json[])) {
    if (want.includes(String(env.value))) {
      console.log(`env ${String(env.value)} = ${String(study.studyName)} #${String(study.id)} / ${String(env.label)}`);
    }
  }
}
