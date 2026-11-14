import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import type { ModelConfigSnapshot } from '../src/models.js';
import { LocalOperatorPolicy, type Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:model-test', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:model-test', kind: 'service' };
const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

class RecordingExecutor implements RunExecutor {
  readonly kind = 'recording';
  readonly models: Array<ModelConfigSnapshot | null | undefined> = [];
  async dispatch(input: { model?: ModelConfigSnapshot | null; launchId?: string; fencingToken?: number }) {
    this.models.push(input.model);
    return {
      launchId: input.launchId ?? 'launch-model-1',
      fencingToken: input.fencingToken ?? 1,
    };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  selectionId: 'model.flash',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  displayName: 'DeepSeek-V4.1-Flash',
  adapter: 'dsh-llm-deepseek',
  adapterVersion: '0.2.2-rc.1',
  enabled: true,
  verification: 'provider-declared',
  capabilities: { contextWindow: 1048576, modalities: ['text', 'image'] },
  parameters: { reasoningEffort: ['low', 'high'], maxTokens: true },
  ...overrides,
});
const catalogDraft = (overrides: Record<string, unknown> = {}) => ({
  catalogId: 'deployment.default',
  runtimeBundleDigest: 'b'.repeat(64),
  defaultSelectionId: 'model.flash',
  entries: [
    entry(),
    entry({
      selectionId: 'model.pro',
      model: 'deepseek-v4-pro',
      displayName: 'DeepSeek-V4-Pro',
      capabilities: { contextWindow: 1048576, modalities: ['text'] },
      parameters: { maxTokens: true },
    }),
  ],
  ...overrides,
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-model-service-'));
  const executor = new RecordingExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor);
  service.registerApp(draft(), operator);
  return { root, executor, service };
};

test('queued dispatch rechecks model availability without changing the frozen route', async () => {
  const { root, service, executor } = await setup();
  try {
    service.registerModelCatalog(catalogDraft(), operator);
    const run = service.createRun('listing', '1.0.0', {}, operator);
    service.registerModelCatalog(catalogDraft({ defaultSelectionId: 'model.pro', entries: [
      entry({ enabled: false, unavailableReason: 'revoked' }),
      entry({ selectionId: 'model.pro', model: 'pro' }),
    ] }), operator);
    await assert.rejects(service.dispatchRun(run.runId, run.snapshot.revision, supervisor),
      isPlatformError('MODEL_SELECTION_UNAVAILABLE'));
    assert.equal(executor.models.length, 0);
    assert.equal(service.getRun(run.runId, operator).model?.model, 'deepseek-flash');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('model policy filters catalog and rejects guessed ids, stale preferences and retries', async () => {
  const { root, service } = await setup();
  try {
    service.registerModelCatalog(catalogDraft(), operator);
    service.setModelPreference('model.flash', operator);
    let run = service.createRun('listing', '1.0.0', {}, operator);
    run = service.fail(run.runId, run.snapshot.revision, 'synthetic', supervisor);
    service.setPolicy(new LocalOperatorPolicy({ allowedModels: ['model.pro'] }));
    const catalog = service.modelCatalog(operator)!;
    assert.deepEqual(catalog.entries.map((item) => item.selectionId), ['model.pro']);
    assert.equal(catalog.defaultSelectionId, undefined);
    assert.equal(service.modelPreference(operator).selectionId, null);
    assert.throws(() => service.setModelPreference('model.flash', operator), isPlatformError('MODEL_SELECTION_UNKNOWN'));
    assert.throws(() => service.createRun('listing', '1.0.0', {}, operator, { modelSelectionId: 'model.flash' }),
      isPlatformError('MODEL_SELECTION_UNKNOWN'));
    assert.throws(() => service.retryRun(run.runId, operator), isPlatformError('MODEL_SELECTION_UNKNOWN'));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an explicit model selection is frozen into the run and the worker dispatch', async () => {
  const { root, executor, service } = await setup();
  try {
    service.registerModelCatalog(catalogDraft(), operator);
    let run = service.createRun('listing', '1.0.0', { goal: 'synthetic' }, operator, {
      modelSelectionId: 'model.flash',
      modelOptions: { reasoningEffort: 'high', maxTokens: 4096 },
    });
    assert.equal(run.model?.selectionId, 'model.flash');
    assert.equal(run.model?.provider, 'deepseek-official');
    assert.equal(run.model?.model, 'deepseek-flash');
    assert.equal(run.model?.adapter, 'dsh-llm-deepseek');
    assert.equal(run.model?.selectionSource, 'explicit');
    assert.deepEqual(run.model?.options, { reasoningEffort: 'high', maxTokens: 4096 });
    assert.match(String(run.model?.catalogDigest), /^[a-f0-9]{64}$/);
    assert.equal(run.model?.runtimeBundleDigest, 'b'.repeat(64));
    const created = service.audit(0, 100, operator).items.find((item) => item.action === 'RUN_CREATED');
    assert.equal((created?.details as { modelSelectionId?: string }).modelSelectionId, 'model.flash');

    run = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(executor.models.length, 1);
    assert.equal(executor.models[0]?.provider, 'deepseek-official');
    assert.equal(executor.models[0]?.model, 'deepseek-flash');
    assert.deepEqual(executor.models[0]?.options, { reasoningEffort: 'high', maxTokens: 4096 });
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a run without options inherits the catalog entry defaults; run options override per key', async () => {
  const { root, executor, service } = await setup();
  try {
    service.registerModelCatalog(catalogDraft({
      entries: [
        entry({ modelOptions: { maxTokens: 32768 } }),
        entry({
          selectionId: 'model.pro',
          model: 'deepseek-v4-pro',
          displayName: 'DeepSeek-V4-Pro',
          capabilities: { contextWindow: 1048576, modalities: ['text'] },
          parameters: { maxTokens: true },
        }),
      ],
    }), operator);
    // No run options: defaults inherited wholesale.
    let run = service.createRun('listing', '1.0.0', { goal: 'synthetic' }, operator, {
      modelSelectionId: 'model.flash',
    });
    assert.deepEqual(run.model?.options, { maxTokens: 32768 });
    run = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(executor.models[0]?.options?.maxTokens, 32768);
    // Partial run options override only the keys they name.
    run = service.createRun('listing', '1.0.0', { goal: 'synthetic' }, operator, {
      modelSelectionId: 'model.flash',
      modelOptions: { maxTokens: 2048 },
    });
    assert.deepEqual(run.model?.options, { maxTokens: 2048 });
    // A run-level null never widens: defaults still apply.
    run = service.createRun('listing', '1.0.0', { goal: 'synthetic' }, operator, {
      modelSelectionId: 'model.flash',
      modelOptions: null,
    });
    assert.deepEqual(run.model?.options, { maxTokens: 32768 });
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('without an explicit choice the deployment default is recorded; a saved preference wins', async () => {
  const { root, service } = await setup();
  try {
    service.registerModelCatalog(catalogDraft(), operator);
    const byDefault = service.createRun('listing', '1.0.0', {}, operator);
    assert.equal(byDefault.model?.selectionId, 'model.flash');
    assert.equal(byDefault.model?.selectionSource, 'catalog-default');

    service.setModelPreference('model.pro', operator);
    const byPreference = service.createRun('listing', '1.0.0', {}, operator);
    assert.equal(byPreference.model?.selectionId, 'model.pro');
    assert.equal(byPreference.model?.selectionSource, 'preference');
    const preference = service.modelPreference(operator);
    assert.equal(preference.state, 'available');
    assert.equal(preference.selectionId, 'model.pro');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown, disabled and option-invalid selections fail explicitly', async () => {
  const { root, service } = await setup();
  try {
    service.registerModelCatalog(catalogDraft(), operator);
    assert.throws(
      () => service.createRun('listing', '1.0.0', {}, operator, { modelSelectionId: 'model.gone' }),
      isPlatformError('MODEL_SELECTION_UNKNOWN'),
    );
    // A client-submitted provider/model route is not a selection id.
    assert.throws(
      () => service.createRun('listing', '1.0.0', {}, operator, { modelSelectionId: 'deepseek-official/deepseek-flash' }),
      isPlatformError('MODEL_SELECTION_UNKNOWN'),
    );
    service.registerModelCatalog(
      catalogDraft({
        defaultSelectionId: 'model.flash',
        entries: [
          entry(),
          entry({ selectionId: 'model.pro', model: 'deepseek-v4-pro', displayName: 'Pro', enabled: false, unavailableReason: '凭据过期' }),
        ],
      }),
      operator,
    );
    assert.throws(
      () => service.createRun('listing', '1.0.0', {}, operator, { modelSelectionId: 'model.pro' }),
      isPlatformError('MODEL_SELECTION_UNAVAILABLE'),
    );
    assert.throws(
      () => service.createRun('listing', '1.0.0', {}, operator, {
        modelSelectionId: 'model.flash',
        modelOptions: { reasoningEffort: 'ultra' },
      }),
      isPlatformError('MODEL_OPTION_UNAVAILABLE'),
    );
    assert.throws(
      () => service.createRun('listing', '1.0.0', {}, operator, {
        modelSelectionId: 'model.flash',
        modelOptions: { apiKey: 'secret' },
      }),
      isPlatformError('MODEL_CATALOG_INVALID'),
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale preference is reported and never silently replaced by the deployment default', async () => {
  const { root, service } = await setup();
  try {
    service.registerModelCatalog(catalogDraft(), operator);
    service.setModelPreference('model.pro', operator);
    service.registerModelCatalog(
      catalogDraft({
        defaultSelectionId: 'model.flash',
        entries: [
          entry(),
          entry({ selectionId: 'model.pro', model: 'deepseek-v4-pro', displayName: 'Pro', enabled: false, unavailableReason: '组织停用' }),
        ],
      }),
      operator,
    );
    const view = service.modelPreference(operator);
    assert.equal(view.state, 'unavailable');
    assert.match(view.reason, /组织停用/);
    assert.throws(
      () => service.createRun('listing', '1.0.0', {}, operator),
      isPlatformError('MODEL_PREFERENCE_UNAVAILABLE'),
    );
    // An explicit reselect succeeds; nothing was swapped in without a choice.
    const run = service.createRun('listing', '1.0.0', {}, operator, { modelSelectionId: 'model.flash' });
    assert.equal(run.model?.selectionId, 'model.flash');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog registration is idempotent, audited, and rejects a bundle outside the release', async () => {
  const { root, service } = await setup();
  try {
    const first = service.registerModelCatalog(catalogDraft(), operator);
    const again = service.registerModelCatalog(catalogDraft(), operator);
    assert.equal(again.catalogDigest, first.catalogDigest);
    const actions = service.audit(0, 100, operator).items.map((item) => item.action);
    assert.equal(actions.filter((action) => action === 'MODEL_CATALOG_REGISTERED').length, 1);

    service.registerModelCatalog(
      catalogDraft({
        entries: [entry({ selectionId: 'model.flash', displayName: 'Renamed' })],
      }),
      operator,
    );
    const updated = service.audit(0, 100, operator).items.filter((item) => item.action === 'MODEL_CATALOG_UPDATED');
    assert.equal(updated.length, 1);

    assert.throws(
      () => service.registerModelCatalog(catalogDraft({ entries: [{ ...entry(), apiKey: 'secret' }] }), operator),
      isPlatformError('MODEL_CATALOG_INVALID'),
    );

    const mismatched = catalogDraft({ runtimeBundleDigest: 'c'.repeat(64) });
    const mismatchedService = new PlatformControlService(join(root, 'mismatch.sqlite'));
    try {
      mismatchedService.registerApp(draft(), operator);
      mismatchedService.registerModelCatalog(mismatched, operator);
      assert.throws(
        () => mismatchedService.createRun('listing', '1.0.0', {}, operator),
        isPlatformError('MODEL_CATALOG_RUNTIME_MISMATCH'),
      );
    } finally {
      mismatchedService.close();
    }
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing run keeps its model snapshot when the catalog later changes', async () => {
  const { root, service } = await setup();
  try {
    service.registerModelCatalog(catalogDraft(), operator);
    const run = service.createRun('listing', '1.0.0', {}, operator, { modelSelectionId: 'model.pro' });
    assert.equal(run.model?.model, 'deepseek-v4-pro');
    service.registerModelCatalog(
      catalogDraft({ entries: [entry({ selectionId: 'model.flash' })] }),
      operator,
    );
    const loaded = service.getRun(run.runId, operator);
    assert.equal(loaded.model?.selectionId, 'model.pro');
    assert.equal(loaded.model?.model, 'deepseek-v4-pro');
    assert.equal(loaded.model?.catalogDigest, run.model?.catalogDigest);
    assert.throws(
      () => service.createRun('listing', '1.0.0', {}, operator, { modelSelectionId: 'model.pro' }),
      isPlatformError('MODEL_SELECTION_UNKNOWN'),
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retry creates a new run on the original route and refuses a disabled or remapped model', async () => {
  const { root, service } = await setup();
  try {
    service.registerModelCatalog(catalogDraft(), operator);
    let run = service.createRun('listing', '1.0.0', {}, operator, { modelSelectionId: 'model.flash' });
    run = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    run = service.fail(run.runId, run.snapshot.revision, 'synthetic failure', supervisor);
    const retried = service.retryRun(run.runId, operator);
    assert.notEqual(retried.runId, run.runId);
    assert.equal(retried.model?.selectionId, 'model.flash');
    assert.equal(retried.model?.model, 'deepseek-flash');
    assert.equal(retried.model?.selectionSource, 'retry');

    service.registerModelCatalog(
      catalogDraft({
        defaultSelectionId: 'model.pro',
        entries: [
          entry({ selectionId: 'model.flash', enabled: false, unavailableReason: '凭据过期' }),
          entry({ selectionId: 'model.pro', model: 'deepseek-v4-pro', displayName: 'Pro' }),
        ],
      }),
      operator,
    );
    assert.throws(() => service.retryRun(run.runId, operator), isPlatformError('MODEL_SELECTION_UNAVAILABLE'));

    service.registerModelCatalog(
      catalogDraft({
        defaultSelectionId: 'model.pro',
        entries: [
          entry({ selectionId: 'model.flash', model: 'deepseek-flash-next' }),
          entry({ selectionId: 'model.pro', model: 'deepseek-v4-pro', displayName: 'Pro' }),
        ],
      }),
      operator,
    );
    assert.throws(() => service.retryRun(run.runId, operator), isPlatformError('MODEL_ROUTE_CHANGED'));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a deployment without a catalog keeps the model unrecorded (legacy, never invented)', async () => {
  const { root, service } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    assert.equal(run.model, null);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
