#!/usr/bin/env node
// M3-02：知识智能体发布覆盖门禁。
// 分母来自 knowledge-assembly.json（批准的装配清单），与实际目录对账：
//  - 未登记的目录 → 失败（新插件不能因“没写声明”而默认通过）；
//  - managed 插件缺 v2 智能体定义、黄金集或证据断链 → 失败；
//  - platform-pending 在 --release 模式下阻断对应发布（仓库门禁只报告，不冒充发布放行）。
// 输出可直接作为 M0-01/A01/A13 的资产清点与 A13 的覆盖证据；不写入任何知识库。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function parseArgs(argv) {
  const options = { root, release: false, json: false, report: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') options.root = resolve(argv[++index] ?? '');
    else if (arg === '--release') options.release = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--report') options.report = resolve(argv[++index] ?? '');
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: verify-knowledge-coverage.mjs [--root DIR] [--release] [--json] [--report FILE]\n');
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return options;
}

function loadParser() {
  const lib = join(root, 'packages', 'platform-knowledge', 'lib', 'index.js');
  if (!existsSync(lib)) {
    process.stderr.write('platform-knowledge 尚未构建：先运行 npm --prefix packages/platform-knowledge run build\n');
    process.exit(2);
  }
  // 复用已安装的合同解析器，避免门禁与运行期出现两份校验实现。
  return import(new URL(`file://${lib.replace(/\\/g, '/')}`).href).then((mod) => mod.parseKnowledgeManifest);
}

const directories = (directory) =>
  existsSync(directory) && statSync(directory).isDirectory()
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const parseKnowledgeManifest = await loadParser();
  const failures = [];
  const blockers = [];
  const rows = [];

  const assemblyPath = join(options.root, 'knowledge-assembly.json');
  if (!existsSync(assemblyPath)) {
    process.stderr.write('knowledge-assembly.json 缺失：装配清单是覆盖分母的唯一来源\n');
    process.exit(1);
  }
  let assembly;
  try {
    assembly = readJson(assemblyPath);
  } catch (error) {
    process.stderr.write(`knowledge-assembly.json 无法解析：${error.message}\n`);
    process.exit(1);
  }
  const entries = Array.isArray(assembly.entries) ? assembly.entries : [];
  const byPath = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || !entry.path.includes('/')) {
      failures.push(`KNOWLEDGE_ASSEMBLY_INVALID_ENTRY:${JSON.stringify(entry)}`);
      continue;
    }
    if (!['managed', 'platform-pending', 'library', 'application'].includes(entry.class)) {
      failures.push(`${entry.path}: KNOWLEDGE_ASSEMBLY_INVALID_CLASS(${entry.class})`);
      continue;
    }
    if (byPath.has(entry.path)) failures.push(`${entry.path}: KNOWLEDGE_ASSEMBLY_DUPLICATE`);
    byPath.set(entry.path, entry);
    if (!existsSync(join(options.root, entry.path))) failures.push(`${entry.path}: KNOWLEDGE_ASSEMBLY_PATH_MISSING`);
  }

  for (const group of ['packages', 'plugins', 'apps']) {
    for (const name of directories(join(options.root, group))) {
      const relative = `${group}/${name}`;
      if (!byPath.has(relative)) failures.push(`${relative}: KNOWLEDGE_ASSEMBLY_UNLISTED`);
    }
  }

  let managedTotal = 0;
  let managedPassed = 0;
  for (const [relative, entry] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.class === 'library' || entry.class === 'application') {
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) failures.push(`${relative}: KNOWLEDGE_ASSEMBLY_REASON_REQUIRED`);
      continue;
    }
    if (entry.class === 'platform-pending') {
      if (typeof entry.owner !== 'string' || !entry.owner.trim()) failures.push(`${relative}: KNOWLEDGE_PENDING_OWNER_REQUIRED`);
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) failures.push(`${relative}: KNOWLEDGE_PENDING_REASON_REQUIRED`);
      blockers.push(`${relative}: KNOWLEDGE_AGENT_PENDING (${entry.owner ?? '未指定负责人'})`);
      continue;
    }
    managedTotal++;
    const manifestPath = join(options.root, relative, 'knowledge', 'manifest.json');
    if (!existsSync(manifestPath)) {
      failures.push(`${relative}: KNOWLEDGE_MANIFEST_MISSING`);
      continue;
    }
    let manifest;
    try {
      manifest = parseKnowledgeManifest(readJson(manifestPath));
    } catch (error) {
      failures.push(`${relative}: ${error.message}`);
      continue;
    }
    if (typeof entry.pluginId !== 'string' || !entry.pluginId) {
      failures.push(`${relative}: KNOWLEDGE_ASSEMBLY_PLUGIN_ID_REQUIRED`);
      continue;
    }
    if (manifest.pluginId !== entry.pluginId) {
      failures.push(`${relative}: KNOWLEDGE_MANIFEST_PLUGIN_MISMATCH(${manifest.pluginId} != ${entry.pluginId})`);
      continue;
    }
    // 定义必须随发布制品分发：package.json 的 files 若显式列出内容，必须包含 knowledge/。
    const packagePath = join(options.root, relative, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const shipped = readJson(packagePath).files;
        if (Array.isArray(shipped) && !shipped.some((item) => item === 'knowledge' || item === 'knowledge/'))
          failures.push(`${relative}: KNOWLEDGE_MANIFEST_NOT_PACKAGED`);
      } catch {
        failures.push(`${relative}: KNOWLEDGE_PACKAGE_JSON_INVALID`);
      }
    }
    const seedIds = new Set(manifest.seeds.map((seed) => seed.knowledgeId));
    const topics = new Set(manifest.taxonomy.topics);
    for (const seed of manifest.seeds) {
      for (const topic of seed.topics) {
        if (!topics.has(topic)) failures.push(`${relative}: KNOWLEDGE_SEED_TOPIC_UNDECLARED(${seed.knowledgeId}:${topic})`);
      }
    }
    for (const testCase of manifest.goldenSet.cases) {
      for (const expected of testCase.expect) {
        if (!seedIds.has(expected)) failures.push(`${relative}: KNOWLEDGE_GOLDEN_TARGET_UNDECLARED(${expected})`);
      }
    }
    const row = {
      path: relative,
      pluginId: manifest.pluginId,
      agent: `${manifest.agent.id}@${manifest.agent.version}`,
      owner: manifest.agent.owner,
      seeds: manifest.seeds.length,
      validators: manifest.validators.length,
      goldenCases: manifest.goldenSet.cases.length,
      projectionVersion: manifest.feedback.projectionVersion,
      status: 'MANAGED',
    };
    rows.push(row);
    if (!failures.some((failure) => failure.startsWith(`${relative}:`))) managedPassed++;
    else row.status = 'BLOCKED';
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: options.root,
    release: options.release,
    coverage: { passed: managedPassed, total: managedTotal },
    managed: rows,
    blockers,
    failures,
  };
  if (options.report) writeFileSync(options.report, JSON.stringify(report, null, 2));

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    for (const row of rows) {
      process.stdout.write(`MANAGED ${row.path} ${row.pluginId} ${row.agent} owner=${row.owner} seeds=${row.seeds} validators=${row.validators} golden=${row.goldenCases}\n`);
    }
    for (const blocker of blockers) process.stdout.write(`PENDING ${blocker}\n`);
    for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
    process.stdout.write(`coverage ${managedPassed}/${managedTotal} managed plugins; ${blockers.length} pending release blockers\n`);
  }
  const blocking = failures.length > 0 || (options.release && blockers.length > 0);
  process.exitCode = blocking ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});