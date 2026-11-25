/** 只读：反复确认 env206 的登记是否稳定（排查同账号其他会话切环境的竞态）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await c.login();
for (let i = 0; i < 4; i++) {
  await c.enterEnvironment('206');
  const reg = await c.getPatientRegistry();
  const files = await any.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=1');
  console.log(`round ${i}: registry=${reg.length} queueTotal=${String(((files.data ?? {}) as Json).total)} first=${reg[0]?.label ?? '-'}`);
  await new Promise((r) => setTimeout(r, 2000));
}
