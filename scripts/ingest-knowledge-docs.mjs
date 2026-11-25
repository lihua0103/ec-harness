#!/usr/bin/env node
// 文档语料导入（KA10）：把 docs 下全部 .md 分片进平台知识库（DSH_HOME/platform/knowledge.sqlite）。
// 幂等：digest 与分片数不变的文档跳过重写；文档变化整体替换该文档的分片。
// 用法：node scripts/ingest-knowledge-docs.mjs [--dry-run] [--home <DSH_HOME>]
// 语料只增引用，不修改 docs 原文；导入结果与检索一致性以 platform-knowledge 测试为准。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { KnowledgeService } from '../packages/platform-knowledge/lib/index.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const homeIndex = args.indexOf('--home');
const home = homeIndex >= 0 ? resolve(args[homeIndex + 1]) : resolve(process.env.DSH_HOME ?? '.runtime/dsh-home');
const storePath = join(home, 'platform', 'knowledge.sqlite');
const docsRoot = resolve('docs');

function* walkMarkdown(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // evidence 目录是验收记录与截图，非设计正文；保留人类阅读，不入语料。
      if (name === 'evidence') continue;
      yield* walkMarkdown(full);
    } else if (name.endsWith('.md')) yield full;
  }
}

if (!existsSync(docsRoot)) {
  console.error('docs/ 不存在；请在仓库根运行。');
  process.exit(1);
}
const service = dryRun ? null : new KnowledgeService(storePath);
try {
  let files = 0, ingested = 0, skipped = 0, chunks = 0;
  const changed = [];
  for (const file of walkMarkdown(docsRoot)) {
    files++;
    const docPath = relative(process.cwd(), file).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    if (dryRun) {
      console.log(`[dry-run] ${docPath} (${text.length} chars)`);
      continue;
    }
    const result = service.ingestDocument(docPath, text);
    chunks += result.chunks;
    if (result.skipped) skipped++;
    else {
      ingested++;
      changed.push(docPath);
    }
  }
  if (dryRun) {
    console.log(`dry-run: ${files} documents would be scanned (ingest skipped).`);
  } else {
    console.log(JSON.stringify({ storePath, files, ingested, skipped, chunks, changed }, null, 2));
  }
} finally {
  if (service) service.close();
}
