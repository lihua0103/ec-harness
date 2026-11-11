/** DSH-profile worker executor. A run is executed by a complete Harness runtime in a locked profile;
 *  this adapter only launches it, maps cancellation, and records the worker's result manifest. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { RunRecord, InputCommit } from './store.js';
import { PlatformError } from './registry.js';
import type { RunArtifact, RunExecutor, RunLaunch, RunOutcome } from './service.js';

export interface WorkerConfig {
  /** Locked DSH profile selected by the application release. */
  profile: string;
  /** Absolute DSH home used by the worker; never the control process home. */
  dshHome: string;
  /** Absolute root for per-run work directories. */
  workspace: string;
  patches?: string[];
  provider?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Bound for the SDK initialize handshake; the SDK default is 10s, often too short on first start. */
  initializeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
export interface WorkerHarness {
  run(
    prompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ sessionId: string; finalResponse: string; finishReason?: string | null }>;
  close(): Promise<void>;
}
export interface WorkerHarnessFactory {
  create(config: WorkerConfig, runId: string): Promise<WorkerHarness>;
}
interface WorkerManifest {
  status?: 'succeeded' | 'failed';
  summary?: string;
  artifacts?: Array<{ name?: string; path?: string; mediaType?: string }>;
}
const RESULT_FILE = 'platform-result.json';
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 256 * 1024 * 1024;

export function workerPrompt(
  run: RunRecord,
  plan: ExecutionPlan,
  workspace: string,
  inputs: InputCommit[] = [],
): string {
  const commits = inputs.length
    ? inputs.map((commit) => `#${commit.sequence} ${JSON.stringify(commit.body)}`)
    : [`#1 ${JSON.stringify(run.input)}`];
  return [
    `你是平台 Worker，正在执行应用 ${run.appId}@${run.appVersion} 的一次运行。`,
    `Run: ${run.runId}`,
    `Plan: ${plan.planDigest}`,
    `工作目录: ${workspace}`,
    '运行输入提交（按提交顺序）：',
    ...commits,
    '',
    '请自主使用当前 profile 提供的工具完成目标；没有固定工具调用顺序。',
    '需要执行/写入的副作用必须符合当前平台授权。不要把未执行或未验证的结果说成完成。',
    `完成后在 ${RESULT_FILE} 写入 JSON：{"status":"succeeded"|"failed","summary":"...","artifacts":[{"name":"...","path":"...","mediaType":"..."}]}。`,
    '所有产物必须位于工作目录内；没有产物时 artifacts 为空数组。',
  ].join('\n');
}

function inside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !relativePath.includes(`..${sep}`) && !isAbsolute(relativePath))
  );
}

async function realFileInside(root: string, candidate: string): Promise<string> {
  const rootReal = await realpath(root);
  const real = await realpath(candidate);
  if (!inside(rootReal, real)) throw new PlatformError('WORKER_ARTIFACT_OUTSIDE_WORKSPACE', candidate);
  return real;
}

async function digestFile(path: string): Promise<{ digest: string; bytes: number }> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) throw new PlatformError('WORKER_ARTIFACT_INVALID', path);
  const data = await readFile(path);
  return { digest: createHash('sha256').update(data).digest('hex'), bytes: data.length };
}

async function readManifest(
  workspace: string,
  finalResponse: string,
): Promise<{ status: 'succeeded' | 'failed'; summary: string; artifacts: RunArtifact[] }> {
  const manifestPath = join(workspace, RESULT_FILE);
  let manifest: WorkerManifest | undefined;
  try {
    const realManifest = await realFileInside(workspace, manifestPath);
    manifest = JSON.parse(await readFile(realManifest, 'utf8')) as WorkerManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error instanceof PlatformError
        ? error
        : new PlatformError('WORKER_MANIFEST_INVALID', error instanceof Error ? error.message : 'UNKNOWN');
    }
  }
  if (!manifest) {
    return { status: 'succeeded', summary: finalResponse, artifacts: [] };
  }
  if (manifest.status !== 'succeeded' && manifest.status !== 'failed') {
    throw new PlatformError('WORKER_MANIFEST_INVALID', 'status');
  }
  const artifacts: RunArtifact[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  for (const artifact of manifest.artifacts ?? []) {
    if (!artifact || typeof artifact.path !== 'string' || !artifact.path.trim()) {
      throw new PlatformError('WORKER_MANIFEST_INVALID', 'artifact path');
    }
    let target: string;
    try {
      target = await realFileInside(workspace, resolve(workspace, artifact.path));
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('WORKER_ARTIFACT_INVALID', artifact.path);
    }
    const name = artifact.name?.trim() || basename(target);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(name) || names.has(name)) {
      throw new PlatformError('WORKER_MANIFEST_INVALID', 'artifact name');
    }
    names.add(name);
    const { digest, bytes } = await digestFile(target);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) throw new PlatformError('WORKER_ARTIFACT_TOTAL_TOO_LARGE');
    artifacts.push({
      name,
      digest,
      bytes,
      ...(artifact.mediaType ? { mediaType: String(artifact.mediaType).slice(0, 200) } : {}),
    });
  }
  return {
    status: manifest.status,
    summary: typeof manifest.summary === 'string' ? manifest.summary.slice(0, 20_000) : finalResponse,
    artifacts,
  };
}

/** The default factory imports the SDK client when the deployment supplies it. */
export const sdkHarnessFactory: WorkerHarnessFactory = {
  async create(config, runId) {
    let sdk: {
      DeepSeekHarness: new (options: Record<string, unknown>) => {
        run: (
          prompt: string,
          options?: { signal?: AbortSignal },
        ) => Promise<{
          sessionId: string;
          finalResponse: string;
          finishReason?: string | null;
        }>;
        close: () => Promise<void>;
      };
    };
    try {
      sdk = (await import('@deepseek-ai/dsh-sdk-client' as string)) as typeof sdk;
    } catch {
      throw new PlatformError('WORKER_SDK_UNAVAILABLE');
    }
    const harness = new sdk.DeepSeekHarness({
      profile: config.profile,
      dshHome: config.dshHome,
      cwd: join(config.workspace, runId),
      ...(config.patches?.length ? { patches: config.patches } : {}),
      ...(config.provider ? { provider: config.provider } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
      ...(config.initializeTimeoutMs ? { initializeTimeoutMs: config.initializeTimeoutMs } : {}),
      ...(config.shutdownTimeoutMs ? { shutdownTimeoutMs: config.shutdownTimeoutMs } : {}),
    });
    return {
      run: (prompt, options) => harness.run(prompt, options),
      close: () => harness.close(),
    };
  },
};

interface ActiveWorker {
  controller: AbortController;
  harness: WorkerHarness;
  timer?: NodeJS.Timeout;
}

export class DshProfileExecutor implements RunExecutor {
  readonly kind = 'dsh-profile';
  private readonly active = new Map<string, ActiveWorker>();
  constructor(
    private readonly config: WorkerConfig,
    private readonly factory: WorkerHarnessFactory = sdkHarnessFactory,
  ) {
    if (!isAbsolute(config.dshHome) || !isAbsolute(config.workspace)) {
      throw new PlatformError('WORKER_CONFIG_INVALID', 'dshHome/workspace 必须是绝对路径');
    }
    if (factory === sdkHarnessFactory) {
      try {
        import.meta.resolve('@deepseek-ai/dsh-sdk-client');
      } catch {
        throw new PlatformError('WORKER_SDK_UNAVAILABLE');
      }
    }
  }
  async dispatch({
    run,
    plan,
    inputs = [],
  }: {
    run: RunRecord;
    plan: ExecutionPlan;
    inputs?: InputCommit[];
  }): Promise<RunLaunch> {
    const launchId = `worker-${run.runId}-${randomUUID()}`;
    const workspace = resolve(this.config.workspace, run.runId);
    if (!inside(this.config.workspace, workspace)) throw new PlatformError('WORKER_WORKSPACE_INVALID');
    await mkdir(workspace, { recursive: true });
    const harness = await this.factory.create(this.config, run.runId);
    const controller = new AbortController();
    const active: ActiveWorker = { controller, harness };
    let timedOut = false;
    if (this.config.timeoutMs && this.config.timeoutMs > 0) {
      active.timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.config.timeoutMs);
      active.timer.unref?.();
    }
    this.active.set(launchId, active);
    const outcome: Promise<RunOutcome> = harness
      .run(workerPrompt(run, plan, workspace, inputs), { signal: controller.signal })
      .then(async (result) => {
        if (timedOut) return { status: 'failed' as const, error: 'WORKER_TIMEOUT' };
        if (controller.signal.aborted) return { status: 'cancelled' as const };
        const manifest = await readManifest(workspace, result.finalResponse);
        return {
          status: manifest.status,
          finalResponse: manifest.summary,
          sessionId: result.sessionId,
          artifacts: manifest.artifacts,
          ...(manifest.status === 'failed' ? { error: manifest.summary || 'WORKER_REPORTED_FAILURE' } : {}),
        };
      })
      .catch((error: unknown) => ({
        status: timedOut
          ? ('failed' as const)
          : controller.signal.aborted
            ? ('cancelled' as const)
            : ('failed' as const),
        error: timedOut
          ? 'WORKER_TIMEOUT'
          : controller.signal.aborted
            ? 'WORKER_CANCELLED'
            : error instanceof Error
              ? `${'code' in error ? `${String(error.code)}:` : ''}${error.message.slice(0, 2000)}`
              : 'WORKER_FAILED',
      }))
      .finally(async () => {
        if (active.timer) clearTimeout(active.timer);
        this.active.delete(launchId);
        await harness.close().catch(() => {});
      });
    return { launchId, fencingToken: run.snapshot.fencingToken + 1, outcome };
  }
  async cancel(launchId: string): Promise<boolean> {
    const active = this.active.get(launchId);
    if (!active) return true;
    active.controller.abort();
    if (active.timer) clearTimeout(active.timer);
    try {
      await active.harness.close();
      return true;
    } catch {
      return false;
    }
  }
}
