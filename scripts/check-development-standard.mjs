// Executable rules from docs/DSH-PLUGIN-DEVELOPMENT-STANDARD.md (§3.3, §13):
// Automatically invoked after every source Write/Edit via .claude/hooks/standard-check.cjs.
//  - Plugins never import another plugin's files or package name (cross-plugin boundary).
//  - Relative imports from a plugin into packages/ must target that package's declared
//    exports surface (its manifest exports map must expose the target path); anything
//    else bypasses the package boundary and is a violation, not a style issue.
// The normative document itself must exist.
// Self-test: `node scripts/check-development-standard.mjs --self-test` builds synthetic
// fixtures and asserts both violation classes are detected.
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative, extname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const SRC_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const IMPORT_PATTERN = /(?:import\s+[^'"]*?from\s*|import\s*|require\s*\(\s*|export\s+[^'"]*?from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

const stripExtension = (file) => {
  const ext = extname(file);
  return ext ? file.slice(0, -ext.length) : file;
};

function* walkSourceFiles(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'lib' || name === '.runtime') continue;
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (SRC_EXTENSIONS.includes(extname(name))) yield full;
    }
  }
}

/** Manifest exports values may be strings or {types,default,...} objects; flatten to path values. */
function exportTargets(manifest) {
  const values = [];
  const collect = (value) => {
    if (typeof value === 'string') values.push(value);
    else if (value && typeof value === 'object') for (const key of Object.keys(value)) collect(value[key]);
  };
  const exports = manifest.exports;
  if (typeof exports === 'string') collect(exports);
  else if (exports && typeof exports === 'object') for (const key of Object.keys(exports)) collect(exports[key]);
  return values;
}

/** True when the plugin's import target is part of the package's declared exports surface.
 *  Handles exact entries (extension-insensitive: `.js` imports resolve to `.ts` sources)
 *  and `./src/*`-style passthrough patterns. */
function isExposedByExports(packageDir, manifest, targetFile) {
  const target = stripExtension(targetFile);
  for (const value of exportTargets(manifest)) {
    if (value.includes('*')) {
      const pattern = value.split('*');
      const prefix = resolve(packageDir, pattern[0] ?? '');
      const suffix = pattern[1] ?? '';
      const rel = relative(prefix, targetFile);
      if (rel && !rel.startsWith('..') && stripExtension(rel).endsWith(stripExtension(suffix))) return true;
    } else {
      const exposed = stripExtension(resolve(packageDir, value));
      if (exposed === target) return true;
    }
  }
  return false;
}

function listPluginBoundaries(root) {
  const plugins = [];
  const pluginsRoot = join(root, 'plugins');
  if (!existsSync(pluginsRoot)) return plugins;
  for (const name of readdirSync(pluginsRoot)) {
    const directory = join(pluginsRoot, name);
    const manifestPath = join(directory, 'package.json');
    if (!statSync(directory).isDirectory() || !existsSync(manifestPath)) continue;
    plugins.push({ name, directory, packageName: JSON.parse(readFileSync(manifestPath, 'utf8')).name });
  }
  return plugins;
}

function listPackages(root) {
  const packages = [];
  const packagesRoot = join(root, 'packages');
  if (!existsSync(packagesRoot)) return packages;
  for (const name of readdirSync(packagesRoot)) {
    const directory = join(packagesRoot, name);
    const manifestPath = join(directory, 'package.json');
    if (!statSync(directory).isDirectory() || !existsSync(manifestPath)) continue;
    packages.push({ name, directory, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) });
  }
  return packages;
}

export function runChecks(root) {
  const violations = [];
  const plugins = listPluginBoundaries(root);
  const packages = listPackages(root);
  const packagesRoot = resolve(root, 'packages');
  const packageByName = new Map(packages.map((entry) => [entry.name, entry]));

  if (!existsSync(join(root, 'docs', 'DSH-PLUGIN-DEVELOPMENT-STANDARD.md')))
    violations.push({ rule: 'NORMATIVE_DOC', file: 'docs/DSH-PLUGIN-DEVELOPMENT-STANDARD.md', detail: '规范正文缺失' });

  const inside = (base, target) => {
    const rel = relative(resolve(base), target);
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
  };

  for (const plugin of plugins) {
    const others = plugins.filter((entry) => entry !== plugin);
    for (const file of walkSourceFiles(join(plugin.directory, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) {
          const hit = others.find((entry) => entry.packageName && (specifier === entry.packageName || specifier.startsWith(`${entry.packageName}/`)));
          if (hit) violations.push({ rule: 'CROSS_PLUGIN', file: relative(root, file), detail: `${specifier} 引入其他插件 ${hit.packageName}` });
          continue;
        }
        const resolved = resolve(dirname(file), specifier);
        const otherPlugin = others.find((entry) => inside(entry.directory, resolved));
        if (otherPlugin) { violations.push({ rule: 'CROSS_PLUGIN', file: relative(root, file), detail: `相对导入进入其他插件 ${otherPlugin.name}` }); continue; }
        if (inside(packagesRoot, resolved)) {
          const pkgName = relative(packagesRoot, resolved).split(/[\\/]/)[0];
          const pkg = packageByName.get(pkgName);
          if (pkg && !isExposedByExports(pkg.directory, pkg.manifest, resolved)) {
            violations.push({ rule: 'PACKAGE_SRC_BYPASS', file: relative(root, file), detail: `${relative(root, resolved)} 不在 ${pkg.name} 的 exports 声明内` });
          }
        }
      }
    }
  }
  return violations;
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'dev-standard-selftest-'));
  try {
    const writeFile = (relativePath, content) => {
      const target = join(root, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    writeFile('docs/DSH-PLUGIN-DEVELOPMENT-STANDARD.md', '# 规范');
    writeFile('packages/pkg-source/package.json', JSON.stringify({ name: '@t/source', exports: { '.': './src/index.ts', './src/*': './src/*' } }));
    writeFile('packages/pkg-source/src/index.ts', 'export const a = 1;');
    writeFile('packages/pkg-source/src/util.ts', 'export const b = 2;');
    writeFile('packages/pkg-lib/package.json', JSON.stringify({ name: '@t/lib', exports: { '.': './lib/index.js' } }));
    writeFile('packages/pkg-lib/src/secret.ts', 'export const c = 3;');
    writeFile('packages/pkg-lib/lib/index.js', 'export const d = 4;');
    writeFile('plugins/one/package.json', JSON.stringify({ name: '@t/plugin-one' }));
    writeFile('plugins/one/src/main.ts', "import { a } from '../../../packages/pkg-source/src/index.js';\nimport { b } from '../../../packages/pkg-source/src/util.js';\n");
    writeFile('plugins/two/package.json', JSON.stringify({ name: '@t/plugin-two' }));
    writeFile('plugins/two/src/main.ts', "import { c } from '../../../packages/pkg-lib/src/secret.js';\nimport { e } from '@t/plugin-one';\nimport { f } from '../../one/src/main.js';\n");
    const violations = runChecks(root);
    const rules = violations.map((violation) => violation.rule);
    const cross = rules.filter((rule) => rule === 'CROSS_PLUGIN').length;
    const bypass = rules.filter((rule) => rule === 'PACKAGE_SRC_BYPASS').length;
    const failures = [];
    if (cross !== 2) failures.push(`CROSS_PLUGIN 期望 2 项，实际 ${cross}：${JSON.stringify(violations)}`);
    if (bypass !== 1) failures.push(`PACKAGE_SRC_BYPASS 期望 1 项，实际 ${bypass}：${JSON.stringify(violations)}`);
    if (failures.length) {
      console.error(`SELF-TEST FAILED:\n- ${failures.join('\n- ')}`);
      return 1;
    }
    console.log('SELF-TEST PASSED: 跨插件导入与绕过 exports 的源码导入均被检出，合规导入不误报。');
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) process.exitCode = selfTest();
else {
  const violations = runChecks(resolve(import.meta.dirname, '..'));
  if (violations.length) {
    console.error(`DEVELOPMENT STANDARD CHECK FAILED (${violations.length}):`);
    for (const violation of violations) console.error(`- [${violation.rule}] ${violation.file}: ${violation.detail}`);
    process.exitCode = 1;
  } else console.log('DEVELOPMENT STANDARD CHECK PASSED: 插件互引与包边界导入未发现违规。');
}
