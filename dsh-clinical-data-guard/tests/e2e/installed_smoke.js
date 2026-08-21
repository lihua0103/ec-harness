import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const installedPlugin = resolve(
  import.meta.dirname,
  '../../../.dsh/profiles/clinical/node_modules/emerald-clinical-data-guard/src/index.js',
);
const pluginUrl = process.env.INSTALLED_PLUGIN_URL ?? pathToFileURL(installedPlugin).href;

const { default: clinicalDataGuard } = await import(pluginUrl);
const packageRoot = new URL('../', new URL(pluginUrl));
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));
const patch = readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8');

if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('installed manifest lost bundle patch');
}
if (!patch.includes('name: emerald-clinical-data-guard')) {
  throw new Error('installed Cordis patch is invalid');
}

const events = new Map();
const ctx = {
  events,
  on(event, handler) {
    if (!events.has(event)) events.set(event, []);
    events.get(event).push(handler);
    return () => events.get(event).splice(events.get(event).indexOf(handler), 1);
  },
  tools: { guard() { return () => {}; } },
  // branding fail-fast (FIX-12/AF-07) 后 webServer 是注入的必需服务。
  webServer: {
    tapIndex() { return () => {}; },
    register() { return () => {}; },
  },
};

const dispose = clinicalDataGuard(ctx, {
  mode: 'enforce',
    python: process.env.PLUGIN_PYTHON ?? process.env.PYTHON,
});

try {
  const stream = await events.get('llm/stream')[0](
    { messages: [{ role: 'user', content: 'clean installation smoke' }] },
    async function* next() {
      yield { kind: 'finish', failure: undefined };
    },
  );
  for await (const chunk of stream) {
    if (chunk?.kind === 'finish' && chunk.failure) {
      throw new Error(chunk.failure.message ?? 'installed stream failed');
    }
  }
  process.stdout.write(JSON.stringify({
    imported: true,
    version: manifest.version,
    inject: clinicalDataGuard.inject,
    streamed: true,
  }));
} finally {
  dispose();
}
