/** The single manifest → release-draft conversion (R1/W1). `scripts/workbench-deployment.cjs`
 *  (release assembly) and `scripts/verify-applications.mjs` (registration gate) must both call
 *  THIS implementation: neither script picks descriptor fields on its own. Business manifests
 *  provide the declarations; this module is common logic and imports no business package.
 *
 *  Version axes are independent (R1): appVersion and pluginVersion come from package.json,
 *  capabilityVersion must be declared by application.json (`capabilityVersion`) — the
 *  conversion never substitutes one version for another, and returns the explicit mapping. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PlatformError, identifier } from './registry.js';
import type { AppReleaseDraft } from './store.js';

const sha256Buffer = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const canonical = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new PlatformError('PLATFORM_NON_JSON_VALUE');
};
const descriptorText = (value: unknown, max: number, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PlatformError('APP_DESCRIPTOR_INVALID', field);
  }
  return value;
};
const descriptorList = (value: unknown, field: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 100)
  ) {
    throw new PlatformError('APP_DESCRIPTOR_INVALID', field);
  }
  return [...new Set(value.map((item) => item.trim()))];
};

/** Recursive, sorted, POSIX-path digest of every file under a directory — the executor-bytes
 *  identity both scripts share. A missing directory hashes as the empty set (callers that
 *  require a build check existence first, so this only normalizes the formula). */
export function directoryDigest(dir: string): string {
  const files: Array<[string, string]> = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else files.push([relative(dir, full).replaceAll('\\', '/'), sha256Buffer(readFileSync(full))]);
    }
  };
  if (existsSync(dir)) walk(dir);
  return sha256Buffer(Buffer.from(JSON.stringify(files), 'utf8'));
}

/** The plugin id the executor registers in cordis: the `cordis.patch.yml` registration id wins
 *  over the npm name with its scope stripped (npm scopes are not valid plan identifiers). */
export function pluginIdFrom(manifest: { name?: string }, patchYaml?: string): string {
  if (patchYaml) {
    const match = /^\s*-\s*id:\s*([A-Za-z0-9][A-Za-z0-9._:/-]*)\s*$/m.exec(patchYaml);
    if (match) return match[1];
  }
  return String(manifest.name ?? '').replace(/^@[^/]+\//, '');
}

/** Verification-gate bundle identity: the registration gate has no worker profile to read, so
 *  its bundle facts are synthetic but deterministic and labeled by this one shared formula.
 *  The gate proves manifest→draft conversion rules, not deployment byte-equality; deployment
 *  derives its profile-based bundle facts in `scripts/workbench-deployment.cjs`. */
export function verificationBundleDigest(input: { appId: string; version: string; artifactDigest: string }): string {
  return sha256Buffer(Buffer.from(canonical(input), 'utf8'));
}

export interface ReleaseVersionMap {
  appId: string;
  /** package.json version — also the plugin package version. */
  appVersion: string;
  capabilityId: string;
  /** Declared in application.json; independent of the two package.json-derived versions. */
  capabilityVersion: string;
  pluginId: string;
  pluginVersion: string;
  artifactDigest: string;
}

export interface BuildAppReleaseDraftInput {
  /** Parsed application.json of the business plugin. */
  application: unknown;
  /** Parsed package.json of the business plugin. */
  manifest: { name?: string; version: string };
  pluginId: string;
  artifactDigest: string;
  runtimeBundleDigest: string;
}

/** Build the AppReleaseDraft for one business plugin from its declared manifests. Every field
 *  mapping lives here — adding a descriptor field means changing this function and nothing
 *  else, and both assembly and verification then see the same bytes. */
export function buildAppReleaseDraft(
  input: BuildAppReleaseDraftInput,
): { draft: AppReleaseDraft; versions: ReleaseVersionMap } {
  const { application, manifest, pluginId, artifactDigest, runtimeBundleDigest } = input;
  if (!application || typeof application !== 'object' || Array.isArray(application)) {
    throw new PlatformError('APP_DESCRIPTOR_INVALID', 'application.json');
  }
  const app = application as Record<string, unknown>;
  const appId = identifier(app.appId);
  const capabilityId = identifier(app.capabilityId);
  if (!app.capabilityVersion) {
    throw new PlatformError('APP_DESCRIPTOR_INVALID', 'application.json capabilityVersion (declared, independent of package version)');
  }
  const capabilityVersion = identifier(app.capabilityVersion);
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new PlatformError('APP_DESCRIPTOR_INVALID', 'package.json version');
  }
  identifier(manifest.version);
  const displayName = descriptorText(app.displayName, 200, 'displayName');
  const description = descriptorText(app.description, 4000, 'description');

  const descriptor: AppReleaseDraft['descriptor'] = {
    appId,
    version: manifest.version,
    displayName,
    description,
    ...(app.listingTypes !== undefined ? { listingTypes: descriptorList(app.listingTypes, 'listingTypes') } : {}),
    ...(app.materialRoles !== undefined ? { materialRoles: descriptorList(app.materialRoles, 'materialRoles') } : {}),
    ...(app.resultTypes !== undefined ? { resultTypes: descriptorList(app.resultTypes, 'resultTypes') } : {}),
    // Declarative result views (E1-5/W6): mapped through untouched so the registry's
    // validateResultViews is the single authority on shape. Omitting this mapping silently
    // dropped every business declaration before it reached releaseOf's view-identity digest.
    ...(app.resultViews !== undefined
      ? { resultViews: app.resultViews as NonNullable<AppReleaseDraft['descriptor']['resultViews']> }
      : {}),
    ...(app.knowledgePluginId !== undefined ? { knowledgePluginId: identifier(app.knowledgePluginId) } : {}),
    ...(app.inputSchema !== undefined ? { inputSchema: app.inputSchema } : {}),
    ...(app.inputSchemaVersion !== undefined ? { inputSchemaVersion: identifier(app.inputSchemaVersion) } : {}),
  };

  const draft: AppReleaseDraft = {
    descriptor,
    requiredCapabilities: [{ capabilityId, version: capabilityVersion }],
    providers: [
      {
        capabilityId,
        version: capabilityVersion,
        pluginId,
        pluginVersion: manifest.version,
        artifactDigest,
        protocolVersion: typeof app.protocolVersion === 'string' ? identifier(app.protocolVersion) : '1',
        inputSchemaVersion: typeof app.inputSchemaVersion === 'string' ? identifier(app.inputSchemaVersion) : '1',
        outputSchemaVersion: typeof app.outputSchemaVersion === 'string' ? identifier(app.outputSchemaVersion) : '1',
        dependencies: [],
      },
    ],
    runtimeBundleDigest,
  };
  return {
    draft,
    versions: { appId, appVersion: manifest.version, capabilityId, capabilityVersion, pluginId, pluginVersion: manifest.version, artifactDigest },
  };
}
