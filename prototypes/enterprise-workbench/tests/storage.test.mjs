import test from 'node:test';
import assert from 'node:assert/strict';
import { applications } from '../applications.mjs';
import * as model from '../model.mjs';
import {
  BACKUP_KEY, KEY, LEGACY_KEY, loadFrom, matchesWork, sanitizeV4, serialize, storedRevision, writeNow,
} from '../storage.mjs';

class FakeStorage {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); this.failKeys = new Set(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    if (this.failKeys.has(key)) { const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error; }
    this.map.set(key, String(value));
  }
  removeItem(key) { this.map.delete(key); }
}
const project = { id: 'P1', name: '合成项目', code: 'SYN-1', directory: 'D:/S', batch: 'B1', server: '' };
const file = i => ({ name: `LEGACY-${i}.xlsx`, role: '需求规格', source: 'sample' });
const task = overrides => ({
  id: 'T1', app: 'listing', type: 'PK', projectId: 'P1', title: '旧工作', request: '旧要求',
  createdAt: '2026-01-01T00:00:00.000Z', files: [file(0)], status: 'sample',
  messages: [{ role: 'user', text: '旧要求' }, { role: 'assistant', text: '旧回复' }], ...overrides,
});
const legacy = tasks => ({
  version: 3, revision: 4, projects: [project], tasks,
  draft: { app: 'dvp', type: 'Manual', projectId: 'P1', prompt: '旧草稿', files: [] },
});
function prepared() {
  const state = model.freshState(applications);
  model.selectContext(state, state.projects[0].id, 'ec.listing', applications);
  model.setDraftPrompt(model.getDraft(state), '合成审核工作');
  return state;
}

test('v3 migrates in place without overwriting the legacy cache', () => {
  const storage = new FakeStorage({ [LEGACY_KEY]: JSON.stringify(legacy([task()])) });
  const result = loadFrom(storage, applications);
  assert.equal(result.mode, 'migrated');
  assert.equal(result.state.works.length, 1);
  const work = result.state.works[0];
  assert.equal(work.inputs[0].options.listingType, 'PK');
  assert.equal(work.resultPreviews.length, 1);
  assert.match(storage.getItem(LEGACY_KEY), /"version":3/);
  assert.equal(JSON.parse(storage.getItem(KEY)).version, 4);
  assert.equal(loadFrom(storage, applications).mode, 'ok');
});

test('DVP migration drops the unrelated Listing type', () => {
  const storage = new FakeStorage({ [LEGACY_KEY]: JSON.stringify(legacy([task({ id: 'T2', app: 'dvp', type: 'Manual', status: 'stopped' })])) });
  const result = loadFrom(storage, applications);
  const work = result.state.works[0];
  assert.equal(work.inputs[0].options.listingType, undefined);
  assert.match(work.readOnlyReason, /归档/);
  assert.equal(model.editable(work, applications), false);
  assert.equal(work.resultPreviews.length, 0);
  assert.equal(result.state.drafts[model.draftKey('P1', 'ec.dvp')].prompt, '旧草稿');
});

test('legacy oversize files are preserved read-only instead of truncated', () => {
  const storage = new FakeStorage({ [LEGACY_KEY]: JSON.stringify(legacy([task({ files: Array.from({ length: 31 }, (_, i) => file(i)) })])) });
  const work = loadFrom(storage, applications).state.works[0];
  assert.equal(work.inputs[0].files.length, 31);
  assert.match(work.readOnlyReason, /超过30个/);
  assert.equal(model.editable(work, applications), false);
});

test('one malformed legacy task is isolated without hiding valid work', () => {
  const storage = new FakeStorage({ [LEGACY_KEY]: JSON.stringify(legacy([task(), { id: 'BAD' }])) });
  const state = loadFrom(storage, applications).state;
  assert.equal(state.works.length, 1);
  assert.equal(state.recovery.length, 1);
  assert.match(state.recovery[0].reason, /缺少必要标识/);
});

test('corrupt v4 is reported and never overwritten', () => {
  const storage = new FakeStorage({ [KEY]: '{not-json' });
  const result = loadFrom(storage, applications);
  assert.equal(result.mode, 'corrupt');
  assert.equal(result.raw, '{not-json');
  assert.equal(storage.getItem(KEY), '{not-json');
});

test('a single invalid v4 work is quarantined while valid records stay available', () => {
  const state = prepared();
  const draft = model.getDraft(state);
  model.addFiles(draft, [{ name: 'A.txt', role: '资料', source: 'local' }], applications);
  model.createWork(state, draft, applications);
  const raw = JSON.parse(serialize(state));
  raw.works.push({ id: 'BROKEN' });
  raw.recovery = [];
  const fixed = sanitizeV4(raw, applications);
  assert.equal(fixed.works.length, 1);
  assert.equal(fixed.recovery.length, 1);
  assert.equal(fixed.recovery[0].kind, 'work');
});

test('drafts are preserved per project and per application across reloads', () => {
  const state = prepared();
  model.selectContext(state, state.projects[0].id, 'ec.dvp', applications);
  model.setDraftPrompt(model.getDraft(state), 'DVP 草稿');
  const reloaded = sanitizeV4(JSON.parse(serialize(state)), applications);
  assert.equal(model.getDraft(reloaded, state.projects[0].id, 'ec.listing', applications).prompt, '合成审核工作');
  assert.equal(model.getDraft(reloaded, state.projects[0].id, 'ec.dvp', applications).prompt, 'DVP 草稿');
});

test('writeNow keeps the previous snapshot and reports quota failure', () => {
  const previous = JSON.stringify({ version: 4, revision: 7, projects: [], works: [], drafts: {}, preferences: {}, selection: {} });
  const storage = new FakeStorage({ [KEY]: previous });
  storage.failKeys.add(KEY);
  const result = writeNow(storage, prepared());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'quota');
  assert.equal(storage.getItem(BACKUP_KEY), previous);
  assert.equal(storedRevision(storage), 7);
});

test('writeNow writes a revision that the next tab can detect', () => {
  const storage = new FakeStorage();
  const state = prepared();
  state.revision = 9;
  assert.equal(writeNow(storage, state).ok, true);
  assert.equal(storedRevision(storage), 9);
});

test('work filters separate archived records and keep project/application filters', () => {
  const state = prepared();
  const first = model.createWork(state, model.getDraft(state), applications);
  model.setDraftPrompt(model.getDraft(state), '第二项工作');
  const second = model.createWork(state, model.getDraft(state), applications);
  model.archiveWork(second);
  assert.deepEqual(state.works.filter(w => matchesWork(w, { archived: 'active' })).map(w => w.id), [first.id]);
  assert.deepEqual(state.works.filter(w => matchesWork(w, { archived: 'archived' })).map(w => w.id), [second.id]);
  assert.equal(matchesWork(first, { appId: 'ec.dvp' }), false);
  assert.equal(matchesWork(first, { query: '合成审核' }), true);
  assert.equal(matchesWork(first, { projectId: first.projectId }), true);
});