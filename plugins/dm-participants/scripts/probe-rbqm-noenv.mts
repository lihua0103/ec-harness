/** 探测：登录→等 25s→上传（不进环境），隔离 enterEnvironment 影响。 */
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
const name = 'VIZ_DYN_noenv_' + Math.random().toString(16).slice(2, 10);
console.log('sleeping 25s then uploading', name, '(no enterEnvironment)');
await new Promise((r) => setTimeout(r, 25000));
try {
  await upload(name, tiny);
  console.log('upload OK (no env)');
} catch (error) {
  console.log('upload FAILED:', error instanceof Error ? error.message : error);
}
