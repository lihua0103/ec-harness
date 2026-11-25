import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveryContent, sealDelivery, sha256 } from '../src/deliver.js';
import { allDatasets, bundleOf, layout, spec } from './fixtures.js';

async function bundle() {
  const specs = [
    spec({
      id: 'd1',
      title: '中心页面数',
      type: 'bar',
      datasetId: 'ds_sites',
      slots: { category: 'site', values: [{ column: 'pages' }] },
    }),
  ];
  return bundleOf(
    specs,
    layout([
      { kind: 'divider', i: 'd0', title: '分区', x: 0, y: 0, w: 24, h: 1 },
      { kind: 'chart', i: 'c1', specId: 'd1', x: 0, y: 1, w: 12, h: 6 },
    ]),
    allDatasets(),
  );
}

test('seals snapshot, page and acceptance with per-file digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dm-viz-deliver-'));
  try {
    const page = await bundle();
    const sealed = await sealDelivery(root, page, [], '2026-11-14T00:00:00.000Z');
    assert.equal(sealed.manifest.result, 'pass');
    assert.equal(sealed.manifest.createdAt, '2026-11-14T00:00:00.000Z');
    assert.deepEqual(
      sealed.manifest.files.map((file) => file.name),
      ['snapshot.json', 'page.html', 'acceptance.json'],
    );
    for (const file of sealed.manifest.files) {
      const content = await readFile(join(sealed.directory, file.name));
      assert.equal(file.bytes, content.length);
      assert.equal(file.sha256, sha256(content));
    }
    const acceptance = JSON.parse(await readFile(join(sealed.directory, 'acceptance.json'), 'utf8'));
    assert.equal(acceptance.result, 'pass');
    const snapshot = JSON.parse(await readFile(join(sealed.directory, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.layout.pageId, 'page1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('re-sealing the same configuration yields identical file digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dm-viz-deliver-'));
  try {
    const page = await bundle();
    const first = await sealDelivery(root, page);
    const second = await sealDelivery(root, page);
    assert.equal(first.directory, second.directory);
    assert.deepEqual(
      first.manifest.files.map((file) => file.sha256),
      second.manifest.files.map((file) => file.sha256),
    );
    assert.equal(first.manifest.specDigest, second.manifest.specDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failing page is still sealed and marked fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dm-viz-deliver-'));
  try {
    const page = await bundle();
    const broken = {
      ...page,
      datasets: [...page.datasets, { id: 'ds_empty_local', name: '空', columns: [{ key: 'a', label: 'a', type: 'number' as const }], rows: [] }],
      specs: [
        {
          id: 'd1',
          title: '空图',
          mode: 'data' as const,
          type: 'bar',
          datasetId: 'ds_empty_local',
          slots: { category: 'a', values: [{ column: 'a' }] },
        },
      ],
    };
    const sealed = await sealDelivery(root, broken);
    assert.equal(sealed.manifest.result, 'fail');
    const acceptance = JSON.parse(await readFile(join(sealed.directory, 'acceptance.json'), 'utf8'));
    assert.deepEqual(acceptance.structure.blankItems, ['c1']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delivery content is deterministic for the same bundle', async () => {
  const page = await bundle();
  const first = deliveryContent(page);
  const second = deliveryContent(page);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(
    first.files.map((file) => sha256(file.content)),
    second.files.map((file) => sha256(file.content)),
  );
});
