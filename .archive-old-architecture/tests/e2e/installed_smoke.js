import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installedPlugin = resolve(
  import.meta.dirname,
  '../../../.dsh/profiles/clinical/node_modules/emerald-clinical-data-guard/src/index.js',
);
const pluginUrl = process.env.INSTALLED_PLUGIN_URL ?? pathToFileURL(installedPlugin).href;

const { default: clinicalDataGuard } = await import(pluginUrl);
const packageRoot = new URL('../', new URL(pluginUrl));
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));
const patch = readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8');
const expectedVersion = process.env.EXPECTED_PLUGIN_VERSION ?? '1.0.7';
// D-2 (2026-08-22): systemPrompt 注入随工具提示 section（FIX-11/F-1 时代）加入，
// 冒烟契约此前未同步，导致每次必红。
const expectedInject = ['tools', 'llm', 'webServer', 'systemPrompt'];
const requireFromPlugin = createRequire(new URL('package.json', packageRoot));

if (manifest.version !== expectedVersion) {
  throw new Error(`unexpected installed version: ${manifest.version}`);
}
if (JSON.stringify(clinicalDataGuard.inject) !== JSON.stringify(expectedInject)) {
  throw new Error(`unexpected inject contract: ${JSON.stringify(clinicalDataGuard.inject)}`);
}
const expectedPeers = {
  cordis: '4.0.1',
  'dsh-host-webserver': '0.1.0-rc.6',
  'dsh-llm': '0.1.0-rc.6',
  'dsh-tools': '0.1.0-rc.6',
};
for (const [peer, expectedPeerVersion] of Object.entries(expectedPeers)) {
  const peerManifest = JSON.parse(readFileSync(
    requireFromPlugin.resolve(`@deepseek-ai/${peer}/package.json`), 'utf8'));
  if (peerManifest.version !== expectedPeerVersion) {
    throw new Error(`unexpected ${peer} peer version: ${peerManifest.version}`);
  }
}

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
    python: process.env.PLUGIN_PYTHON ?? process.env.PYTHON,
});

try {
  const python = process.env.PLUGIN_PYTHON ?? process.env.PYTHON ?? 'python';
  const worker = spawnSync(python, ['-m', 'security.worker'], {
    cwd: fileURLToPath(packageRoot),
    input: '{"operation":"ping"}\n',
    encoding: 'utf8',
    env: process.env,
  });
  if (worker.status !== 0) {
    throw new Error(`installed worker failed: ${worker.stderr || worker.status}`);
  }
  const ping = JSON.parse(worker.stdout.trim());
  if (ping.ok !== true || ping.action !== 'pong') {
    throw new Error(`installed worker ping failed: ${worker.stdout}`);
  }
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
    worker: ping.action,
  }));
} finally {
  dispose();
}
