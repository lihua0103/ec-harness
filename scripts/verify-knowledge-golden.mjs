// Aggregate gate: per-plugin golden retrieval checks run from platform-knowledge package.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, ['--test', 'tests/golden.test.mjs'], {
  cwd: join(here, '..', 'packages', 'platform-knowledge'),
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
