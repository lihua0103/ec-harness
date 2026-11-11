/** Bundle configuration: deployment-varying paths, worker launch and local policy are validated at assembly. */
import { isAbsolute, resolve } from 'node:path';
import { PlatformError } from './registry.js';
import type { WorkerConfig } from './worker.js';

export interface Config {
  /** Absolute, or relative to `DSH_HOME`. Defaults to `platform/control.sqlite`. */
  storePath?: string;
  /** Local policy allow-list; absent means every registered app is visible to the operator. */
  allowedApps?: string[];
  /** When present, dispatch launches a DSH SDK/profile worker; absent keeps EXECUTOR_NOT_CONFIGURED. */
  worker?: WorkerConfig;
  /** Whether a successful worker must declare at least one artifact before the run can finish. */
  requireArtifacts?: boolean;
  /** Platform-owned QUEUED run scheduling; enabled by default when a worker executor exists. */
  scheduler?: { enabled?: boolean; intervalMs?: number };
  /** Fail STARTING/RUNNING runs left by a previous control process; disabled by default. */
  reconcileOnStartup?: boolean;
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
        'maxTokens',
        'timeoutMs',
        'initializeTimeoutMs',
        'shutdownTimeoutMs',
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
  for (const key of ['provider', 'model'] as const) {
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
  return {
    profile: worker.profile,
    dshHome: worker.dshHome,
    workspace: worker.workspace,
    ...(patches !== undefined ? { patches } : {}),
    ...(worker.provider !== undefined ? { provider: String(worker.provider) } : {}),
    ...(worker.model !== undefined ? { model: String(worker.model) } : {}),
    ...(worker.maxTokens !== undefined ? { maxTokens: Number(worker.maxTokens) } : {}),
    ...(worker.timeoutMs !== undefined ? { timeoutMs: Number(worker.timeoutMs) } : {}),
    ...(worker.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: Number(worker.initializeTimeoutMs) } : {}),
    ...(worker.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: Number(worker.shutdownTimeoutMs) } : {}),
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

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID');
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!['storePath', 'allowedApps', 'worker', 'requireArtifacts', 'scheduler', 'reconcileOnStartup'].includes(key)) {
      throw new PlatformError('PLATFORM_CONFIG_INVALID', key);
    }
  }
  if (config.storePath !== undefined && (typeof config.storePath !== 'string' || !config.storePath.trim())) {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'storePath');
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
  if (config.reconcileOnStartup !== undefined && typeof config.reconcileOnStartup !== 'boolean') {
    throw new PlatformError('PLATFORM_CONFIG_INVALID', 'reconcileOnStartup');
  }
  const allowedApps = Array.isArray(config.allowedApps) ? [...config.allowedApps] : undefined;
  return {
    ...(config.storePath !== undefined ? { storePath: String(config.storePath) } : {}),
    ...(allowedApps !== undefined ? { allowedApps } : {}),
    ...(config.worker !== undefined ? { worker: validateWorker(config.worker) } : {}),
    ...(config.requireArtifacts !== undefined ? { requireArtifacts: config.requireArtifacts } : {}),
    ...(config.scheduler !== undefined ? { scheduler: validateScheduler(config.scheduler) } : {}),
    ...(config.reconcileOnStartup !== undefined ? { reconcileOnStartup: config.reconcileOnStartup } : {}),
  };
}

export function resolveStorePath(config: Config): string {
  const home = resolve(process.env.DSH_HOME ?? '.runtime/dsh-home');
  return config.storePath ? resolve(home, config.storePath) : resolve(home, 'platform', 'control.sqlite');
}
