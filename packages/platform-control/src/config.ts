/** Bundle configuration: deployment-varying paths, worker launch and local policy are validated at assembly. */
import { isAbsolute, resolve } from 'node:path';
import { PlatformError } from './registry.js';
import type { WorkerConfig } from './worker.js';
import type { KnowledgeDeploymentScope } from './policy.js';

export interface Config {
  /** Absolute, or relative to `DSH_HOME`. Defaults to `platform/control.sqlite`. */
  storePath?: string;
  /** Local policy allow-list; absent means every registered app is visible to the operator. */
  allowedApps?: string[];
  /** When present, dispatch launches a DSH SDK/profile worker; absent keeps EXECUTOR_NOT_CONFIGURED. */
  worker?: WorkerConfig;
  /** Whether a successful worker must declare at least one artifact before the run can finish. */
  requireArtifacts?: boolean;
  /** Require an ACTIVE release approval matching each run's release digest. */
  requireReleaseApproval?: boolean;
  /** Treat a recorded `unavailable` model health fact as a dispatch blocker. */
  requireModelHealth?: boolean;
  /** Require an ACTIVE model approval for every run's resolved model selection (E2-4). */
  requireModelApproval?: boolean;
  /** Per-project run quotas (E2-3); absent/0 for a cap means it is not enforced. */
  quotas?: { maxConcurrentRunsPerProject?: number; maxRunsPerDayPerProject?: number };
  /** Global cap on concurrently open launches; absent/0 means no cap. */
  maxConcurrentRuns?: number;
  /** Platform-owned QUEUED run scheduling; enabled by default when a worker executor exists. */
  scheduler?: { enabled?: boolean; intervalMs?: number };
  /** Fail STARTING/RUNNING runs left by a previous control process; disabled by default. */
  reconcileOnStartup?: boolean;
  /** Knowledge store path (absolute, or relative to DSH_HOME). When set, Run creation binds a
   *  read-only knowledge snapshot digest for apps that declare descriptor.knowledgePluginId (KA11). */
  knowledgeStorePath?: string;
  /** Trusted knowledge tenant scope (WP2): `local` binds explicit standalone snapshots without
   *  tenant filtering; `enterprise` declares the deployment org/region ceiling and demands a
   *  trusted scope at run creation. Absent defaults to `local` for existing deployments. */
  knowledgeScope?: KnowledgeDeploymentScope;
  /** L1 权威服务（开发设计 §3）：控制面分进程部署时经认证 HTTP 访问同一知识服务实例。
   *  token 只校验通道；主体/租户由上游认证方转发（x-dsh-subject 头），合同见 ADR-0004。 */
  knowledgeServiceUrl?: string;
  knowledgeServiceToken?: string;
}

const validateWorker = (value: unknown): WorkerConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker');
  }
  const worker = value as Record<string, unknown>;
  for (const key of Object.keys(worker)) {
      if (
        ![
          'profile',
          'dshHome',
          'workspace',
          'patches',
          'provider',
          'model',
          'adapter',
          'maxTokens',
          'timeoutMs',
          'initializeTimeoutMs',
          'shutdownTimeoutMs',
          'runtimeBundleDigest',
          'mode',
          'runnerPath',
          'killTimeoutMs',
          'pluginArtifactPaths',
        ].includes(key)
      ) {
        throw new PlatformError('PLATFORM_CONFIG_INVALID', `worker.${key}`);
      }
  }
  if (typeof worker.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(worker.profile)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker.profile');
  }
  if (typeof worker.dshHome !== 'string' || !isAbsolute(worker.dshHome)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker.dshHome');
  }
  if (typeof worker.workspace !== 'string' || !isAbsolute(worker.workspace)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker.workspace');
  }
  if (typeof worker.runtimeBundleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(worker.runtimeBundleDigest)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker.runtimeBundleDigest');
  }
  let patches: string[] | undefined;
  if (worker.patches !== undefined) {
    if (
      !Array.isArray(worker.patches) ||
      worker.patches.length > 20 ||
      worker.patches.some((patch) => typeof patch !== 'string' || !patch.trim())
    ) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker.patches');
    }
    patches = worker.patches.map((patch) => String(patch).trim());
  }
  for (const key of ['provider', 'model', 'adapter'] as const) {
    if (
      worker[key] !== undefined &&
      (typeof worker[key] !== 'string' || !worker[key].trim() || worker[key].length > 200)
    ) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', `worker.${key}`);
    }
  }
  for (const key of ['maxTokens', 'timeoutMs', 'initializeTimeoutMs', 'shutdownTimeoutMs'] as const) {
    if (worker[key] !== undefined && (!Number.isSafeInteger(worker[key]) || Number(worker[key]) <= 0)) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', `worker.${key}`);
    }
  }
  if (worker.mode !== undefined && worker.mode !== 'in-process' && worker.mode !== 'child-process') {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker.mode');
  }
  if (worker.runnerPath !== undefined && (typeof worker.runnerPath !== 'string' || !worker.runnerPath.trim())) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker.runnerPath');
  }
  if (worker.killTimeoutMs !== undefined && (!Number.isSafeInteger(worker.killTimeoutMs) || Number(worker.killTimeoutMs) < 100)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker.killTimeoutMs');
  }
  let pluginArtifactPaths: Record<string, string> | undefined;
  if (worker.pluginArtifactPaths !== undefined) {
    if (!worker.pluginArtifactPaths || typeof worker.pluginArtifactPaths !== 'object' || Array.isArray(worker.pluginArtifactPaths)) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', 'worker.pluginArtifactPaths');
    }
    pluginArtifactPaths = {};
    for (const [pluginId, path] of Object.entries(worker.pluginArtifactPaths as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(pluginId) || typeof path !== 'string' || !isAbsolute(path)) {
        throw new PlatformError('PLATFORM_CONFIG_INVALID', `worker.pluginArtifactPaths.${pluginId}`);
      }
      pluginArtifactPaths[pluginId] = path;
    }
  }
  return {
    profile: worker.profile,
    dshHome: worker.dshHome,
    workspace: worker.workspace,
    runtimeBundleDigest: worker.runtimeBundleDigest,
    ...(patches !== undefined ? { patches } : {}),
    ...(worker.provider !== undefined ? { provider: String(worker.provider) } : {}),
    ...(worker.model !== undefined ? { model: String(worker.model) } : {}),
    ...(worker.adapter !== undefined ? { adapter: String(worker.adapter) } : {}),
    ...(worker.maxTokens !== undefined ? { maxTokens: Number(worker.maxTokens) } : {}),
    ...(worker.timeoutMs !== undefined ? { timeoutMs: Number(worker.timeoutMs) } : {}),
    ...(worker.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: Number(worker.initializeTimeoutMs) } : {}),
    ...(worker.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: Number(worker.shutdownTimeoutMs) } : {}),
    ...(worker.mode !== undefined ? { mode: worker.mode as 'in-process' | 'child-process' } : {}),
    ...(worker.runnerPath !== undefined ? { runnerPath: String(worker.runnerPath) } : {}),
    ...(worker.killTimeoutMs !== undefined ? { killTimeoutMs: Number(worker.killTimeoutMs) } : {}),
    ...(pluginArtifactPaths !== undefined ? { pluginArtifactPaths } : {}),
  };
};

const validateScheduler = (value: unknown): { enabled?: boolean; intervalMs?: number } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'scheduler');
  }
  const scheduler = value as Record<string, unknown>;
  for (const key of Object.keys(scheduler)) {
    if (key !== 'enabled' && key !== 'intervalMs') {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', `scheduler.${key}`);
    }
  }
  if (scheduler.enabled !== undefined && typeof scheduler.enabled !== 'boolean') {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'scheduler.enabled');
  }
  if (
    scheduler.intervalMs !== undefined &&
    (!Number.isSafeInteger(scheduler.intervalMs) ||
      Number(scheduler.intervalMs) < 100 ||
      Number(scheduler.intervalMs) > 3_600_000)
  ) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'scheduler.intervalMs');
  }
  return {
    ...(scheduler.enabled !== undefined ? { enabled: scheduler.enabled } : {}),
    ...(scheduler.intervalMs !== undefined ? { intervalMs: Number(scheduler.intervalMs) } : {}),
  };
};

const validateKnowledgeScope = (value: unknown): KnowledgeDeploymentScope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'knowledgeScope');
  }
  const scope = value as Record<string, unknown>;
  if (scope.mode !== 'local' && scope.mode !== 'enterprise') {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'knowledgeScope.mode');
  }
  if (scope.mode === 'local') {
    for (const key of Object.keys(scope)) {
      if (key !== 'mode') throw new PlatformError('PLATFORM_CONFIG_INVALID', `knowledgeScope.${key}`);
    }
    return { mode: 'local' };
  }
  for (const key of Object.keys(scope)) {
    if (key !== 'mode' && key !== 'orgId' && key !== 'region') {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', `knowledgeScope.${key}`);
    }
  }
  const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
  for (const key of ['orgId', 'region'] as const) {
    const tenant = scope[key];
    if (tenant === undefined) continue;
    if (typeof tenant !== 'string' || !identifierPattern.test(tenant)) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', `knowledgeScope.${key}`);
    }
  }
  return {
    mode: 'enterprise',
    ...(scope.orgId !== undefined ? { orgId: String(scope.orgId) } : {}),
    ...(scope.region !== undefined ? { region: String(scope.region) } : {}),
  };
};

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID');
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (
      ![
        'storePath',
        'allowedApps',
        'worker',
        'requireArtifacts',
        'requireReleaseApproval',
        'requireModelHealth',
        'requireModelApproval',
        'quotas',
        'maxConcurrentRuns',
        'scheduler',
        'reconcileOnStartup',
        'knowledgeStorePath',
        'knowledgeScope',
        'knowledgeServiceUrl',
        'knowledgeServiceToken',
      ].includes(key)
    ) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', key);
    }
  }
  for (const key of ['storePath', 'knowledgeStorePath'] as const) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim())) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', key);
    }
  }
  if (config.allowedApps !== undefined) {
    if (!Array.isArray(config.allowedApps) || config.allowedApps.length > 100) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', 'allowedApps');
    }
    for (const appId of config.allowedApps) {
      if (typeof appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(appId)) {
        throw new PlatformError('PLATFORM_CONFIG_INVALID', 'allowedApps');
      }
    }
  }
  if (config.requireArtifacts !== undefined && typeof config.requireArtifacts !== 'boolean') {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'requireArtifacts');
  }
  for (const key of ['requireReleaseApproval', 'requireModelHealth', 'requireModelApproval'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', key);
    }
  }
  if (config.quotas !== undefined) {
    if (!config.quotas || typeof config.quotas !== 'object' || Array.isArray(config.quotas)) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', 'quotas');
    }
    const quotas = config.quotas as Record<string, unknown>;
    for (const key of Object.keys(quotas)) {
      if (key !== 'maxConcurrentRunsPerProject' && key !== 'maxRunsPerDayPerProject') {
        throw new PlatformError('PLATFORM_CONFIG_INVALID', `quotas.${key}`);
      }
    }
    for (const key of ['maxConcurrentRunsPerProject', 'maxRunsPerDayPerProject'] as const) {
      if (quotas[key] !== undefined && (!Number.isSafeInteger(quotas[key]) || Number(quotas[key]) < 0 || Number(quotas[key]) > 10_000)) {
        throw new PlatformError('PLATFORM_CONFIG_INVALID', `quotas.${key}`);
      }
    }
  }
  if (
    config.maxConcurrentRuns !== undefined &&
    (!Number.isSafeInteger(config.maxConcurrentRuns) || (config.maxConcurrentRuns as number) < 0 ||
      (config.maxConcurrentRuns as number) > 100)
  ) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'maxConcurrentRuns');
  }
  if (config.reconcileOnStartup !== undefined && typeof config.reconcileOnStartup !== 'boolean') {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'reconcileOnStartup');
  }
  if (config.knowledgeServiceUrl !== undefined) {
    const url = String(config.knowledgeServiceUrl);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', 'knowledgeServiceUrl');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', 'knowledgeServiceUrl');
    }
    // 拒绝带凭据/查询串的目标（与工作台代理同规则）：凭据经 token 配置，不经 URL。
    if (parsed.username || parsed.password || parsed.search) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', 'knowledgeServiceUrl');
    }
  }
  if (config.knowledgeServiceToken !== undefined && (typeof config.knowledgeServiceToken !== 'string' || !config.knowledgeServiceToken)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'knowledgeServiceToken');
  }
  const allowedApps = Array.isArray(config.allowedApps) ? [...config.allowedApps] : undefined;
  return {
    ...(config.knowledgeStorePath !== undefined ? { knowledgeStorePath: String(config.knowledgeStorePath) } : {}),
    ...(config.storePath !== undefined ? { storePath: String(config.storePath) } : {}),
    ...(allowedApps !== undefined ? { allowedApps } : {}),
    ...(config.worker !== undefined ? { worker: validateWorker(config.worker) } : {}),
    ...((config.requireArtifacts as boolean | undefined) !== undefined
      ? { requireArtifacts: config.requireArtifacts as boolean }
      : {}),
    ...((config.requireReleaseApproval as boolean | undefined) !== undefined
      ? { requireReleaseApproval: config.requireReleaseApproval as boolean }
      : {}),
    ...((config.requireModelHealth as boolean | undefined) !== undefined
      ? { requireModelHealth: config.requireModelHealth as boolean }
      : {}),
    ...((config.requireModelApproval as boolean | undefined) !== undefined
      ? { requireModelApproval: config.requireModelApproval as boolean }
      : {}),
    ...(config.quotas !== undefined
      ? {
          quotas: {
            ...((config.quotas as Record<string, unknown>).maxConcurrentRunsPerProject !== undefined
              ? { maxConcurrentRunsPerProject: Number((config.quotas as Record<string, unknown>).maxConcurrentRunsPerProject) }
              : {}),
            ...((config.quotas as Record<string, unknown>).maxRunsPerDayPerProject !== undefined
              ? { maxRunsPerDayPerProject: Number((config.quotas as Record<string, unknown>).maxRunsPerDayPerProject) }
              : {}),
          },
        }
      : {}),
    ...(config.maxConcurrentRuns !== undefined
      ? { maxConcurrentRuns: Number(config.maxConcurrentRuns) }
      : {}),
    ...(config.scheduler !== undefined ? { scheduler: validateScheduler(config.scheduler) } : {}),
    ...(config.reconcileOnStartup !== undefined ? { reconcileOnStartup: config.reconcileOnStartup } : {}),
    ...(config.knowledgeScope !== undefined ? { knowledgeScope: validateKnowledgeScope(config.knowledgeScope) } : {}),
    ...(config.knowledgeServiceUrl !== undefined ? { knowledgeServiceUrl: String(config.knowledgeServiceUrl) } : {}),
    ...(config.knowledgeServiceToken !== undefined ? { knowledgeServiceToken: String(config.knowledgeServiceToken) } : {}),
  };
}

/** The one control-plane home (E0d): `DSH_HOME` when set, else the checked-out default. Every
 *  entrypoint resolves fallback paths through this helper so no two defaults can silently drift. */
export function resolveControlHome(): string {
  return resolve(process.env.DSH_HOME ?? '.runtime/dsh-home');
}

/** The canonical control-plane store filename. `workbench.sqlite` was a divergent api-cli default;
 *  the E0d fallback unifies the entry point by naming and leaves any old file untouched — there is
 *  no data migration, and an operator with an old `workbench.sqlite` must move it explicitly. */
export const CONTROL_STORE_FILENAME = 'control.sqlite';

export function defaultControlStorePath(home: string = resolveControlHome()): string {
  return resolve(home, 'platform', CONTROL_STORE_FILENAME);
}

export function resolveStorePath(config: Config): string {
  const home = resolveControlHome();
  return config.storePath ? resolve(home, config.storePath) : defaultControlStorePath(home);
}

/** Knowledge store path resolution mirrors storePath: absolute, or relative to DSH_HOME. */
export function resolveKnowledgeStorePath(config: Config): string | undefined {
  if (config.knowledgeStorePath === undefined) return undefined;
  return resolve(resolveControlHome(), config.knowledgeStorePath);
}
