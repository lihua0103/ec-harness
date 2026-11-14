/** Data-only deployment inputs; never load a domain plugin into the control process. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateConfig, type Config } from './config.js';
import { PlatformError } from './registry.js';
import type { AppReleaseDraft } from './store.js';
import { validateModelCatalog, type ModelCatalogDraft } from './models.js';

export interface WorkbenchDeployment {
  config: Config;
  applications: AppReleaseDraft[];
  catalog: ModelCatalogDraft;
}
export async function readDeployment(file: string): Promise<WorkbenchDeployment> {
  const root = dirname(resolve(file));
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PlatformError('DEPLOYMENT_INVALID');
  const value = raw as Record<string, unknown>;
  const config = validateConfig(value.config);
  if (!config.worker) throw new PlatformError('DEPLOYMENT_WORKER_REQUIRED');
  if (!Array.isArray(value.applications) || value.applications.length === 0) throw new PlatformError('DEPLOYMENT_APPLICATIONS_REQUIRED');
  const applications: AppReleaseDraft[] = [];
  for (const entry of value.applications) {
    if (typeof entry !== 'string') throw new PlatformError('DEPLOYMENT_APPLICATION_INVALID');
    // Registration validates every descriptor/plan; these are JSON, never imports of executable code.
    applications.push(JSON.parse(await readFile(resolve(root, entry), 'utf8')) as AppReleaseDraft);
  }
  const catalog = validateModelCatalog(value.catalog);
  if (catalog.runtimeBundleDigest !== config.worker.runtimeBundleDigest ||
      applications.some((app) => app.runtimeBundleDigest !== config.worker!.runtimeBundleDigest)) {
    throw new PlatformError('DEPLOYMENT_RUNTIME_MISMATCH');
  }
  return { config, applications, catalog };
}
