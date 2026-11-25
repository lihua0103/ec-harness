import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('215');
const list = await any.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=15');
for (const f of (((list.data as Json)?.data ?? []) as Json[])) {
  console.log(`${String(f.fileName)} st=${String(f.fileStatus)} total=${String(f.totalCount)} finish=${String(f.finishCount)} fail=${String(f.failCount)} ${String(f.creatTime).slice(0,19)} fails=${JSON.stringify(f.failureFileList ?? null).slice(0,160)}`);
}
console.log('tree PT_:', (await c.listDatasetNames()).filter((n) => /PT_/.test(n)).join(' | '));
