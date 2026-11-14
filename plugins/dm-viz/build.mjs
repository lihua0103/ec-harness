import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
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
console.log('DM VIZ host bundle built.');
