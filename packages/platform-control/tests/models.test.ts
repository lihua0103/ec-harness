import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelCatalogDigest,
  normalizeSelectionOptions,
  publicCatalog,
  requireAvailableEntry,
  retrySnapshot,
  snapshotSelection,
  validateModelCatalog,
  type ModelCatalogRecord,
} from '../src/models.js';
import { PlatformError } from '../src/registry.js';

const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

const entry = (overrides: Record<string, unknown> = {}) => ({
  selectionId: 'model.deepseek-flash',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  displayName: 'DeepSeek-V4.1-Flash',
  description: 'Synthetic catalog entry for tests.',
  adapter: 'dsh-llm-deepseek',
  adapterVersion: '0.2.2-rc.1',
  enabled: true,
  verification: 'provider-declared',
  capabilities: { contextWindow: 1048576, modalities: ['text', 'image'] },
  parameters: { reasoningEffort: ['low', 'high'], maxTokens: true },
  ...overrides,
});

function catalog(overrides: Record<string, unknown> = {}): ModelCatalogRecord {
  const draft = validateModelCatalog({
    catalogId: 'deployment.default',
    runtimeBundleDigest: 'b'.repeat(64),
    defaultSelectionId: 'model.deepseek-flash',
    entries: [
      entry(),
      entry({
        selectionId: 'model.deepseek-pro',
        model: 'deepseek-v4-pro',
        displayName: 'DeepSeek-V4-Pro',
        capabilities: { contextWindow: 1048576, modalities: ['text'] },
        parameters: { maxTokens: true },
      }),
    ],
    ...overrides,
  });
  return {
    ...draft,
    catalogDigest: modelCatalogDigest(draft),
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  };
}

test('catalog snapshots are validated and digested independently of key order', () => {
  const first = validateModelCatalog({
    catalogId: 'deployment.default',
    runtimeBundleDigest: 'b'.repeat(64),
    entries: [entry()],
  });
  const second = validateModelCatalog({
    entries: [entry()],
    runtimeBundleDigest: 'b'.repeat(64),
    catalogId: 'deployment.default',
  });
  assert.equal(modelCatalogDigest(first), modelCatalogDigest(second));
  assert.equal(first.entries[0].capabilities?.modalities?.[1], 'image');
});

test('catalog validation rejects secrets, duplicates, bad ids and unusable defaults', () => {
  const base = { catalogId: 'deployment.default', runtimeBundleDigest: 'b'.repeat(64) };
  assert.throws(
    () => validateModelCatalog({ ...base, entries: [{ ...entry(), apiKey: 'secret' }] }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
  assert.throws(
    () => validateModelCatalog({ ...base, entries: [entry({ baseURL: 'https://evil.test' })] }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
  assert.throws(
    () => validateModelCatalog({ ...base, entries: [entry(), entry()] }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
  // selectionId must not be a provider/model route string minted by a client.
  assert.throws(
    () => validateModelCatalog({ ...base, entries: [entry({ selectionId: 'deepseek-official/deepseek-flash' })] }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
  assert.throws(
    () => validateModelCatalog({ ...base, defaultSelectionId: 'model.missing', entries: [entry()] }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
  assert.throws(
    () =>
      validateModelCatalog({
        ...base,
        defaultSelectionId: 'model.off',
        entries: [entry({ selectionId: 'model.off', enabled: false, unavailableReason: 'disabled' })],
      }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
  assert.throws(
    () =>
      validateModelCatalog({
        ...base,
        entries: [entry({ enabled: false })],
      }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
});

test('availability and option allowlists are enforced at resolution time', () => {
  const record = catalog();
  assert.equal(requireAvailableEntry(record, 'model.deepseek-flash').provider, 'deepseek-official');
  assert.throws(() => requireAvailableEntry(record, 'model.missing'), isPlatformError('MODEL_SELECTION_UNKNOWN'));
  const disabled = catalog({
    defaultSelectionId: undefined,
    entries: [entry({ selectionId: 'model.off', enabled: false, unavailableReason: '组织策略停用' })],
  });
  assert.throws(
    () => requireAvailableEntry(disabled, 'model.off'),
    isPlatformError('MODEL_SELECTION_UNAVAILABLE'),
  );
  const flash = requireAvailableEntry(record, 'model.deepseek-flash');
  assert.deepEqual(normalizeSelectionOptions(flash, { reasoningEffort: 'high', maxTokens: 2048 }), {
    reasoningEffort: 'high',
    maxTokens: 2048,
  });
  assert.throws(
    () => normalizeSelectionOptions(flash, { reasoningEffort: 'ultra' }),
    isPlatformError('MODEL_OPTION_UNAVAILABLE'),
  );
  assert.throws(
    () => normalizeSelectionOptions(flash, { provider: 'other' }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
  const pro = requireAvailableEntry(record, 'model.deepseek-pro');
  assert.throws(
    () => normalizeSelectionOptions(pro, { reasoningEffort: 'low' }),
    isPlatformError('MODEL_OPTION_UNAVAILABLE'),
  );
});

test('entry-level default modelOptions are validated like run options', () => {
  const draft = { catalogId: 'deployment.default', runtimeBundleDigest: 'b'.repeat(64), defaultSelectionId: 'model.deepseek-flash' };
  // Permitted default: maxTokens declared by parameters.
  const withDefault = validateModelCatalog({
    ...draft,
    entries: [entry({ modelOptions: { maxTokens: 32768 } })],
  });
  assert.deepEqual(withDefault.entries[0].modelOptions, { maxTokens: 32768 });
  // A default the entry's parameters do not permit is a catalog-invalid entry, never a run-time error.
  assert.throws(
    () => validateModelCatalog({ ...draft, entries: [entry({ modelOptions: { maxTokens: 2048 }, parameters: {} })] }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
  assert.throws(
    () => validateModelCatalog({ ...draft, entries: [entry({ modelOptions: { apiKey: 'secret' } })] }),
    isPlatformError('MODEL_CATALOG_INVALID'),
  );
});

test('run snapshots freeze the route, options and catalog digest', () => {
  const record = catalog();
  const snapshot = snapshotSelection(
    record,
    requireAvailableEntry(record, 'model.deepseek-flash'),
    { reasoningEffort: 'high' },
    'explicit',
    '2026-11-11T01:00:00.000Z',
  );
  assert.equal(snapshot.provider, 'deepseek-official');
  assert.equal(snapshot.model, 'deepseek-flash');
  assert.equal(snapshot.adapter, 'dsh-llm-deepseek');
  assert.equal(snapshot.catalogDigest, record.catalogDigest);
  assert.equal(snapshot.runtimeBundleDigest, record.runtimeBundleDigest);
  assert.equal(snapshot.selectionSource, 'explicit');
  assert.deepEqual(snapshot.options, { reasoningEffort: 'high' });
  assert.equal(snapshot.verification, 'provider-declared');
});

test('retry keeps the original route and refuses silent remaps or disabled models', () => {
  const record = catalog();
  const previous = snapshotSelection(
    record,
    requireAvailableEntry(record, 'model.deepseek-flash'),
    {},
    'explicit',
  );
  const retried = retrySnapshot(record, previous, '2026-11-11T02:00:00.000Z');
  assert.equal(retried.selectionId, previous.selectionId);
  assert.equal(retried.model, previous.model);
  assert.equal(retried.selectionSource, 'retry');

  const remapped = catalog();
  remapped.entries = remapped.entries.map((item) =>
    item.selectionId === 'model.deepseek-flash' ? { ...item, model: 'deepseek-other' } : item,
  );
  remapped.catalogDigest = modelCatalogDigest(remapped);
  assert.throws(() => retrySnapshot(remapped, previous), isPlatformError('MODEL_ROUTE_CHANGED'));

  const off = catalog({
    defaultSelectionId: undefined,
    entries: [entry({ selectionId: 'model.deepseek-flash', enabled: false, unavailableReason: '凭据过期' })],
  });
  assert.throws(() => retrySnapshot(off, previous), isPlatformError('MODEL_SELECTION_UNAVAILABLE'));
});

test('public catalog exposes availability without secrets', () => {
  const record = catalog({
    defaultSelectionId: undefined,
    entries: [
      entry(),
      entry({ selectionId: 'model.off', enabled: false, unavailableReason: '未获区域批准' }),
    ],
  });
  const view = publicCatalog(record);
  assert.equal(view?.entries[0].available, true);
  assert.equal(view?.entries[1].available, false);
  assert.match(String(view?.entries[1].unavailableReason), /区域/);
  assert.equal(JSON.stringify(view).includes('apiKey'), false);
  assert.equal(publicCatalog(null), null);
});
