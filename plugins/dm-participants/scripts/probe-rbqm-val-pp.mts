/** 探测（只读）：VAL 参考环境的参与者档案链路形态——目标表结构、SQL 脚本、配置、患者登记、布局。
 *  凭据从 .env.rbqm-envs 由本进程解析，仅内存使用，不回显任何值。 */
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
// VAL 网关拆两台主机（前端打包产物 baseURL 实证）：rbqmapival=API、rbqmuploadval=文件。
const rawUrl = (envs['RBQM_VAL_URL'] ?? '').replace(/\/+$/, '');
const host = rawUrl.replace(/^https?:\/\//, '').split('/')[0]!;
const apiBase = 'https://rbqmapival.' + host.split('.').slice(1).join('.') + '/api/v1';
const uploadBase = 'https://rbqmuploadval.' + host.split('.').slice(1).join('.');
const client = new RbqmClient({
  apiBase,
  uploadBase,
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

// 1. 研究与环境清单
const studyList = await post('/study/getUserStudyList', { pageNo: 1, pageSize: 50 });
console.log('getUserStudyList raw:', JSON.stringify(studyList).slice(0, 700));
const studies = (((studyList.data as Json | undefined)?.data ?? []) as Json[]).filter(Boolean);
console.log('VAL studies:', studies.length);
const flatten: Array<{ study: string; studyId: string; envId: string; envName: string }> = [];
for (const study of studies) {
  const studyId = String(study['sTUDY_ID'] ?? study['studyId'] ?? study['id'] ?? '');
  const studyName = String(study['sTUDY_NAME'] ?? study['studyName'] ?? study['name'] ?? '');
  const envsOf = (study['studyEnvironment'] ?? []) as Json[];
  for (const env of envsOf) {
    flatten.push({ study: studyName, studyId, envId: String(env['value'] ?? ''), envName: String(env['label'] ?? '') });
  }
}
// 优先肾病参考项目；同项目内优先 PROD（数据在 PROD 环境）。
const renal = flatten.filter((row) => /CKD|IGAN|DKD/i.test(row.study));
const pool = renal.length > 0 ? renal : flatten;
const target = pool.find((row) => /PROD/i.test(row.envName)) ?? pool[0]!;
for (const row of pool.slice(0, 12)) console.log(`  ${row.study} | studyId=${row.studyId} envId=${row.envId} env=${row.envName.slice(0, 30)}`);
if (!target) throw new Error('VAL_NO_ENVIRONMENT_DISCOVERED');
console.log('enter env:', target.envId, '(' + target.envName.slice(0, 30) + ')');
await client.enterEnvironment(target.envId);

// 3. 目标数据（Diagrams）清单：键名 → 物理表名
const diagrams = await get('/sqlScript/getDiagramsList');
const diagramRows = ((diagrams.data as Json | undefined)?.data ?? []) as Json[];
console.log('diagrams list:', diagramRows.length);
for (const row of diagramRows) {
  console.log(`  key=${String(row['key'])} table=${String(row['tableName'])} name=${String(row['diagramsName']).slice(0, 30)}`);
}

// 4. PatientProfile 目标表列结构（executeDiagramsSql 结果集按此列序映射）
const tableInfo = await get('/sqlScript/getDiagramsTableInfo?diagramsKey=PatientProfile&pageNo=1&pageSize=5');
const info = (tableInfo.data ?? {}) as Json;
console.log('PatientProfile tableName:', String(info['tableName'] ?? ''));
const columns = (info['columnData'] ?? []) as Json[];
console.log('PatientProfile columns:', columns.map((c) => `${String(c['prop'])}:${String(c['dataType'])}`).join(', '));

// 5. PatientProfile 的 SQL 脚本历史（学这里：登记怎么生成的）
const scripts = await get('/sqlScript/getSqlScriptList?diagramsKey=PatientProfile');
const scriptRows = ((scripts.data as Json | undefined)?.data ?? []) as Json[];
console.log('PatientProfile sql scripts:', scriptRows.length);
for (const row of scriptRows.slice(0, 8)) {
  console.log('  ---remark:', String(row['rEMARK'] ?? row['remark'] ?? '').slice(0, 60));
  console.log('  sql:', String(row['sQL_SCRIPT'] ?? row['sql'] ?? '').replace(/\s+/g, ' ').slice(0, 600));
}

// 6. PP 图表配置清单（type=2）
const configs = await post('/csm/getChartConfigList', { pageNo: 1, pageSize: 20, type: 2 });
const configRows = ((configs.data as Json | undefined)?.data ?? []) as Json[];
console.log('PP configs(type=2):', configRows.length);
for (const row of configRows.slice(0, 10)) {
  console.log(`  id=${String(row['id'])} name=${String(row['name'] ?? row['chartName']).slice(0, 40)} chartType=${String(row['chartType'] ?? '')}`);
}

// 7. 患者登记行形状（只取前 2 行、截断，不批量导出）
const patients = await get('/patientProfile/getPatientProfile');
const pData = patients.data as Json | undefined;
const patientRows = ((Array.isArray(pData) ? pData : (pData as Json | undefined)?.data) as Json[] | undefined) ?? [];
console.log('patient registry rows:', patientRows.length);
for (const row of patientRows.slice(0, 2)) console.log('  keys:', Object.keys(row).join(','), '| sample:', JSON.stringify(row).slice(0, 260));

// 8. PP 布局
const layout = await client.getLayout(2, 1);
console.log('PP layout(type=2,pageType=1):', JSON.stringify(layout).slice(0, 500));
