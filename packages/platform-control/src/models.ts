/** Platform model catalog contracts.
 *
 *  The catalog is a deployment-owned, reviewable snapshot of provider routes that are actually
 *  assembled in the locked DSH RuntimeBundle/profile. This module validates that snapshot and
 *  freezes a per-run ModelConfigSnapshot. It never contacts a provider, never holds credentials
 *  and never invents capabilities or rankings.
 */
import { createHash } from 'node:crypto';
import { PlatformError } from './registry.js';

export type ModelVerification = 'provider-declared' | 'platform-verified' | 'unverified';
export type Modality = 'text' | 'image' | 'audio' | 'video';
export type TriState = 'yes' | 'no' | 'unknown';

export interface ModelCapabilities {
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: Modality[];
  toolUse?: TriState;
  reasoning?: TriState;
}
export interface ModelParameters {
  /** Allowed reasoning-effort values; presence means the route accepts a choice. */
  reasoningEffort?: string[];
  /** Whether the route accepts an explicit maxTokens option. */
  maxTokens?: boolean;
}
export interface ModelCatalogEntry {
  /** Platform-issued opaque selection id; never a provider/model string submitted by clients. */
  selectionId: string;
  provider: string;
  model: string;
  displayName: string;
  description?: string;
  /** Adapter/plugin that owns this route inside the locked RuntimeBundle. */
  adapter: string;
  adapterVersion?: string;
  enabled: boolean;
  /** Required explanation when enabled is false. */
  unavailableReason?: string;
  verification: ModelVerification;
  capabilities?: ModelCapabilities;
  parameters?: ModelParameters;
  /** Deployment-declared default run options for this route. A run that passes its own
   *  modelOptions overrides these per key; a run that passes none inherits them wholesale.
   *  Catalog entries are the reviewable authority for route budgets — never worker defaults. */
  modelOptions?: ModelSelectionOptions;
}
export interface ModelCatalogDraft {
  catalogId: string;
  /** The approved runtime bundle this catalog was probed from; must equal a run plan's digest. */
  runtimeBundleDigest: string;
  defaultSelectionId?: string;
  entries: ModelCatalogEntry[];
}
export interface ModelCatalogRecord extends ModelCatalogDraft {
  catalogDigest: string;
  createdAt: string;
  updatedAt: string;
}
export interface ModelSelectionOptions {
  reasoningEffort?: string;
  maxTokens?: number;
}
export type ModelSelectionSource = 'explicit' | 'preference' | 'catalog-default' | 'retry';
export interface ModelConfigSnapshot {
  selectionId: string;
  provider: string;
  model: string;
  adapter: string;
  adapterVersion?: string;
  catalogId: string;
  catalogDigest: string;
  runtimeBundleDigest: string;
  verification: ModelVerification;
  capabilities?: ModelCapabilities;
  options: ModelSelectionOptions;
  selectionSource: ModelSelectionSource;
  selectedAt: string;
}
export interface ModelPreferenceView {
  selectionId: string | null;
  updatedAt: string | null;
  state: 'none' | 'available' | 'unavailable' | 'unknown';
  entry: ModelCatalogEntry | null;
  reason: string;
}

const canonical = (value: unknown): string => {
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
  throw new PlatformError('MODEL_CATALOG_INVALID', 'non-json value');
};
export const modelCatalogDigest = (draft: ModelCatalogDraft): string =>
  createHash('sha256').update(canonical(draft)).digest('hex');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SELECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MODALITIES: readonly Modality[] = ['text', 'image', 'audio', 'video'];
const VERIFICATIONS: readonly ModelVerification[] = ['provider-declared', 'platform-verified', 'unverified'];
const TRI_STATES: readonly TriState[] = ['yes', 'no', 'unknown'];

function invalid(field: string): never {
  throw new PlatformError('MODEL_CATALOG_INVALID', field);
}
const identifier = (value: unknown, field: string, pattern = IDENTIFIER): string => {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(field);
  return value as string;
};
const optionalText = (value: unknown, max: number, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) invalid(field);
  return value as string;
};
const positiveInteger = (value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) invalid(field);
  return value as number;
};
const object = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
};
const closedKeys = (value: Record<string, unknown>, allowed: readonly string[], field: string): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${field}.${key}`);
};

function validateCapabilities(value: unknown): ModelCapabilities | undefined {
  if (value === undefined) return undefined;
  const capabilities = object(value, 'capabilities');
  closedKeys(capabilities, ['contextWindow', 'maxOutputTokens', 'modalities', 'toolUse', 'reasoning'], 'capabilities');
  const result: ModelCapabilities = {};
  if (capabilities.contextWindow !== undefined) {
    result.contextWindow = positiveInteger(capabilities.contextWindow, 'capabilities.contextWindow');
  }
  if (capabilities.maxOutputTokens !== undefined) {
    result.maxOutputTokens = positiveInteger(capabilities.maxOutputTokens, 'capabilities.maxOutputTokens');
  }
  if (capabilities.modalities !== undefined) {
    const rawModalities = capabilities.modalities;
    if (!Array.isArray(rawModalities) || rawModalities.length > MODALITIES.length) {
      invalid('capabilities.modalities');
    }
    const modalities: Modality[] = [];
    for (const modality of rawModalities as unknown[]) {
      if (!MODALITIES.includes(modality as Modality) || modalities.includes(modality as Modality)) {
        invalid('capabilities.modalities');
      }
      modalities.push(modality as Modality);
    }
    result.modalities = modalities;
  }
  for (const key of ['toolUse', 'reasoning'] as const) {
    const candidate = capabilities[key];
    if (candidate !== undefined) {
      if (!TRI_STATES.includes(candidate as TriState)) invalid(`capabilities.${key}`);
      result[key] = candidate as TriState;
    }
  }
  return result;
}

function validateParameters(value: unknown): ModelParameters | undefined {
  if (value === undefined) return undefined;
  const parameters = object(value, 'parameters');
  closedKeys(parameters, ['reasoningEffort', 'maxTokens'], 'parameters');
  const result: ModelParameters = {};
  if (parameters.reasoningEffort !== undefined) {
    if (
      !Array.isArray(parameters.reasoningEffort) ||
      parameters.reasoningEffort.length > 10 ||
      parameters.reasoningEffort.some((item) => typeof item !== 'string' || !item.trim() || item.length > 64)
    ) {
      invalid('parameters.reasoningEffort');
    }
    const efforts = (parameters.reasoningEffort as string[]).map((item) => item.trim());
    if (new Set(efforts).size !== efforts.length) invalid('parameters.reasoningEffort');
    result.reasoningEffort = efforts;
  }
  if (parameters.maxTokens !== undefined) {
    const maxTokens = parameters.maxTokens;
    if (typeof maxTokens !== 'boolean') invalid('parameters.maxTokens');
    result.maxTokens = maxTokens as boolean;
  }
  return result;
}

function validateEntry(value: unknown, seen: Set<string>): ModelCatalogEntry {
  const entry = object(value, 'entry');
  closedKeys(
    entry,
    [
      'selectionId',
      'provider',
      'model',
      'displayName',
      'description',
      'adapter',
      'adapterVersion',
      'enabled',
      'unavailableReason',
      'verification',
      'capabilities',
      'parameters',
      'modelOptions',
    ],
    'entry',
  );
  const selectionId = identifier(entry.selectionId, 'selectionId', SELECTION_ID);
  if (seen.has(selectionId)) invalid('selectionId duplicate');
  seen.add(selectionId);
  if (!VERIFICATIONS.includes(entry.verification as ModelVerification)) invalid('verification');
  const enabled = entry.enabled;
  if (typeof enabled !== 'boolean') invalid('enabled');
  if (enabled === false && (typeof entry.unavailableReason !== 'string' || !entry.unavailableReason.trim())) {
    invalid('unavailableReason');
  }
  if (enabled === true && entry.unavailableReason !== undefined) invalid('unavailableReason');
  if (typeof entry.displayName !== 'string' || !entry.displayName.trim() || entry.displayName.length > 200) {
    invalid('displayName');
  }
  const result: ModelCatalogEntry = {
    selectionId,
    provider: identifier(entry.provider, 'provider', ROUTE),
    model: identifier(entry.model, 'model', ROUTE),
    displayName: String(entry.displayName),
    ...(entry.description !== undefined
      ? { description: optionalText(entry.description, 2000, 'description') as string }
      : {}),
    adapter: identifier(entry.adapter, 'adapter', ROUTE),
    ...(entry.adapterVersion !== undefined
      ? { adapterVersion: optionalText(entry.adapterVersion, 100, 'adapterVersion') as string }
      : {}),
    enabled: enabled as boolean,
    ...(enabled === false ? { unavailableReason: String(entry.unavailableReason) } : {}),
    verification: entry.verification as ModelVerification,
    ...(entry.capabilities !== undefined
      ? { capabilities: validateCapabilities(entry.capabilities) as ModelCapabilities }
      : {}),
    ...(entry.parameters !== undefined
      ? { parameters: validateParameters(entry.parameters) as ModelParameters }
      : {}),
  };
  if (entry.modelOptions !== undefined) {
    // The declared defaults are validated against the SAME rules a run's options face, so a
    // catalog cannot advertise a budget its parameters do not permit. Selection-option errors
    // surface as catalog-invalid on the entry field, not as a run-time option error.
    try {
      result.modelOptions = normalizeSelectionOptions(result, entry.modelOptions);
    } catch (error) {
      if (error instanceof PlatformError) invalid(`modelOptions.${error.code}`);
      throw error;
    }
  }
  return result;
}

export function validateModelCatalog(value: unknown): ModelCatalogDraft {
  const draft = object(value, 'catalog');
  closedKeys(draft, ['catalogId', 'runtimeBundleDigest', 'defaultSelectionId', 'entries'], 'catalog');
  const catalogId = identifier(draft.catalogId, 'catalogId');
  if (typeof draft.runtimeBundleDigest !== 'string' || !DIGEST.test(draft.runtimeBundleDigest)) {
    invalid('runtimeBundleDigest');
  }
  if (!Array.isArray(draft.entries) || draft.entries.length === 0 || draft.entries.length > 200) {
    invalid('entries');
  }
  const seen = new Set<string>();
  const entries = (draft.entries as unknown[]).map((entry) => validateEntry(entry, seen));
  if (draft.defaultSelectionId !== undefined) {
    const defaultSelectionId = draft.defaultSelectionId as string;
    identifier(defaultSelectionId, 'defaultSelectionId', SELECTION_ID);
    const selected = entries.find((entry) => entry.selectionId === defaultSelectionId);
    if (selected === undefined || !selected.enabled) invalid('defaultSelectionId');
  }
  return {
    catalogId,
    runtimeBundleDigest: draft.runtimeBundleDigest as string,
    ...(draft.defaultSelectionId !== undefined ? { defaultSelectionId: String(draft.defaultSelectionId) } : {}),
    entries,
  };
}

export function findCatalogEntry(catalog: ModelCatalogRecord, selectionId: string): ModelCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.selectionId === selectionId);
}

/** Server-side availability check used at preference save, run creation and retry. */
export function requireAvailableEntry(catalog: ModelCatalogRecord, selectionId: string): ModelCatalogEntry {
  const entry = findCatalogEntry(catalog, selectionId);
  if (!entry) throw new PlatformError('MODEL_SELECTION_UNKNOWN', selectionId);
  if (!entry.enabled) {
    throw new PlatformError('MODEL_SELECTION_UNAVAILABLE', entry.unavailableReason || selectionId);
  }
  return entry;
}

export function normalizeSelectionOptions(entry: ModelCatalogEntry, value: unknown): ModelSelectionOptions {
  if (value === undefined || value === null) return {};
  const options = object(value, 'modelOptions');
  closedKeys(options, ['reasoningEffort', 'maxTokens'], 'modelOptions');
  const result: ModelSelectionOptions = {};
  if (options.reasoningEffort !== undefined) {
    const allowed = entry.parameters?.reasoningEffort;
    if (
      typeof options.reasoningEffort !== 'string' ||
      !Array.isArray(allowed) ||
      !allowed.includes(options.reasoningEffort)
    ) {
      throw new PlatformError('MODEL_OPTION_UNAVAILABLE', 'reasoningEffort');
    }
    result.reasoningEffort = options.reasoningEffort;
  }
  if (options.maxTokens !== undefined) {
    if (entry.parameters?.maxTokens !== true) throw new PlatformError('MODEL_OPTION_UNAVAILABLE', 'maxTokens');
    result.maxTokens = positiveInteger(options.maxTokens, 'modelOptions.maxTokens', 10_000_000);
  }
  return result;
}

export function snapshotSelection(
  catalog: ModelCatalogRecord,
  entry: ModelCatalogEntry,
  options: ModelSelectionOptions,
  selectionSource: ModelSelectionSource,
  selectedAt = new Date().toISOString(),
): ModelConfigSnapshot {
  return {
    selectionId: entry.selectionId,
    provider: entry.provider,
    model: entry.model,
    adapter: entry.adapter,
    ...(entry.adapterVersion !== undefined ? { adapterVersion: entry.adapterVersion } : {}),
    catalogId: catalog.catalogId,
    catalogDigest: catalog.catalogDigest,
    runtimeBundleDigest: catalog.runtimeBundleDigest,
    verification: entry.verification,
    ...(entry.capabilities !== undefined ? { capabilities: structuredClone(entry.capabilities) } : {}),
    options: { ...options },
    selectionSource,
    selectedAt,
  };
}

/** A retry keeps the original route; a catalog that remaps the selection must not silently
 *  change what the retried run means. */
export function retrySnapshot(
  catalog: ModelCatalogRecord,
  previous: ModelConfigSnapshot,
  selectedAt = new Date().toISOString(),
): ModelConfigSnapshot {
  const entry = requireAvailableEntry(catalog, previous.selectionId);
  if (entry.provider !== previous.provider || entry.model !== previous.model || entry.adapter !== previous.adapter) {
    throw new PlatformError('MODEL_ROUTE_CHANGED', previous.selectionId);
  }
  // Re-validate recorded options against the current catalog entry instead of copying blindly.
  const options = normalizeSelectionOptions(entry, previous.options);
  return snapshotSelection(catalog, entry, options, 'retry', selectedAt);
}

export function publicCatalog(record: ModelCatalogRecord | null) {
  if (!record) return null;
  return {
    catalogId: record.catalogId,
    catalogDigest: record.catalogDigest,
    runtimeBundleDigest: record.runtimeBundleDigest,
    defaultSelectionId: record.defaultSelectionId ?? null,
    updatedAt: record.updatedAt,
    entries: record.entries.map((entry) => ({
      ...entry,
      available: entry.enabled,
      unavailableReason: entry.enabled ? null : entry.unavailableReason ?? '未说明',
    })),
  };
}
