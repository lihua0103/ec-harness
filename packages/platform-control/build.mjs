import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('./lib', import.meta.url), { recursive: true });
for (const [entry, outfile] of [['src/index.ts', 'lib/index.js'], ['src/cordis.ts', 'lib/cordis.js']]) {
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm',
    target: 'node24', packages: 'external', sourcemap: true,
  });
}
console.log('Platform control bundle built.');