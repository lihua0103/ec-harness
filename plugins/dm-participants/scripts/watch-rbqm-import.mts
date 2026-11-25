/** 只读守望：等解析 worker 把 PT_LABS_WIDE_V2 消费到终态。
 *  st=4 → exit 0（可以接着落位）；st=5 → exit 2（解析失败，带 failReason）；超 20 分钟 → exit 3。
 *  期间只读队列，不上传、不改配置。 */
import { readFile } from 'node:fs/promises';
import { RbqmClient } from '../../../packages/platform-viz/src/index.js';

type Json = Record<string, unknown>;
const TARGET = process.argv[2] ?? 'PT_LABS_WIDE_V2.xlsx';
const parse = (t: string) =>
  Object.fromEntries(
    t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean)
      .map((m) => [m![1]!, m![2]!.trim().replace(/^['"]|['"]$/g, '')]),
  );
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const client = new RbqmClient({
  apiBase: 'http://localhost:3333/api/v1',
  uploadBase: 'http://10.111.6.155:2222',
  userName: envs['RBQM_INTRANET_USER'] ?? '',
  password: envs['RBQM_INTRANET_PASSWORD'] ?? '',
});
const any = client as unknown as { json: (p: string, o?: Json) => Promise<Json> };
await client.login();
await client.enterEnvironment('215');

let last = '';
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    const body = await any.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=30');
    const rows = (((body.data ?? {}) as Json).data ?? []) as Json[];
    const row = rows.find((r) => String(r.fileName ?? '') === TARGET);
    const status = row ? String(row.fileStatus ?? '') : 'absent';
    if (status !== last) {
      console.log(`${new Date().toISOString().slice(11, 19)} ${TARGET} fileStatus=${status}`);
      last = status;
    }
    if (status === '4') {
      console.log('IMPORT_DONE: worker consumed the file, table should exist now');
      process.exit(0);
    }
    if (status === '5' || status === '2') {
      console.log('IMPORT_FAILED: ' + JSON.stringify(row?.failureFileList ?? null).slice(0, 300));
      process.exit(2);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== last) {
      console.log(`${new Date().toISOString().slice(11, 19)} probe error: ${message.slice(0, 120)}`);
      last = message;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 15000));
}
console.log('WATCH_TIMEOUT: worker still has not consumed the file after 20 minutes');
process.exit(3);