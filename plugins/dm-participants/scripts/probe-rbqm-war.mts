/** 探测：连续 8 轮「登录→立即上传」，观察会话挤占节奏。 */
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
const tiny = buildXlsx([['CATEGORY', 'VALUE'], ['a', 1]], 'DATA');
for (let round = 1; round <= 8; round++) {
  const client = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
  const t0 = Date.now();
  await client.login();
  const loginMs = Date.now() - t0;
  // @ts-expect-error 私有方法
  const up = (client as unknown as { uploadXlsx: (n: string, b: Buffer) => Promise<void> }).uploadXlsx.bind(client);
  try {
    await up('VIZ_DYN_war' + round + '_' + Math.random().toString(16).slice(2, 8), tiny);
    console.log(`round ${round}: login ${loginMs}ms, upload OK`);
  } catch (error) {
    console.log(`round ${round}: login ${loginMs}ms, upload FAIL:`, error instanceof Error ? error.message : error);
  }
  await new Promise((r) => setTimeout(r, 4000));
}
