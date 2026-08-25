import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerBranding } from '../../src/branding.js';
import { createDataInterceptionPolicy } from '../../src/data-interception-policy.js';

const taps = [];
const routes = new Map();
const ctx = {
  webServer: {
    tapIndex(transform) {
      taps.push(transform);
      return () => {
        const index = taps.indexOf(transform);
        if (index >= 0) taps.splice(index, 1);
      };
    },
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
};

const policy = createDataInterceptionPolicy(true);
const dispose = registerBranding(ctx, { brandName: 'Emerald Clinical', brandShortName: 'Emerald' }, policy);
assert.equal(taps.length, 1);
assert.equal(routes.size, 3);

const source = await readFile(new URL('../../../runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html', import.meta.url), 'utf8');
const html = taps[0](source);
assert.match(html, /<title>Emerald Clinical<\/title>/);
assert.doesNotMatch(html, /<title>DeepSeek Harness<\/title>/);
assert.match(html, /<meta name="application-name" content="Emerald Clinical">/);
assert.ok(html.includes('.replace(/DeepSeek(?: Harness)?/gi, brand)'));
assert.ok(html.includes('.replace(/\\bDSH\\b/g, "Emerald")'));
assert.ok(html.includes('div[class*="logoRow"] > button[class*="brand"] > svg'));
assert.ok(html.includes('svg[class*="railFish"]'));
assert.ok(html.includes('data-brand-logo'));

async function readRoute(path, method = 'GET', reqBody = undefined, headers = {}) {
  const response = { headers: null, body: '' };
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (reqBody !== undefined) yield reqBody;
    },
  };
  await routes.get(path).handler(
    req,
    {
      writeHead(status, headers) {
        response.status = status;
        response.headers = headers;
      },
      end(body = '') {
        response.body = body;
      },
    },
  );
  return response;
}

const manifest = await readRoute('/manifest.webmanifest');
assert.equal(manifest.status, 200);
assert.match(manifest.headers['content-type'], /^application\/manifest\+json/);
assert.equal(JSON.parse(manifest.body).name, 'Emerald Clinical');
assert.equal(JSON.parse(manifest.body).short_name, 'Emerald');

const favicon = await readRoute('/favicon.svg');
assert.equal(favicon.status, 200);
assert.match(favicon.headers['content-type'], /^image\/svg\+xml/);
const faviconText = favicon.body.toString('utf8');
assert.match(faviconText, /#0f766e/);
assert.doesNotMatch(faviconText, /DeepSeek/i);

// FIX-8: 数据拦截设置开关 — 设置页注入脚本 + GET/PUT 端点往返
assert.ok(html.includes('settings.general.item'), 'toggle anchors on official slot');
assert.ok(html.includes('var(--dsw-alias-state-success-primary)'), 'toggle uses theme vars');
assert.ok(html.includes('data-cdg-track'), 'toggle renders switch track');

const stateBefore = await readRoute('/api/settings/data-interception');
assert.equal(stateBefore.status, 200);
const initialEnabled = JSON.parse(stateBefore.body).dataInterceptionEnabled;
assert.equal(typeof initialEnabled, 'boolean');

const jsonHeaders = { 'content-type': 'application/json', host: 'localhost' };
const disabled = await readRoute('/api/settings/data-interception', 'PUT', JSON.stringify({ dataInterceptionEnabled: false }), jsonHeaders);
assert.equal(disabled.status, 200);
assert.equal(JSON.parse(disabled.body).dataInterceptionEnabled, false);
assert.equal(policy.isEnabled(), false);

const reEnabled = await readRoute('/api/settings/data-interception', 'PUT', JSON.stringify({ dataInterceptionEnabled: initialEnabled }), jsonHeaders);
assert.equal(reEnabled.status, 200);
assert.equal(JSON.parse(reEnabled.body).dataInterceptionEnabled, initialEnabled);

const badJson = await readRoute('/api/settings/data-interception', 'PUT', '{invalid', jsonHeaders);
assert.equal(badJson.status, 400);

const wrongType = await readRoute('/api/settings/data-interception', 'PUT', JSON.stringify({ dataInterceptionEnabled: 'false' }), jsonHeaders);
assert.equal(wrongType.status, 400);
const extraField = await readRoute('/api/settings/data-interception', 'PUT', JSON.stringify({ dataInterceptionEnabled: false, extra: true }), jsonHeaders);
assert.equal(extraField.status, 400);
const wrongMedia = await readRoute('/api/settings/data-interception', 'PUT', '{}', { 'content-type': 'text/plain' });
assert.equal(wrongMedia.status, 415);
const crossSite = await readRoute('/api/settings/data-interception', 'PUT', JSON.stringify({ dataInterceptionEnabled: false }), {
  ...jsonHeaders, 'sec-fetch-site': 'cross-site', origin: 'https://example.invalid',
});
assert.equal(crossSite.status, 403);
const tooLarge = await readRoute('/api/settings/data-interception', 'PUT', 'x'.repeat(1025), jsonHeaders);
assert.equal(tooLarge.status, 413);
assert.equal(policy.isEnabled(), initialEnabled);

dispose();
assert.equal(taps.length, 0);
assert.equal(routes.size, 0);

process.stdout.write(JSON.stringify({
  brandedTitle: true,
  manifestBranded: true,
  faviconBranded: true,
  officialRoutes: true,
  dataInterceptionToggle: true,
}));
