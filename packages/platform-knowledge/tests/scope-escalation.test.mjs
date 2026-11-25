// 模型/工具面（KnowledgeScopeBoundary）永远不能写入 shared：shared 对所有插件可见，
// 一个插件的运行不得借工具参数把自己的内容发布给全部插件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService, KnowledgeScopeBoundary } from '../lib/index.js';

const draft = (over = {}) => ({
  knowledgeId: 'p.method.note', scope: 'plugin', pluginId: 'p', kind: 'technical_method',
  title: 't', problemSignal: 's', cause: 'c', method: 'm', scenarios: [], edc: [], topics: [],
  preconditions: ['a'], notApplicable: [], counterexamples: ['b'], sources: ['c'], ...over,
});
const open = (name) => {
  const root = mkdtempSync(join(tmpdir(), `km-scope-${name}-`));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  return { service, close: () => { service.close(); rmSync(root, { recursive: true, force: true }); } };
};

test('boundary.capture refuses shared scope; nothing is written and other plugins stay blind', () => {
  const { service, close } = open('shared');
  try {
    const boundary = new KnowledgeScopeBoundary(service, { pluginId: 'p', allProjects: true });
    assert.throws(
      () => boundary.capture({}, draft({ scope: 'shared', pluginId: undefined })),
      /KNOWLEDGE_SCOPE_ESCALATION/,
    );
    assert.equal(service.search({ pluginId: 'p' }, { states: ['CANDIDATE'] }).total, 0, '被拒的候选没有落库');
    const record = boundary.capture({}, draft());
    assert.equal(record.state, 'CANDIDATE');
    assert.equal(service.search({ pluginId: 'other' }, { states: ['CANDIDATE'] }).total, 0, 'plugin scope 对其他插件不可见');
  } finally {
    close();
  }
});

test('project scope through the boundary must equal the request projectId', () => {
  const { service, close } = open('project');
  try {
    const boundary = new KnowledgeScopeBoundary(service, { pluginId: 'p', allProjects: true });
    assert.throws(() => boundary.capture({}, draft({ scope: 'project', projectId: 'proj-a' })), /KNOWLEDGE_CONTEXT_MISMATCH/);
    assert.throws(
      () => boundary.capture({ projectId: 'proj-b' }, draft({ scope: 'project', projectId: 'proj-a' })),
      /KNOWLEDGE_CONTEXT_MISMATCH/,
    );
    const record = boundary.capture({ projectId: 'proj-a' }, draft({ scope: 'project', projectId: 'proj-a' }));
    assert.equal(record.state, 'CANDIDATE');
    assert.equal(service.search({ pluginId: 'p', projectId: 'proj-a' }, { states: ['CANDIDATE'] }).total, 1);
    assert.equal(service.search({ pluginId: 'p', projectId: 'proj-b' }, { states: ['CANDIDATE'] }).total, 0, '项目专属知识不跨项目');
    assert.equal(service.search({ pluginId: 'p' }, { states: ['CANDIDATE'] }).total, 0, '无项目上下文读不到项目专属知识');
  } finally {
    close();
  }
});
