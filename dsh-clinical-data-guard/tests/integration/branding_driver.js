import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerBranding } from '../../src/branding.js';

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

const dispose = registerBranding(ctx, { brandName: 'Emerald Clinical', brandShortName: 'Emerald' });
assert.equal(taps.length, 1);
assert.equal(routes.size, 2);

const source = await readFile(new URL('../../../runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html', import.meta.url), 'utf8');
const html = taps[0](source);
assert.match(html, /<title>Emerald Clinical<\/title>/);
assert.doesNotMatch(html, /<title>DeepSeek Harness<\/title>/);
assert.match(html, /<meta name="application-name" content="Emerald Clinical">/);
assert.ok(html.includes('.replace(/DeepSeek(?: Harness)?/gi, brand)'));
assert.ok(html.includes('.replace(/\\bDSH\\b/g, "Emerald")'));

async function readRoute(path, method = 'GET') {
  const response = { headers: null, body: '' };
  await routes.get(path).handler(
    { method },
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

dispose();
assert.equal(taps.length, 0);
assert.equal(routes.size, 0);

process.stdout.write(JSON.stringify({
  brandedTitle: true,
  manifestBranded: true,
  faviconBranded: true,
  officialRoutes: true,
}));
