/** Child-process worker executor.
 *
 *  The in-process executor keeps the SDK harness inside the control process, so an OS cannot prove
 *  or stop a separate process tree. This executor launches the same SDK harness in a dedicated
 *  Node child process and speaks a small NDJSON protocol over stdio:
 *
 *    child → parent  {"type":"notification","notification":{method,params}}
 *                    {"type":"question","request":{requestId,sessionId,questions}}
 *                    {"type":"result","result":{sessionId,finalResponse,finishReason,events}}
 *                    {"type":"error","error":"..."}
 *    parent → child  {"type":"answer","requestId":"...","result":{answers:[...]}}
 *                    {"type":"answer","requestId":"...","result":{"cancelled":true}}
 *                    {"type":"cancel"}
 *
 *  The parent records the real PID + instance identity on the launch attempt, and a cancel or
 *  timeout terminates the whole process tree (taskkill /T on Windows, process group on POSIX).
 *  Exit evidence is an actual OS exit event; without it the outcome stays unknown.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { InputCommit, RunRecord } from './store.js';
import { PlatformError } from './registry.js';
import { verifyInstalledArtifacts } from './artifact-verify.js';
import type {
  RunActivity,
  RunExecutor,
  RunLaunch,
  RunOutcome,
  UserQuestionRequest,
  UserQuestionResult,
} from './service.js';
import type { ModelConfigSnapshot } from './models.js';
import { executionDirectoryOf, outputDirectoryOf } from './projects.js';
import {
  promptWasConsumed,
  readWorkerManifest,
  sessionActivities,
  workerPrompt,
  type ExitEvidenceStore,
  type WorkerConfig,
  type WorkerNotification,
} from './worker.js';

export interface ChildWorkerConfig extends WorkerConfig {
  /** Runner script; defaults to the packaged `scripts/worker-runner.mjs`. */
  runnerPath?: string;
  /** Grace period between tree termination attempts. */
  killTimeoutMs?: number;
}

const RESULT_FILE = 'platform-result.json';

interface ChildMessage {
  type?: string;
  notification?: WorkerNotification;
  request?: UserQuestionRequest;
  result?: { sessionId: string; finalResponse: string; finishReason?: string | null; events?: unknown[] };
  error?: string;
}

interface ActiveChild {
  launchId: string;
  pid: number;
  child: ChildProcess;
  exited: Promise<number | null>;
  cancel: () => void;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const inside = (root: string, target: string): boolean => {
  const relativePath = relative(root, target);
  return relativePath === '' ||
    (!relativePath.startsWith('..') && !relativePath.includes(`..${sep}`) && !isAbsolute(relativePath));
};

const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export class ChildProcessWorkerExecutor implements RunExecutor {
  readonly kind = 'dsh-child-process';
  private readonly active = new Map<string, ActiveChild>();
  private readonly evidence: Map<string, boolean>;
  constructor(
    private readonly config: ChildWorkerConfig,
    private readonly exitEvidence?: ExitEvidenceStore,
  ) {
    if (!isAbsolute(config.dshHome) || !isAbsolute(config.workspace)) {
      throw new PlatformError('WORKER_CONFIG_INVALID', 'dshHome/workspace 必须是绝对路径');
    }
    this.evidence = new Map();
  }

  private recordEvidence(launchId: string, proven: boolean): void {
    this.evidence.set(launchId, proven);
    this.exitEvidence?.record(launchId, proven);
  }

  private readEvidence(launchId: string): boolean | null {
    return this.exitEvidence?.read(launchId) ?? this.evidence.get(launchId) ?? null;
  }

  private runnerPath(): string {
    if (this.config.runnerPath) return resolve(this.config.runnerPath);
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'worker-runner.mjs');
  }

  /** Terminate the whole tree. Windows uses taskkill /T; POSIX kills the process group. */
  private async killTree(pid: number): Promise<void> {
    const timeout = this.config.killTimeoutMs ?? 5000;
    if (process.platform === 'win32') {
      await new Promise<void>((resolveKill) => {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolveKill());
      });
      return;
    }
    try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
    await delay(Math.min(timeout, 2000));
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }

  async dispatch({
    run,
    plan,
    inputs = [],
    model = null,
    launchId,
    fencingToken,
    onUserQuestion,
    onStarted,
    onActivity,
  }: {
    run: RunRecord;
    plan: ExecutionPlan;
    inputs?: InputCommit[];
    model?: ModelConfigSnapshot | null;
    launchId?: string;
    fencingToken?: number;
    onUserQuestion?: (request: UserQuestionRequest, context: { signal: AbortSignal }) => Promise<UserQuestionResult>;
    onStarted?: () => void;
    onActivity?: (activity: RunActivity) => void;
  }): Promise<RunLaunch> {
    if (this.config.runtimeBundleDigest !== plan.runtimeBundleDigest) {
      throw new PlatformError('WORKER_RUNTIME_MISMATCH', `config=${this.config.runtimeBundleDigest} plan=${plan.runtimeBundleDigest}`);
    }
    if (model) {
      if (model.runtimeBundleDigest !== this.config.runtimeBundleDigest) {
        throw new PlatformError('WORKER_MODEL_ROUTE_MISMATCH', `model=${model.runtimeBundleDigest} worker=${this.config.runtimeBundleDigest}`);
      }
      if (this.config.adapter && model.adapter !== this.config.adapter) {
        throw new PlatformError('WORKER_MODEL_ROUTE_MISMATCH', `model=${model.adapter} worker=${this.config.adapter}`);
      }
    }
    // WP1: same installed-byte rule as the in-process entrance, before any input is consumed.
    verifyInstalledArtifacts(plan, this.config.pluginArtifactPaths);
    const resolvedLaunchId = launchId ?? `worker-${run.runId}-${randomUUID()}`;
    const resolvedFencing = fencingToken ?? run.snapshot.fencingToken + 1;

    // P0-4：每个 Run 独立 home，作业/会话/凭据按 Run 隔离。
    const runHome = this.config.isolateRunHome
      ? join(this.config.dshHome, 'run-home', run.runId)
      : this.config.dshHome;
    if (this.config.isolateRunHome) await mkdir(runHome, { recursive: true });

    let cwd = resolve(this.config.workspace, run.runId);
    if (!inside(this.config.workspace, cwd)) throw new PlatformError('WORKER_WORKSPACE_INVALID');
    if (run.workspace) {
      const projectDirectory = await realpath(executionDirectoryOf(run.workspace)).catch(() => {
        throw new PlatformError('WORKSPACE_DIRECTORY_UNAVAILABLE', '执行主机无法访问工作目录，请检查实际路径映射。');
      });
      if (!(await stat(projectDirectory)).isDirectory()) throw new PlatformError('WORKSPACE_DIRECTORY_CHANGED');
      cwd = projectDirectory;
    }
    const workspace = run.workspace ? join(outputDirectoryOf(run.workspace), run.runId) : cwd;
    if (!inside(cwd, workspace)) {
      throw new PlatformError('WORKSPACE_OUTPUT_OUTSIDE', '产物目录不在执行工作目录内，DSH 文件沙箱无法写入。');
    }
    await mkdir(workspace, { recursive: true }).catch(() => {
      throw new PlatformError('WORKSPACE_NOT_WRITABLE', '工作空间目录不可写；请为该项目的执行身份提供可写目录。');
    });

    const jobDir = join(runHome, 'platform-jobs', resolvedLaunchId);
    await mkdir(jobDir, { recursive: true });
    const jobPath = join(jobDir, 'job.json');
    const prompt = workerPrompt(run, plan, workspace, inputs);
    await writeFile(jobPath, JSON.stringify({
      runId: run.runId,
      prompt,
      cwd,
      workspace,
      harness: {
        profile: this.config.profile,
        dshHome: runHome,
        ...(this.config.patches?.length ? { patches: this.config.patches } : {}),
        ...(model?.provider ?? this.config.provider ? { provider: model?.provider ?? this.config.provider } : {}),
        ...(model?.model ?? this.config.model ? { model: model?.model ?? this.config.model } : {}),
        ...(model?.options.reasoningEffort ? { reasoningEffort: model.options.reasoningEffort } : {}),
        ...(model ? (model.options.maxTokens ? { maxTokens: model.options.maxTokens } : {})
          : (this.config.maxTokens ? { maxTokens: this.config.maxTokens } : {})),
        ...(this.config.initializeTimeoutMs ? { initializeTimeoutMs: this.config.initializeTimeoutMs } : {}),
        ...(this.config.shutdownTimeoutMs ? { shutdownTimeoutMs: this.config.shutdownTimeoutMs } : {}),
      },
    }, null, 2), { mode: 0o600 });

    const runner = this.runnerPath();
    const runnerFile = await stat(runner).then((info) => info.isFile()).catch(() => false);
    if (!runnerFile) throw new PlatformError('WORKER_RUNNER_MISSING', runner);
    // P0-3：子进程环境白名单——只透传运行必需的变量，绝不展开控制面 process.env。
    const env: NodeJS.ProcessEnv =
      this.config.envAllowlist !== undefined
        ? { DSH_HOME: runHome }
        : { ...process.env, DSH_HOME: runHome };
    if (this.config.envAllowlist) {
      for (const name of this.config.envAllowlist) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
    }
    const child = spawn(process.execPath, [runner, jobPath], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const started = new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', () => resolveSpawn());
      child.once('error', (error) => rejectSpawn(new PlatformError('WORKER_SPAWN_FAILED', error.message.slice(0, 500))));
    });
    try {
      await started;
    } catch (error) {
      await this.killTree(child.pid ?? 0);
      throw error;
    }
    const pid = child.pid ?? 0;
    if (pid <= 0) throw new PlatformError('WORKER_SPAWN_FAILED', 'no pid');
    try { onStarted?.(); } catch { /* projection only */ }

    const descendants = new Map<string, { parent: string; done: boolean }>();
    let invalidDescendantEvidence = false;
    const toolCallNames = new Map<string, string>();
    const collect = (notification: WorkerNotification): void => {
      for (const activity of sessionActivities(notification, toolCallNames)) onActivity?.(activity);
      if (notification.method !== 'subagent.started' && notification.method !== 'subagent.finished') return;
      const { parentSessionId: parent, childSessionId: childId } = notification.params;
      if (typeof parent !== 'string' || !parent || typeof childId !== 'string' || !childId || parent === childId) {
        invalidDescendantEvidence = true;
        return;
      }
      const existing = descendants.get(childId);
      if (notification.method === 'subagent.started') {
        if (existing) invalidDescendantEvidence = true;
        else descendants.set(childId, { parent, done: false });
      } else if (!existing || existing.parent !== parent || existing.done) invalidDescendantEvidence = true;
      else existing.done = true;
    };

    let result: ChildMessage['result'];
    let childError = '';
    const write = (message: unknown): void => {
      try { child.stdin?.write(`${JSON.stringify(message)}\n`) } catch { /* child may be gone */ }
    };
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      let message: ChildMessage;
      try {
        message = JSON.parse(line) as ChildMessage;
      } catch {
        return;
      }
      if (message.type === 'notification' && message.notification) {
        collect(message.notification);
        return;
      }
      if (message.type === 'question' && message.request) {
        const request = message.request;
        if (!onUserQuestion) {
          write({ type: 'answer', requestId: request.requestId, result: { cancelled: true } });
          return;
        }
        void onUserQuestion(request, { signal: new AbortController().signal })
          .then((answer) => write({ type: 'answer', requestId: request.requestId, result: answer }))
          .catch(() => write({ type: 'answer', requestId: request.requestId, result: { cancelled: true } }));
        return;
      }
      if (message.type === 'result') {
        result = message.result;
        return;
      }
      if (message.type === 'error') childError = typeof message.error === 'string' ? message.error : 'WORKER_CHILD_ERROR';
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep a bounded tail for failure diagnosis; never forward raw worker logs to the UI.
      childError = `${childError}${chunk.toString('utf8')}`.slice(-4000);
    });

    const exited = new Promise<number | null>((resolveExit) => {
      // `close` fires after stdio is drained, so the final result line is never lost to the exit
      // event ordering.
      child.once('close', (code) => resolveExit(code));
    });

    let cancelled = false;
    let timedOut = false;
    const active: ActiveChild = {
      launchId: resolvedLaunchId,
      pid,
      child,
      exited,
      cancel: () => { cancelled = true },
    };
    this.active.set(resolvedLaunchId, active);
    const timer = this.config.timeoutMs && this.config.timeoutMs > 0
      ? setTimeout(() => { timedOut = true; write({ type: 'cancel' }); void this.killTree(pid) }, this.config.timeoutMs)
      : undefined;
    timer?.unref?.();

    const outcome: Promise<RunOutcome> = (async () => {
      const NO_EXIT: unique symbol = Symbol('no-exit');
      const killTimeout = this.config.killTimeoutMs ?? 5000;
      const code = await (timedOut || cancelled
        ? Promise.race([exited, delay(killTimeout).then(() => NO_EXIT)])
        : exited);
      if (timer) clearTimeout(timer);
      // The job file contains the full prompt; it is only needed until the child has started.
      void rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
      this.active.delete(resolvedLaunchId);
      if (code === NO_EXIT) {
        // The tree did not report an exit within the kill budget: never claim a settlement.
        this.recordEvidence(resolvedLaunchId, false);
        return {
          status: 'failed',
          error: 'WORKER_EXIT_UNPROVEN',
          exitProven: false,
          cleanedUp: false,
        };
      }
      this.recordEvidence(resolvedLaunchId, true);
      const exitCode: number | null = code as number | null;
      const finalResponse = result?.finalResponse ?? '';
      if (timedOut) return { status: 'failed', error: 'WORKER_TIMEOUT', exitProven: true, cleanedUp: true };
      if (cancelled) {
        return {
          status: 'cancelled', exitProven: true, cleanedUp: true,
          sessionId: result?.sessionId,
        };
      }
      if (!result || exitCode !== 0) {
        const detail = childError.trim().slice(0, 1800);
        return {
          status: 'failed',
          error: `WORKER_EXIT_${exitCode ?? 'UNKNOWN'}${detail ? `:${detail}` : ''}`.slice(0, 2000),
          exitProven: true,
          cleanedUp: true,
        };
      }
      const finishReason = typeof result.finishReason === 'string' && result.finishReason ? result.finishReason : 'unrecorded';
      if (finishReason !== 'completed') {
        return {
          status: 'failed',
          error: `WORKER_FINISH_${finishReason.toUpperCase().replaceAll('-', '_')}`,
          finishReason,
          exitProven: true,
          cleanedUp: true,
        };
      }
      const consumedThrough = promptWasConsumed(result.events, prompt) ? inputs.at(-1)?.sequence : undefined;
      // Lineage must lead back to the actual root session.
      for (const [childId, entry] of descendants) {
        const seen = new Set([childId]);
        let parent = entry.parent;
        while (parent !== result.sessionId) {
          if (seen.has(parent) || !descendants.has(parent)) { invalidDescendantEvidence = true; break }
          seen.add(parent);
          parent = descendants.get(parent)!.parent;
        }
      }
      const modelSelections: NonNullable<RunOutcome['modelSelections']> = [];
      for (const event of result.events ?? []) {
        if (!record(event)) continue;
        if (event.type === 'request/header' && record(event.data)) {
          const header = record(event.data.header) ? event.data.header : undefined;
          const config = header && record(header.config) ? header.config : undefined;
          if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
            modelSelections.push({ provider: config.provider, model: config.model,
              ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}) });
          }
          continue;
        }
        if (event.type !== 'model/selection' || !record(event.data)) continue;
        const { provider, model: modelId, reasoningEffort } = event.data;
        if (typeof provider !== 'string' || typeof modelId !== 'string') continue;
        modelSelections.push({ provider, model: modelId,
          ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}) });
      }
      const distinct = [...new Map(modelSelections.map((item) =>
        [`${item.provider}\u0000${item.model}\u0000${item.reasoningEffort ?? ''}`, item])).values()];
      const manifest = await readWorkerManifest(workspace, finalResponse);
      const base: RunOutcome = manifest
        ? {
            status: manifest.status,
            finalResponse: manifest.summary,
            sessionId: result.sessionId,
            artifacts: manifest.artifacts,
            finishReason,
            ...(manifest.status === 'failed' ? { error: manifest.summary || 'WORKER_REPORTED_FAILURE' } : {}),
          }
        : {
            status: 'succeeded',
            finalResponse,
            sessionId: result.sessionId,
            artifacts: [],
            finishReason,
          };
      return {
        ...base,
        exitProven: true,
        cleanedUp: true,
        ...(consumedThrough !== undefined ? { consumedThrough } : {}),
        modelSelections: distinct,
        descendantsDone: !invalidDescendantEvidence && [...descendants.values()].every((entry) => entry.done),
      };
    })();

    return {
      launchId: resolvedLaunchId,
      fencingToken: resolvedFencing,
      outcome,
      process: { pid, identity: `${pid}:${resolvedLaunchId}`, mode: 'child-process' },
    };
  }

  async cancel(launchId: string): Promise<boolean> {
    const active = this.active.get(launchId);
    if (!active) return this.readEvidence(launchId) ?? false;
    active.cancel();
    try { active.child.stdin?.write(`${JSON.stringify({ type: 'cancel' })}\n`) } catch { /* gone */ }
    await this.killTree(active.pid);
    // Wait for the actual exit event; a kill request alone is not proof.
    const exited = await Promise.race([
      active.exited.then(() => true),
      delay(this.config.killTimeoutMs ?? 5000).then(() => false),
    ]);
    if (exited) this.recordEvidence(launchId, true);
    this.active.delete(launchId);
    return exited;
  }
}

export { RESULT_FILE };