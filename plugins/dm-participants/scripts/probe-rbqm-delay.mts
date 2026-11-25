/** 探测：登录→进环境→等 N 秒→上传，验证是否时间敏感（无凭据回显）。 */
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
const delay = Number(process.argv[2] ?? '25');
const envs = parseDotEnv(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const client = new RbqmClient({ apiBase: 'http://localhost:3333/api/v1', uploadBase: 'http://10.111.6.155:2222', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' });
await client.login();
await client.enterEnvironment('215');
const tiny = buildXlsx([['CATEGORY', 'VALUE'], ['a', 1], ['b', 2]], 'DATA');
// @ts-expect-error 私有方法，探针专用
const upload = (client as unknown as { uploadXlsx: (n: string, b: Buffer) => Promise<void> }).uploadXlsx.bind(client);
const name = 'VIZ_DYN_delaytest_' + Math.random().toString(16).slice(2, 10);
console.log('sleeping', delay, 's then uploading', name);
await new Promise((r) => setTimeout(r, delay * 1000));
try {
  await upload(name, tiny);
  console.log('upload OK after', delay, 's');
} catch (error) {
  console.log('upload FAILED after', delay, 's:', error instanceof Error ? error.message : error);
}
