import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('204');
const list = await any.json('/chartType/getChartTypeList', { method: 'POST', body: { pageNo: 1, pageSize: 10, chartName: 'VIZ-PT' } });
for (const t of (((list.data as Json)?.data ?? []) as Json[])) {
  const opt = String(t.defaultOption ?? '');
  let ok = true;
  try { JSON.parse(opt); } catch (e) { ok = false; }
  console.log(`${String(t.chartName)} code=${String(t.typeCode)} jsonOk=${ok} len=${opt.length}`);
  if (!ok) console.log('  raw:', opt.slice(0, 400));
}
const detail = await any.json('/csm/getCsmChartDetail?id=1719');
const p = ((detail.data as Json)?.data ?? {}) as Json;
console.log('config 1719 fieldList.number:', JSON.stringify((p.fieldList as Json)?.number).slice(0, 400));
console.log('config 1719 fileObj:', JSON.stringify(p.fileObj).slice(0, 200));
