/** Read-only migration inventory for the old workbench records (T10).
 *
 *  This module never writes: it opens the control-plane SQLite file read-only and counts what a
 *  migration would carry over, so an operator can compare the numbers before anything is changed.
 *  Old browser-local records are parsed as data; a corrupt or partial record is counted and kept
 *  out of the totals rather than invented. Run activities that lived only in memory are reported
 *  as absent, never reconstructed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface BrowserStorageSummary {
  kind: 'none' | 'v4' | 'v3' | 'unknown';
  projects: number;
  works: number;
  inputs: number;
  messages: number;
  drafts: number;
  readOnlyWorks: number;
  recovery: number;
  earliest?: string;
  latest?: string;
  error?: string;
}

export interface MigratedWorkRow {
  workId: string;
  title: string;
  appId: string;
  appVersion: string;
  state: string;
  projectId: string;
  sessionId: string | null;
  domainId: string | null;
  runs: number;
  artifacts: number;
  /** Read-only migration decision for this Work. */
  decision: 'verified-session' | 'no-session-read-only' | 'unknown-session';
}

export interface ControlStoreSummary {
  status: 'MISSING' | 'OK' | 'UNREADABLE';
  counts: Record<string, number>;
  works: MigratedWorkRow[];
  unboundWorks: number;
  /** Read-only migration decisions: verified session / read-only retained / unknown. */
  decisions: { verifiedSession: number; readOnly: number; unknownSession: number };
  /** Stable digest of work/run identities and states, so two dry-runs can be compared. */
  digest: string;
  error?: string;
}

export interface MigrationSummary {
  dryRun: true;
  generatedAt: string;
  controlStore: ControlStoreSummary;
  browserStorage: BrowserStorageSummary;
  notes: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

function storageState(value: unknown): unknown {
  let current = value;
  if (typeof current === 'string') current = parseJson(current);
  if (isObject(current)) {
    // A localStorage dump: prefer the newest prototype key, fall back to the legacy one.
    for (const key of ['emerald.dsh.platform.prototype.v4', 'emerald.dsh.platform.prototype.v3']) {
      const entry = current[key];
      if (typeof entry === 'string') {
        const parsed = parseJson(entry);
        if (parsed !== undefined) return parsed;
      }
    }
  }
  return current;
}

/** Summarize an exported browser-local workbench state (v4 preferred, v3 accepted). */
export function summarizeBrowserStorage(raw: unknown): BrowserStorageSummary {
  const empty: BrowserStorageSummary = {
    kind: 'none', projects: 0, works: 0, inputs: 0, messages: 0, drafts: 0, readOnlyWorks: 0, recovery: 0,
  };
  if (raw === undefined || raw === null || raw === '') return empty;
  const value = storageState(raw);
  if (!isObject(value)) return { ...empty, kind: 'unknown', error: '记录不是可识别的 JSON 对象。' };
  if (value.version === 4 && Array.isArray(value.works) && Array.isArray(value.projects)) {
    const works = value.works.filter(isObject);
    const times = works.map((work) => work.createdAt).filter((time): time is string => typeof time === 'string').sort();
    return {
      kind: 'v4',
      projects: value.projects.length,
      works: works.length,
      inputs: works.reduce((total, work) => total + asArray(work.inputs).length, 0),
      messages: works.reduce((total, work) => total + asArray(work.messages).length, 0),
      drafts: isObject(value.drafts) ? Object.keys(value.drafts).length : 0,
      readOnlyWorks: works.filter((work) => typeof work.readOnlyReason === 'string' && work.readOnlyReason.length > 0).length,
      recovery: asArray(value.recovery).length,
      ...(times.length ? { earliest: times[0], latest: times.at(-1) } : {}),
    };
  }
  if (value.version === 3 && Array.isArray(value.tasks)) {
    const tasks = value.tasks.filter(isObject);
    const times = tasks.map((task) => task.createdAt).filter((time): time is string => typeof time === 'string').sort();
    return {
      kind: 'v3',
      projects: asArray(value.projects).length,
      works: tasks.length,
      inputs: tasks.reduce((total, task) => total + (typeof task.request === 'string' && task.request ? 1 : 0), 0),
      messages: tasks.reduce((total, task) => total + asArray(task.messages).length, 0),
      drafts: isObject(value.draft) ? 1 : 0,
      readOnlyWorks: tasks.filter((task) => task.status === 'stopped' || task.status === 'sample').length,
      recovery: 0,
      ...(times.length ? { earliest: times[0], latest: times.at(-1) } : {}),
    };
  }
  return { ...empty, kind: 'unknown', error: '记录版本不是可迁移的 v4 或 v3。' };
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name?: string } | undefined;
  return row?.name === name;
}

function count(db: DatabaseSync, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

/** Whether the DSH sessions home holds a durable directory for this session id. */
function sessionDirectoryExists(sessionsHome: string | undefined, sessionId: string): boolean {
  if (!sessionsHome || !existsSync(sessionsHome)) return false;
  try {
    for (const workspace of readdirSync(sessionsHome)) {
      const candidate = join(sessionsHome, workspace, sessionId);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Read-only inventory of the control-plane store; a missing file is a real "nothing here". */
export function summarizeControlStore(storePath: string, sessionsHome?: string): ControlStoreSummary {
  if (!existsSync(storePath)) {
    return {
      status: 'MISSING', counts: {}, works: [], unboundWorks: 0, decisions: { verifiedSession: 0, readOnly: 0, unknownSession: 0 },
      digest: createHash('sha256').update('missing').digest('hex'),
      error: '控制面库不存在；没有可迁移的运行记录。',
    };
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(storePath, { readOnly: true, allowExtension: false });
    const counts: Record<string, number> = {};
    for (const table of [
      'projects', 'project_workspaces', 'works', 'runs', 'run_inputs', 'run_artifacts',
      'run_events', 'run_interactions', 'audit_events', 'work_drafts', 'work_session_bindings',
      'submissions', 'execution_domains', 'input_baselines', 'app_releases', 'model_catalog',
    ]) {
      if (tableExists(db, table)) counts[table] = count(db, table);
    }
    const body = (value: unknown): Record<string, unknown> => {
      if (typeof value !== 'string') return {};
      const parsed = parseJson(value);
      return isObject(parsed) ? parsed : {};
    };
    const rows = tableExists(db, 'works')
      ? db.prepare('SELECT work_id, project_id, app_id, app_version, state, body FROM works ORDER BY work_id').all() as Array<Record<string, unknown>>
      : [];
    const bindingStatement = tableExists(db, 'work_session_bindings')
      ? db.prepare("SELECT domain_id, session_id FROM work_session_bindings WHERE work_id=? ORDER BY CASE relation WHEN 'primary' THEN 0 ELSE 1 END, created_at DESC LIMIT 1")
      : undefined;
    const runCount = tableExists(db, 'runs')
      ? db.prepare('SELECT COUNT(*) AS count FROM runs WHERE work_id=?')
      : undefined;
    const artifactCount = tableExists(db, 'run_artifacts')
      ? db.prepare('SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id IN (SELECT run_id FROM runs WHERE work_id=?)')
      : undefined;
    const works: MigratedWorkRow[] = [];
    const digestLines: string[] = [];
    const decisions = { verifiedSession: 0, readOnly: 0, unknownSession: 0 };
    for (const row of rows) {
      const workId = String(row.work_id);
      const parsed = body(row.body);
      const binding = bindingStatement?.get(workId) as { domain_id?: string; session_id?: string } | undefined;
      const sessionId = binding?.session_id ?? null;
      const decision: MigratedWorkRow['decision'] = sessionId === null
        ? 'no-session-read-only'
        : sessionDirectoryExists(sessionsHome, sessionId)
          ? 'verified-session'
          : 'unknown-session';
      if (decision === 'verified-session') decisions.verifiedSession += 1;
      else if (decision === 'no-session-read-only') decisions.readOnly += 1;
      else decisions.unknownSession += 1;
      works.push({
        workId,
        title: typeof parsed.title === 'string' && parsed.title ? parsed.title : workId,
        appId: String(row.app_id),
        appVersion: String(row.app_version),
        state: String(row.state),
        projectId: String(row.project_id),
        sessionId,
        domainId: binding?.domain_id ?? null,
        runs: runCount ? Number((runCount.get(workId) as { count: number }).count) : 0,
        artifacts: artifactCount ? Number((artifactCount.get(workId) as { count: number }).count) : 0,
        decision,
      });
      digestLines.push(`work:${workId}:${row.state}`);
      if (sessionId !== null) digestLines.push(`binding:${workId}:${sessionId}:${binding?.domain_id ?? ''}:${decision}`);
    }
    if (tableExists(db, 'runs')) {
      for (const row of db.prepare('SELECT run_id, state FROM runs ORDER BY run_id').all() as Array<Record<string, unknown>>) {
        digestLines.push(`run:${String(row.run_id)}:${String(row.state)}`);
      }
    }
    return {
      status: 'OK',
      counts,
      works,
      unboundWorks: works.filter((work) => work.sessionId === null).length,
      decisions,
      digest: createHash('sha256').update(digestLines.sort().join('\n')).digest('hex'),
    };
  } catch (error) {
    return {
      status: 'UNREADABLE', counts: {}, works: [], unboundWorks: 0, decisions: { verifiedSession: 0, readOnly: 0, unknownSession: 0 },
      digest: createHash('sha256').update('unreadable').digest('hex'),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

/** Build one dry-run report; no file, database row or browser record is changed. */
export function summarizeMigration(input: {
  storePath: string;
  browserStorage?: unknown;
  sessionsHome?: string;
  now?: string;
}): MigrationSummary {
  const controlStore = summarizeControlStore(input.storePath, input.sessionsHome);
  const browserStorage = summarizeBrowserStorage(input.browserStorage);
  const notes = [
    'dry-run：未创建、更新或删除任何记录。',
    '旧 Work 没有原生 Session 关联时只能只读展示；必须由用户确认后才创建带来源的新 Session。',
    '内存中的活动记录不在运行正文中，迁移不补造历史事件。',
  ];
  if (controlStore.status === 'MISSING') notes.push('控制面库不存在：这是空部署，不是迁移失败。');
  if (controlStore.status === 'UNREADABLE') notes.push('控制面库不可读：修复文件或权限后再试，不能按空库处理。');
  if (controlStore.unboundWorks > 0) notes.push(`${controlStore.unboundWorks} 个旧 Work 尚未绑定原生会话，迁移时需只读展示。`);
  if (controlStore.status === 'OK') {
    notes.push(`迁移判定：可验证 Session ${controlStore.decisions.verifiedSession} 个；无 Session 只读保留 ${controlStore.decisions.readOnly} 个；Session 未知 ${controlStore.decisions.unknownSession} 个。`);
    if (controlStore.decisions.unknownSession > 0) notes.push('Session 未知的 Work 只能只读展示；本轮不写迁移，也不新建 Session。');
  }
  if (browserStorage.kind === 'unknown') notes.push(`浏览器本地记录无法解析：${browserStorage.error ?? '未知原因'}`);
  return {
    dryRun: true,
    generatedAt: input.now ?? new Date().toISOString(),
    controlStore,
    browserStorage,
    notes,
  };
}
