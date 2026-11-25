import type { AppReleaseDraft } from '../src/store.js';

export const provider = (
  id: string,
  version: string,
  dependencies: Array<{ capabilityId: string; version: string }> = [],
) => ({
  capabilityId: id,
  version,
  pluginId: `plugin-${id}`,
  pluginVersion: version,
  artifactDigest: 'a'.repeat(64),
  protocolVersion: '1',
  inputSchemaVersion: `in-${version}`,
  outputSchemaVersion: `out-${version}`,
  dependencies,
});

export function draft(id = 'listing', version = '1.0.0'): AppReleaseDraft {
  return {
    descriptor: {
      appId: id,
      version,
      displayName: 'Listing',
      description: 'Synthetic application for control-plane tests.',
      listingTypes: ['Manual', 'Medical', 'PK', 'Report'],
    },
    requiredCapabilities: [{ capabilityId: 'listing', version: '1.0.0' }],
    providers: [provider('listing', '1.0.0')],
    runtimeBundleDigest: 'b'.repeat(64),
  };
}

/** A synthetic DVP-family draft: same release contract, but the descriptor declares no Listing
 *  fields at all. The frozen-input tests use it to prove the platform faithfully carries an
 *  application's own input — never injecting Listing semantics the app did not declare. */
export function dvpDraft(id = 'dm-dvp', version = '1.0.0'): AppReleaseDraft {
  return {
    descriptor: {
      appId: id,
      version,
      displayName: 'DVP',
      description: 'Synthetic DVP application for control-plane tests.',
    },
    requiredCapabilities: [{ capabilityId: 'dvp', version: '1.0.0' }],
    providers: [provider('dvp', '1.0.0')],
    runtimeBundleDigest: 'c'.repeat(64),
  };
}
