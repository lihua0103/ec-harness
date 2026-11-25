/** M1-01：服务端授权范围。
 *  可信主体验证后由平台装配方给出声明式范围（插件、组织、区域、允许项目、语料前缀）；
 *  调用方（模型工具参数、插件）只能在声明内收窄查询，永远不能改写插件身份/租户/区域或跨项目读取。
 *  任何越界都显式拒绝，不做静默回落。 */
import { KnowledgeService, type SearchOptions } from './service.js';
import type { KnowledgeSnapshot } from './snapshot-readonly.js';
import { identifier, validateContext, type KnowledgeContext, type KnowledgeDraft, type KnowledgeRecord } from './schema.js';
import type { ValidationRequest } from './validation-protocol.js';

export interface KnowledgeScopeDeclaration {
  pluginId: string;
  orgId?: string;
  region?: string;
  /** 允许的项目集合；与 allProjects 二选一。 */
  projectIds?: readonly string[];
  allProjects?: boolean;
  locale?: string;
  /** 语料入口约束：只有这些前缀下的文档可检索。未声明则语料检索整体拒绝。 */
  corpusDocPrefixes?: readonly string[];
}
export interface ScopeRequest {
  pluginId?: string;
  orgId?: string;
  region?: string;
  projectId?: string;
  scenario?: string;
  edc?: string;
  locale?: string;
}

export class KnowledgeScopeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'KnowledgeScopeError';
    this.code = code;
  }
}
const deny = (code: string): never => {
  throw new KnowledgeScopeError(code);
};

export function validateScopeDeclaration(declaration: KnowledgeScopeDeclaration): void {
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) deny('KNOWLEDGE_SCOPE_DECLARATION_INVALID');
  const allowed = new Set(['pluginId', 'orgId', 'region', 'projectIds', 'allProjects', 'locale', 'corpusDocPrefixes']);
  for (const key of Object.keys(declaration)) if (!allowed.has(key)) deny(`KNOWLEDGE_SCOPE_DECLARATION_INVALID:${key}`);
  identifier(declaration.pluginId);
  if (declaration.orgId !== undefined) identifier(declaration.orgId);
  if (declaration.region !== undefined) identifier(declaration.region);
  if (declaration.locale !== undefined && !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(declaration.locale))
    deny('KNOWLEDGE_SCOPE_DECLARATION_INVALID');
  if (declaration.projectIds !== undefined) {
    if (!Array.isArray(declaration.projectIds)) deny('KNOWLEDGE_SCOPE_DECLARATION_INVALID');
    for (const project of declaration.projectIds) identifier(project);
  }
  if (declaration.projectIds !== undefined && declaration.allProjects === true)
    deny('KNOWLEDGE_SCOPE_DECLARATION_INVALID');
  if (declaration.corpusDocPrefixes !== undefined) {
    if (!Array.isArray(declaration.corpusDocPrefixes)) deny('KNOWLEDGE_SCOPE_DECLARATION_INVALID');
    for (const prefix of declaration.corpusDocPrefixes) {
      if (typeof prefix !== 'string' || !prefix.trim() || prefix.length > 256) deny('KNOWLEDGE_SCOPE_DECLARATION_INVALID');
      if (prefix.startsWith('/') || /^[A-Za-z]:[\\/]/.test(prefix)) deny('KNOWLEDGE_SCOPE_DECLARATION_INVALID');
      // 允许结尾分隔符：语料前缀写作 `docs/` 是常规形式；拒绝相对穿越段。
      if (prefix.split(/[\\/]/).filter((segment: string) => segment !== '').some((segment: string) => segment === '..' || segment === '.'))
        deny('KNOWLEDGE_SCOPE_DECLARATION_INVALID');
    }
  }
}

/** 从可信声明与调用方请求派生检索上下文；请求只能收窄。 */
export function deriveContext(declaration: KnowledgeScopeDeclaration, request: ScopeRequest = {}): KnowledgeContext {
  validateScopeDeclaration(declaration);
  if (request.pluginId !== undefined && request.pluginId !== declaration.pluginId) deny('KNOWLEDGE_SCOPE_ESCALATION');
  if (request.orgId !== undefined && request.orgId !== declaration.orgId) deny('KNOWLEDGE_SCOPE_ESCALATION');
  if (request.region !== undefined && request.region !== declaration.region) deny('KNOWLEDGE_SCOPE_ESCALATION');
  if (request.projectId !== undefined) {
    identifier(request.projectId);
    if (declaration.allProjects !== true && !(declaration.projectIds ?? []).includes(request.projectId))
      deny('KNOWLEDGE_PROJECT_OUT_OF_SCOPE');
  }
  const context: KnowledgeContext = { pluginId: declaration.pluginId };
  if (declaration.orgId !== undefined) context.orgId = declaration.orgId;
  if (declaration.region !== undefined) context.region = declaration.region;
  if (request.projectId !== undefined) context.projectId = request.projectId;
  if (request.scenario !== undefined) context.scenario = request.scenario;
  if (request.edc !== undefined) context.edc = request.edc;
  const locale = request.locale ?? declaration.locale;
  if (locale !== undefined) context.locale = locale;
  validateContext(context);
  return context;
}

/** 快照必须属于同一授权范围：换插件/租户/区域或越界项目一律拒绝。 */
export function assertSnapshotInScope(declaration: KnowledgeScopeDeclaration, snapshot: KnowledgeSnapshot): void {
  validateScopeDeclaration(declaration);
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.records)) deny('KNOWLEDGE_SNAPSHOT_INVALID');
  const bound = snapshot.context;
  if (!bound || bound.pluginId !== declaration.pluginId) deny('KNOWLEDGE_SCOPE_ESCALATION');
  if ((bound.orgId ?? undefined) !== (declaration.orgId ?? undefined)) deny('KNOWLEDGE_SCOPE_ESCALATION');
  if ((bound.region ?? undefined) !== (declaration.region ?? undefined)) deny('KNOWLEDGE_SCOPE_ESCALATION');
  if (bound.projectId !== undefined && declaration.allProjects !== true && !(declaration.projectIds ?? []).includes(bound.projectId))
    deny('KNOWLEDGE_PROJECT_OUT_OF_SCOPE');
}

/** 绑定一个声明范围的轻量门面：所有读写都先派生可信上下文再进入服务。 */
export class KnowledgeScopeBoundary {
  private readonly service: KnowledgeService;
  readonly declaration: KnowledgeScopeDeclaration;
  constructor(service: KnowledgeService, declaration: KnowledgeScopeDeclaration) {
    validateScopeDeclaration(declaration);
    this.service = service;
    this.declaration = Object.freeze({
      ...declaration,
      ...(declaration.projectIds !== undefined ? { projectIds: Object.freeze([...declaration.projectIds]) } : {}),
      ...(declaration.corpusDocPrefixes !== undefined
        ? { corpusDocPrefixes: Object.freeze([...declaration.corpusDocPrefixes]) }
        : {}),
    });
  }
  context(request: ScopeRequest = {}): KnowledgeContext {
    return deriveContext(this.declaration, request);
  }
  search(request: ScopeRequest, options?: SearchOptions) {
    return this.service.search(this.context(request), options);
  }
  searchPinned(request: ScopeRequest, snapshot: KnowledgeSnapshot, options?: SearchOptions) {
    assertSnapshotInScope(this.declaration, snapshot);
    return this.service.searchPinned(this.context(request), snapshot, options);
  }
  /** 服务端按 runRef 还原绑定快照（解析器由控制面装配注入，§5：不信任客户端自带快照）。 */
  searchPinnedForRun(request: ScopeRequest, runId: string, options?: SearchOptions) {
    return this.service.searchPinnedForRun(this.context(request), runId, options);
  }
  get(request: ScopeRequest, knowledgeId: string, revision?: number): KnowledgeRecord {
    return this.service.get(this.context(request), knowledgeId, revision);
  }
  events(request: ScopeRequest, knowledgeId: string, offset = 0, limit = 50) {
    return this.service.events(this.context(request), knowledgeId, offset, limit);
  }
  capture(request: ScopeRequest, draft: KnowledgeDraft, expectedRevision = 0) {
    // `shared` is visible to every plugin, so it is never a tool/model-facing write target: one plugin's
    // run must not be able to publish to all of them. Shared records only come from trusted platform code
    // calling the service directly; through this boundary the draft's own scope field cannot escalate.
    if (draft && draft.scope === 'shared') deny('KNOWLEDGE_SCOPE_ESCALATION');
    return this.service.capture(this.context(request), draft, expectedRevision);
  }
  validate(request: ScopeRequest, knowledgeId: string, revision: number, validatorId: string) {
    return this.service.validate(this.context(request), knowledgeId, revision, validatorId);
  }
  createValidationRequestFor(request: ScopeRequest, knowledgeId: string, revision: number, validatorId: string, actor: string, executionEpoch = 1): ValidationRequest {
    return this.service.createValidationRequestFor(this.context(request), knowledgeId, revision, validatorId, actor, executionEpoch);
  }
  checkSnapshotImpact(request: ScopeRequest, snapshot: { records: Array<{ knowledgeId: string; revision: number }> }) {
    return this.service.checkSnapshotImpact(this.context(request), snapshot);
  }
  snapshot(request: ScopeRequest, runId: string) {
    return this.service.snapshot(this.context(request), runId);
  }
  readSnapshot(request: ScopeRequest, runId: string) {
    return this.service.readSnapshot(this.context(request), runId);
  }
  cite(request: ScopeRequest, runId: string, snapshot: KnowledgeSnapshot, refs: ReadonlyArray<Parameters<KnowledgeService['cite']>[3][number]>) {
    assertSnapshotInScope(this.declaration, snapshot);
    return this.service.cite(this.context(request), runId, snapshot, refs);
  }
  /** 语料入口同样受约束：未声明前缀即拒绝，不做全库检索。 */
  searchCorpus(options: { query: string; offset?: number; limit?: number }) {
    const prefixes = this.declaration.corpusDocPrefixes;
    if (!prefixes || !prefixes.length) deny('KNOWLEDGE_CORPUS_SCOPE_REQUIRED');
    return this.service.searchCorpus({ ...options, docPrefixes: prefixes });
  }
}