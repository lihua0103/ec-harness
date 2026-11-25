/**
 * dm-participants → RBQM 参与者档案（PP）落位（配置面，不改 RBQM 任何代码）：
 * canonical 工作簿（import 通道读取）→ 长表数据集（每表 PATIENT + VALUE 列）→
 * saveType 注册动态类型 → saveConfig（scopeType=2 + patientColumn=PATIENT，
 * 满足后端 ChartHelper.PatientMustConfigured 的「参与者字段关联」）→
 * saveLayout（type=2）。布局项 item.type 是预览请求类型，恒 1；PP scope 只活在
 * 保存键（type=2）上。凭据只从环境变量/Windows 用户级注册表读取，不打印不落盘。
 * 运行：cd plugins/dm-participants && ./node_modules/.bin/tsx scripts/place-rbqm-pp.mts [workbook.xlsx]
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { importParticipantsWorkbook, type ImportedParticipants } from '../src/data.js';
import { generateCohortForLabels, labByKey, LABS, type Participant } from '../src/participant-model.js';
import { SINGLE_CHARTS } from '../src/participant-single.js';
import { buildXlsx, RbqmClient, type RbqmDataset, type RbqmType } from '../../../packages/platform-viz/src/index.js';

const PROJECT_ROOT = 'D:/project/company/ec-clinical-dsh';
const ARGS = process.argv.slice(2);
const flag = (name: string): string | null => {
  const index = ARGS.indexOf(name);
  return index >= 0 ? (ARGS[index + 1] ?? null) : null;
};
const WORKBOOK = ARGS.find((arg) => !arg.startsWith('--') && ARGS[ARGS.indexOf(arg) - 1]?.startsWith('--') !== true) ??
  resolve(PROJECT_ROOT, '.runtime/dsh-home/dm-participants/import/cohort-b-e2e.xlsx');
const API_BASE = process.env.RBQM_API ?? 'http://localhost:3333/api/v1';
const UPLOAD_BASE = process.env.RBQM_UPLOAD ?? 'http://10.111.6.155:2222';
// 目标环境：215 = VIZ-VERIFY-2026/PROD（需生成患者登记）；
// 206 = DYDR-524-0516/PROD（localhost:3333 登录默认环境，已有 76 名登记参与者）。
const ENV_ID = flag('--env') ?? '215';
// --from-registry：目标环境已有登记，按登记 label 生成演示队列并绑定（不再写 PATIENT_PROFILE）。
const FROM_REGISTRY = ARGS.includes('--from-registry');
// --registry-only：只写患者登记（依赖已建好的 PT_PATIENTS），跳过图表/布局；
// 解析服务停摆导致新表建不出来时，仍可把登记这一环单独收尾。
const REGISTRY_ONLY = ARGS.includes('--registry-only');
const PAGE_ID = 'pt-page';
const BINDINGS_PATH = resolve(PROJECT_ROOT, `plugins/dm-participants/.runtime/rbqm-pp-bindings-env${ENV_ID}.json`);
// RBQM 项目既有测试账号（用户确认已配置）。这些 .env 自带使用规则：程序解析、仅内存传递、
// 禁止 Read/Grep/cat 或把内容打印进会话/报告——本脚本遵守，仅取值登录，不回显。
const RBQM_DOT_ENV = 'D:/project/company/RBQM/.env';
const RBQM_ENVS_DOT_ENV = 'D:/project/company/RBQM/.env.rbqm-envs';

/** RBQM 按表名复用数据集（同名不重传）：表头或**内容**变化都必须换表名，
 *  否则会继续渲染旧表（实测 consent 仍显示旧里程碑文案、toxshift 缺新列）。
 *  表名按「表头 + 全量行」digest 派生：同输入幂等复用，输入一变自然落到新表。
 *  不删除旧表——旧表是历史快照，删除超出落位脚本的职责。 */
async function ensureDatasetFor(
  client: RbqmClient, name: string, rows: Array<Array<string | number>>, header: string[],
): Promise<RbqmDataset> {
  const digest = createHash('sha1')
    .update(header.join('|') + '#' + JSON.stringify(rows))
    .digest('hex')
    .slice(0, 8);
  const versioned = `${name}_S${digest}`;
  const dataset = await client.ensureDataset(versioned, buildXlsx(rows, versioned), header);
  const missing = header.filter((h) => !dataset.columns[h]);
  if (missing.length) throw new Error(`RBQM_SCHEMA_STALE:${versioned} missing ${missing.join(',')}`);
  return dataset;
}

const toNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

type Sheet = { name: string; rows: Array<Array<string | number>> };
type Json = Record<string, unknown>;

/** 域表 → RBQM 长表（PATIENT + CATEGORY[=维度] + VALUE[=度量]）。非数值 VALUE 跳过并计数，不编造。 */
function longTable(name: string, rows: Record<string, unknown>[], pick: (row: Record<string, unknown>) => [string, string] | null): { sheet: Sheet; skipped: number } {
  const out: Sheet['rows'] = [['PATIENT', 'CATEGORY', 'VALUE']];
  let skipped = 0;
  for (const row of rows) {
    const picked = pick(row);
    if (!picked) {
      skipped++;
      continue;
    }
    out.push([String(row.participantId ?? '').trim(), picked[0], picked[1]]);
  }
  return { sheet: { name, rows: out }, skipped };
}

function labsTable(rows: Record<string, unknown>[]): { sheet: Sheet; skipped: number } {
  const out: Sheet['rows'] = [['PATIENT', 'CATEGORY', 'TEST', 'VALUE']];
  let skipped = 0;
  for (const row of rows) {
    const value = toNumber(row.value);
    if (value === null || !String(row.participantId ?? '').trim()) {
      skipped++;
      continue;
    }
    out.push([String(row.participantId).trim(), String(row.week ?? '').trim(), String(row.analyte ?? '').trim(), value]);
  }
  return { sheet: { name: 'PT_LABS', rows: out }, skipped };
}

/** 参与者主数据 → 患者登记源表（PATIENT_PROFILE 业务列同名列）。
 *  仅填有据可依的列：PATIENT/SITE/STATUS/访视计数来自工作簿事实；COUNTRY/AGE/SEX/
 *  SCORE/ENROLL_DATE 等无来源的留空（后端数值列允许空串），不编造。
 *  PATIENT 列值 = 登记表 label = PP 页下拉选项 = 图表取数过滤键——三处必须同源一致。 */
function patientsTable(participants: Participant[]): Sheet {
  const header = [
    'SCORE',
    'PATIENT',
    'SITE',
    'COUNTRY',
    'AGE',
    'SEX',
    'COMPLETED_VISITS_COUNT',
    'VISITS_COUNT',
    'CURRENT_VISIT',
    'IS_ENTER_NEXT_VISIT',
    'NEXT_VISIT',
    'STATUS',
    'ENROLL_DATE',
  ];
  const standardWeeks = [4, 12, 24, 48];
  const out: Sheet['rows'] = [header];
  for (const participant of participants) {
    const doneWeeks = Object.entries(participant.visits ?? {})
      .filter(([, visit]) => visit.state === 'done')
      .map(([week]) => Number(week))
      .filter((week) => Number.isFinite(week));
    const maxDone = doneWeeks.length > 0 ? Math.max(...doneWeeks) : null;
    const nextWeek = maxDone === null ? null : standardWeeks.find((week) => week > maxDone && week <= participant.weeks) ?? null;
    out.push([
      '',
      participant.id,
      String(participant.site ?? ''),
      '',
      '',
      '',
      String(doneWeeks.length),
      String(participant.weeks ?? ''),
      maxDone === null ? '' : String(maxDone),
      '',
      nextWeek === null ? '' : String(nextWeek),
      String(participant.status ?? ''),
      '',
    ]);
  }
  return { sheet: { name: 'PT_PATIENTS', rows: out }, skipped: 0 };
}

/** 化验宽表：一行 = 一名参与者 × 一个访视周，5 个化验项各占一列。
 *  动态图后端按 Number 列拆系列，宽表才能得到「每个化验项一条线」而不是把项目拼成一条锯齿线。 */
// 表头由化验定义派生（去掉空格：'Serum K' → 'SerumK'），避免显示名与列名对不上导致整列空掉。
const LAB_HEADERS = LABS.map((lab) => lab.name.replace(/\s+/g, ''));
// 工作簿用 key（egfr/k/hb…），生成队列用显示名（eGFR/Serum K…）：两种写法都要认，未知项（如 CRP）跳过不编造。
const LAB_INDEX = new Map<string, number>();
LABS.forEach((lab, index) => {
  for (const alias of [lab.key, lab.name, lab.name.replace(/\s+/g, '')]) {
    LAB_INDEX.set(alias.toLowerCase(), index);
  }
});

function labsWideTable(rows: Record<string, unknown>[]): { sheet: Sheet; skipped: number } {
  const byKey = new Map<string, Map<string, number>>();
  let skipped = 0;
  for (const row of rows) {
    const value = toNumber(row.value);
    const patient = String(row.participantId ?? '').trim();
    const week = String(row.week ?? '').trim();
    const analyte = String(row.analyte ?? '').trim();
    const index = LAB_INDEX.get(analyte.toLowerCase()) ?? -1;
    if (value === null || !patient || !week || index < 0) {
      skipped++;
      continue;
    }
    const key = patient + '|' + week;
    if (!byKey.has(key)) byKey.set(key, new Map());
    byKey.get(key)!.set(String(index), value);
  }
  const out: Sheet['rows'] = [['PATIENT', 'WEEK', ...LAB_HEADERS]];
  for (const [key, values] of byKey) {
    const [patient, week] = key.split('|');
    // 缺测的项留空（后端解析为 null，折线断开），不补 0、不编造。
    out.push([patient!, week!, ...LAB_HEADERS.map((_, index) => values.get(String(index)) ?? '')]);
  }
  return { sheet: { name: 'PT_LABS_WIDE_V2', rows: out }, skipped };
}

/** 生成的演示队列 → 与 canonical 工作簿同形的源行（供同一套长表构建器消费）。 */
function rowsFromParticipants(participants: Participant[]): Record<string, Record<string, unknown>[]> {
  const labs: Record<string, unknown>[] = [];
  const aes: Record<string, unknown>[] = [];
  const visits: Record<string, unknown>[] = [];
  const dose: Record<string, unknown>[] = [];
  for (const participant of participants) {
    for (const [key, points] of Object.entries(participant.lab ?? {})) {
      for (const point of points) {
        if (point.v === null) continue; // 未到期/缺访视的点不编造数值
        labs.push({ participantId: participant.id, analyte: labByKey[key]?.name ?? key, week: point.wk, value: point.v });
      }
    }
    // grade 必须带上：aetl 图按 GRADE 过滤（row[2] !== ''），缺 grade 会整表被滤空。
    for (const event of participant.aes ?? []) aes.push({ participantId: participant.id, week: event.wk, grade: event.grade, term: event.term });
    // state 必须带上（done/missed）；漏访没有 dev，不能因缺 dev 丢掉整行。
    for (const [week, visit] of Object.entries(participant.visits ?? {})) {
      if (visit.state === 'notdue') continue;
      visits.push({ participantId: participant.id, week, state: visit.state, deviationDays: visit.dev ?? null });
    }
    for (const segment of participant.doseSegs ?? []) {
      dose.push({ participantId: participant.id, fromWeek: segment.from, toWeek: segment.to, state: segment.state });
    }
  }
  return { labs, aes, visits, dose };
}

/** 目标数据 SQL 的源表引用与列映射（后端契约，两条都容易踩）：
 *  ① 临时表名 = #<SYSTEM_TABLE_NAME>，而 SYSTEM_TABLE_NAME 由 GetValidString 生成——
 *     它会删掉下划线/空格/点/横线等，所以 PT_PATIENTS → #PTPATIENTS；
 *  ② 临时表由 `SELECT * INTO #X FROM 存储表` 得到，列名是 DATA_1..DATA_n（不是 xlsx 表头），
 *     按上传列序映射到目标业务列。 */
function diagramsSqlFor(targetColumns: string[], sourceTable: string): string {
  const ref = '#' + sourceTable.replace(/[^A-Za-z0-9]/g, '');
  // 空串不能进 numeric 列（Error converting nvarchar to numeric）：一律 NULLIF 成 NULL，
  // 有据可依的值原样保留，缺的列就是 NULL，不补 0、不编造。
  const source = targetColumns.map((_, index) => `NULLIF(DATA_${index + 1},'')`).join(',');
  return `INSERT INTO #PatientProfile(${targetColumns.join(',')}) SELECT ${source} FROM ${ref}`;
}


/** 单人图的数据集表名（与图表 key 对应，前缀 PT_S1_ 表示单人视图）。 */
function chartTableName(chart: { key: string }): string {
  return 'PT_S1_' + chart.key.toUpperCase();
}

/** 按设计稿单人图定义，从参与者模型生成宽表：
 *  一行 = 一名参与者 × 一个维度值（访视周 / AE 周 / 剂量周 / ePRO 周），各系列各占一列。
 *  只填有据可依的值，缺的留空（后端解析为 null，不补 0、不编造）。 */
function singleChartTable(
  chart: { key: string; columns: string[] },
  participants: Participant[],
  sourceRows: Record<string, Record<string, unknown>[]>,
): Sheet {
  const name = chartTableName(chart);
  const header = chart.columns;
  const rows: Sheet['rows'] = [header];
  const push = (values: Array<string | number>): void => {
    rows.push(values);
  };

  if (chart.key === 'labs') {
    // 宽表：PATIENT | WEEK | 5 个化验项
    const byKey = new Map<string, Map<number, number>>();
    for (const row of sourceRows['labs'] ?? []) {
      const value = toNumber(row.value);
      const patient = String(row.participantId ?? '').trim();
      const week = toNumber(row.week);
      const analyte = String(row.analyte ?? '').trim().toLowerCase();
      const index = LAB_INDEX.get(analyte);
      if (value === null || !patient || week === null || index === undefined) continue;
      const key = patient + '|' + week;
      if (!byKey.has(key)) byKey.set(key, new Map());
      byKey.get(key)!.set(index, value);
    }
    for (const [key, values] of byKey) {
      const [patient, week] = key.split('|');
      push([patient!, week!, ...LAB_HEADERS.map((_, index) => values.get(index) ?? '')]);
    }
    return { name, rows };
  }

  if (chart.key === 'aetl') {
    // AE 发生周 + 等级（每行一个 AE）
    for (const row of sourceRows['aes'] ?? []) {
      const patient = String(row.participantId ?? '').trim();
      const week = toNumber(row.week);
      const grade = toNumber(row.grade);
      if (!patient || week === null || grade === null) continue;
      push([patient, week, grade]);
    }
    return { name, rows };
  }

  if (chart.key === 'visits') {
    // 访视周 × 偏差天数，按状态分列（窗口内/超窗/缺失）
    const weeks = ['4', '12', '24', '48'];
    const byPatient = new Map<string, Map<string, Record<string, unknown>>>();
    for (const row of sourceRows['visits'] ?? []) {
      const patient = String(row.participantId ?? '').trim();
      const week = String(row.week ?? '').trim();
      if (!patient || !week) continue;
      if (!byPatient.has(patient)) byPatient.set(patient, new Map());
      byPatient.get(patient)!.set(week, row);
    }
    for (const participant of participants) {
      const visits = byPatient.get(participant.id) ?? new Map();
      for (const week of weeks) {
        const visit = visits.get(week);
        const deviation = toNumber(visit?.deviationDays);
        const state = String(visit?.state ?? '').trim().toLowerCase();
        if (!visit) continue; // 没有该访视记录就不编造
        const inWindow = state === 'done' && deviation !== null && Math.abs(deviation) <= 7 ? deviation : '';
        const outWindow = state === 'done' && deviation !== null && Math.abs(deviation) > 7 ? deviation : '';
        const missed = state === 'missed' ? 0 : '';
        push([participant.id, week, inWindow, outWindow, missed]);
      }
    }
    return { name, rows };
  }

  if (chart.key === 'dose') {
    // 剂量状态按周展开：每周落在 FULL / REDUCED / HELD 哪一档
    const byPatient = new Map<string, Array<Record<string, unknown>>>();
    for (const row of sourceRows['dose'] ?? []) {
      const patient = String(row.participantId ?? '').trim();
      if (!patient) continue;
      if (!byPatient.has(patient)) byPatient.set(patient, []);
      byPatient.get(patient)!.push(row);
    }
    for (const participant of participants) {
      const segments = byPatient.get(participant.id) ?? [];
      const maxWeek = Math.min(48, Math.max(...segments.map((s) => toNumber(s.toWeek) ?? 0), 0));
      for (let week = 0; week <= maxWeek; week += 4) {
        const segment = segments.find((s) => {
          const from = toNumber(s.fromWeek);
          const to = toNumber(s.toWeek);
          return from !== null && to !== null && week >= from && week < to;
        });
        if (!segment) continue;
        const state = String(segment.state ?? '').trim().toLowerCase();
        push([participant.id, week, state === 'full' ? 1 : 0, state === 'reduced' ? 1 : 0, state === 'held' ? 1 : 0]);
      }
    }
    return { name, rows };
  }

  // epro：12 周日记状态
  for (const participant of participants) {
    const states = participant.epro ?? [];
    states.forEach((state, index) => {
      push([
        participant.id,
        index + 1,
        state === 'full' ? 1 : 0,
        state === 'partial' ? 1 : 0,
        state === 'missed' ? 1 : 0,
        state === 'notdue' ? 1 : 0,
      ]);
    });
  }
  return { name, rows };
}

interface ChartDef {
  key: string;
  table: string;
  title: string;
  baseType: string;
  option: Record<string, unknown>;
  scope: { scopeType: 2; patientColumn: string; columnColumn?: string; numberColumns?: string[]; dimensionColumn?: string };
}

const CHARTS: ChartDef[] = [
  {
    key: 'labs',
    table: 'PT_LABS_WIDE_V2',
    title: 'Lab trajectory',
    baseType: 'line',
    option: {
      // 前端 deepMerge 会整体替换数组：直接烘焙 series 会把 builder 注入的数据覆盖成空。
      // 平台既有配方 _bypassBuilder + _dataMap：外观烘焙、类目轴与各系列按列名从数据集注入。
      _bypassBuilder: true,
      _dataMap: { axis: true },
      tooltip: { trigger: 'axis' },
      legend: { show: true, type: 'scroll' },
      grid: { left: 48, right: 24, top: 36, bottom: 32, containLabel: true },
      xAxis: { type: 'category', name: 'Week', data: [] },
      yAxis: { type: 'value' },
      series: LAB_HEADERS.map((name) => ({ type: 'line', name, data: [], connectNulls: false, symbolSize: 5 })),
    },
    scope: { scopeType: 2, patientColumn: 'PATIENT', dimensionColumn: 'WEEK', numberColumns: LAB_HEADERS },
  },
  {
    key: 'aes',
    table: 'PT_AES',
    title: 'Adverse events',
    baseType: 'bar',
    option: {
      // 前端 deepMerge 会整体替换数组：直接烘焙 series 会把 builder 注入的数据覆盖成空。
      // 平台既有配方 _bypassBuilder + _dataMap：外观烘焙、类目轴与 VALUE 系列按数据集注入。
      _bypassBuilder: true,
      _dataMap: { axis: true, series: ['VALUE'] },
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 24, top: 24, bottom: 32, containLabel: true },
      xAxis: { type: 'category', name: 'Term', data: [] },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{ type: 'bar', name: 'VALUE', data: [], barMaxWidth: 28 }],
    },
    scope: { scopeType: 2, patientColumn: 'PATIENT' },
  },
  {
    key: 'visits',
    table: 'PT_VISITS',
    title: 'Visit deviation',
    baseType: 'bar',
    option: {
      // 前端 deepMerge 会整体替换数组：直接烘焙 series 会把 builder 注入的数据覆盖成空。
      // 平台既有配方 _bypassBuilder + _dataMap：外观烘焙、类目轴与 VALUE 系列按数据集注入。
      _bypassBuilder: true,
      _dataMap: { axis: true, series: ['VALUE'] },
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 24, top: 24, bottom: 32, containLabel: true },
      xAxis: { type: 'category', name: 'Week', data: [] },
      yAxis: { type: 'value', name: 'Days' },
      series: [{ type: 'bar', name: 'VALUE', data: [], barMaxWidth: 28 }],
    },
    scope: { scopeType: 2, patientColumn: 'PATIENT' },
  },
  {
    key: 'dose',
    table: 'PT_DOSE',
    title: 'Dose state',
    baseType: 'bar',
    option: {
      // 前端 deepMerge 会整体替换数组：直接烘焙 series 会把 builder 注入的数据覆盖成空。
      // 平台既有配方 _bypassBuilder + _dataMap：外观烘焙、类目轴与 VALUE 系列按数据集注入。
      _bypassBuilder: true,
      _dataMap: { axis: true, series: ['VALUE'] },
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 24, top: 24, bottom: 32, containLabel: true },
      xAxis: { type: 'category', name: 'State', data: [] },
      yAxis: { type: 'value', name: 'Weeks' },
      series: [{ type: 'bar', name: 'VALUE', data: [], barMaxWidth: 28 }],
    },
    scope: { scopeType: 2, patientColumn: 'PATIENT' },
  },
];

async function readSecret(name: string): Promise<string> {
  if (process.env[name]?.trim()) return process.env[name]!.trim();
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile',
    '-Command',
    `[Environment]::GetEnvironmentVariable('${name}','User')`,
  ]);
  return stdout.trim();
}

/** 解析 .env 键值（仅内存，不打印任何值）。 */
function parseDotEnv(text: string): Record<string, string> {
  const bag: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (match) bag[match[1]!] = match[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return bag;
}

async function main(): Promise<void> {
  // 账号候选顺序：显式 env/注册表覆盖 → .env.rbqm-envs 内网账号（本地系统既有已验证账号）→
  // .env admin → demo；值全程不回显。
  const dotenv = parseDotEnv(await readFile(RBQM_DOT_ENV, 'utf8'));
  const envs = parseDotEnv(await readFile(RBQM_ENVS_DOT_ENV, 'utf8'));
  const candidates = [
    { label: 'RBQM_USER override', userName: await readSecret('RBQM_USER'), password: await readSecret('RBQM_PASSWORD') },
    { label: 'RBQM .env.rbqm-envs intranet', userName: envs['RBQM_INTRANET_USER'] ?? '', password: envs['RBQM_INTRANET_PASSWORD'] ?? '' },
    { label: 'RBQM .env admin', userName: dotenv['RBQM_ADMIN_USER'] ?? '', password: dotenv['RBQM_ADMIN_PASSWORD'] ?? '' },
    { label: 'RBQM .env demo', userName: dotenv['RBQM_DEMO_USER'] ?? '', password: dotenv['RBQM_DEMO_PASSWORD'] ?? '' },
  ].filter((candidate) => candidate.userName && candidate.password);
  if (candidates.length === 0) {
    console.error(`no credentials available (checked env RBQM_USER/RBQM_PASSWORD and ${RBQM_DOT_ENV})`);
    process.exit(2);
  }

  let client: RbqmClient | null = null;
  for (const candidate of candidates) {
    const attempt = new RbqmClient({ apiBase: API_BASE, uploadBase: UPLOAD_BASE, userName: candidate.userName, password: candidate.password });
    try {
      await attempt.login();
      client = attempt;
      console.log(`login ok via ${candidate.label} (account name not echoed)`);
      break;
    } catch (error) {
      if (error instanceof Error && error.message === 'RBQM_LOGIN_FAILED') {
        console.log(`login rejected for ${candidate.label}; trying next candidate`);
        continue;
      }
      throw error; // 网络/协议级失败不重试其他账号
    }
  }
  if (!client) {
    console.error('all credential candidates rejected by RBQM login');
    process.exit(3);
  }
  // --env none：保持登录后账号所处的 scope（UI 打开 localhost:3333 看到的就是它），
  // 不调用 saveStudyEnvironment——任何切环境都会离开这个 scope。
  if (ENV_ID === 'none') {
    console.log('environment: keeping the post-login scope (no saveStudyEnvironment call)');
  } else {
    await client.enterEnvironment(ENV_ID);
    console.log('environment entered:', ENV_ID);
  }

  // 数据来源二选一：
  // ① --from-registry：目标环境已有患者登记，按其 label 生成**演示**队列（数值由模型确定性派生，
  //    不是真实测量值），PATIENT 列直接用登记 label，保证下拉/过滤三处同源；
  // ② 默认：导入 canonical 工作簿的真实数据，并另行生成患者登记。
  let participants: Participant[];
  let sourceRows: Record<string, Record<string, unknown>[]>;
  let registryLabels: string[] | null = null;
  if (FROM_REGISTRY) {
    const registry = await client.getPatientRegistry();
    registryLabels = registry.map((row) => String(row.label ?? '')).filter(Boolean);
    if (registryLabels.length === 0) throw new Error('RBQM_REGISTRY_EMPTY: --from-registry 需要目标环境已有登记');
    participants = generateCohortForLabels(registryLabels);
    sourceRows = rowsFromParticipants(participants);
    console.log(`registry-driven demo cohort: ${participants.length} participants keyed to existing registry labels (generated demo values, not measurements)`);
  } else {
    const imported: ImportedParticipants = await importParticipantsWorkbook(WORKBOOK);
    console.log(`workbook imported: ${imported.participants.length} participants, warnings ${imported.warnings.length}`);
    for (const warning of imported.warnings) console.log('  warning:', warning);
    participants = imported.participants;
    sourceRows = imported.sourceRows;
  }

  // 数据集按设计稿单人图定义生成：每张图一张宽表（PATIENT + 维度列 + 各系列数值列）。
  // 后端动态图只按 Number 列拆系列、Dimension[0] 取类目，所以多系列必须宽表。
  // 每张图一张宽表：表头 = chart.columns，行由 chart.buildRows 从参与者模型生成。
  const tables: Array<{ sheet: Sheet; skipped: number }> = SINGLE_CHARTS.map((chart) => ({
    sheet: {
      name: chartTableName(chart),
      rows: [chart.columns, ...chart.buildRows(participants, sourceRows)],
    },
    skipped: 0,
  }));
  if (REGISTRY_ONLY) {
    const sheet = patientsTable(participants).sheet;
    await client.saveDiagramsData('PatientProfile', diagramsSqlFor(sheet.rows[0]!.map(String), 'PT_PATIENTS'));
    console.log('patient registry populated via saveDiagramsData (PatientProfile, persisted)');
    const registry = await client.getPatientRegistry();
    const labels = registry.map((row) => String(row.label ?? '')).filter(Boolean).sort();
    const expected = participants.map((participant) => participant.id).sort();
    const missing = expected.filter((id) => !labels.includes(id));
    if (registry.length === 0) throw new Error('RBQM_REGISTRY_EMPTY');
    if (missing.length > 0) throw new Error('RBQM_REGISTRY_MISMATCH missing=' + missing.slice(0, 5).join(','));
    console.log(`patient registry verified: ${registry.length} rows, all ${expected.length} PATIENT values registered`);
    return;
  }
  for (const { sheet, skipped } of tables) {
    console.log(`table ${sheet.name}: ${sheet.rows.length - 1} data rows, skipped ${skipped} non-numeric/blank`);
    if (sheet.rows.length <= 1) throw new Error(`table ${sheet.name} has no usable rows`);
  }

  // 患者登记源表（仅默认路径需要）：登记写入放在图表落位之后，
  // 这样登记通道若被环境挡住，图表类型/配置/布局仍然真实落位、可单独验收。
  let patientsSheet: Sheet | null = null;
  let patientsTableName = 'PT_PATIENTS';
  if (!FROM_REGISTRY) {
    patientsSheet = patientsTable(participants).sheet;
    console.log(`table PT_PATIENTS: ${patientsSheet.rows.length - 1} data rows`);
    const patientsDataset = await ensureDatasetFor(client, 'PT_PATIENTS', patientsSheet.rows, patientsSheet.rows[0]!.map(String));
    patientsTableName = patientsDataset.tableName;
    console.log(`dataset PT_PATIENTS: id=${patientsDataset.tableId} rows=${patientsSheet.rows.length - 1} table=${patientsTableName}`);
  }

  const bindings: Array<{
    key: string;
    table: string;
    tableId: string;
    typeCode: number;
    configId: number;
    chartName: string;
  }> = [];
  const layout: Array<Record<string, unknown>> = [];
  for (const [index, chart] of SINGLE_CHARTS.entries()) {
    const built = tables.find((item) => item.sheet.name === chartTableName(chart))!;
    const header = built.sheet.rows[0]!.map(String);
    const dataset: RbqmDataset = await ensureDatasetFor(client, chartTableName(chart), built.sheet.rows, header);
    console.log(`dataset ${chartTableName(chart)}: id=${dataset.tableId} columns=${Object.keys(dataset.columns).join(',')}`);
    for (const column of chart.scope.numberColumns) {
      const meta = dataset.columns[column];
      if (!meta || !/number/i.test(meta.type)) {
        throw new Error(`RBQM_NUMBER_COLUMN_NOT_NUMERIC:${chartTableName(chart)}.${column}=${meta?.type ?? 'missing'}`);
      }
    }
    const scope = { scopeType: 2 as const, patientColumn: 'PATIENT', ...chart.scope };
    const type: RbqmType = await client.saveType(`VIZ-PT ${chart.key}`, 'bar', chart.option, scope);
    console.log(`type VIZ-PT ${chart.key}: row=${type.rowId} typeCode=${type.typeCode}`);
    const chartName = `${chart.section} ${chart.title}`;
    const description = FROM_REGISTRY
      ? 'participant profile — generated demo values keyed to registered patients (not measurements)'
      : 'participant profile';
    const configId = await client.saveConfig(`VIZ-PT ${chart.key}`, type.typeCode, dataset, description, scope);
    console.log(`config VIZ-PT ${chart.key}: id=${configId}`);
    layout.push({
      id: configId,
      i: `vizpt_${chart.key}`,
      chartType: type.typeCode,
      chartName,
      des: '',
      type: 1,
      x: (index % 3) * 8,
      y: Math.floor(index / 3) * 10,
      w: 8,
      h: 10,
      static: false,
      moved: false,
      tabs: null,
    });
    bindings.push({ key: chart.key, table: dataset.tableName, tableId: dataset.tableId, typeCode: type.typeCode, configId, chartName });
  }

  // 布局是整页替换语义：先读回既有 PP 布局并保留，把本次 4 张追加到末尾，
  // 不覆盖目标环境里已有的参与者档案设计。
  const existingRaw = (await client.getLayout(2, 1)) as Json | Json[] | null;
  const existingItems = (Array.isArray(existingRaw) ? existingRaw : ((existingRaw as Json | null)?.data ?? [])) as Array<Record<string, unknown>>;
  const kept = existingItems.filter((item) => !String(item.i ?? '').startsWith('vizpt_'));
  const bottom = kept.reduce((max, item) => Math.max(max, Number(item.y ?? 0) + Number(item.h ?? 0)), 0);
  const merged = [
    ...kept,
    ...layout.map((item) => ({ ...item, y: Number(item.y ?? 0) + bottom })),
  ];
  await client.saveLayout(PAGE_ID, merged, 2);
  console.log(`layout saved: pageId=${PAGE_ID} scope=2 kept=${kept.length} added=${layout.length} total=${merged.length}`);

  if (patientsSheet) {
    // 患者登记（链路最后一环）：PATIENT_PROFILE 为空 ⇒ PP 页参与者下拉空 ⇒ chartIds=[]
    // 零预览请求 ⇒「参与者图表加载失败」。通过 PP SQL 脚本契约（executeDiagramsSql，
    // 与前端 sqlScript 功能同一服务端路径）从上传的参与者主表生成登记。
    await client.saveDiagramsData('PatientProfile', diagramsSqlFor(patientsSheet.rows[0]!.map(String), patientsTableName));
    console.log('patient registry populated via saveDiagramsData (PatientProfile, persisted)');
    // 服务端替换语义（尾部 DELETE）走 rbqmExec，该账号对 PATIENT_PROFILE 无 DELETE 权限，
    // 删除静默失效 ⇒ 重复保存会累积重复行 ⇒ 前端 validPatientOptions（label 唯一）整页报
    // 「参与者图表加载失败」。落位后就地在临时表 #PatientProfile 上按 PATIENT 去重，
    // BulkCopy 把干净结果写回真实表（env215 实测 55→28 行有效）。
    await client.saveDiagramsData('PatientProfile',
      'WITH ranked AS (SELECT PATIENT, ROW_NUMBER() OVER (PARTITION BY PATIENT ORDER BY PATIENT) AS rn FROM #PatientProfile) DELETE FROM ranked WHERE rn > 1');
    console.log('registry dedup applied on #PatientProfile');
  }
  // 绑定验证：登记 label 集合必须覆盖上传各表的 PATIENT 列值（PP 页逐参与者过滤键）。
  const registry = await client.getPatientRegistry();
  const labels = registry.map((row) => String(row.label ?? '')).filter(Boolean).sort();
  const expected = participants.map((participant) => participant.id).sort();
  const missing = expected.filter((id) => !labels.includes(id));
  const extra = FROM_REGISTRY ? [] : labels.filter((label) => !expected.includes(label));
  if (registry.length === 0) throw new Error('RBQM_REGISTRY_EMPTY: patient dropdown would stay empty');
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`RBQM_REGISTRY_MISMATCH missing=${missing.slice(0, 5).join(',')} extra=${extra.slice(0, 5).join(',')}`);
  }
  // 替换语义依赖服务端尾部 `DELETE … ID<=maxId`，它走低权限 SQL 账号 rbqmExec；
  // 该账号对 PATIENT_PROFILE 没有 DELETE 权限时删除静默失效，重复保存就会累积重复参与者。
  const distinct = new Set(labels).size;
  if (distinct !== registry.length) {
    throw new Error(
      `RBQM_REGISTRY_DUPLICATED rows=${registry.length} distinct=${distinct}` +
        ' — 服务端替换（DELETE）未生效，通常是 rbqmExec 缺少 PATIENT_PROFILE 的 DELETE 权限，需 DBA 授权',
    );
  }
  console.log(`patient registry verified: ${registry.length} rows, all ${expected.length} uploaded PATIENT values are registered`);

  await mkdir(resolve(BINDINGS_PATH, '..'), { recursive: true });
  await writeFile(
    BINDINGS_PATH,
    JSON.stringify(
      {
        placedAt: new Date().toISOString(),
        dataSource: FROM_REGISTRY ? 'generated demo cohort keyed to existing registry labels' : WORKBOOK,
        participants: participants.length,
        pageId: PAGE_ID,
        envId: ENV_ID,
        charts: bindings,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log('bindings written:', BINDINGS_PATH);
}

await main();
