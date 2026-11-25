/** L1 权威服务访问面：进程内与 HTTP 两种实现共享同一合同。
 *  控制面用它代理工作台的交互操作（偏好/草稿/学习个案/发布清单）；
 *  Run 创建时的绑定（快照/发布指针/偏好引用）走 snapshot-readonly 只读文件口，保持同步事务语义。
 *  身份合同（§5）：请求主体、租户和区域来自验证过的身份连接——HTTP 客户端把已认证的主体
 *  放进转发头（x-dsh-subject/org/region），绝不放进请求体；服务端 authenticator 从连接派生主体。 */
import type { KnowledgeService } from './service.js';
import type { PersonalDraftRecord, PersonalSettingRecord } from './preferences.js';
import type {
  KnowledgeReleasePointer,
  KnowledgeReleaseRecord,
  LearningCaseRecord,
  LearningCaseSourceEvent,
  LearningCaseStatus,
} from './learning.js';
import type { KnowledgePrincipal } from './identity-scope.js';
import type { KnowledgeContext } from './schema.js';

export interface KnowledgeAccess {
  preferencesGetMine(principal: KnowledgePrincipal, options?: { pluginId?: string }): Promise<PersonalSettingRecord[]>;
  preferencesSetMine(
    principal: KnowledgePrincipal,
    input: { key: string; value: unknown; pluginId?: string; expectedRevision: number },
  ): Promise<PersonalSettingRecord>;
  preferencesPauseMine(principal: KnowledgePrincipal, key: string, pluginId?: string): Promise<PersonalSettingRecord>;
  preferencesDeleteMine(principal: KnowledgePrincipal, key: string, pluginId?: string): Promise<PersonalSettingRecord>;
  personalDraftCreate(
    principal: KnowledgePrincipal,
    input: { pluginId?: string; title: string; body: string },
  ): Promise<PersonalDraftRecord>;
  personalDraftListMine(principal: KnowledgePrincipal): Promise<PersonalDraftRecord[]>;
  personalDraftUpdateMine(
    principal: KnowledgePrincipal,
    draftId: string,
    expectedRevision: number,
    patch: { title?: string; body?: string },
  ): Promise<PersonalDraftRecord>;
  personalDraftDeleteMine(principal: KnowledgePrincipal, draftId: string): Promise<PersonalDraftRecord>;
  learningCaseOpen(
    context: KnowledgeContext,
    input: { sourceEvent: LearningCaseSourceEvent; hypothesisKey: string; category?: string },
  ): Promise<{ case: LearningCaseRecord; duplicate: boolean }>;
  learningCases(
    context: KnowledgeContext,
    options?: { status?: LearningCaseStatus; limit?: number },
  ): Promise<LearningCaseRecord[]>;
  learningCaseDispose(
    context: KnowledgeContext,
    caseId: string,
    disposition: 'NO_REUSABLE' | 'PENDING' | 'CONFLICT',
    reason?: string,
  ): Promise<LearningCaseRecord>;
  proposeFromCase(
    context: KnowledgeContext,
    principal: KnowledgePrincipal,
    input: {
      caseId: string;
      contributionConfirmed: boolean;
      idempotencyKey: string;
      draft: Record<string, unknown>;
    },
  ): Promise<{ knowledgeId: string; revision: number; contentDigest: string; duplicate: boolean; caseId: string }>;
  releasesList(
    principal: KnowledgePrincipal,
    input: { pluginId: string; state?: KnowledgeReleaseRecord['state']; limit?: number },
  ): Promise<KnowledgeReleaseRecord[]>;
  publishRelease(
    principal: KnowledgePrincipal,
    input: {
      pluginId: string;
      audience: string;
      entries: Array<{ knowledgeId: string; revision: number }>;
      evalReportRef?: string;
      expectedVersion: number;
    },
  ): Promise<{ release: KnowledgeReleaseRecord; pointer: KnowledgeReleasePointer }>;
  withdrawRelease(
    principal: KnowledgePrincipal,
    releaseId: string,
    reason: string,
  ): Promise<{ releaseId: string; entries: KnowledgeReleaseRecord['entries']; affectedReleases: string[] }>;
  rollbackRelease(
    principal: KnowledgePrincipal,
    input: { pluginId: string; expectedVersion: number; toReleaseId?: string; reason: string },
  ): Promise<{ pointer: KnowledgeReleasePointer; release: KnowledgeReleaseRecord }>;
  releasePointerInfo(principal: KnowledgePrincipal, pluginId: string): Promise<KnowledgeReleasePointer | undefined>;
  close?(): void | Promise<void>;
}

/** 进程内适配：DSH bundle 与知识服务同进程时使用（单一写者即本进程）。 */
export class InProcessKnowledgeAccess implements KnowledgeAccess {
  constructor(private readonly service: KnowledgeService) {}
  preferencesGetMine(principal: KnowledgePrincipal, options?: { pluginId?: string }) {
    return Promise.resolve(this.service.preferencesGetMine(principal, options));
  }
  preferencesSetMine(
    principal: KnowledgePrincipal,
    input: { key: string; value: unknown; pluginId?: string; expectedRevision: number },
  ) {
    return Promise.resolve(this.service.preferencesSetMine(principal, input));
  }
  preferencesPauseMine(principal: KnowledgePrincipal, key: string, pluginId?: string) {
    return Promise.resolve(this.service.preferencesPauseMine(principal, key, pluginId));
  }
  preferencesDeleteMine(principal: KnowledgePrincipal, key: string, pluginId?: string) {
    return Promise.resolve(this.service.preferencesDeleteMine(principal, key, pluginId));
  }
  personalDraftCreate(principal: KnowledgePrincipal, input: { pluginId?: string; title: string; body: string }) {
    return Promise.resolve(this.service.personalDraftCreate(principal, input));
  }
  personalDraftListMine(principal: KnowledgePrincipal) {
    return Promise.resolve(this.service.personalDraftsListMine(principal));
  }
  personalDraftUpdateMine(
    principal: KnowledgePrincipal,
    draftId: string,
    expectedRevision: number,
    patch: { title?: string; body?: string },
  ) {
    return Promise.resolve(this.service.personalDraftUpdateMine(principal, draftId, expectedRevision, patch));
  }
  personalDraftDeleteMine(principal: KnowledgePrincipal, draftId: string) {
    return Promise.resolve(this.service.personalDraftDeleteMine(principal, draftId));
  }
  learningCaseOpen(
    context: KnowledgeContext,
    input: { sourceEvent: LearningCaseSourceEvent; hypothesisKey: string; category?: string },
  ) {
    return Promise.resolve(this.service.learningCaseOpen(context, input));
  }
  learningCases(context: KnowledgeContext, options?: { status?: LearningCaseStatus; limit?: number }) {
    return Promise.resolve(this.service.learningCases(context, options));
  }
  learningCaseDispose(
    context: KnowledgeContext,
    caseId: string,
    disposition: 'NO_REUSABLE' | 'PENDING' | 'CONFLICT',
    reason?: string,
  ) {
    return Promise.resolve(this.service.learningCaseDispose(context, caseId, disposition, reason));
  }
  proposeFromCase(
    context: KnowledgeContext,
    principal: KnowledgePrincipal,
    input: { caseId: string; contributionConfirmed: boolean; idempotencyKey: string; draft: Record<string, unknown> },
  ) {
    return Promise.resolve(
      this.service.proposeFromCase(context, principal, input as Parameters<KnowledgeService['proposeFromCase']>[2]),
    );
  }
  releasesList(
    principal: KnowledgePrincipal,
    input: { pluginId: string; state?: KnowledgeReleaseRecord['state']; limit?: number },
  ) {
    return Promise.resolve(this.service.releasesList(principal, input));
  }
  publishRelease(
    principal: KnowledgePrincipal,
    input: {
      pluginId: string;
      audience: string;
      entries: Array<{ knowledgeId: string; revision: number }>;
      evalReportRef?: string;
      expectedVersion: number;
    },
  ) {
    return Promise.resolve(this.service.publishRelease(principal, input));
  }
  withdrawRelease(principal: KnowledgePrincipal, releaseId: string, reason: string) {
    return Promise.resolve(this.service.withdrawRelease(principal, releaseId, reason));
  }
  rollbackRelease(
    principal: KnowledgePrincipal,
    input: { pluginId: string; expectedVersion: number; toReleaseId?: string; reason: string },
  ) {
    return Promise.resolve(this.service.rollbackRelease(principal, input));
  }
  releasePointerInfo(principal: KnowledgePrincipal, pluginId: string) {
    return Promise.resolve(this.service.releasePointerInfo(principal, pluginId));
  }
}

interface KnowledgeCallInit {
  principal?: KnowledgePrincipal;
  body?: unknown;
}

/** HTTP 适配：知识服务与控制面分进程部署时使用（同一区域一个权威服务实例，§3）。
 *  主体放转发头不放请求体；服务端（headerIdentityAuthenticator）从连接派生主体与租户。 */
export class HttpKnowledgeAccess implements KnowledgeAccess {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}
  private headers(principal?: KnowledgePrincipal): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`;
    if (principal) {
      headers['x-dsh-subject'] = principal.actorId;
      if (principal.orgId !== undefined) headers['x-dsh-org'] = principal.orgId;
      if (principal.region !== undefined) headers['x-dsh-region'] = principal.region;
    }
    return headers;
  }
  private async call<T>(path: string, init: KnowledgeCallInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: this.headers(init.principal),
      body: JSON.stringify(init.body ?? {}),
    });
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? `KNOWLEDGE_HTTP_STATUS_${response.status}`);
    return payload.result as T;
  }
  preferencesGetMine(principal: KnowledgePrincipal, options?: { pluginId?: string }) {
    return this.call<PersonalSettingRecord[]>('/preferences/get', { principal, body: options ?? {} });
  }
  preferencesSetMine(
    principal: KnowledgePrincipal,
    input: { key: string; value: unknown; pluginId?: string; expectedRevision: number },
  ) {
    return this.call<PersonalSettingRecord>('/preferences/set', { principal, body: input });
  }
  preferencesPauseMine(principal: KnowledgePrincipal, key: string, pluginId?: string) {
    return this.call<PersonalSettingRecord>('/preferences/pause', {
      principal,
      body: { key, ...(pluginId !== undefined ? { pluginId } : {}) },
    });
  }
  preferencesDeleteMine(principal: KnowledgePrincipal, key: string, pluginId?: string) {
    return this.call<PersonalSettingRecord>('/preferences/delete', {
      principal,
      body: { key, ...(pluginId !== undefined ? { pluginId } : {}) },
    });
  }
  personalDraftCreate(principal: KnowledgePrincipal, input: { pluginId?: string; title: string; body: string }) {
    return this.call<PersonalDraftRecord>('/drafts/create', { principal, body: input });
  }
  personalDraftListMine(principal: KnowledgePrincipal) {
    return this.call<PersonalDraftRecord[]>('/drafts/list', { principal });
  }
  personalDraftUpdateMine(
    principal: KnowledgePrincipal,
    draftId: string,
    expectedRevision: number,
    patch: { title?: string; body?: string },
  ) {
    return this.call<PersonalDraftRecord>('/drafts/update', { principal, body: { draftId, expectedRevision, ...patch } });
  }
  personalDraftDeleteMine(principal: KnowledgePrincipal, draftId: string) {
    return this.call<PersonalDraftRecord>('/drafts/delete', { principal, body: { draftId } });
  }
  learningCaseOpen(
    context: KnowledgeContext,
    input: { sourceEvent: LearningCaseSourceEvent; hypothesisKey: string; category?: string },
  ) {
    return this.call<{ case: LearningCaseRecord; duplicate: boolean }>('/learning/cases/open', {
      body: { context, ...input },
    });
  }
  learningCases(context: KnowledgeContext, options?: { status?: LearningCaseStatus; limit?: number }) {
    return this.call<LearningCaseRecord[]>('/learning/cases/list', { body: { context, ...options } });
  }
  learningCaseDispose(
    context: KnowledgeContext,
    caseId: string,
    disposition: 'NO_REUSABLE' | 'PENDING' | 'CONFLICT',
    reason?: string,
  ) {
    return this.call<LearningCaseRecord>('/learning/cases/dispose', {
      body: { context, caseId, disposition, ...(reason !== undefined ? { reason } : {}) },
    });
  }
  proposeFromCase(
    context: KnowledgeContext,
    principal: KnowledgePrincipal,
    input: { caseId: string; contributionConfirmed: boolean; idempotencyKey: string; draft: Record<string, unknown> },
  ) {
    return this.call<{ knowledgeId: string; revision: number; contentDigest: string; duplicate: boolean; caseId: string }>(
      '/learning/cases/propose',
      { principal, body: { context, ...input } },
    );
  }
  releasesList(
    principal: KnowledgePrincipal,
    input: { pluginId: string; state?: KnowledgeReleaseRecord['state']; limit?: number },
  ) {
    return this.call<KnowledgeReleaseRecord[]>('/releases/list', { principal, body: input });
  }
  publishRelease(
    principal: KnowledgePrincipal,
    input: {
      pluginId: string;
      audience: string;
      entries: Array<{ knowledgeId: string; revision: number }>;
      evalReportRef?: string;
      expectedVersion: number;
    },
  ) {
    return this.call<{ release: KnowledgeReleaseRecord; pointer: KnowledgeReleasePointer }>('/releases/publish', {
      principal,
      body: input,
    });
  }
  withdrawRelease(principal: KnowledgePrincipal, releaseId: string, reason: string) {
    return this.call<{
      releaseId: string;
      entries: KnowledgeReleaseRecord['entries'];
      affectedReleases: string[];
    }>('/releases/withdraw', { principal, body: { releaseId, reason } });
  }
  rollbackRelease(
    principal: KnowledgePrincipal,
    input: { pluginId: string; expectedVersion: number; toReleaseId?: string; reason: string },
  ) {
    return this.call<{ pointer: KnowledgeReleasePointer; release: KnowledgeReleaseRecord }>('/releases/rollback', {
      principal,
      body: input,
    });
  }
  releasePointerInfo(principal: KnowledgePrincipal, pluginId: string) {
    return this.call<KnowledgeReleasePointer | undefined>('/releases/pointer', { principal, body: { pluginId } });
  }
}
