import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('no source imports another plugin or its package', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      if (specifier.includes('/plugins/') || /^@ec-clinical\/dsh-dm-(?!viz)/.test(specifier)) {
        offenders.push(`${file}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('manifest declares the plugin name and no runtime package dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    dependencies?: Record<string, string>;
    dsh?: { bundle?: { patch?: string } };
  };
  assert.equal(manifest.name, '@ec-clinical/dsh-dm-viz');
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
});
