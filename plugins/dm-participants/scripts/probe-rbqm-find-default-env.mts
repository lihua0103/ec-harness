/** 只读：按指纹（队列 24 + 登记 76）定位登录后默认环境的真实 id。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
const list = await any.json('/study/getUserStudyList', { method: 'POST', body: { pageNo: 1, pageSize: 60 } });
const studies = (((list.data as Json)?.data ?? []) as Json[]);
for (const study of studies) {
  for (const env of ((study.studyEnvironment ?? []) as Json[])) {
    await c.enterEnvironment(String(env.value));
    const reg = await c.getPatientRegistry();
    if (reg.length !== 76) continue;
    const files = await any.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=1');
    const total = Number(((files.data ?? {}) as Json).total ?? 0);
    console.log(`MATCH: ${String(study.studyName)} #${String(study.id)} / ${String(env.label)} env=${String(env.value)} queue=${total} registry=${reg.length} first=${String(reg[0]?.label)}`);
  }
}
console.log('scan done');
