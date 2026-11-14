/** Local project directory. Enterprise discovery can replace this repository without changing Work identity. */
import { randomUUID } from 'node:crypto';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, basename, dirname, join, relative, resolve, sep } from 'node:path';
import { PlatformError } from './registry.js';
import { PlatformStore, type ProjectRecord, type WorkspaceRecord } from './store.js';

export interface ProjectDraft { name: string; code?: string }
export interface WorkspaceDraft {
  projectId: string;
  name: string;
  /** Local directory chosen by the employee. */
  directory: string;
  /** Optional path the execution host sees, when it differs from the local directory. */
  executionDirectory?: string;
  outputDirectory?: string;
}

/** The path the worker must use: the execution-host mapping when provided. */
export function executionDirectoryOf(workspace: WorkspaceRecord): string {
  return workspace.executionDirectory ?? workspace.directory;
}

/** Legacy workspaces without a chosen output directory use a contained default. */
export function outputDirectoryOf(workspace: WorkspaceRecord): string {
  return workspace.outputDirectory ?? join(executionDirectoryOf(workspace), '.platform', 'runs');
}

function requiredText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new PlatformError('PROJECT_INPUT_INVALID', field);
  }
  return value.trim();
}
function insidePath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`) && !isAbsolute(rel));
}
/** Canonicalize a path that may not exist yet, using the nearest existing ancestor. */
async function canonicalizePath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    const parent = dirname(candidate);
    if (parent === candidate) throw new PlatformError('WORKSPACE_OUTPUT_INVALID', '无法解析产物目录。');
    return join(await canonicalizePath(parent), basename(candidate));
  }
}

export class ProjectRepository {
  constructor(private readonly store: PlatformStore) {}

  create(draft: ProjectDraft, actor: string): ProjectRecord {
    const name = requiredText(draft?.name, 200, 'name');
    const code = draft.code === undefined || draft.code === '' ? '' : requiredText(draft.code, 100, 'code');
    const record: ProjectRecord = {
      projectId: randomUUID(), name, code, source: 'local', createdBy: actor, createdAt: new Date().toISOString(),
    };
    return this.store.transaction(() => {
      this.store.projectInsert(record);
      this.store.audit(actor, 'PROJECT_CREATED', record.projectId, { name, code });
      return record;
    });
  }

  get(projectId: string): ProjectRecord {
    const project = this.store.projectGet(projectId);
    if (!project) throw new PlatformError('PROJECT_NOT_FOUND', projectId);
    return project;
  }

  list(): ProjectRecord[] { return this.store.projectList(); }

  workspaces(projectId: string): WorkspaceRecord[] {
    this.get(projectId);
    return this.store.workspaceList(projectId);
  }

  workspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.store.workspaceGet(workspaceId);
    if (!workspace) throw new PlatformError('WORKSPACE_NOT_FOUND', workspaceId);
    return workspace;
  }

  /** The output directory must stay inside the execution workspace (the harness sandbox boundary). */
  private async resolveOutputDirectory(roots: string[], requested?: string): Promise<string> {
    const raw = requested?.trim();
    if (raw && !isAbsolute(raw)) throw new PlatformError('WORKSPACE_OUTPUT_INVALID', '请选择绝对路径的产物目录。');
    const executionRoot = roots[roots.length - 1];
    const candidate = raw ? resolve(raw) : join(executionRoot, '.platform', 'runs');
    const canonical = await canonicalizePath(candidate).catch(() => {
      throw new PlatformError('WORKSPACE_OUTPUT_INVALID', '产物目录不可解析。');
    });
    if (!roots.some((root) => insidePath(root, canonical))) {
      throw new PlatformError('WORKSPACE_OUTPUT_OUTSIDE', '产物目录必须位于工作目录内。');
    }
    try {
      await mkdir(canonical, { recursive: true });
    } catch {
      throw new PlatformError('WORKSPACE_OUTPUT_NOT_WRITABLE', '无法创建产物目录；请检查执行主机权限。');
    }
    const real = await realpath(canonical);
    if (!roots.some((root) => insidePath(root, real))) {
      throw new PlatformError('WORKSPACE_OUTPUT_OUTSIDE', '产物目录必须位于工作目录内。');
    }
    try {
      await access(real, constants.R_OK | constants.W_OK);
    } catch {
      throw new PlatformError('WORKSPACE_OUTPUT_NOT_WRITABLE');
    }
    return real;
  }

  /** Resolves a server-side directory only. No copying, source writes or permission changes. */
  async createWorkspace(draft: WorkspaceDraft, actor: string): Promise<WorkspaceRecord> {
    this.get(draft?.projectId);
    const name = requiredText(draft.name, 200, 'workspace.name');
    const requested = requiredText(draft.directory, 4096, 'workspace.directory');
    if (!isAbsolute(requested)) throw new PlatformError('WORKSPACE_DIRECTORY_INVALID', '请选择本机上的绝对目录。');
    let directory: string;
    try {
      directory = await realpath(requested);
      if (!(await stat(directory)).isDirectory()) throw new Error('not a directory');
      await access(directory, constants.R_OK);
    } catch {
      throw new PlatformError('WORKSPACE_DIRECTORY_UNAVAILABLE', '无法读取此目录，请检查路径及访问权限。');
    }
    let executionDirectory: string | undefined;
    if (draft.executionDirectory !== undefined && draft.executionDirectory.trim()) {
      const raw = requiredText(draft.executionDirectory, 4096, 'workspace.executionDirectory');
      if (!isAbsolute(raw)) {
        throw new PlatformError('WORKSPACE_EXECUTION_PATH_INVALID', '执行主机实际路径必须是绝对路径。');
      }
      executionDirectory = await canonicalizePath(resolve(raw)).catch(() => resolve(raw));
    }
    const roots = executionDirectory ? [directory, executionDirectory] : [directory];
    const record: WorkspaceRecord = {
      workspaceId: randomUUID(), projectId: draft.projectId, name, directory,
      ...(executionDirectory ? { executionDirectory } : {}),
      outputDirectory: await this.resolveOutputDirectory(roots, draft.outputDirectory),
      revision: 1, createdBy: actor, createdAt: new Date().toISOString(),
    };
    return this.store.transaction(() => {
      if (this.store.workspaceList(draft.projectId).some((item) => item.directory === directory)) {
        throw new PlatformError('WORKSPACE_EXISTS', '该目录已登记到本项目，请选择已有工作空间。');
      }
      this.store.workspaceInsert(record);
      this.store.audit(actor, 'WORKSPACE_CREATED', record.workspaceId, { projectId: record.projectId, revision: 1 });
      return record;
    });
  }
}
