/** 探测：单次登录后按 5s 间隔连续上传，定位会话失效边界。 */
import { readFile } from 'node:fs/promises';
import { buildXlsx, RbqmClient } from '../../../packages/platform-viz/src/index.js';
const parseDotEnv = (text: string): Record<string, string> => {
  const bag: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) bag[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return bag;
};
const envs = parseDotEnv(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const client = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await client.login();
const tiny = buildXlsx([['CATEGORY', 'VALUE'], ['a', 1]], 'DATA');
// @ts-expect-error 私有方法，探针专用
const upload = (client as unknown as { uploadXlsx: (n: string, b: Buffer) => Promise<void> }).uploadXlsx.bind(client);
const start = Date.now();
for (const at of [2, 5, 8, 11, 14, 17, 20, 24]) {
  const waitMs = at * 1000 - (Date.now() - start);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  const name = 'VIZ_DYN_sweep' + at + '_' + Math.random().toString(16).slice(2, 8);
  try {
    await upload(name, tiny);
    console.log(`t=+${at}s OK`);
  } catch (error) {
    console.log(`t=+${at}s FAIL:`, error instanceof Error ? error.message : error);
  }
}
