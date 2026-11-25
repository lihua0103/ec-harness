/** WP1 consumption-time artifact verification: the installed plugin bytes on the execution host
 *  must re-verify against the approved plan before any business input is consumed. The deployment
 *  declares where each provider's artifact directory is installed (`worker.pluginArtifactPaths`);
 *  both the in-process and child-process worker entrances run this same rule, and a failure
 *  surfaces as a dispatch failure bound to the Run and its launch attempt. The digest formula is
 *  the deployment's own `directoryDigest(lib)` — assembly and consumption never diverge. */
import { createHash } from 'node:crypto';
import { directoryDigest } from './release-manifest.js';
import { PlatformError } from './registry.js';
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';

/** The digest directoryDigest() reports for a missing directory: the empty file set. A declared
 *  install path hashing as this value means the artifact is not installed — never "empty". */
export const EMPTY_DIRECTORY_DIGEST = createHash('sha256').update(Buffer.from('[]', 'utf8')).digest('hex');

/** pluginId → installed artifact directory (absolute). Declared by the deployment, not by the
 *  plan or the model; undeclared pluginIds keep the prior behavior (no consumption-time check). */
export type PluginArtifactPaths = Record<string, string>;

export function verifyInstalledArtifacts(plan: ExecutionPlan, paths: PluginArtifactPaths | undefined): void {
  if (!paths) return;
  for (const provider of plan.capabilities) {
    const declared = paths[provider.pluginId];
    if (declared === undefined) continue;
    const installed = directoryDigest(declared);
    if (installed === EMPTY_DIRECTORY_DIGEST) {
      throw new PlatformError('WORKER_ARTIFACT_MISSING', `${provider.pluginId}: ${declared}`);
    }
    if (installed !== provider.artifactDigest) {
      throw new PlatformError(
        'WORKER_ARTIFACT_MISMATCH',
        `${provider.pluginId}: plan=${provider.artifactDigest} installed=${installed}`,
      );
    }
  }
}
