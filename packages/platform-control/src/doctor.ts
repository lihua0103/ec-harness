/** Local installation doctor.
 *
 *  Employees install and run the platform on their own machine, so the most common failures are
 *  environmental: wrong Node version, an unwritable directory, a store from another product, a
 *  worker profile that does not exist, a missing R runtime, or the SDK client not installed.
 *  This module checks those facts and reports them; it never "fixes" anything silently.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONTROL_APPLICATION_ID } from './store.js';
import type { WorkerConfig } from './worker.js';
import { directoryDigest } from './release-manifest.js';
import { EMPTY_DIRECTORY_DIGEST } from './artifact-verify.js';

const execFileAsync = promisify(execFile);

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  checks: DoctorCheck[];
}

const MIN_NODE: [number, number] = [24, 9];

const compareVersion = (current: string, minimum: [number, number]): boolean => {
  const [major = 0, minor = 0] = current.split('.').map((part) => Number.parseInt(part, 10));
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
};

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(() => true).catch(() => false);

const canWrite = async (directory: string): Promise<boolean> => {
  try {
    await mkdir(directory, { recursive: true });
    const probe = join(directory, `.platform-doctor-${process.pid}-${Date.now()}`);
    await writeFile(probe, 'probe');
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
};

/** Check without creating the target: an existing directory is probed; a missing one is reported
 *  as creatable when its parent is writable, and the doctor never creates it itself. */
const writableOrCreatable = async (directory: string): Promise<{ ok: boolean; willCreate: boolean }> => {
  if (await exists(directory)) return { ok: await canWrite(directory), willCreate: false };
  const parent = dirname(directory);
  if (await exists(parent)) return { ok: await canWrite(parent), willCreate: true };
  return { ok: false, willCreate: true };
};

const commandExists = async (command: string): Promise<boolean> => {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(tool, [command], { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

const inspectStore = (path: string): { check: DoctorCheck; counts?: Record<string, number> } => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    const quick = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: string }>;
    const bad = quick.map((row) => String(row.quick_check ?? '')).filter((message) => message && message.toLowerCase() !== 'ok');
    if (bad.length > 0) {
      return { check: { name: 'store.integrity', status: 'fail', detail: bad.join('; ') } };
    }
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    const application = Number((db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id);
    if (version !== 1 || application !== CONTROL_APPLICATION_ID) {
      return {
        check: {
          name: 'store.identity',
          status: 'fail',
          detail: `不是平台控制面库（user_version=${version}, application_id=${application}）`,
        },
      };
    }
    const count = (sql: string): number => Number((db!.prepare(sql).get() as { count: number }).count);
    const counts = {
      apps: count('SELECT COUNT(*) AS count FROM app_releases'),
      works: count('SELECT COUNT(*) AS count FROM works'),
      runs: count('SELECT COUNT(*) AS count FROM runs'),
      queued: count("SELECT COUNT(*) AS count FROM runs WHERE state='QUEUED'"),
      outboxPending: count("SELECT COUNT(*) AS count FROM outbox_messages WHERE state='PENDING'"),
      approvals: count("SELECT COUNT(*) AS count FROM release_approvals WHERE state='ACTIVE'"),
    };
    return { check: { name: 'store.integrity', status: 'ok', detail: 'SQLite quick_check 通过' }, counts };
  } catch (error) {
    return {
      check: {
        name: 'store.integrity',
        status: 'fail',
        detail: error instanceof Error ? error.message.slice(0, 500) : 'STORE_UNREADABLE',
      },
    };
  } finally {
    db?.close();
  }
};

/** WP1 precheck: the declared installed artifact directories must exist and their bytes must
 *  re-verify against the approved plans registered in the control store. A mismatch here is the
 *  same refusal the worker entrances enforce at dispatch, surfaced before any run starts. */
const inspectArtifacts = (
  storePath: string,
  paths: Record<string, string>,
): DoctorCheck => {
  const missing = Object.entries(paths).filter(([, path]) => !existsSync(path));
  if (missing.length > 0) {
    return { name: 'worker.artifacts', status: 'fail', detail: `安装目录缺失：${missing.map(([id, path]) => `${id} → ${path}`).join('; ')}` };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(storePath, { readOnly: true, allowExtension: false });
  } catch {
    return { name: 'worker.artifacts', status: 'warn', detail: '控制面库不可读，无法对照已批准计划核验安装字节' };
  }
  try {
    const planned = new Map<string, { digest: string; app: string }>();
    const rows = db.prepare("SELECT app_id, app_version, body FROM app_releases WHERE state='ACTIVE'").all() as Array<{
      app_id: string;
      app_version: string;
      body: string;
    }>;
    for (const row of rows) {
      let plan: { capabilities?: Array<{ pluginId?: string; artifactDigest?: string }> } | undefined;
      try {
        plan = (JSON.parse(row.body) as { plan?: typeof plan }).plan;
      } catch {
        continue;
      }
      for (const provider of plan?.capabilities ?? []) {
        if (provider.pluginId && paths[provider.pluginId] !== undefined) {
          planned.set(provider.pluginId, { digest: String(provider.artifactDigest), app: `${row.app_id}@${row.app_version}` });
        }
      }
    }
    const problems: string[] = [];
    const verified: string[] = [];
    for (const [pluginId, path] of Object.entries(paths)) {
      const installed = directoryDigest(path);
      if (installed === EMPTY_DIRECTORY_DIGEST) {
        problems.push(`${pluginId}: 安装目录为空（${path}）`);
        continue;
      }
      const expected = planned.get(pluginId);
      if (!expected) {
        problems.push(`${pluginId}: 控制面无已登记发布可对照（${path}）`);
        continue;
      }
      if (installed !== expected.digest) {
        problems.push(`${pluginId}: plan=${expected.digest} installed=${installed}（${expected.app}）`);
        continue;
      }
      verified.push(pluginId);
    }
    if (problems.length > 0) {
      return { name: 'worker.artifacts', status: 'fail', detail: problems.join('; ') };
    }
    return { name: 'worker.artifacts', status: 'ok', detail: `安装字节与已批准计划一致：${verified.join(', ')}` };
  } finally {
    db.close();
  }
};

export async function runDoctor(options: {
  storePath: string;
  worker?: WorkerConfig;
  /** Skip the process-wide SDK probe (tests inject their own environment). */
  checkSdk?: boolean;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeVersion = process.versions.node;
  checks.push({
    name: 'node.version',
    status: compareVersion(nodeVersion, MIN_NODE) ? 'ok' : 'fail',
    detail: `Node ${nodeVersion}（需要 ≥ ${MIN_NODE[0]}.${MIN_NODE[1]}）`,
  });

  const storePath = resolve(options.storePath);
  const storeDir = dirname(storePath);
  const storeDirCheck = await writableOrCreatable(storeDir);
  checks.push({
    name: 'store.directory',
    status: storeDirCheck.ok ? 'ok' : 'fail',
    detail: storeDirCheck.willCreate && storeDirCheck.ok ? `${storeDir}（首次启动时创建）` : storeDir,
  });
  if (await exists(storePath)) {
    const inspected = inspectStore(storePath);
    checks.push(inspected.check);
    if (inspected.counts) {
      checks.push({
        name: 'store.facts',
        status: 'ok',
        detail: `应用 ${inspected.counts.apps} · 工作 ${inspected.counts.works} · 运行 ${inspected.counts.runs}（QUEUED ${inspected.counts.queued}）· Outbox PENDING ${inspected.counts.outboxPending} · 审批 ${inspected.counts.approvals}`,
      });
      if (inspected.counts.apps > 0 && inspected.counts.approvals === 0) {
        checks.push({
          name: 'store.approvals',
          status: 'warn',
          detail: '已登记发布但没有生效审批；若启用 requireReleaseApproval，运行会被拒绝',
        });
      }
    }
  } else {
    checks.push({ name: 'store.integrity', status: 'warn', detail: '控制面库尚未创建（首次启动会创建）' });
  }

  if (options.worker) {
    const worker = options.worker;
    checks.push({
      name: 'worker.paths',
      status: isAbsolute(worker.dshHome) && isAbsolute(worker.workspace) ? 'ok' : 'fail',
      detail: `dshHome=${worker.dshHome} workspace=${worker.workspace}`,
    });
    checks.push({
      name: 'worker.dshHome',
      status: (await exists(worker.dshHome)) ? 'ok' : 'fail',
      detail: worker.dshHome,
    });
    const workspaceCheck = await writableOrCreatable(worker.workspace);
    checks.push({
      name: 'worker.workspace',
      status: workspaceCheck.ok ? 'ok' : 'fail',
      detail: workspaceCheck.willCreate && workspaceCheck.ok
        ? `${worker.workspace}（首次运行时创建）`
        : worker.workspace,
    });
    const profileDir = join(worker.dshHome, 'profiles', worker.profile);
    checks.push({
      name: 'worker.profile',
      status: (await exists(profileDir)) ? 'ok' : 'fail',
      detail: profileDir,
    });
    if (worker.mode === 'child-process') {
      const runner = worker.runnerPath
        ? resolve(worker.runnerPath)
        : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'worker-runner.mjs');
      checks.push({
        name: 'worker.runner',
        status: (await exists(runner)) ? 'ok' : 'fail',
        detail: runner,
      });
    }
    if (worker.pluginArtifactPaths && Object.keys(worker.pluginArtifactPaths).length > 0) {
      checks.push(inspectArtifacts(resolve(storePath), worker.pluginArtifactPaths));
    }
    if (options.checkSdk !== false) {
      let sdk = true;
      try {
        import.meta.resolve('@deepseek-ai/dsh-sdk-client');
      } catch {
        sdk = false;
      }
      checks.push({
        name: 'worker.sdk',
        status: sdk ? 'ok' : 'fail',
        detail: sdk ? 'SDK client 可解析' : '未安装 @deepseek-ai/dsh-sdk-client',
      });
    }
  } else {
    checks.push({
      name: 'worker.config',
      status: 'warn',
      detail: '未配置 Worker：只能创建/排队运行，不会执行',
    });
  }

  const rscript = await commandExists('Rscript') || await commandExists('Rterm');
  checks.push({
    name: 'runtime.r',
    status: rscript ? 'ok' : 'warn',
    detail: rscript ? 'R 可用' : '未找到 Rscript/Rterm；Listing 运行会失败（本机 R 环境由员工自装）',
  });

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    generatedAt: new Date().toISOString(),
    checks,
  };
}