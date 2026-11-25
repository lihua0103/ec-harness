/** 只读：用 dashboard 信息认出登录后默认研究/环境的名字。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
const dash = await any.json('/study/getStudyDashboardInfo');
console.log('dashboard:', JSON.stringify(dash).slice(0, 600));
const files = await any.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=3');
console.log('queue:', JSON.stringify(((files.data ?? {}) as Json).total), ((files.data as Json)?.data as Json[])?.map((f) => String(f.fileName)).join(','));
const reg = await c.getPatientRegistry();
console.log('registry:', reg.length, reg[0]?.label);
