// M1-01 剩余：身份接线部署配置。可信 Principal → 插件知识范围；越界失败关闭，不静默补全。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentityScopeConfig, deriveScope } from '../lib/index.js';

const config = {
  schemaVersion: 1,
  bindings: [
    { pluginId: 'dm-dvp', allProjects: true, orgId: 'org-a', region: 'cn', corpusDocPrefixes: ['docs/dvp/'] },
    { pluginId: 'dm-listing', projectIds: ['proj-a', 'proj-b'], locale: 'zh-CN' },
  ],
};

test('a bound plugin with full authorization derives an in-scope declaration', () => {
  const parsed = parseIdentityScopeConfig(config);
  const scope = deriveScope(parsed, { actorId: 'session:alice', pluginIds: ['dm-dvp', 'dm-listing'] }, 'dm-dvp');
  assert.equal(scope.pluginId, 'dm-dvp');
  assert.equal(scope.allProjects, true);
  assert.equal(scope.orgId, 'org-a');
  assert.equal(scope.region, 'cn');
  assert.deepEqual(scope.corpusDocPrefixes, ['docs/dvp/']);
});

test('a project-bound plugin derives project list from the binding, not from Principal', () => {
  const parsed = parseIdentityScopeConfig(config);
  const scope = deriveScope(parsed, { actorId: 'session:bob', pluginIds: ['dm-listing'], orgId: 'org-a' }, 'dm-listing');
  assert.equal(scope.pluginId, 'dm-listing');
  assert.deepEqual(scope.projectIds, ['proj-a', 'proj-b']);
  assert.equal(scope.locale, 'zh-CN');
  assert.equal(scope.orgId, 'org-a');
  assert.equal(scope.allProjects, undefined);
});

test('binding org/region inherit from Principal when the binding does not declare them', () => {
  const parsed = parseIdentityScopeConfig({
    schemaVersion: 1,
    bindings: [{ pluginId: 'no-binding-org', projectIds: ['proj-a'] }],
  });
  const scope = deriveScope(parsed, { actorId: 'session:carol', orgId: 'org-x', region: 'eu', pluginIds: ['no-binding-org'] }, 'no-binding-org');
  assert.equal(scope.orgId, 'org-x');
  assert.equal(scope.region, 'eu');
});

test('a plugin not in the Principal authorization set is refused', () => {
  const parsed = parseIdentityScopeConfig(config);
  assert.throws(() => deriveScope(parsed, { actorId: 'session:alice', pluginIds: ['dm-listing'] }, 'dm-dvp'),
    /KNOWLEDGE_PLUGIN_NOT_AUTHORIZED/);
});

test('a plugin without a binding is refused', () => {
  const parsed = parseIdentityScopeConfig(config);
  assert.throws(() => deriveScope(parsed, { actorId: 'session:alice', pluginIds: ['unknown'] }, 'unknown'),
    /KNOWLEDGE_PLUGIN_NOT_BOUND/);
});

test('duplicate plugins and unknown config fields are rejected', () => {
  assert.throws(() => parseIdentityScopeConfig({
    schemaVersion: 1,
    bindings: [{ pluginId: 'p', allProjects: true }, { pluginId: 'p', allProjects: true }],
  }), /KNOWLEDGE_IDENTITY_CONFIG_DUPLICATE_PLUGIN/);
  assert.throws(() => parseIdentityScopeConfig({ schemaVersion: 1, bindings: [{ pluginId: 'p' }], bogus: true }),
    /KNOWLEDGE_IDENTITY_CONFIG_INVALID:/);
  assert.throws(() => parseIdentityScopeConfig({ schemaVersion: 2, bindings: [{ pluginId: 'p' }] }),
    /KNOWLEDGE_IDENTITY_CONFIG_UNSUPPORTED/);
  assert.throws(() => parseIdentityScopeConfig('not an object'), /KNOWLEDGE_IDENTITY_CONFIG_INVALID/);
});