import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformApi } from '../src/api.mjs';

// No server/model calls: assert the transport contract with deterministic responses.
test('history pagination includes record 101 and encodes run identity', async () => {
  const api = new PlatformApi();
  const paths = [];
  api.request = async (_method, path) => {
    paths.push(path);
    const offset = Number(new URL(path, 'http://test').searchParams.get('offset'));
    return { total: 101, items: Array.from({ length: offset === 0 ? 100 : 1 }, (_, i) => ({ sequence: offset + i + 1 })) };
  };
  const result = await api.runInputs('a/b');
  assert.equal(result.items.length, 101);
  assert.equal(result.items[100].sequence, 101);
  assert.match(paths[0], /a%2Fb/);
  assert.match(paths[1], /offset=100/);
});

test('empty intermediate page fails instead of claiming complete history', async () => {
  const api = new PlatformApi();
  api.request = async () => ({ total: 2, items: [] });
  await assert.rejects(api.listWorks(), { code: 'PAGE_INCOMPLETE' });
});

test('network error after a write reports unknown outcome, not safe replay', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('connection reset'); });
  const api = new PlatformApi();
  await assert.rejects(api.createWork({ title: 'synthetic' }), (error) => {
    assert.equal(error.code, 'NETWORK_UNAVAILABLE');
    assert.match(error.detail, /结果未知/);
    assert.doesNotMatch(error.detail, /没有提交/);
    return true;
  });
});
