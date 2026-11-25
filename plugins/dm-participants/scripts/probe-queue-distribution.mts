/** 队列状态分布 + 是否有 st=3（处理中，说明 worker 活着但卡住）+ 超 200 列失败项。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('215');
const all: Json[] = [];
let total = 0;
for (let page = 1; page <= 6; page++) {
  const body = await any.json(`/dynamicdata/getDynamicDataFileList?pageNo=${page}&pageSize=100`);
  const d = (body.data ?? {}) as Json;
  total = Number(d.total ?? total);
  const rows = (d.data ?? []) as Json[];
  all.push(...rows);
  if (all.length >= total || rows.length === 0) break;
}
const byStatus = new Map<string, number>();
for (const r of all) byStatus.set(String(r.fileStatus), (byStatus.get(String(r.fileStatus)) ?? 0) + 1);
console.log('total:', total, '| by status:', [...byStatus.entries()].sort().map(([k, v]) => `st${k}=${v}`).join(' '));
console.log('st=3 (processing):', all.filter((r) => String(r.fileStatus) === '3').map((r) => String(r.fileName)).join(', ') || '(none)');
const over200 = all.filter((r) => JSON.stringify(r.failureFileList ?? '').includes('GreaterThan200'));
console.log('over-200-column failures:', over200.length, over200.map((r) => String(r.fileName)).join(', '));
console.log('st=1 files:', all.filter((r) => String(r.fileStatus) === '1').map((r) => `${String(r.fileName)}@${String(r.creatTime).slice(11, 19)}`).join(' | '));
