// Keep all checks on the same Node executable, independent of pnpm/CMD PATH shims.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 9)) {
  console.error(`Node >=24.9.0 required; current: ${process.execPath} (${process.version})`);
  process.exit(1);
}
const tests = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
if (!tests.length) throw new Error('No test files found');
for (const [label, args] of [
  ['TypeScript host/client', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['Tests including actual synthetic R execution', ['--import', 'tsx', '--test', '--test-concurrency=2', ...tests]],
  ['Host/client bundle', ['build.mjs']],
]) {
  console.log(`\n== ${label} (${process.version}) ==`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
console.log('\nDM Listing verification passed. Clinical acceptance and browser verification are separate.');
