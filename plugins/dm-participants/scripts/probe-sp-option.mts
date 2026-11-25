/** 只读：SP-* 配置的 option 形态（是否 _bypassBuilder/_dataMap/烘焙数据）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('204');
const cfg = await any.json('/csm/getChartConfigList', { method: 'POST', body: { pageNo: 1, pageSize: 50, chartName: 'SP-', type: 2 } });
const rows = (((cfg.data as Json)?.data ?? []) as Json[]);
for (const r of rows.slice(0, 3)) {
  const detail = await any.json('/csm/getCsmChartDetail?id=' + String(r.id));
  const p = ((detail.data as Json)?.data ?? {}) as Json;
  const style = (p.style ?? {}) as Json;
  const opt = String(style.option ?? style.defaultOption ?? '');
  console.log(`${String((p.fileObj as Json)?.name)}: styleKeys=${Object.keys(style).join(',')} optionLen=${opt.length}`);
  console.log('  head:', opt.slice(0, 220));
}
