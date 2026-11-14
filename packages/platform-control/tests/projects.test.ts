import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import { draft } from './helpers.js';
import type { Principal } from '../src/policy.js';

const operator: Principal = { actorId: 'local:projects-test', kind: 'operator' };
const code = (expected: string) => (error: unknown) => error instanceof PlatformError && error.code === expected;

test('projects, real workspace references, long goals and personal drafts survive reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-projects-'));
  const path = join(root, 'control.sqlite');
  let service = new PlatformControlService(path);
  try {
    service.registerApp(draft(), operator);
    const project = service.createProject({ name: '合成项目', code: 'P001' }, operator);
    const other = service.createProject({ name: '合成项目', code: 'P001' }, operator);
    assert.notEqual(project.projectId, other.projectId);
    const workspace = await service.createWorkspace({ projectId: project.projectId, name: '服务器工作空间', directory: root }, operator);
    assert.equal(workspace.directory, await realpath(root));
    assert.equal(workspace.outputDirectory, await realpath(join(root, '.platform', 'runs')));
    await mkdir(join(root, 'chosen'), { recursive: true });
    const chosen = await service.createWorkspace({
      projectId: project.projectId, name: '自选产物目录', directory: join(root, 'chosen'), outputDirectory: join(root, 'chosen', 'results'),
    }, operator);
    assert.equal(chosen.outputDirectory, await realpath(join(root, 'chosen', 'results')));
    await assert.rejects(service.createWorkspace({ projectId: project.projectId, name: '重复', directory: root }, operator), code('WORKSPACE_EXISTS'));
    assert.throws(() => service.createWork({ projectId: other.projectId, workspaceId: workspace.workspaceId, appId: 'listing', appVersion: '1.0.0', title: '错误关联' }, operator), code('WORKSPACE_PROJECT_MISMATCH'));
    const work = service.createWork({ projectId: project.projectId, workspaceId: workspace.workspaceId, appId: 'listing', appVersion: '1.0.0', title: '持续工作', goal: '完整要求。'.repeat(100) }, operator);
    const saved = service.saveWorkDraft(work.workId, '未提交的修改要求', 0, operator);
    assert.equal(saved.revision, 1);
    assert.throws(() => service.saveWorkDraft(work.workId, '覆盖', 0, operator), code('WORK_DRAFT_REVISION_STALE'));
    assert.equal(service.workDraft(work.workId, { ...operator, actorId: 'local:other' }).text, '');
    service.close();
    service = new PlatformControlService(path);
    assert.equal(service.listProjects(operator).length, 2);
    assert.equal(service.projectWorkspaces(project.projectId, operator)[0].workspaceId, workspace.workspaceId);
    assert.equal(service.getWork(work.workId, operator).goal, work.goal);
    assert.equal(service.workDraft(work.workId, operator).text, '未提交的修改要求');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace registration rejects missing projects, relative paths and unavailable directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-projects-invalid-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  try {
    const project = service.createProject({ name: '测试' }, operator);
    await assert.rejects(service.createWorkspace({ projectId: 'missing', name: 'x', directory: root }, operator), code('PROJECT_NOT_FOUND'));
    await assert.rejects(service.createWorkspace({ projectId: project.projectId, name: 'x', directory: './data' }, operator), code('WORKSPACE_DIRECTORY_INVALID'));
    await assert.rejects(service.createWorkspace({ projectId: project.projectId, name: 'x', directory: join(root, 'missing') }, operator), code('WORKSPACE_DIRECTORY_UNAVAILABLE'));
    await assert.rejects(
      service.createWorkspace({ projectId: project.projectId, name: 'x', directory: root, outputDirectory: join(root, '..', 'outside') }, operator),
      code('WORKSPACE_OUTPUT_OUTSIDE'),
    );
    assert.throws(() => service.createProject({ name: ' ' }, operator), code('PROJECT_INPUT_INVALID'));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
