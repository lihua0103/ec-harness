import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('215');
for (const [id, name] of [['3830', 'PT_AES'], ['3809', 'PT_LABS']] as const) {
  const body = await any.json(`/dynamicdata/getDynamicData?dynamicDataTableId=${id}&pageNo=1&pageSize=5`);
  const d = (body.data ?? {}) as Json;
  console.log(name, 'total=', String(d.total), 'sample=', JSON.stringify(((d.data ?? []) as Json[]).slice(0, 2)).slice(0, 220));
}
const preview = await any.json('/csm/getCsmChartPreviewData?id=1720&patient=' + encodeURIComponent('S-2101') + '&type=1');
console.log('aes preview:', JSON.stringify(preview).slice(0, 400));
