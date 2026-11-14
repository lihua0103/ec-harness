#!/usr/bin/env node
'use strict';
// Dry-run inventory for the old enterprise workbench records (T10).
//
// It reads the control-plane SQLite file read-only and, when given an exported browser-local
// state, summarizes the old v4/v3 records. Nothing is created, updated or deleted. The actual
// migration is intentionally not implemented here: the native workbench replacement must first be
// verified end to end (T08/T09/T11) before any destructive or when-in-doubt write is offered.
//
// Usage:
//   node scripts/native-workbench-migrate.cjs --store <control.sqlite> [--browser-storage <export.json>]
//                                             [--out <report.json>] [--json]
//
// Exit codes: 0 report produced; 1 unreadable input; 2 apply refused; 3 package not built;
//              4 inventory digest differs from --expect-digest.

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

if (flag('help') || args.includes('-h')) {
  console.log(
    'Dry-run inventory of old workbench records.\n' +
    '  --store <path>            control-plane SQLite file (read-only)\n' +
    '  --browser-storage <path>  exported localStorage JSON (v4/v3 or {key: value})\n' +
    '  --out <path>              write the JSON report here instead of stdout\n' +
    '  --expect-digest <sha256>  fail when the inventory digest differs (pre/post rehearsal)\n' +
    '  --json                    print the JSON report to stdout\n' +
    '  --apply                   refused: no verified replacement yet\n',
  );
  process.exit(0);
}

if (flag('apply')) {
  console.error(
    'MIGRATION_APPLY_NOT_READY: 正式迁移尚未实现。先完成并验证原生工作台替代（T08/T09/T11），\n' +
    '再由用户明确确认才可写入；本脚本只做只读盘点。',
  );
  process.exit(2);
}

const built = path.join(__dirname, '..', 'packages', 'platform-control', 'lib', 'migration.js');
if (!existsSync(built)) {
  console.error('packages/platform-control/lib/migration.js 不存在：先在 packages/platform-control 运行 npm run build。');
  process.exit(3);
}

const storePath = value('store') ?? process.env.PLATFORM_WORKBENCH_STORE;
if (!storePath) {
  console.error('--store <control.sqlite> is required (or set PLATFORM_WORKBENCH_STORE).');
  process.exit(1);
}

let browserStorage;
const browserPath = value('browser-storage');
if (browserPath) {
  try {
    browserStorage = readFileSync(browserPath, 'utf8');
  } catch (error) {
    console.error(`无法读取浏览器本地记录：${error.message}`);
    process.exit(1);
  }
}

(async () => {
  const { summarizeMigration } = await import(pathToFileURL(built).href);
  const report = summarizeMigration({
    storePath: path.resolve(storePath),
    browserStorage,
    ...(value('sessions-home') ? { sessionsHome: path.resolve(value('sessions-home')) } : {}),
  });

  if (report.controlStore.status === 'UNREADABLE') {
    console.error(`控制面库不可读：${report.controlStore.error}`);
    process.exit(1);
  }

  const out = value('out');
  if (out) writeFileSync(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // A rehearsal compares the exact inventory digest before and after a migration step. The digest
  // covers Work/Run identity and state; a difference must be explained, never waved through.
  const expected = value('expect-digest');
  if (expected && report.controlStore.status === 'OK' && expected !== report.controlStore.digest) {
    console.error(
      `MIGRATION_DIGEST_MISMATCH: expected ${expected}, got ${report.controlStore.digest}\n` +
      '盘点摘要不一致：停止迁移并核对身份/状态是否被改写，不要继续写入。',
    );
    process.exit(4);
  }

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const counts = report.controlStore.counts;
  const browser = report.browserStorage;
  console.log('原生工作台迁移 dry-run（未写入任何记录）');
  console.log(`控制面库：${path.resolve(storePath)} [${report.controlStore.status}]`);
  if (report.controlStore.status === 'OK') {
    console.log(
      `  项目 ${counts.projects ?? 0} · 工作 ${counts.works ?? 0} · 运行 ${counts.runs ?? 0} · ` +
      `输入 ${counts.run_inputs ?? 0} · 成果 ${counts.run_artifacts ?? 0} · 绑定 ${counts.work_session_bindings ?? 0}`,
    );
    console.log(`  未绑定原生会话的工作：${report.controlStore.unboundWorks}`);
    console.log(
      `  迁移判定：可验证 Session ${report.controlStore.decisions.verifiedSession} · ` +
      `无 Session 只读 ${report.controlStore.decisions.readOnly} · ` +
      `Session 未知 ${report.controlStore.decisions.unknownSession}`,
    );
    for (const work of report.controlStore.works) {
      console.log(
        `    - ${work.workId} ${work.title} [${work.decision}] runs=${work.runs} artifacts=${work.artifacts}` +
        (work.sessionId ? ` session=${work.sessionId}` : ''),
      );
    }
    console.log(`  记录摘要（SHA-256）：${report.controlStore.digest}`);
  }
  console.log(
    `浏览器本地记录：${browser.kind} · 项目 ${browser.projects} · 工作 ${browser.works} · ` +
    `输入批次 ${browser.inputs} · 消息 ${browser.messages} · 草稿 ${browser.drafts} · ` +
    `只读记录 ${browser.readOnlyWorks} · 隔离记录 ${browser.recovery}`,
  );
  if (browser.error) console.log(`  说明：${browser.error}`);
  for (const note of report.notes) console.log(`- ${note}`);
  if (out) console.log(`报告已写入 ${path.resolve(out)}（不影响任何数据）。`);
})().catch((error) => {
  console.error(`迁移盘点失败：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
