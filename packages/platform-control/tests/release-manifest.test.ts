import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformError, releaseOf } from '../src/registry.js';
import { buildAppReleaseDraft, directoryDigest, pluginIdFrom, verificationBundleDigest } from '../src/release-manifest.js';

const application = {
  appId: 'ec.listing',
  displayName: 'Listing 开发与复跑',
  description: 'Synthetic business declaration for conversion tests.',
  listingTypes: ['Manual', 'Medical', 'PK', 'Report'],
  materialRoles: ['需求说明', 'ALS / 数据结构'],
  capabilityId: 'ec.listing.develop',
  capabilityVersion: '3.0.0',
  knowledgePluginId: 'dm-listing',
};
const manifest = { name: '@ec-clinical/dm-listing', version: '0.2.0' };

test('the shared conversion maps declared fields once and keeps the three version axes independent', () => {
  const { draft, versions } = buildAppReleaseDraft({
    application,
    manifest,
    pluginId: 'ec-clinical-dm-listing',
    artifactDigest: 'a'.repeat(64),
    runtimeBundleDigest: 'b'.repeat(64),
  });
  assert.equal(draft.descriptor.appId, 'ec.listing');
  assert.equal(draft.descriptor.version, manifest.version);
  assert.equal(draft.descriptor.knowledgePluginId, 'dm-listing');
  assert.deepEqual(draft.descriptor.listingTypes, ['Manual', 'Medical', 'PK', 'Report']);
  // Capability version comes from the application declaration, package versions from package.json.
  assert.deepEqual(draft.requiredCapabilities, [{ capabilityId: 'ec.listing.develop', version: '3.0.0' }]);
  assert.equal(draft.providers[0]?.version, '3.0.0');
  assert.equal(draft.providers[0]?.pluginVersion, '0.2.0');
  assert.deepEqual(versions, {
    appId: 'ec.listing',
    appVersion: '0.2.0',
    capabilityId: 'ec.listing.develop',
    capabilityVersion: '3.0.0',
    pluginId: 'ec-clinical-dm-listing',
    pluginVersion: '0.2.0',
    artifactDigest: 'a'.repeat(64),
  });
  assert.notEqual(versions.appVersion, versions.capabilityVersion);
  assert.notEqual(versions.capabilityVersion, versions.pluginVersion);
});

test('the conversion refuses undeclared capability versions and propagates input schema declarations', () => {
  const missing = { ...application, capabilityVersion: undefined };
  delete (missing as Record<string, unknown>).capabilityVersion;
  assert.throws(
    () => buildAppReleaseDraft({ application: missing, manifest, pluginId: 'x', artifactDigest: 'a'.repeat(64), runtimeBundleDigest: 'b'.repeat(64) }),
    (error: unknown) => error instanceof PlatformError && error.code === 'APP_DESCRIPTOR_INVALID',
  );
  const declared = buildAppReleaseDraft({
    application: { ...application, inputSchema: { type: 'object', required: ['batch'] }, inputSchemaVersion: '2' },
    manifest,
    pluginId: 'x',
    artifactDigest: 'a'.repeat(64),
    runtimeBundleDigest: 'b'.repeat(64),
  });
  assert.deepEqual(declared.draft.descriptor.inputSchema, { type: 'object', required: ['batch'] });
  assert.equal(declared.draft.descriptor.inputSchemaVersion, '2');
});

test('declared result views survive the shared conversion into the view-identity digest (W6/R1)', () => {
  const resultViews = [
    {
      viewId: 'issues-table',
      title: '问题清单',
      kind: 'table' as const,
      findingKind: 'issue',
      columns: [{ field: 'subject', label: '对象' }],
    },
  ];
  const input = {
    application: { ...application, resultViews },
    manifest,
    pluginId: 'x',
    artifactDigest: 'a'.repeat(64),
    runtimeBundleDigest: 'b'.repeat(64),
  };
  const { draft } = buildAppReleaseDraft(input);
  // The conversion must not drop the declaration: registry validation and releaseOf's view
  // identity both read this field, and the workbench renders the declared views from it.
  assert.deepEqual(draft.descriptor.resultViews, resultViews);
  const view = releaseOf(draft).identity?.view;
  assert.ok(view, 'a declared view must reach the plan identity');
  assert.equal(view?.version, '1');
  assert.match(view?.digest ?? '', /^[a-f0-9]{64}$/);
  // Any controlled view change moves the identity digest — the old approval cannot be reused.
  const changed = buildAppReleaseDraft({
    ...input,
    application: { ...application, resultViews: [{ ...resultViews[0], title: '问题清单（改）' }] },
  });
  assert.notEqual(releaseOf(changed.draft).identity?.view?.digest, view?.digest);
  // Undeclared means absent, never an empty digest.
  const none = buildAppReleaseDraft({ ...input, application });
  assert.equal(none.draft.descriptor.resultViews, undefined);
  assert.equal(releaseOf(none.draft).identity?.view, undefined);
});

test('pluginIdFrom prefers the cordis registration id over the npm name', () => {
  assert.equal(pluginIdFrom(manifest, '- insert:\n    - id: ec-clinical-dm-listing\n      name: x\n'), 'ec-clinical-dm-listing');
  assert.equal(pluginIdFrom(manifest), 'dm-listing');
});

test('directoryDigest is order-stable, content-sensitive and empty-set defined', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-manifest-'));
  try {
    await mkdir(join(root, 'lib', 'chunks'), { recursive: true });
    await writeFile(join(root, 'lib', 'index.js'), 'export const a = 1;\n');
    await writeFile(join(root, 'lib', 'chunks', 'b.js'), 'export const b = 2;\n');
    const first = directoryDigest(join(root, 'lib'));
    const second = directoryDigest(join(root, 'lib'));
    assert.equal(first, second);
    await writeFile(join(root, 'lib', 'chunks', 'b.js'), 'export const b = 3;\n');
    assert.notEqual(directoryDigest(join(root, 'lib')), first, 'any executor byte change moves the artifact digest');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(directoryDigest(join(root, 'does-not-exist')), directoryDigest(join(root, 'also-missing')));
});

test('verificationBundleDigest is deterministic and input-sensitive', () => {
  const base = verificationBundleDigest({ appId: 'ec.listing', version: '0.2.0', artifactDigest: 'a'.repeat(64) });
  assert.equal(base, verificationBundleDigest({ appId: 'ec.listing', version: '0.2.0', artifactDigest: 'a'.repeat(64) }));
  assert.notEqual(base, verificationBundleDigest({ appId: 'ec.listing', version: '0.2.0', artifactDigest: 'c'.repeat(64) }));
  assert.match(base, /^[a-f0-9]{64}$/);
});
