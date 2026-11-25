/** 探测：验证单会话挤占——T2 登录后 T1 是否被踢。 */
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
const mk = () => new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
const t1 = mk();
await t1.login();
const tiny = buildXlsx([['CATEGORY', 'VALUE'], ['a', 1]], 'DATA');
// @ts-expect-error 私有方法
const up1 = (t1 as unknown as { uploadXlsx: (n: string, b: Buffer) => Promise<void> }).uploadXlsx.bind(t1);
await up1('VIZ_DYN_kick_a_' + Math.random().toString(16).slice(2, 8), tiny);
console.log('T1 upload before second login: OK');

const t2 = mk();
await t2.login();
console.log('T2 logged in (same account) — T1 should now be kicked');
// @ts-expect-error 私有方法
const up2 = (t2 as unknown as { uploadXlsx: (n: string, b: Buffer) => Promise<void> }).uploadXlsx.bind(t2);
try {
  await up1('VIZ_DYN_kick_b_' + Math.random().toString(16).slice(2, 8), tiny);
  console.log('T1 upload AFTER second login: OK (no kick)');
} catch (error) {
  console.log('T1 upload AFTER second login: FAIL:', error instanceof Error ? error.message : error);
}
try {
  await up2('VIZ_DYN_kick_c_' + Math.random().toString(16).slice(2, 8), tiny);
  console.log('T2 upload: OK');
} catch (error) {
  console.log('T2 upload: FAIL:', error instanceof Error ? error.message : error);
}
