/** Approved application releases. Registration is data-only: no application code is imported or run. */
import { createHash } from 'node:crypto';
import { resolveExecutionPlan, type ApplicationRelease, type ExecutionPlan } from '../../platform-runtime/src/plan.js';
import { PlatformStore, type AppRecord, type AppReleaseDraft, type AppState, type StoredAppBody } from './store.js';
import { assertClosedSchema } from './input-schema.js';

export class PlatformError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
export const identifier = (value: unknown): string => {
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

/** Declarative result views (E1-5): the descriptor may describe how its findings render. Views
 *  are data — a viewId, a rendering kind, the finding kind they read and explicit columns or
 *  metric declarations. Nothing here lets the platform branch on which application it is. */
function validateResultViews(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 20) {
    throw new PlatformError('APP_DESCRIPTOR_INVALID', 'resultViews');
  }
  const viewIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PlatformError('APP_DESCRIPTOR_INVALID', 'resultViews entry');
    }
    const view = entry as Record<string, unknown>;
    if (typeof view.viewId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(view.viewId)) {
      throw new PlatformError('APP_DESCRIPTOR_INVALID', 'resultViews.viewId');
    }
    if (viewIds.has(view.viewId)) throw new PlatformError('APP_DESCRIPTOR_INVALID', `duplicate viewId ${view.viewId}`);
    viewIds.add(view.viewId);
    text(view.title, 200, 'resultViews.title');
    if (view.kind !== 'table' && view.kind !== 'metrics') {
      throw new PlatformError('APP_DESCRIPTOR_INVALID', 'resultViews.kind');
    }
    if (typeof view.findingKind !== 'string' || !view.findingKind.trim() || view.findingKind.length > 64) {
      throw new PlatformError('APP_DESCRIPTOR_INVALID', 'resultViews.findingKind');
    }
    const declared = (item: unknown, what: string): Record<string, unknown> => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new PlatformError('APP_DESCRIPTOR_INVALID', what);
      }
      const record = item as Record<string, unknown>;
      if (typeof record.field !== 'string' || !record.field.trim() || record.field.length > 100) {
        throw new PlatformError('APP_DESCRIPTOR_INVALID', `${what}.field`);
      }
      text(record.label, 100, `${what}.label`);
      return record;
    };
    if (view.columns !== undefined) {
      if (!Array.isArray(view.columns) || view.columns.length > 12) {
        throw new PlatformError('APP_DESCRIPTOR_INVALID', 'resultViews.columns');
      }
      for (const column of view.columns) declared(column, 'resultViews.column');
    }
    if (view.metrics !== undefined) {
      if (!Array.isArray(view.metrics) || view.metrics.length > 12) {
        throw new PlatformError('APP_DESCRIPTOR_INVALID', 'resultViews.metrics');
      }
      for (const metric of view.metrics) {
        const record = declared(metric, 'resultViews.metric');
        if (record.stat !== 'count' && record.stat !== 'sum' && record.stat !== 'avg') {
          throw new PlatformError('APP_DESCRIPTOR_INVALID', 'resultViews.metric.stat');
        }
        if (record.unit !== undefined && (typeof record.unit !== 'string' || record.unit.length > 16)) {
          throw new PlatformError('APP_DESCRIPTOR_INVALID', 'resultViews.metric.unit');
        }
      }
    }
    if (view.kind === 'table' && !Array.isArray(view.columns)) {
      throw new PlatformError('APP_DESCRIPTOR_INVALID', 'table view requires columns');
    }
    if (view.kind === 'metrics' && !Array.isArray(view.metrics)) {
      throw new PlatformError('APP_DESCRIPTOR_INVALID', 'metrics view requires metrics');
    }
  }
}

function validateDraft(draft: AppReleaseDraft): void {  if (!draft || typeof draft !== 'object') throw new PlatformError('APP_RELEASE_INVALID');
  const descriptor = draft.descriptor;
  if (!descriptor || typeof descriptor !== 'object') throw new PlatformError('APP_DESCRIPTOR_INVALID');
  identifier(descriptor.appId);
  identifier(descriptor.version);
  text(descriptor.displayName, 200, 'displayName');
  text(descriptor.description, 4000, 'description');
  stringList(descriptor.listingTypes, 'listingTypes');
  stringList(descriptor.materialRoles, 'materialRoles');
  stringList(descriptor.resultTypes, 'resultTypes');
  validateResultViews(descriptor.resultViews);
  if (descriptor.knowledgePluginId !== undefined) identifier(descriptor.knowledgePluginId);
  // Input-schema contract envelope (R1/W1): JSON object only, bounded canonical size, and the
  // body must stay inside the declared closed subset (assertClosedSchema) so no keyword is ever
  // silently ignored. Submitted values are enforced at the Run freeze entry (input-schema.ts).
  // A version without a schema body is dangling and invalid.
  if (descriptor.inputSchema !== undefined) {
    if (descriptor.inputSchema === null || typeof descriptor.inputSchema !== 'object' || Array.isArray(descriptor.inputSchema)) {
      throw new PlatformError('APP_DESCRIPTOR_INVALID', 'inputSchema');
    }
    if (canonical(descriptor.inputSchema).length > 65536) {
      throw new PlatformError('APP_DESCRIPTOR_INVALID', 'inputSchema size');
    }
    assertClosedSchema(descriptor.inputSchema);
  }
  if (descriptor.inputSchemaVersion !== undefined) {
    if (descriptor.inputSchema === undefined) throw new PlatformError('APP_DESCRIPTOR_INVALID', 'inputSchemaVersion requires inputSchema');
    identifier(descriptor.inputSchemaVersion);
  }
  validateProvenance(draft.provenance);
  if (!Array.isArray(draft.requiredCapabilities) || draft.requiredCapabilities.length === 0) {
    throw new PlatformError('APP_RELEASE_CAPABILITIES_REQUIRED');
  }
  if (!Array.isArray(draft.providers) || draft.providers.length === 0) {
    throw new PlatformError('APP_RELEASE_PROVIDERS_REQUIRED');
  }
}

/** Provenance is digest-only build metadata; it never carries credentials or arbitrary URLs. */
function validateProvenance(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformError('APP_PROVENANCE_INVALID');
  }
  const provenance = value as Record<string, unknown>;
  const allowed = ['sourceRevision', 'builder', 'builtAt', 'sbomDigest', 'dependenciesDigest'];
  for (const key of Object.keys(provenance)) {
    if (!allowed.includes(key)) throw new PlatformError('APP_PROVENANCE_INVALID', key);
  }
  for (const key of ['sourceRevision', 'builder'] as const) {
    const item = provenance[key];
    if (item !== undefined && (typeof item !== 'string' || !item.trim() || item.length > 200)) {
      throw new PlatformError('APP_PROVENANCE_INVALID', key);
    }
  }
  if (provenance.builtAt !== undefined) {
    if (typeof provenance.builtAt !== 'string' || Number.isNaN(Date.parse(provenance.builtAt))) {
      throw new PlatformError('APP_PROVENANCE_INVALID', 'builtAt');
    }
  }
  for (const key of ['sbomDigest', 'dependenciesDigest'] as const) {
    const item = provenance[key];
    if (item !== undefined && (typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))) {
      throw new PlatformError('APP_PROVENANCE_INVALID', key);
    }
  }
}

/** Release-envelope formula (R1): bind descriptor + planDigest (+ declared build provenance)
 *  into the releaseDigest that approvals bind. The formula itself is stable; what moves is the
 *  planDigest input — contract v2 plans embed descriptor and contract facts, so any controlled
 *  declaration change yields a new releaseDigest and the old approval no longer matches. */
export function releaseDigestOf(draft: AppReleaseDraft, planDigest: string): string {
  return draft.provenance
    ? digest({ descriptor: draft.descriptor, planDigest, provenance: draft.provenance })
    : digest({ descriptor: draft.descriptor, planDigest });
}

/** Project a validated draft onto the plan resolver's release view. Contract '2' (default)
 *  carries release identity facts — descriptor digest plus input-schema / material-role /
 *  declarative-view contract digests — so any controlled declaration change moves planDigest
 *  and therefore releaseDigest. Contract '1' omits them and reproduces the legacy release view,
 *  used only to re-verify records created before contract v2 in their original format; old
 *  records are never rewritten into v2. */
export function releaseOf(draft: AppReleaseDraft, contractVersion: '1' | '2' = '2'): ApplicationRelease {
  const base = {
    appId: draft.descriptor.appId,
    version: draft.descriptor.version,
    requiredCapabilities: draft.requiredCapabilities,
    providers: draft.providers,
    runtimeBundleDigest: draft.runtimeBundleDigest,
  };
  if (contractVersion === '1') return base;
  const descriptor = draft.descriptor;
  return {
    ...base,
    identity: {
      descriptorDigest: digest(descriptor),
      ...(descriptor.inputSchema !== undefined
        ? { input: { version: descriptor.inputSchemaVersion ?? '1', digest: digest(descriptor.inputSchema) } }
        : {}),
      ...(descriptor.materialRoles?.length
        ? { roles: { version: '1', digest: digest(descriptor.materialRoles) } }
        : {}),
      ...(descriptor.resultViews?.length
        ? { view: { version: '1', digest: digest(descriptor.resultViews) } }
        : {}),
    },
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
    const releaseDigest = releaseDigestOf(draft, plan.planDigest);
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
        registeredBy: actor,
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
    // Envelope verification (R1): recompute the plan and release digests from the stored draft in
    // the record's own contract format — legacy records re-verify as v1, never rewritten to v2.
    const storedV2 = record.plan.planContractVersion === '2';
    const expectedPlan = resolveExecutionPlan(releaseOf(record.draft, storedV2 ? '2' : '1'));
    const expectedReleaseDigest = releaseDigestOf(record.draft, expectedPlan.planDigest);
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
