import test from 'node:test';
import assert from 'node:assert/strict';
import { applications, searchApplications, supported } from '../applications.mjs';
import * as model from '../model.mjs';

const third = {
  appId: 'test.third', version: 'prototype-4', displayName: '内部测试应用', icon: 'file',
  description: '仅用于验证通用接入，不发布给员工。', keywords: ['测试', '通用接入'],
  options: [{ key: 'siteType', label: '现场类型', values: ['中心', '卫星'], default: '中心' }],
  materialRoles: ['测试资料'], resultTypes: ['测试成果'], plan: ['理解测试目标'],
  samples: [{ name: 'TEST-INPUT.txt', role: '测试资料' }],
  suggestions: [{ title: '开始测试', text: '开始通用接入测试。' }],
  placeholder: '测试', limitation: '仅测试。',
};
const catalog = [...applications, third];
const localFile = i => ({ name: `AUDIT-${i}.txt`, role: '待 AI 识别', source: 'local' });
function prepared(appId = 'ec.listing') {
  const state = model.freshState(catalog);
  const projectId = state.projects[0].id;
  model.selectContext(state, projectId, appId, catalog);
  const draft = model.getDraft(state);
  model.setDraftPrompt(draft, '合成审核工作：不使用真实临床资料。');
  return { state, projectId, draft };
}

test('DVP contribution has no Listing type; Listing keeps exactly four values', () => {
  const dvp = applications.find(a => a.appId === 'ec.dvp');
  const listing = applications.find(a => a.appId === 'ec.listing');
  assert.equal(dvp.options.some(o => o.key === 'listingType'), false);
  assert.deepEqual(listing.options[0].values, ['Manual', 'Medical', 'PK', 'Report']);
  assert.equal(supported(third), true);
});

test('file cap is enforced at every add entry without destroying existing records', () => {
  const { draft } = prepared();
  for (let i = 0; i < 30; i++) model.addFiles(draft, [localFile(i)], catalog);
  assert.equal(draft.files.length, 30);
  const result = model.addFiles(draft, applications[0].samples.map(f => ({ ...f, source: 'sample' })), catalog);
  assert.equal(result.added, 0);
  assert.equal(result.rejected, 3);
  assert.equal(draft.files.length, 30);
  assert.equal(model.addFiles(draft, [localFile(0)], catalog).duplicate, 1);
});

test('a work can be saved without attachments and keeps a project snapshot', () => {
  const { state, projectId, draft } = prepared();
  const work = model.createWork(state, draft, catalog);
  assert.equal(work.inputs[0].files.length, 0);
  assert.equal(work.projectSnapshot.directory, 'D:/Clinical/SYN-001');
  model.saveProject(state, { name: '改名项目', code: 'SYN-001', directory: 'D:/Clinical/NEW', batch: '2026-11-11' }, projectId);
  assert.equal(work.projectSnapshot.directory, 'D:/Clinical/SYN-001');
  assert.equal(state.projects[0].directory, 'D:/Clinical/NEW');
  assert.equal(work.contextOrigin, 'captured');
});

test('archive is independent from results and makes every input read-only', () => {
  const { state, draft } = prepared();
  model.addFiles(draft, [localFile(1)], catalog);
  const work = model.createWork(state, draft, catalog);
  const preview = model.previewResults(work, catalog);
  model.archiveWork(work);
  assert.ok(work.archivedAt);
  assert.equal(model.editable(work, catalog), false);
  assert.equal(work.resultPreviews.length, 1);
  assert.match(model.previewMarkdown(work, preview.id), /输入修订：1/);
  assert.throws(() => model.addFiles(work, [localFile(2)], catalog));
  assert.throws(() => model.appendMessage(work, '归档后补充', catalog));
});

test('same-application selection is a no-op and drafts survive application switches', () => {
  const { state, projectId, draft } = prepared();
  model.addFiles(draft, [localFile(5)], catalog);
  const again = model.selectContext(state, projectId, 'ec.listing', catalog);
  assert.equal(again, draft);
  assert.equal(again.files.length, 1);
  model.selectContext(state, projectId, 'ec.dvp', catalog);
  const dvp = model.getDraft(state);
  assert.equal(dvp.options.listingType, undefined);
  model.setDraftPrompt(dvp, 'DVP 草稿');
  model.selectContext(state, projectId, 'ec.listing', catalog);
  assert.equal(model.getDraft(state).prompt, '合成审核工作：不使用真实临床资料。');
  assert.equal(model.getDraft(state).files.length, 1);
});

test('options are validated from the application contribution', () => {
  const { state, draft } = prepared();
  assert.throws(() => model.setOption(draft, 'listingType', 'BE', catalog));
  model.setOption(draft, 'listingType', 'PK', catalog);
  const work = model.createWork(state, draft, catalog);
  assert.equal(work.inputs[0].options.listingType, 'PK');
});

test('a third application renders and runs through the same model without core branches', () => {
  const { state, draft } = prepared('test.third');
  assert.equal(draft.options.siteType, '中心');
  model.setOption(draft, 'siteType', '卫星', catalog);
  const work = model.createWork(state, draft, catalog);
  assert.equal(work.inputs[0].options.siteType, '卫星');
  assert.equal(work.inputs[0].options.listingType, undefined);
  assert.deepEqual(work.appSnapshot.resultTypes, ['测试成果']);
  assert.deepEqual(work.appSnapshot.plan, ['理解测试目标']);
});

test('previews bind to the input revision and never rewrite older evidence', () => {
  const { state, draft } = prepared();
  const work = model.createWork(state, draft, catalog);
  const first = model.previewResults(work, catalog);
  model.appendMessage(work, '补充要求', catalog);
  const second = model.previewResults(work, catalog);
  assert.equal(first.inputRevision, 1);
  assert.equal(second.inputRevision, 2);
  assert.notEqual(first.id, second.id);
  assert.match(model.previewMarkdown(work, first.id), /输入修订：1/);
  assert.equal(work.inputs.length, 2);
});

test('continueWork reuses an empty context draft and never overwrites existing text', () => {
  const { state, draft } = prepared();
  const work = model.createWork(state, draft, catalog);
  model.setDraftPrompt(model.getDraft(state), '尚未发送的新草稿');
  model.continueWork(state, work, catalog);
  assert.equal(model.getDraft(state).prompt, '尚未发送的新草稿');
  assert.equal(model.getDraft(state).sourceWorkId, null);
});

test('directory search, favorites, recents and pagination handle 200 synthetic entries', () => {
  const synthetic = Array.from({ length: 200 }, (_, i) => ({
    ...third, appId: `test.app${i}`, displayName: `合成应用 ${String(i).padStart(3, '0')}`,
    description: `规模测试 ${i}`, keywords: ['合成', String(i)],
  }));
  const page = searchApplications(synthetic, { page: 1, pageSize: 12 });
  assert.equal(page.total, 200);
  assert.equal(page.pages, 17);
  assert.equal(page.items.length, 12);
  assert.equal(searchApplications(synthetic, { query: '应用 017' }).total, 1);
  assert.equal(searchApplications(synthetic, { filter: 'favorites', favorites: ['test.app3'] }).items[0].appId, 'test.app3');
  assert.deepEqual(searchApplications(synthetic, { filter: 'recent', recent: ['test.app9', 'test.app2'] }).items.map(a => a.appId), ['test.app9', 'test.app2']);
  assert.equal(searchApplications(synthetic, { query: '规模测试 199' }).items[0].appId, 'test.app199');
});