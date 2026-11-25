/** 探测（只读）：遍历 VAL 全部研究×环境，找患者档案（PP）有真实数据的参考环境。 */
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
const rawUrl = (envs['RBQM_VAL_URL'] ?? '').replace(/\/+$/, '');
const host = rawUrl.replace(/^https?:\/\//, '').split('/')[0]!;
const apiBase = 'https://rbqmapival.' + host.split('.').slice(1).join('.') + '/api/v1';
const client = new RbqmClient({
  apiBase,
  uploadBase: 'https://rbqmuploadval.' + host.split('.').slice(1).join('.'),
  userName: envs['RBQM_VAL_USER'] ?? '',
  password: envs['RBQM_VAL_PASSWORD'] ?? '',
});
await client.login();
const anyClient = client as unknown as { token: string };
const headers = (): Json => ({
  'content-type': 'application/json',
  'RBQM-language': 'en',
  Authorization: 'Bearer ' + anyClient.token,
});
const get = async (path: string): Promise<Json> => (await fetch(apiBase + path, { headers: headers() }).then((r) => r.json())) as Json;
const post = async (path: string, body: unknown): Promise<Json> =>
  (await fetch(apiBase + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) }).then((r) => r.json())) as Json;

const studyList = await post('/study/getUserStudyList', { pageNo: 1, pageSize: 50 });
const studies = (((studyList.data as Json | undefined)?.data ?? []) as Json[]).filter(Boolean);
for (const study of studies) {
  const studyName = String(study['studyName'] ?? '');
  for (const env of (study['studyEnvironment'] ?? []) as Json[]) {
    const envId = String(env['value'] ?? '');
    const envName = String(env['label'] ?? '');
    await client.enterEnvironment(envId);
    const patients = await get('/patientProfile/getPatientProfile');
    const pData = patients.data as Json | undefined;
    const patientRows = ((Array.isArray(pData) ? pData : (pData as Json | undefined)?.data) as Json[] | undefined) ?? [];
    const configs = await post('/csm/getChartConfigList', { pageNo: 1, pageSize: 20, type: 2 });
    const configRows = ((configs.data as Json | undefined)?.data ?? []) as Json[];
    const layout = await client.getLayout(2, 1);
    const layoutRows = ((layout as Json | undefined)?.data ?? []) as Json[];
    const scripts = await get('/sqlScript/getSqlScriptList?diagramsKey=PatientProfile');
    const scriptRows = ((scripts.data as Json | undefined)?.data ?? []) as Json[];
    const hit = patientRows.length > 0 || configRows.length > 0 || layoutRows.length > 0 || scriptRows.length > 0;
    console.log(
      `${hit ? '>>> ' : '    '}${studyName} ${envName} (env ${envId}): patients=${patientRows.length} ppConfigs=${configRows.length} ppLayout=${layoutRows.length} ppScripts=${scriptRows.length}`,
    );
  }
}
