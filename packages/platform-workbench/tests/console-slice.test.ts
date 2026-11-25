/** W5 工作台纵向切片的源码合同：验收点最终在真实宿主 UI 里，但结构事实可以先用源码锚定——
 *  跳转清 Session 的路径不得回归，创建清单必须来自获准目录，发布声明必须按需读取，
 *  复核决定必须随目标清单提交，归档工作必须走只读入口。这些锚与真实宿主验收互补，不替代它。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pageSource = readFileSync(fileURLToPath(new URL('../src/client/WorkbenchPage.tsx', import.meta.url)), 'utf8');
const apiSource = readFileSync(fileURLToPath(new URL('../src/api.ts', import.meta.url)), 'utf8');

const consoleStart = pageSource.indexOf('function WorkConsole(');
const consoleEnd = pageSource.indexOf('\nfunction ', consoleStart);
const consoleBody = pageSource.slice(consoleStart, consoleEnd);

test('the console no longer navigates away or clears the native session (W5/R4)', () => {
  assert.equal(pageSource.includes('openDetailFromConsole'), false, '查看详情清空 Session 的路径已移除，不得回归');
  assert.equal(consoleBody.includes('onDetail'), false, '控制台不应再有跳转详情的入口');
  assert.match(consoleBody, /aria-controls="ec-wb-console-detail"/, '详情是右栏内展开');
  assert.match(consoleBody, /hidden=\{!detailOpen\}/, '展开不卸载原生会话');
});

test('the console rail carries start, Q&A, deliverables and review (W5 scope)', () => {
  for (const anchor of ['<ReviewPanel', '<InteractionPanel', '<RunLauncher', '<DeliveryPackagesCard', '<ResultViewsCard']) {
    assert.ok(consoleBody.includes(anchor), `右栏应承载 ${anchor}`);
  }
});

test('creation lists come from the approved catalog, not the bootstrap summary (W5/R2)', () => {
  assert.match(pageSource, /api\.catalogSummaries\(id, \{ cursor, limit: 100 \}\)/, '新建工作按项目读取获准目录');
  assert.equal(pageSource.includes("(data.apps ?? []).filter((app) => app.state === 'ACTIVE')"), false, 'bootstrap 应用摘要不再充当创建清单');
});

test('declarations are read on demand from the catalog release, never cached (W5/R2)', () => {
  const matches = pageSource.match(/api\.catalogRelease\(context\.app\.appId, context\.work\.projectId\)/g) ?? [];
  assert.ok(matches.length >= 2, '详情页与控制台都按需读取发布声明');
});

test('the review decision carries the bound manifest digest and legacy sends none (W4/R5)', () => {
  assert.match(apiSource, /\.\.\.\(target\.expectedManifestDigest \? \{ expectedManifestDigest: target\.expectedManifestDigest \} : \{\}\)/, '绑定记录随清单摘要提交');
  assert.match(pageSource, /expectedManifestDigest: open\.deliverable\?\.manifestDigest/, '决定表单回显复核记录携带的清单摘要');
});

test('archived works open the read-only detail and never mount a session (W5/R4)', () => {
  assert.match(pageSource, /if \(context\.work\.state === 'ARCHIVED'\) \{[\s\S]{0,400}?openDetail\(/, '归档工作打开即只读详情');
  assert.match(pageSource, /else void openWork\(workId, \{ focusRunId: runId \}\)/, '待处理的使用中工作进控制台');
});
