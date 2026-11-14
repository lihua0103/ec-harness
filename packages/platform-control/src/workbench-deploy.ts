/** Parameterized native-workbench deployment assembly (T08).
 *
 *  Two shapes share one UI artifact and one control-plane service:
 *  - `local`: a single-owner process with explicit home/workspace/port; the operator principal is
 *    the local trust boundary.
 *  - `hosted`: one authoritative control-service process plus execution domains reached through an
 *    authenticated, Origin-checked entry. The entry proxies only allow-listed services and never
 *    accepts a user-supplied URL, so a browser cannot turn it into an open proxy.
 *
 *  This module validates and shapes the assembly inputs. It never writes credentials: providers are
 *  referenced only by the environment variable name their adapter reads.
 */
import { isAbsolute } from 'node:path';
import { PlatformError } from './registry.js';

export type DeploymentMode = 'local' | 'hosted';

export interface LocalDeploymentDraft {
  mode: 'local';
  home: string;
  workspace: string;
  port: number;
}

export interface HostedDeploymentDraft {
  mode: 'hosted';
  /** One authoritative control-service origin; execution domains connect to it, not to each other. */
  controlUrl: string;
  /** Allowed browser origins (scheme + host + port); no wildcards. */
  allowedOrigins: string[];
  /** Execution domains reachable through the authenticated entry; each carries a stable id. */
  domains: Array<{ domainId: string; controlUrl: string }>;
  port: number;
}

export type DeploymentDraft = LocalDeploymentDraft | HostedDeploymentDraft;

export interface ValidatedDeployment {
  mode: DeploymentMode;
  port: number;
  /** Absolute local home/workspace for the local shape. */
  home?: string;
  workspace?: string;
  /** Hosted control origin and its allow-listed domains/origins. */
  controlUrl?: string;
  allowedOrigins?: string[];
  domains?: Array<{ domainId: string; controlUrl: string }>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

const requirePort = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new PlatformError('DEPLOYMENT_INVALID', 'port');
  }
  return Number(value);
};
const requireAbsolute = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new PlatformError('DEPLOYMENT_INVALID', field);
  }
  return value;
};
const requireOrigin = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !ORIGIN.test(value)) throw new PlatformError('DEPLOYMENT_INVALID', field);
  return value;
};

/** A URL is never accepted with embedded credentials or a query string (they leak into logs). */
export function assertNoSecretInUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PlatformError('DEPLOYMENT_URL_INVALID', url);
  }
  if (parsed.username || parsed.password) throw new PlatformError('DEPLOYMENT_URL_HAS_CREDENTIALS');
  if (parsed.search) throw new PlatformError('DEPLOYMENT_URL_HAS_QUERY');
  return url;
}

/**
 * Validate a deployment draft.
 * Hosted mode refuses a domain that points at the browser or a non-http(s) scheme, and requires at
 * least one allow-listed origin so the entry cannot be driven by an arbitrary page.
 */
export function validateDeployment(draft: unknown): ValidatedDeployment {
  if (!draft || typeof draft !== 'object') throw new PlatformError('DEPLOYMENT_INVALID');
  const value = draft as Record<string, unknown>;
  if (value.mode === 'local') {
    return {
      mode: 'local',
      port: requirePort(value.port),
      home: requireAbsolute(value.home, 'home'),
      workspace: requireAbsolute(value.workspace, 'workspace'),
    };
  }
  if (value.mode === 'hosted') {
    const controlUrl = assertNoSecretInUrl(requireOrigin(value.controlUrl, 'controlUrl'));
    if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length === 0) {
      throw new PlatformError('DEPLOYMENT_INVALID', 'allowedOrigins');
    }
    const allowedOrigins = value.allowedOrigins.map((origin) => requireOrigin(origin, 'allowedOrigins'));
    if (new Set(allowedOrigins).size !== allowedOrigins.length) {
      throw new PlatformError('DEPLOYMENT_INVALID', 'duplicate origin');
    }
    if (!Array.isArray(value.domains) || value.domains.length === 0) {
      throw new PlatformError('DEPLOYMENT_INVALID', 'domains');
    }
    const seen = new Set<string>();
    const domains = value.domains.map((entry) => {
      const domain = entry as Record<string, unknown>;
      const domainId = domain.domainId;
      if (typeof domainId !== 'string' || !IDENTIFIER.test(domainId)) {
        throw new PlatformError('DEPLOYMENT_INVALID', 'domainId');
      }
      if (seen.has(domainId)) throw new PlatformError('DEPLOYMENT_INVALID', 'duplicate domainId');
      seen.add(domainId);
      return { domainId, controlUrl: assertNoSecretInUrl(requireOrigin(domain.controlUrl, 'domains.controlUrl')) };
    });
    return { mode: 'hosted', port: requirePort(value.port), controlUrl, allowedOrigins, domains };
  }
  throw new PlatformError('DEPLOYMENT_INVALID', 'mode');
}

/** Browser-facing origin allow-list decision used by the hosted entry. */
export function originAllowed(validated: ValidatedDeployment, origin: string | undefined): boolean {
  if (validated.mode !== 'hosted') return false;
  if (typeof origin !== 'string') return false;
  return validated.allowedOrigins?.includes(origin) === true;
}
