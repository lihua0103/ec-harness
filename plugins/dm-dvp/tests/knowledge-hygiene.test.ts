// 知识沉淀卫生闸：纯函数级断言。夹具全部为合成文本，不含任何真实项目内容。
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureHygiene, resolveCaptureScope, scanSensitive, summarizeKnowledgeItems } from '../src/knowledge-hygiene.js';

const withBoundary = async <T>(mode: 'redacted' | 'full', body: () => T): Promise<T> => {
  const previous = process.env.DM_DATA_BOUNDARY;
  process.env.DM_DATA_BOUNDARY = mode;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.DM_DATA_BOUNDARY;
    else process.env.DM_DATA_BOUNDARY = previous;
  }
};

test('high-precision categories are detected; ordinary method text, URLs and hex digests are not', () => {
  const dirty = scanSensitive(
    'C:\\Users\\someone\\x.xlsx | \\\\fileserver\\share\\a.xlsx | a.b@example.com | 13900000000 | 110101199001011234 | AB-123 | LB-04-06',
    'dm-dvp.note',
  );
  assert.deepEqual(dirty, { LOCAL_PATH: 1, UNC_PATH: 1, EMAIL: 1, PHONE: 1, ID_NUMBER: 1, PROJECT_CODE: 2 });
  // 项目代号写进知识 ID 同样算命中。
  assert.deepEqual(scanSensitive('', 'dm-dvp.abcd1234.note'), { PROJECT_CODE: 1 });

  const clean =
    'fire when A > 1 AND B is missing；V6.0 实物为 Edit Checks Rave；dd MMM yyyy；True/False；LB4_04_06；ICD-10；'
    + '参考 https://example.com/docs/a 与 sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855；'
    + '版本串 3.0/ 22-Dec-2022；时间戳 1795493125108';
  assert.deepEqual(scanSensitive(clean, 'dm-dvp.note'), {});
});

test('data security on: machine/personal identifiers are refused in any scope', async () => {
  await withBoundary('redacted', () => {
    for (const scope of ['plugin', 'project'] as const) {
      const decision = captureHygiene({ knowledgeId: 'dm-dvp.note', scope, text: '来源：a.b@example.com 提供的 C:\\work\\a.xlsx' });
      assert.equal(decision.rejected, true, scope);
      assert.equal(decision.mode, 'redacted');
      // 拒绝理由只含类别与计数，绝不回显命中值。
      assert.match(decision.reason ?? '', /LOCAL_PATH=1/);
      assert.match(decision.reason ?? '', /EMAIL=1/);
      assert.doesNotMatch(decision.reason ?? '', /example\.com|work/);
    }
  });
});

test('data security on: a project code blocks cross-project (plugin) capture but is fine in project scope', async () => {
  await withBoundary('redacted', () => {
    const text = '实物页形见 AB-123 的 Edit Checks 页';
    const shared = captureHygiene({ knowledgeId: 'dm-dvp.note', scope: 'plugin', text });
    assert.equal(shared.rejected, true);
    assert.deepEqual(shared.hits, { PROJECT_CODE: 1 });
    const scoped = captureHygiene({ knowledgeId: 'dm-dvp.note', scope: 'project', text });
    assert.equal(scoped.rejected, false);
    assert.deepEqual(scoped.hits, { PROJECT_CODE: 1 });
    assert.equal(captureHygiene({ knowledgeId: 'dm-dvp.note', scope: 'plugin', text: '通用方法正文' }).rejected, false);
  });
});

test('data security off: nothing is refused, hits are still reported', async () => {
  await withBoundary('full', () => {
    const decision = captureHygiene({ knowledgeId: 'dm-dvp.abcd1234.note', scope: 'plugin', text: 'C:\\work\\a.xlsx a.b@example.com' });
    assert.deepEqual(decision, { mode: 'full', hits: { LOCAL_PATH: 1, EMAIL: 1, PROJECT_CODE: 1 }, rejected: false });
  });
});

test('capture scope follows projectId: given = project scope, blank = cross-project plugin scope', () => {
  assert.deepEqual(resolveCaptureScope('proj-1'), { scope: 'project', projectId: 'proj-1' });
  assert.deepEqual(resolveCaptureScope('  '), { scope: 'plugin' });
  assert.deepEqual(resolveCaptureScope(undefined), { scope: 'plugin' });
});

test('search summary labels unverified candidates instead of letting them pass as verified methods', () => {
  const items = [{ state: 'ACTIVE' }, { state: 'CANDIDATE' }, { state: 'CANDIDATE' }];
  const mixed = summarizeKnowledgeItems(items, 5);
  assert.deepEqual(mixed.summary, { matched: 5, returned: 3, active: 1, candidate: 2 });
  assert.match(mixed.stateNotice ?? '', /2 条为 CANDIDATE/);
  assert.equal('stateNotice' in summarizeKnowledgeItems([{ state: 'ACTIVE' }], 1), false);
});
