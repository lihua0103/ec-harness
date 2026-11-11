/** Deterministic application execution plans: capability requirement -> exact provider.
 *  No implicit "latest", no install-order resolution, no runtime fallback. */
import { createHash } from 'node:crypto';

export interface CapabilityRequirement { capabilityId: string; version: string; }
export interface CapabilityProvider {
  capabilityId: string; version: string;
  pluginId: string; pluginVersion: string; artifactDigest: string;
  protocolVersion: string; inputSchemaVersion: string; outputSchemaVersion: string;
  dependencies: readonly CapabilityRequirement[];
}
export interface ApplicationRelease {
  appId: string; version: string;
  requiredCapabilities: readonly CapabilityRequirement[];
  providers: readonly CapabilityProvider[];
  runtimeBundleDigest: string;
}
export interface PlannedCapability extends CapabilityProvider {
  dependencies: CapabilityRequirement[];
}
export interface ExecutionPlan {
  appId: string; appVersion: string; runtimeBundleDigest: string;
  requirements: CapabilityRequirement[];
  capabilities: PlannedCapability[];
  planDigest: string;
}
export class PlanError extends Error {
  constructor(readonly code: string, message?: string) { super(message ?? code); }
}

const identifier = (value: string): void => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value)) throw new PlanError('PLAN_IDENTIFIER_INVALID', String(value));
};
const digestOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new PlanError('PLAN_NON_JSON_VALUE');
}
const keyOf = (requirement: CapabilityRequirement): string => `${requirement.capabilityId}@${requirement.version}`;

function validateProvider(provider: CapabilityProvider): void {
  identifier(provider.capabilityId);
  identifier(provider.version);
  identifier(provider.pluginId);
  identifier(provider.pluginVersion);
  if (!/^[a-f0-9]{64}$/.test(provider.artifactDigest)) throw new PlanError('PLAN_ARTIFACT_DIGEST_INVALID', provider.pluginId);
  for (const schema of [provider.protocolVersion, provider.inputSchemaVersion, provider.outputSchemaVersion]) identifier(schema);
  for (const dependency of provider.dependencies) {
    identifier(dependency.capabilityId);
    identifier(dependency.version);
  }
}

/** Resolve every requirement and each provider's transitive dependencies to exactly one provider. */
export function resolveExecutionPlan(release: ApplicationRelease): ExecutionPlan {
  identifier(release.appId);
  identifier(release.version);
  if (!/^[a-f0-9]{64}$/.test(release.runtimeBundleDigest)) throw new PlanError('PLAN_RUNTIME_DIGEST_INVALID');
  const providers = new Map<string, CapabilityProvider>();
  for (const provider of release.providers) {
    validateProvider(provider);
    const key = keyOf(provider);
    if (providers.has(key)) throw new PlanError('PLAN_PROVIDER_CONFLICT', key);
    providers.set(key, provider);
  }
  const selected = new Map<string, PlannedCapability>();
  const visiting = new Set<string>();
  const visit = (requirement: CapabilityRequirement): void => {
    const key = keyOf(requirement);
    if (selected.has(key)) return;
    if (visiting.has(key)) throw new PlanError('PLAN_DEPENDENCY_CYCLE', key);
    const provider = providers.get(key);
    if (!provider) throw new PlanError('PLAN_CAPABILITY_MISSING', key);
    visiting.add(key);
    for (const dependency of provider.dependencies) visit(dependency);
    visiting.delete(key);
    selected.set(key, {
      ...provider,
      dependencies: provider.dependencies.map((dependency) => ({ ...dependency })),
    });
  };
  for (const requirement of release.requiredCapabilities) {
    identifier(requirement.capabilityId);
    identifier(requirement.version);
    visit(requirement);
  }
  const capabilities = [...selected.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  // One runtime bundle cannot host two versions/artifacts of the same plugin. Sharing a plugin across
  // capabilities is fine; selecting different builds of it is not.
  const byPlugin = new Map<string, { key: string; pluginVersion: string; artifactDigest: string }>();
  for (const capability of capabilities) {
    const key = keyOf(capability);
    const previous = byPlugin.get(capability.pluginId);
    if (previous && (previous.pluginVersion !== capability.pluginVersion || previous.artifactDigest !== capability.artifactDigest)) {
      throw new PlanError('PLAN_PLUGIN_VERSION_CONFLICT', `${previous.key} vs ${key} (${capability.pluginId})`);
    }
    byPlugin.set(capability.pluginId, {
      key,
      pluginVersion: capability.pluginVersion,
      artifactDigest: capability.artifactDigest,
    });
  }
  const requirements = release.requiredCapabilities
    .map((requirement) => ({ ...requirement }))
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const body = {
    appId: release.appId, appVersion: release.version,
    runtimeBundleDigest: release.runtimeBundleDigest, requirements, capabilities,
  };
  return { ...body, requirements: requirements.map((requirement) => ({ ...requirement })),
    capabilities: capabilities.map(cloneCapability), planDigest: digestOf(body) };
}

function cloneCapability(capability: PlannedCapability): PlannedCapability {
  return {
    ...capability,
    dependencies: capability.dependencies.map((dependency) => ({ ...dependency })),
  };
}

/** Startup check: the plan in hand must be exactly the one this release resolves to, not merely carry
 *  the same digest field. A tampered capability list or dependency set is rejected. */
export function assertPlanMatchesRelease(release: ApplicationRelease, plan: ExecutionPlan): void {
  const expected = resolveExecutionPlan(release);
  if (expected.planDigest !== plan.planDigest) {
    throw new PlanError('PLAN_DIGEST_MISMATCH', `${expected.planDigest} != ${plan.planDigest}`);
  }
  if (canonical(expected) !== canonical(plan)) throw new PlanError('PLAN_CONTENT_MISMATCH');
}