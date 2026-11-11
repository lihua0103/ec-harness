/** Approved application releases. Registration is data-only: no application code is imported or run. */
import { createHash } from 'node:crypto';
import { resolveExecutionPlan, type ApplicationRelease, type ExecutionPlan } from '../../platform-runtime/src/plan.js';
import { PlatformStore, type AppRecord, type AppReleaseDraft, type AppState, type StoredAppBody } from './store.js';

export class PlatformError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value)) {
    throw new PlatformError('PLATFORM_IDENTIFIER_INVALID', String(value));
  }
  return value;
};
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  throw new PlatformError('PLATFORM_NON_JSON_VALUE');
}
const text = (value: unknown, max: number, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PlatformError('APP_DESCRIPTOR_INVALID', field);
  }
  return value;
};
const stringList = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 100)
  ) {
    throw new PlatformError('APP_DESCRIPTOR_INVALID', field);
  }
  return [...new Set(value.map((item) => item.trim()))];
};

function validateDraft(draft: AppReleaseDraft): void {
  if (!draft || typeof draft !== 'object') throw new PlatformError('APP_RELEASE_INVALID');
  const descriptor = draft.descriptor;
  if (!descriptor || typeof descriptor !== 'object') throw new PlatformError('APP_DESCRIPTOR_INVALID');
  identifier(descriptor.appId);
  identifier(descriptor.version);
  text(descriptor.displayName, 200, 'displayName');
  text(descriptor.description, 4000, 'description');
  stringList(descriptor.listingTypes, 'listingTypes');
  stringList(descriptor.materialRoles, 'materialRoles');
  stringList(descriptor.resultTypes, 'resultTypes');
  if (!Array.isArray(draft.requiredCapabilities) || draft.requiredCapabilities.length === 0) {
    throw new PlatformError('APP_RELEASE_CAPABILITIES_REQUIRED');
  }
  if (!Array.isArray(draft.providers) || draft.providers.length === 0) {
    throw new PlatformError('APP_RELEASE_PROVIDERS_REQUIRED');
  }
}

export function releaseOf(draft: AppReleaseDraft): ApplicationRelease {
  return {
    appId: draft.descriptor.appId,
    version: draft.descriptor.version,
    requiredCapabilities: draft.requiredCapabilities,
    providers: draft.providers,
    runtimeBundleDigest: draft.runtimeBundleDigest,
  };
}

export class ApplicationRegistry {
  constructor(private readonly store: PlatformStore) {}

  register(draft: AppReleaseDraft, actor: string): AppRecord {
    validateDraft(draft);
    let plan: ExecutionPlan;
    try {
      plan = resolveExecutionPlan(releaseOf(draft));
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        throw new PlatformError('APP_RELEASE_PLAN_INVALID', `${String(error.code)}: ${error.message}`);
      }
      throw error;
    }
    const releaseDigest = digest({ descriptor: draft.descriptor, planDigest: plan.planDigest });
    const appId = draft.descriptor.appId;
    const appVersion = draft.descriptor.version;
    return this.store.transaction(() => {
      const existing = this.store.appGet(appId, appVersion);
      if (existing) {
        if (existing.state === 'REVOKED') throw new PlatformError('APP_RELEASE_REVOKED', `${appId}@${appVersion}`);
        if (existing.releaseDigest === releaseDigest) return existing;
        throw new PlatformError('APP_RELEASE_CONFLICT', `${appId}@${appVersion}`);
      }
      const body: StoredAppBody = { draft, plan, releaseDigest };
      const record: AppRecord = {
        ...body,
        appId,
        appVersion,
        state: 'ACTIVE',
        createdAt: new Date().toISOString(),
      };
      this.store.appInsert(record);
      this.store.audit(actor, 'APP_RELEASE_REGISTERED', `${appId}@${appVersion}`, {
        releaseDigest,
        planDigest: plan.planDigest,
        capabilities: plan.capabilities.map((capability) => `${capability.capabilityId}@${capability.version}`),
      });
      return record;
    });
  }

  get(appId: string, appVersion?: string): AppRecord {
    identifier(appId);
    if (appVersion !== undefined) identifier(appVersion);
    const record = this.store.appGet(appId, appVersion);
    if (!record) throw new PlatformError('APP_NOT_FOUND', appVersion ? `${appId}@${appVersion}` : appId);
    const expectedPlan = resolveExecutionPlan(releaseOf(record.draft));
    const expectedReleaseDigest = digest({ descriptor: record.draft.descriptor, planDigest: expectedPlan.planDigest });
    if (
      expectedPlan.planDigest !== record.plan.planDigest ||
      canonical(expectedPlan) !== canonical(record.plan) ||
      expectedReleaseDigest !== record.releaseDigest
    ) {
      throw new PlatformError('APP_RECORD_CHANGED', `${appId}@${appVersion}`);
    }
    return record;
  }

  active(appId: string, appVersion: string): AppRecord {
    const record = this.get(appId, appVersion);
    if (record.state !== 'ACTIVE') throw new PlatformError('APP_RELEASE_NOT_ACTIVE', `${appId}@${appVersion}`);
    return record;
  }

  list(state?: AppState): AppRecord[] {
    if (state !== undefined && state !== 'ACTIVE' && state !== 'REVOKED') {
      throw new PlatformError('APP_STATE_INVALID', String(state));
    }
    return this.store.appList(state);
  }

  revoke(appId: string, appVersion: string, reason: string, actor: string): AppRecord {
    identifier(appId);
    identifier(appVersion);
    const trimmed = text(reason, 2000, 'reason');
    return this.store.transaction(() => {
      const record = this.get(appId, appVersion);
      if (record.state === 'REVOKED') return record;
      const revokedAt = new Date().toISOString();
      this.store.appRevoke(appId, appVersion, trimmed, revokedAt);
      this.store.audit(actor, 'APP_RELEASE_REVOKED', `${appId}@${appVersion}`, { reason: trimmed });
      return { ...record, state: 'REVOKED', revokedAt, revokeReason: trimmed };
    });
  }
}
