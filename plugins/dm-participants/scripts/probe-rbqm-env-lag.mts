/** 只读：检查 saveStudyEnvironment 是否存在生效延迟（切环境后立刻读 vs 等待后读）。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';
type Json = Record<string, unknown>;
const parse = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const c = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const any = c as unknown as { json: (p: string, o?: Json) => Promise<Json> };
const snap = async (tag: string) => {
  const files = await any.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=1');
  const reg = await c.getPatientRegistry();
  console.log(`${tag}: queue=${String(((files.data ?? {}) as Json).total)} registry=${reg.length} firstLabel=${reg[0]?.label ?? '-'}`);
};
await c.login();
await snap('after-login(default)');
for (const env of ['215', '206', '205']) {
  await c.enterEnvironment(env);
  await snap(`env${env} immediate`);
  await new Promise((r) => setTimeout(r, 3000));
  await snap(`env${env} +3s`);
}
