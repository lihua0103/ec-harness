#!/usr/bin/env node
// 知识证据验收（操作者侧过渡工具，R6）：把运行期沉淀的 CANDIDATE 按「每条 claim 绑定一项证据检查」激活为 ACTIVE。
// 模型侧工具拿不到这个入口，仍不能自批；激活走 KnowledgeService.validate() 的标准事务，回执与事件照常落库。
// R6 说明：本脚本是过渡验收工具，不是生产独立验证执行器。生产独立执行器（K01–K08 隔离 epoch/一次性回执/
// 可信租户与主体）待实现；迁移后不得保留绕过可信回执的激活路径。本脚本上下文仅 {pluginId}，对带租户记录
// 需显式传 --org/--region 或由部署适配器注入可信主体。
//
// 用法：
//   node scripts/knowledge-accept.mjs --store <knowledge.sqlite> --plugin <pluginId> --knowledge <id> --spec <acceptance.json> [--revision <n>]
// spec：
//   { suiteId, suiteVersion?, checks:[{claim, evidence, pointer, op, value?}], guards:[{id, group, evidence, pointer, op, value?}] }
//   - claim 必须是候选声明的 claim 原文，每条恰好一项检查；evidence 是相对 spec 文件的 JSON 文件路径；
//   - pointer 是证据文档内的 JSON 指针；op ∈ eq ne gt gte lt lte contains exists type；
//   - guards 须同时含 negative 与 boundary 各至少一项（例如「证据不是候选自身」「对比行数非零」）。
// 退出码：0=已激活；2=验收未通过（候选保持 CANDIDATE，原因见输出）；1=用法或输入错误。
// 运行前确认 --store 是现行部署实际在读的那个库（本机存在两个 home：.runtime/nw-platform-web 与 .runtime/worker-home）。
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { KnowledgeService, buildAcceptanceSuite, loadAcceptanceEvidence } from '../packages/platform-knowledge/lib/index.js';

const USAGE = '用法: node scripts/knowledge-accept.mjs --store <knowledge.sqlite> --plugin <pluginId> --knowledge <id> --spec <acceptance.json> [--revision <n>]';
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const store = option('--store');
const pluginId = option('--plugin');
const knowledgeId = option('--knowledge');
const specPath = option('--spec');
const revisionArg = option('--revision');
if (!store || !pluginId || !knowledgeId || !specPath) {
  console.error(USAGE);
  process.exit(1);
}

const service = new KnowledgeService(store);
try {
  const ctx = { pluginId };
  const revision = revisionArg !== undefined ? Number(revisionArg) : service.get(ctx, knowledgeId).revision;
  const record = service.get(ctx, knowledgeId, revision);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const evidence = loadAcceptanceEvidence(
    [...(spec.checks ?? []), ...(spec.guards ?? [])].map((check) => check.evidence),
    dirname(specPath),
  );
  const suite = buildAcceptanceSuite({ record, spec, evidence });
  service.registerValidator(pluginId, suite);
  const out = await service.validate(ctx, knowledgeId, revision, suite.id);
  console.log(JSON.stringify({
    knowledgeId,
    revision,
    state: out.state,
    validationScope: out.validationScope,
    receiptId: out.id,
    cases: out.results.map((result) => `${result.id}=${result.passed ? 'PASS' : 'FAIL'}`),
    ...(out.state === 'ACTIVE' ? {} : { lastEvent: service.events(ctx, knowledgeId).items[0] }),
  }));
  process.exitCode = out.state === 'ACTIVE' ? 0 : 2;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  service.close();
}
