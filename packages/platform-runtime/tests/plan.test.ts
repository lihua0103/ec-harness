import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PlanError, assertPlanMatchesRelease, resolveExecutionPlan,
  type ApplicationRelease, type CapabilityProvider,
} from '../src/plan.js';

const digest = (character: string): string => character.repeat(64);
const provider = (id: string, version: string, dependencies: { capabilityId: string; version: string }[] = []): CapabilityProvider => ({
  capabilityId: id, version, pluginId: `plugin-${id}`, pluginVersion: version, artifactDigest: 'a'.repeat(64),
  protocolVersion: '1', inputSchemaVersion: `in-${version}`, outputSchemaVersion: `out-${version}`, dependencies,
});
const release = (providers: CapabilityProvider[], required = [{ capabilityId: 'listing', version: '1.0.0' }]): ApplicationRelease => ({
  appId: 'app-listing', version: '1.0.0', requiredCapabilities: required,
  providers, runtimeBundleDigest: digest('a'),
});

test('capability resolution is deterministic regardless of provider order', () => {
  const providers = [provider('listing', '1.0.0', [{ capabilityId: 'workbook', version: '2.0.0' }]), provider('workbook', '2.0.0')];
  const first = resolveExecutionPlan(release(providers));
  const second = resolveExecutionPlan(release([...providers].reverse()));
  assert.equal(first.planDigest, second.planDigest);
  assert.deepEqual(first.capabilities.map((c) => `${c.capabilityId}@${c.version}`), ['listing@1.0.0', 'workbook@2.0.0']);
  assert.deepEqual(first.requirements, [{ capabilityId: 'listing', version: '1.0.0' }]);
  assertPlanMatchesRelease(release(providers), first);
  const narrower = { ...release(providers), requiredCapabilities: [] };
  assert.notEqual(resolveExecutionPlan(narrower).planDigest, first.planDigest, 'requirements are part of the plan identity');
});

test('missing, conflicting, cyclic and version-mismatched providers fail at release time', () => {
  assert.throws(() => resolveExecutionPlan(release([])), (error: unknown) => error instanceof PlanError && error.code === 'PLAN_CAPABILITY_MISSING');
  assert.throws(() => resolveExecutionPlan(release([provider('listing', '1.0.0'), provider('listing', '1.0.0')])),
    (error: unknown) => error instanceof PlanError && error.code === 'PLAN_PROVIDER_CONFLICT');
  assert.throws(() => resolveExecutionPlan(release([provider('listing', '1.0.0', [{ capabilityId: 'workbook', version: '9.0.0' }])])),
    (error: unknown) => error instanceof PlanError && error.code === 'PLAN_CAPABILITY_MISSING');
  assert.throws(() => resolveExecutionPlan(release([
    provider('listing', '1.0.0', [{ capabilityId: 'workbook', version: '1.0.0' }]),
    provider('workbook', '1.0.0', [{ capabilityId: 'listing', version: '1.0.0' }]),
  ])), (error: unknown) => error instanceof PlanError && error.code === 'PLAN_DEPENDENCY_CYCLE');
  const base = release([provider('listing', '1.0.0')]);
  const otherBundle = { ...base, runtimeBundleDigest: digest('b') };
  assert.throws(
    () => assertPlanMatchesRelease(otherBundle, resolveExecutionPlan(base)),
    (error: unknown) => error instanceof PlanError && error.code === 'PLAN_DIGEST_MISMATCH',
  );

  const plan = resolveExecutionPlan(base);
  const tampered = {
    ...plan,
    capabilities: plan.capabilities.map((capability, index) =>
      index === 0 ? { ...capability, outputSchemaVersion: 'tampered' } : capability,
    ),
  };
  assert.throws(
    () => assertPlanMatchesRelease(base, tampered),
    (error: unknown) => error instanceof PlanError && error.code === 'PLAN_CONTENT_MISMATCH',
  );

  const sharedPluginA = { ...provider('listing', '1.0.0'), pluginId: 'plugin-shared', pluginVersion: '1.0.0' };
  const sharedPluginB = { ...provider('workbook', '1.0.0'), pluginId: 'plugin-shared', pluginVersion: '2.0.0' };
  assert.throws(
    () => resolveExecutionPlan(release([sharedPluginA, sharedPluginB], [
      { capabilityId: 'listing', version: '1.0.0' },
      { capabilityId: 'workbook', version: '1.0.0' },
    ])),
    (error: unknown) => error instanceof PlanError && error.code === 'PLAN_PLUGIN_VERSION_CONFLICT',
  );
});