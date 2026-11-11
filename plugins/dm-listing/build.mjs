import { build } from 'esbuild';
import { mkdir, readFile, cp } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
await mkdir(new URL('./lib', import.meta.url), { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: true });
const result = await build({ entryPoints: ['src/client/index.ts'], bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false });
const { writeFile } = await import('node:fs/promises');
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory(require){const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`);
// build skipped; no projection/operator-review/als modules left
console.log('DM Listing host/client bundle built.');
