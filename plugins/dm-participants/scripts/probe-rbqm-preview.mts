/** 只读：看 PP 预览返回的数据形状（截断，不回传大量原始行）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('204');
const reg = await c.getPatientRegistry();
const patient = String(reg[0]?.label ?? '');
for (const id of [1719, 1720]) {
  const body = await any.json(`/csm/getCsmChartPreviewData?id=${id}&patient=${encodeURIComponent(patient)}&type=1`);
  console.log(`config ${id} patient ${patient}:`, JSON.stringify(body).slice(0, 800));
}
