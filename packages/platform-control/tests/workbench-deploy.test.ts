import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoSecretInUrl,
  originAllowed,
  validateDeployment,
} from '../src/workbench-deploy.js';
import { PlatformError } from '../src/registry.js';

const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

test('a local deployment requires explicit absolute home and workspace and a valid port', () => {
  const local = validateDeployment({ mode: 'local', home: 'C:/work/home', workspace: 'C:/work/study', port: 3083 });
  assert.deepEqual(local, { mode: 'local', home: 'C:/work/home', workspace: 'C:/work/study', port: 3083 });
  assert.throws(() => validateDeployment({ mode: 'local', home: 'relative/home', workspace: 'C:/w', port: 3083 }), isPlatformError('DEPLOYMENT_INVALID'));
  assert.throws(() => validateDeployment({ mode: 'local', home: 'C:/h', workspace: 'C:/w', port: 70000 }), isPlatformError('DEPLOYMENT_INVALID'));
});

test('hosted requires control URL, allow-listed origins and unique domains', () => {
  const hosted = validateDeployment({
    mode: 'hosted',
    controlUrl: 'https://control.example.internal:8443',
    allowedOrigins: ['https://workbench.example.internal'],
    domains: [{ domainId: 'domain-a', controlUrl: 'https://domain-a.internal:9000' }],
    port: 8443,
  });
  assert.equal(hosted.mode, 'hosted');
  assert.equal(hosted.domains?.length, 1);
  assert.throws(() => validateDeployment({ mode: 'hosted', controlUrl: 'https://c.i', allowedOrigins: [], domains: [{ domainId: 'd', controlUrl: 'https://d.i' }], port: 1 }), isPlatformError('DEPLOYMENT_INVALID'));
  assert.throws(() => validateDeployment({ mode: 'hosted', controlUrl: 'https://c.i', allowedOrigins: ['https://w.i'], domains: [{ domainId: 'd', controlUrl: 'https://d.i' }, { domainId: 'd', controlUrl: 'https://e.i' }], port: 1 }), isPlatformError('DEPLOYMENT_INVALID'));
});

test('a URL with embedded credentials or a query string is refused', () => {
  assert.throws(() => assertNoSecretInUrl('https://user:pass@control.i'), isPlatformError('DEPLOYMENT_URL_HAS_CREDENTIALS'));
  assert.throws(() => assertNoSecretInUrl('https://control.i/?token=abc'), isPlatformError('DEPLOYMENT_URL_HAS_QUERY'));
  assert.equal(assertNoSecretInUrl('https://control.i:8443'), 'https://control.i:8443');
});

test('the hosted entry only admits allow-listed browser origins', () => {
  const hosted = validateDeployment({
    mode: 'hosted',
    controlUrl: 'https://c.i:8443',
    allowedOrigins: ['https://w.i'],
    domains: [{ domainId: 'd', controlUrl: 'https://d.i:9000' }],
    port: 8443,
  });
  assert.equal(originAllowed(hosted, 'https://w.i'), true);
  assert.equal(originAllowed(hosted, 'https://evil.i'), false);
  assert.equal(originAllowed(hosted, undefined), false);
  const local = validateDeployment({ mode: 'local', home: 'C:/h', workspace: 'C:/w', port: 3083 });
  assert.equal(originAllowed(local, 'https://w.i'), false);
});
