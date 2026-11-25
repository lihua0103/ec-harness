import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('./lib', import.meta.url), { recursive: true });
const common = { sourcemap: true };
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  ...common,
});
await build({
  entryPoints: ['src/pt-app.ts'],
  outfile: 'lib/pt-charts.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'PT',
  target: 'es2022',
  ...common,
});
console.log('DM PARTICIPANTS host bundle built.');
