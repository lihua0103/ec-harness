import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
// The browser half is a client-module factory: the DSH web shell loads plugin bundles through
// `window.__ModuleLoader__.load({ id, factory })`, and React plus the @deepseek-ai/* client packages
// are resolved by the shell's module table through the factory's `require` — never bundled here.
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
await mkdir(new URL('./lib', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/index.ts'], outfile: 'lib/index.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  packages: 'external', sourcemap: true,
});
const client = await build({
  entryPoints: ['src/client/index.ts'], bundle: true, write: false,
  platform: 'browser', format: 'cjs', target: 'es2022',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
});
const { writeFile } = await import('node:fs/promises');
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
console.log('DM DVP host/client bundle built.');
