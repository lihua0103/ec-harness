/** 探测（只读）：跨研究/环境找 PT_PATIENTS.xlsx 队列行——验证「当前研究由账号服务端状态决定」假设。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';

type Json = Record<string, unknown>;
const parseDotEnv = (text: string): Record<string, string> => {
  const bag: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) bag[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return bag;
};
const envs = parseDotEnv(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const client = new RbqmClient({
  apiBase: 'http://localhost:3333/api/v1',
  uploadBase: 'http://10.111.6.155:2222',
  userName: envs['RBQM_INTRANET_USER'] ?? '',
  password: envs['RBQM_INTRANET_PASSWORD'] ?? '',
});
await client.login();
const anyClient = client as unknown as { token: string; json: (p: string, o?: Json) => Promise<Json> };
const studies = (await anyClient.json('/study/getUserStudyList', { method: 'POST', body: { pageNo: 1, pageSize: 50 } })) as Json;
const rows = (((studies.data as Json)?.data ?? []) as Json[]);
for (const study of rows) {
  const envList = (study.studyEnvironment ?? []) as Json[];
  for (const env of envList) {
    await client.enterEnvironment(String(env.value));
    const list = await anyClient.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=100');
    const data = (list.data ?? {}) as Json;
    const files = ((data.data ?? []) as Json[]);
    const hit = files.filter((f) => /PATIENT/i.test(String(f.fileName ?? '')));
    const newest = files.slice(0, 2).map((f) => `${String(f.fileName)} st=${String(f.fileStatus)} ${String(f.creatTime).slice(0, 19)}`);
    console.log(`${String(study.studyName)} / ${String(env.label)} (env ${String(env.value)}): total=${String(data.total)} ${hit.length ? '>>> ' + hit.map((f) => `${String(f.fileName)} st=${String(f.fileStatus)} ${String(f.creatTime).slice(0, 19)}`).join(' | ') : ''}`);
    if (!hit.length) console.log('    newest:', newest.join(' | '));
  }
}