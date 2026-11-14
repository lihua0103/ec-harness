import test from 'node:test';
import assert from 'node:assert/strict';
import { applications } from '../applications.mjs';
import * as model from '../model.mjs';
import {
  DEFAULT_MODEL_ID, defaultModel, findModel, formatContext, isSelectableModel, modalityLabel, modelAvailability,
  modelLabel, models, resolveModelId, validModelEntry,
} from '../models.mjs';
import { KEY, loadFrom, sanitizeV4, serialize } from '../storage.mjs';

class FakeStorage {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}
function prepared() {
  const state = model.freshState(applications);
  model.selectContext(state, state.projects[0].id, 'ec.listing', applications);
  model.setDraftPrompt(model.getDraft(state), '合成模型选择测试');
  return state;
}

test('catalog is grounded, valid and has a resolvable default', () => {
  assert.ok(models.length >= 2);
  assert.ok(models.every(validModelEntry));
  assert.equal(defaultModel().id, DEFAULT_MODEL_ID);
  assert.equal(isSelectableModel('deepseek-v4-pro'), true);
  assert.equal(isSelectableModel('not-a-model'), false);
  // No silent substitution: an unknown selection resolves to null, never to another model.
  assert.equal(resolveModelId('not-a-model'), null);
  assert.equal(resolveModelId(null), null);
  assert.equal(modelLabel(null), '模型未记录');
  assert.equal(modelLabel('gone'), '未知模型（gone）');
  assert.equal(formatContext(1048576), '1M 上下文');
  assert.equal(formatContext(null), '上下文未知');
  assert.equal(modalityLabel([]), '输入模态未声明');
  assert.ok(findModel('deepseek-flash').modalities.includes('image'));
  assert.equal(modelAvailability(null).state, 'missing');
  assert.equal(modelAvailability('gone').state, 'unknown');
  assert.equal(modelAvailability(DEFAULT_MODEL_ID).state, 'available');
});

test('an unavailable catalog entry is explained and never swapped silently', () => {
  const catalog = models.map(m => m.id === 'deepseek-v4-pro'
    ? { ...m, availability: 'unavailable', unavailableReason: '组织策略停用了该模型。' }
    : m);
  const state = modelAvailability('deepseek-v4-pro', catalog);
  assert.equal(state.state, 'unavailable');
  assert.match(state.reason, /组织策略/);
  assert.equal(isSelectableModel('deepseek-v4-pro', catalog), false);
  assert.equal(resolveModelId('deepseek-v4-pro', catalog), null);
  assert.equal(defaultModel(catalog).id, DEFAULT_MODEL_ID);
  assert.equal(defaultModel([{ ...catalog[0], availability: 'unavailable' }]), null);
});

test('new drafts inherit the platform default model', () => {
  const state = prepared();
  assert.equal(model.getDraft(state).modelId, DEFAULT_MODEL_ID);
  model.setDefaultModel(state, 'deepseek-v4-pro');
  model.selectContext(state, state.projects[0].id, 'ec.dvp', applications);
  assert.equal(model.getDraft(state).modelId, 'deepseek-v4-pro');
  assert.throws(() => model.setDefaultModel(state, 'bogus'));
});

test('an unknown recorded model blocks starting work instead of switching models', () => {
  const state = prepared();
  const draft = model.getDraft(state);
  draft.modelId = 'removed-model';
  assert.throws(() => model.createWork(state, draft, applications), /不在模型目录|未选择模型/);
  assert.equal(state.works.length, 0);
  model.setDraftModel(draft, DEFAULT_MODEL_ID);
  assert.equal(model.createWork(state, draft, applications).inputs[0].modelId, DEFAULT_MODEL_ID);
});

test('draft model selection is validated and bound into the created work', () => {
  const state = prepared();
  const draft = model.getDraft(state);
  assert.throws(() => model.setDraftModel(draft, 'bogus'));
  model.setDraftModel(draft, 'deepseek-v4-pro');
  const work = model.createWork(state, draft, applications);
  assert.equal(work.inputs[0].modelId, 'deepseek-v4-pro');
  assert.match(model.previewMarkdown(work, model.previewResults(work, applications).id), /模型：DeepSeek-V4-Pro/);
});

test('switching a work model creates a new input revision; same model is a no-op', () => {
  const state = prepared();
  const work = model.createWork(state, model.getDraft(state), applications);
  assert.equal(model.setWorkModel(work, DEFAULT_MODEL_ID, applications), false);
  assert.equal(work.inputs.length, 1);
  assert.equal(model.setWorkModel(work, 'deepseek-v4-pro', applications), true);
  assert.equal(work.inputs.length, 2);
  assert.equal(model.activeInput(work).modelId, 'deepseek-v4-pro');
  assert.equal(work.inputs[0].modelId, DEFAULT_MODEL_ID);
  const first = model.previewResults(work, applications);
  assert.match(model.previewMarkdown(work, first.id), /模型：DeepSeek-V4-Pro/);
  model.appendMessage(work, '补充要求', applications);
  assert.equal(model.activeInput(work).modelId, 'deepseek-v4-pro');
  model.archiveWork(work);
  assert.throws(() => model.setWorkModel(work, DEFAULT_MODEL_ID, applications));
  assert.throws(() => model.setWorkModel(work, 'gone', applications));
});

test('legacy works keep model unrecorded; recorded preferences survive reload without substitution', () => {
  const legacy = {
    version: 3, revision: 1,
    projects: [{ id: 'P1', name: '项目', code: 'C1', directory: '', batch: '', server: '' }],
    tasks: [{ id: 'T1', app: 'listing', type: 'Manual', projectId: 'P1', title: '旧工作', request: '旧要求', createdAt: '2026-01-01T00:00:00.000Z', files: [], status: 'draft', messages: [] }],
    draft: { app: 'listing', type: 'Manual', projectId: 'P1', prompt: '', files: [] },
  };
  const storage = new FakeStorage({ 'emerald.dsh.platform.prototype.v3': JSON.stringify(legacy) });
  const state = loadFrom(storage, applications).state;
  assert.equal(state.works[0].inputs[0].modelId, null);
  assert.equal(state.preferences.defaultModelId, DEFAULT_MODEL_ID);
  const raw = JSON.parse(serialize(state));
  raw.preferences.defaultModelId = 'deepseek-v4-pro';
  assert.equal(sanitizeV4(raw, applications).preferences.defaultModelId, 'deepseek-v4-pro');
  raw.preferences.defaultModelId = 'gone';
  const reloaded = sanitizeV4(raw, applications);
  assert.equal(reloaded.preferences.defaultModelId, 'gone');
  // A new draft for an app without an existing draft keeps the recorded (unknown) preference.
  assert.equal(model.getDraft(reloaded, 'P1', 'ec.dvp', applications).modelId, 'gone');
  assert.ok(storage.getItem(KEY));
});
