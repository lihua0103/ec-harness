/** 只读：PT_PATIENTS 到底有没有行（截断输出，不回传大量原始数据）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
await c.enterEnvironment('215');
const body = await any.json('/dynamicdata/getDynamicData?dynamicDataTableId=3829&pageNo=1&pageSize=3');
const data = (body.data ?? {}) as Json;
console.log('code:', String(body.code), 'total:', String(data.total));
const rows = ((data.data ?? []) as Json[]);
console.log('first row keys:', rows[0] ? Object.keys(rows[0]).slice(0, 16).join(',') : '(none)');
console.log('first row sample:', JSON.stringify(rows[0] ?? {}).slice(0, 300));
