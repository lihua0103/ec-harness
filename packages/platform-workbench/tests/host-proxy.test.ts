import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_METHODS,
  CONTROL_PREFIX,
  forwardedHeaders,
  forwardedResponseHeaders,
  safeProxiedPath,
  upstreamUrl,
  writeOriginAllowed,
} from '../src/index.js';

test('the proxy maps the platform prefix onto the configured control origin only', () => {
  const configured = new URL('https://control.internal:8443');
  const mapped = upstreamUrl(configured, '/platform-workbench/api/works/w1/context', '?sessionId=s1');
  assert.equal(mapped.origin, 'https://control.internal:8443');
  assert.equal(mapped.pathname, '/api/works/w1/context');
  assert.equal(mapped.search, '?sessionId=s1');
});

test('the proxy never lets a path escape the configured origin', () => {
  const configured = new URL('https://control.internal:8443');
  // An absolute-path remains on the configured origin; protocol-relative segments cannot redirect it.
  const mapped = upstreamUrl(configured, '/platform-workbench//evil.example/x', '');
  assert.equal(mapped.origin, 'https://control.internal:8443');
});

test('only caller credentials and content headers are forwarded upstream', () => {
  const headers = forwardedHeaders(new Headers({
    authorization: 'Bearer token',
    cookie: 'a=b',
    accept: 'application/json',
    'x-forwarded-host': 'spoofed',
    'x-evil': '1',
  }));
  assert.equal(headers.get('authorization'), 'Bearer token');
  assert.equal(headers.get('cookie'), 'a=b');
  assert.equal(headers.get('x-forwarded-host'), null);
  assert.equal(headers.get('x-evil'), null);
});

test('a sealed-artifact download keeps its filename and type, but no control-plane internals', () => {
  const headers = forwardedResponseHeaders(new Headers({
    'content-type': 'text/csv',
    'content-disposition': 'attachment; filename="listing.csv"',
    'content-length': '12',
    'set-cookie': 'secret=1',
    'x-control-internal': 'seal-root',
  }));
  assert.equal(headers.get('content-type'), 'text/csv');
  assert.match(headers.get('content-disposition') ?? '', /listing\.csv/);
  assert.equal(headers.get('content-length'), '12');
  assert.equal(headers.get('set-cookie'), null);
  assert.equal(headers.get('x-control-internal'), null);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
});

test('the control prefix is a fixed, non-colliding path', () => {
  assert.equal(CONTROL_PREFIX, '/platform-workbench');
  assert.equal(CONTROL_PREFIX.startsWith('/api'), false);
});

test('the workbench operations the page needs are forwarded, nothing else', () => {
  assert.deepEqual([...ALLOWED_METHODS], ['GET', 'HEAD', 'POST', 'PUT']);
  assert.equal(ALLOWED_METHODS.includes('DELETE' as never), false);
});

test('a proxied path cannot climb out of the control route space', () => {
  assert.equal(safeProxiedPath('/platform-workbench/api/works/w1/draft'), true);
  assert.equal(safeProxiedPath('/platform-workbench/../admin'), false);
  assert.equal(safeProxiedPath('/platform-workbench/%2e%2e/admin'), false);
  assert.equal(safeProxiedPath('/platform-workbench/api/..%2fsecret'), false);
  assert.equal(safeProxiedPath('/platform-workbench/api\\secret'), false);
});

test('a browser write is accepted only from this origin', () => {
  const same = writeOriginAllowed({ headers: new Headers({ origin: 'http://127.0.0.1:3095', host: '127.0.0.1:3095' }) });
  assert.equal(same, true);
  const foreign = writeOriginAllowed({ headers: new Headers({ origin: 'https://evil.example', host: '127.0.0.1:3095' }) });
  assert.equal(foreign, false);
  const crossSite = writeOriginAllowed({ headers: new Headers({ 'sec-fetch-site': 'cross-site', host: '127.0.0.1:3095' }) });
  assert.equal(crossSite, false);
  // A CLI probe or same-origin GET has no Origin header; it is not a cross-site browser write.
  assert.equal(writeOriginAllowed({ headers: new Headers({ host: '127.0.0.1:3095' }) }), true);
  assert.equal(writeOriginAllowed({ headers: new Headers({ origin: 'not a url', host: '127.0.0.1:3095' }) }), false);
});
