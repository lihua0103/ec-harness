// Prototype verification: ESM syntax for shipped modules, then Node's built-in tests.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const modules = ['app.js', 'applications.mjs', 'model.mjs', 'storage.mjs'];
let failed = false;
for (const file of modules) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) { failed = true; console.error(`Syntax check failed: ${file}`); }
}
const testsDir = path.join(root, 'tests');
const testFiles = readdirSync(testsDir).filter(name => name.endsWith('.test.mjs')).map(name => path.join(testsDir, name));
const tests = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
if (tests.status !== 0) failed = true;
if (failed) process.exitCode = 1;
else console.log('Workbench prototype verification passed.');