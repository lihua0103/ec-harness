import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputBaselineRepository } from '../src/input-baselines.js';
import { PlatformStore } from '../src/store.js';
import { PlatformError } from '../src/registry.js';

const actor = 'session:baseline-test';
const digest = (n: string) => n.padEnd(64, '0').slice(0, 64);

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-baseline-'));
  const store = new PlatformStore(join(root, 'control.sqlite'));
  return { root, store, baselines: new InputBaselineRepository(store) };
};

test('a new input batch appends a new revision and never rewrites the old one', async () => {
  const { root, store, baselines } = await setup();
  try {
    const first = baselines.append({ workId: 'w1', sourceRef: 'dir:/study/v1', digest: digest('a') }, actor);
    const second = baselines.append({ workId: 'w1', sourceRef: 'dir:/study/v2', digest: digest('b') }, actor);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    const history = baselines.history('w1');
    assert.equal(history.length, 2);
    assert.equal(history[0].digest, digest('a'));
    assert.equal(baselines.latest('w1')?.revision, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('input baseline validation requires a supported source ref and a sha256 digest', async () => {
  const { root, store, baselines } = await setup();
  try {
    assert.throws(
      () => baselines.append({ workId: 'w1', sourceRef: '', digest: digest('a') }, actor),
      (error: unknown) => error instanceof PlatformError && error.code === 'INPUT_BASELINE_INVALID',
    );
    assert.throws(
      () => baselines.append({ workId: 'w1', sourceRef: 'dir:/x', digest: 'not-a-digest' }, actor),
      (error: unknown) => error instanceof PlatformError && error.code === 'INPUT_BASELINE_INVALID',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
