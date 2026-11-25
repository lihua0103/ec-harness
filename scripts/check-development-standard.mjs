// Executable rules from docs/DSH-PLUGIN-DEVELOPMENT-STANDARD.md (§3.3, §4, §7, §13):
// Automatically invoked after every source Write/Edit via .claude/hooks/standard-check.cjs.
//  - Plugins never import another plugin's files or package name (cross-plugin boundary).
//  - Relative imports from a plugin into packages/ must target that package's declared
//    exports surface (its manifest exports map must expose the target path); anything
//    else bypasses the package boundary and is a violation, not a style issue.
//  - Every business plugin ships knowledge/manifest.json; every registered business tool is
//    mapped to knowledge topics (backed by a seed) or explicitly declared no-method-knowledge
//    with a concrete reason (KNOWLEDGE-ARCHITECTURE §7). Management of the knowledge service
//    itself stays in packages/platform-knowledge; plugins only contribute.
// The normative document itself must exist.
// Self-test: `node scripts/check-development-standard.mjs --self-test` builds synthetic
// fixtures and asserts all violation classes are detected.
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative, extname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const SRC_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const IMPORT_PATTERN = /(?:import\s+[^'"]*?from\s*|import\s*|require\s*\(\s*|export\s+[^'"]*?from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
const TOOL_NAME_PATTERN = /defineTool\(\{[\s\S]{0,600}?name:\s*'([^']+)'/g;
const META_TOOL_PATTERN = /_knowledge_(capture|validate|events|search|get|status)$/;

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
  /** 每插件知识沉淀合同（§7 / KNOWLEDGE-ARCHITECTURE §7）：manifest 必在、工具必映射、主题必有种子支撑。 */
  for (const plugin of plugins) {
    if (!existsSync(join(plugin.directory, 'application.json'))) continue;
    const manifestPath = join(plugin.directory, 'knowledge', 'manifest.json');
    const manifestRel = relative(root, manifestPath);
    if (!existsSync(manifestPath)) {
      violations.push({
        rule: 'KNOWLEDGE_MANIFEST_MISSING',
        file: manifestRel,
        detail: `${plugin.name} 缺少知识沉淀 manifest；无方法知识也必须显式声明 noMethodKnowledge`,
      });
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      violations.push({ rule: 'KNOWLEDGE_MANIFEST_INVALID', file: manifestRel, detail: `JSON 解析失败：${error.message}` });
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      violations.push({ rule: 'KNOWLEDGE_MANIFEST_INVALID', file: manifestRel, detail: 'manifest 必须是对象' });
      continue;
    }
    const cordisPatchPath = join(plugin.directory, 'cordis.patch.yml');
    const patchText = existsSync(cordisPatchPath) ? readFileSync(cordisPatchPath, 'utf8') : '';
    const pluginIdMatch = /^\s*-\s*id:\s*([A-Za-z0-9][A-Za-z0-9._:/-]*)\s*$/m.exec(patchText);
    const cordisId = pluginIdMatch ? pluginIdMatch[1] : undefined;
    // 知识域 ID 以源码 knowledge-seeds 导出的 *PLUGIN_ID 常量为准；无种子模块时才退回 cordis 注册 ID。
    const seedsPath = join(plugin.directory, 'src', 'knowledge-seeds.ts');
    const seedsText = existsSync(seedsPath) ? readFileSync(seedsPath, 'utf8') : '';
    const knowledgeIdMatch = /\w*PLUGIN_ID\w*\s*=\s*'([^']+)'/.exec(seedsText);
    const knowledgeId = knowledgeIdMatch ? knowledgeIdMatch[1] : cordisId;
    if (knowledgeId !== undefined && manifest.pluginId !== knowledgeId) {
      violations.push({
        rule: 'KNOWLEDGE_MANIFEST_PLUGIN_ID',
        file: manifestRel,
        detail: `manifest.pluginId=${String(manifest.pluginId)} 与源码知识域 ID ${knowledgeId} 不一致`,
      });
    }
    const taxonomyTopics = new Set(
      Array.isArray(manifest.taxonomy?.topics) ? manifest.taxonomy.topics.filter((t) => typeof t === 'string') : [],
    );
    const seeds = Array.isArray(manifest.seeds) ? manifest.seeds : [];
    const seedTopics = new Set();
    for (const entry of seeds) {
      if (entry && typeof entry === 'object' && Array.isArray(entry.topics))
        for (const topic of entry.topics) if (typeof topic === 'string') seedTopics.add(topic);
    }
    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    const noMethod = Array.isArray(manifest.noMethodKnowledge) ? manifest.noMethodKnowledge : [];
    const mappedTools = new Set();
    for (const entry of [...capabilities, ...noMethod]) {
      if (entry && typeof entry === 'object' && typeof entry.tool === 'string') mappedTools.add(entry.tool);
    }
    for (const entry of noMethod) {
      if (!entry || typeof entry !== 'object' || !String(entry.reason ?? '').trim()) {
        violations.push({
          rule: 'KNOWLEDGE_NO_METHOD_REASON',
          file: manifestRel,
          detail: `noMethodKnowledge 条目 ${String(entry?.tool)} 缺少具体理由；“暂无”不是理由`,
        });
      }
    }
    for (const entry of capabilities) {
      if (!entry || typeof entry !== 'object' || typeof entry.tool !== 'string') continue;
      for (const topic of Array.isArray(entry.topics) ? entry.topics : []) {
        if (typeof topic !== 'string') continue;
        if (!taxonomyTopics.has(topic)) {
          violations.push({
            rule: 'KNOWLEDGE_TOPIC_UNRESOLVED',
            file: manifestRel,
            detail: `工具 ${entry.tool} 映射的主题 ${topic} 不在 taxonomy.topics 中`,
          });
        } else if (!seedTopics.has(topic)) {
          violations.push({
            rule: 'KNOWLEDGE_TOPIC_UNRESOLVED',
            file: manifestRel,
            detail: `主题 ${topic} 没有任何种子支撑（seeds[].topics）`,
          });
        }
      }
    }
    const registeredTools = new Set();
    for (const file of walkSourceFiles(join(plugin.directory, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(TOOL_NAME_PATTERN)) registeredTools.add(match[1]);
    }
    for (const tool of registeredTools) {
      if (META_TOOL_PATTERN.test(tool)) continue;
      if (!mappedTools.has(tool)) {
        violations.push({
          rule: 'KNOWLEDGE_CAPABILITY_UNMAPPED',
          file: manifestRel,
          detail: `插件 ${plugin.name} 注册的工具 ${tool} 未映射知识主题，也未声明 noMethodKnowledge`,
        });
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
    // 知识沉淀合同夹具：three 缺 manifest；four 有 manifest 但映射不全。
    writeFile('plugins/three/package.json', JSON.stringify({ name: '@t/plugin-three' }));
    writeFile('plugins/three/application.json', JSON.stringify({ appId: 't.three', capabilityId: 't.three.cap' }));
    writeFile('plugins/three/src/index.ts', "ctx.tools.register(defineTool({\n      name: 't3_orphan_tool',\n      parameters: {},\n      output,\n      async execute() {},\n    }));\n");
    writeFile('plugins/four/package.json', JSON.stringify({ name: '@t/plugin-four' }));
    writeFile('plugins/four/application.json', JSON.stringify({ appId: 't.four', capabilityId: 't.four.cap' }));
    writeFile('plugins/four/cordis.patch.yml', "- insert:\n    - id: four-plugin\n      name: '@t/plugin-four'\n");
    writeFile('plugins/four/src/index.ts', "ctx.tools.register(defineTool({\n      name: 't4_mapped_tool',\n      parameters: {},\n      output,\n      async execute() {},\n    }));\nctx.tools.register(defineTool({\n      name: 't4_unmapped_tool',\n      parameters: {},\n      output,\n      async execute() {},\n    }));\n");
    writeFile('plugins/four/knowledge/manifest.json', JSON.stringify({
      schemaVersion: 1,
      pluginId: 'four-plugin',
      taxonomy: { topics: ['alpha'] },
      seeds: [{ knowledgeId: 't4.seed', topics: [] }],
      capabilities: [{ tool: 't4_mapped_tool', topics: ['alpha', 'ghost'] }],
      noMethodKnowledge: [{ tool: 't4_reasonless_tool', reason: '' }],
    }));
    const violations = runChecks(root);
    const rules = violations.map((violation) => violation.rule);
    const cross = rules.filter((rule) => rule === 'CROSS_PLUGIN').length;
    const bypass = rules.filter((rule) => rule === 'PACKAGE_SRC_BYPASS').length;
    const manifestMissing = rules.filter((rule) => rule === 'KNOWLEDGE_MANIFEST_MISSING').length;
    const unmapped = rules.filter((rule) => rule === 'KNOWLEDGE_CAPABILITY_UNMAPPED').length;
    const unresolved = rules.filter((rule) => rule === 'KNOWLEDGE_TOPIC_UNRESOLVED').length;
    const noReason = rules.filter((rule) => rule === 'KNOWLEDGE_NO_METHOD_REASON').length;
    const failures = [];
    if (cross !== 2) failures.push(`CROSS_PLUGIN 期望 2 项，实际 ${cross}：${JSON.stringify(violations)}`);
    if (bypass !== 1) failures.push(`PACKAGE_SRC_BYPASS 期望 1 项，实际 ${bypass}：${JSON.stringify(violations)}`);
    if (manifestMissing !== 1) failures.push(`KNOWLEDGE_MANIFEST_MISSING 期望 1 项，实际 ${manifestMissing}：${JSON.stringify(violations)}`);
    if (unmapped !== 1) failures.push(`KNOWLEDGE_CAPABILITY_UNMAPPED 期望 1 项，实际 ${unmapped}：${JSON.stringify(violations)}`);
    if (unresolved !== 2) failures.push(`KNOWLEDGE_TOPIC_UNRESOLVED 期望 2 项，实际 ${unresolved}：${JSON.stringify(violations)}`);
    if (noReason !== 1) failures.push(`KNOWLEDGE_NO_METHOD_REASON 期望 1 项，实际 ${noReason}：${JSON.stringify(violations)}`);
    if (failures.length) {
      console.error(`SELF-TEST FAILED:\n- ${failures.join('\n- ')}`);
      return 1;
    }
    console.log('SELF-TEST PASSED: 跨插件导入、绕过 exports 与知识沉淀合同违规均被检出，合规实现不误报。');
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
