import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('./lib', import.meta.url), { recursive: true });
for (const [entry, outfile] of [
  ['src/index.ts', 'lib/index.js'],
  ['src/cordis.ts', 'lib/cordis.js'],
  ['src/http.ts', 'lib/http.js'],
  ['src/api-cli.ts', 'lib/api-cli.js'],
  ['src/migration.ts', 'lib/migration.js'],
]) {
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm',
    target: 'node24', packages: 'external', sourcemap: true,
  });
}
console.log('Platform control bundle built.');