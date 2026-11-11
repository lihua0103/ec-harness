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
