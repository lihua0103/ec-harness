// Build the enterprise workbench plugin: a node (host) half and a browser (client) half.
//
// The browser half must be a *client-module factory*, not a plain ESM module: the DSH web shell
// loads plugin bundles through `window.__ModuleLoader__.load({ id, factory })`, and every external
// (React, @deepseek-ai/*) is resolved by the shell's frozen module table through the factory's
// `require`. Shipping a second React or an ESM module would not load. Host dependencies stay
// external for the same reason: the assembled host provides them.
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const PACKAGE_ID = '@ec-clinical/platform-workbench';
await mkdir(new URL('./lib', import.meta.url), { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
});

// Client half: compile to CJS-shaped output, then wrap it in the loader factory the shell expects.
const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  packages: 'external',
  sourcemap: false,
  banner: {
    js: [
      `window.__ModuleLoader__.load({`,
      `\tid: ${JSON.stringify(PACKAGE_ID)},`,
      `\tfactory: (require) => {`,
      `\t\tvar module = { exports: {} };`,
      `\t\tvar exports = module.exports;`,
    ].join('\n'),
  },
  footer: {
    js: ['\t\treturn module.exports;', '\t}', '});'].join('\n'),
  },
});
const body = result.outputFiles[0].text;
const { writeFileSync } = await import('node:fs');
writeFileSync('lib/client.js', body);

// Sanity: the emitted bundle must be a factory registration, not a stray ESM module.
if (!body.includes('__ModuleLoader__.load(') || !body.includes('__export(index_exports')) {
  throw new Error('client bundle is not a ModuleLoader factory');
}
if (/\bimport\s+.*\bfrom\b/.test(body.split('\n').slice(0, 6).join('\n'))) {
  throw new Error('client bundle leaked a top-level ESM import');
}

console.log('Enterprise workbench bundle built.');
