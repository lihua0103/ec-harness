/** L1 权威服务 HTTP 面（§1/§3：不同客户端经认证访问同一权威服务）。
 *  行为合同（§5）：请求主体、租户和区域来自验证过的身份连接（authenticator），不来自请求体；
 *  普通授权读取不加人工审批；越权与不存在对无权限方不可区分（404 掩蔽）；
 *  错误日志只记代码与路径，不记录查询词或正文。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { KnowledgeService } from './service.js';
import type { KnowledgePrincipal } from './identity-scope.js';
import type { LearningCaseSourceEvent, LearningCaseStatus, KnowledgeReleaseRecord } from './learning.js';
import type { KnowledgeContext } from './schema.js';
import { readSnapshot } from './snapshot-readonly.js';

export type KnowledgeAuthenticator = (request: IncomingMessage) => KnowledgePrincipal | Promise<KnowledgePrincipal>;

/** 默认身份适配：部署通道验证连接后转发主体断言（x-dsh-subject/org/region）。
 *  token 校验通道本身；主体断言的强度由控制面（上游认证方）负责——合同见 ADR-0004。 */
export function headerIdentityAuthenticator(options: { token?: string } = {}): KnowledgeAuthenticator {
  const expected = options.token === undefined ? undefined : `Bearer ${options.token}`;
  const headerValue = (request: IncomingMessage, name: string): string | undefined => {
    const value = request.headers[name];
    return typeof value === 'string' && value ? value : undefined;
  };
  return (request) => {
    if (expected !== undefined && request.headers.authorization !== expected) {
      throw new Error('KNOWLEDGE_AUTH_REQUIRED');
    }
    const subject = headerValue(request, 'x-dsh-subject');
    if (!subject || subject.length > 160) throw new Error('KNOWLEDGE_AUTH_SUBJECT_REQUIRED');
    const orgId = headerValue(request, 'x-dsh-org');
    const region = headerValue(request, 'x-dsh-region');
    return {
      actorId: subject,
      ...(orgId !== undefined ? { orgId } : {}),
      ...(region !== undefined ? { region } : {}),
    };
  };
}

const NOT_FOUND_CODES = new Set([
  'KNOWLEDGE_NOT_FOUND',
  'PREFERENCE_NOT_FOUND',
  'PERSONAL_DRAFT_NOT_FOUND',
  'LEARNING_CASE_NOT_FOUND',
  'RELEASE_NOT_FOUND',
  'RELEASE_POINTER_MISSING',
  'RELEASE_ROLLBACK_TARGET_MISSING',
]);
const CONFLICT_CODES = new Set([
  'PREFERENCE_REVISION_STALE',
  'PERSONAL_DRAFT_REVISION_STALE',
  'LEARNING_PROPOSAL_CONFLICT',
  'LEARNING_CASE_ALREADY_PROPOSED',
  'RELEASE_ALREADY_WITHDRAWN',
  'RELEASE_WITHDRAW_CONFLICT',
  'RELEASE_ROLLBACK_TARGET_WITHDRAWN',
  'RELEASE_VERSION_STALE',
  'KNOWLEDGE_SNAPSHOT_CONTEXT_MISMATCH',
]);
export function knowledgeErrorStatus(code: string): number {
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (CONFLICT_CODES.has(code)) return 409;
  if (code === 'KNOWLEDGE_AUTH_REQUIRED' || code === 'KNOWLEDGE_AUTH_SUBJECT_REQUIRED') return 401;
  return 400;
}

interface RouteCall {
  (service: KnowledgeService, principal: KnowledgePrincipal, body: Record<string, unknown>): unknown | Promise<unknown>;
}

/** 服务端从连接身份派生学习上下文的租户（orgId/region），拒绝请求体越权携带。 */
function contextFrom(principal: KnowledgePrincipal, body: Record<string, unknown>): KnowledgeContext {
  const raw = (body.context ?? {}) as Record<string, unknown>;
  const context: KnowledgeContext = {
    pluginId: String(raw.pluginId ?? ''),
    ...(typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {}),
    ...(typeof raw.scenario === 'string' ? { scenario: raw.scenario } : {}),
    ...(typeof raw.edc === 'string' ? { edc: raw.edc } : {}),
    ...(typeof raw.locale === 'string' ? { locale: raw.locale } : {}),
    ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}),
    ...(principal.region !== undefined ? { region: principal.region } : {}),
  };
  if (raw.orgId !== undefined && raw.orgId !== principal.orgId) throw new Error('KNOWLEDGE_SCOPE_ESCALATION');
  if (raw.region !== undefined && raw.region !== principal.region) throw new Error('KNOWLEDGE_SCOPE_ESCALATION');
  return context;
}

/** 全部路由：1:1 对应 KnowledgeAccess 合同（access.ts）。 */
const ROUTES: Record<string, RouteCall> = {
  '/preferences/get': (service, principal, body) =>
    service.preferencesGetMine(principal, typeof body.pluginId === 'string' ? { pluginId: body.pluginId } : {}),
  '/preferences/set': (service, principal, body) =>
    service.preferencesSetMine(principal, {
      key: String(body.key ?? ''),
      value: body.value,
      ...(typeof body.pluginId === 'string' ? { pluginId: body.pluginId } : {}),
      expectedRevision: Number(body.expectedRevision ?? 0),
    }),
  '/preferences/pause': (service, principal, body) =>
    service.preferencesPauseMine(principal, String(body.key ?? ''), typeof body.pluginId === 'string' ? body.pluginId : undefined),
  '/preferences/delete': (service, principal, body) =>
    service.preferencesDeleteMine(principal, String(body.key ?? ''), typeof body.pluginId === 'string' ? body.pluginId : undefined),
  '/preferences/for-run': (service, principal, body) => service.preferencesForRunBinding(principal, String(body.pluginId ?? '')),
  '/drafts/create': (service, principal, body) =>
    service.personalDraftCreate(principal, {
      ...(typeof body.pluginId === 'string' ? { pluginId: body.pluginId } : {}),
      title: String(body.title ?? ''),
      body: String(body.body ?? ''),
    }),
  '/drafts/list': (service, principal) => service.personalDraftsListMine(principal),
  '/drafts/update': (service, principal, body) =>
    service.personalDraftUpdateMine(principal, String(body.draftId ?? ''), Number(body.expectedRevision ?? 0), {
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.body === 'string' ? { body: body.body } : {}),
    }),
  '/drafts/delete': (service, principal, body) => service.personalDraftDeleteMine(principal, String(body.draftId ?? '')),
  '/learning/cases/open': (service, principal, body) =>
    service.learningCaseOpen(contextFrom(principal, body), {
      sourceEvent: body.sourceEvent as LearningCaseSourceEvent,
      hypothesisKey: String(body.hypothesisKey ?? ''),
      ...(typeof body.category === 'string' ? { category: body.category } : {}),
    }),
  '/learning/cases/list': (service, principal, body) =>
    service.learningCases(contextFrom(principal, body), {
      ...(typeof body.status === 'string' ? { status: body.status as LearningCaseStatus } : {}),
      ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
    }),
  '/learning/cases/dispose': (service, principal, body) =>
    service.learningCaseDispose(
      contextFrom(principal, body),
      String(body.caseId ?? ''),
      body.disposition as 'NO_REUSABLE' | 'PENDING' | 'CONFLICT',
      typeof body.reason === 'string' ? body.reason : undefined,
    ),
  '/learning/cases/propose': (service, principal, body) =>
    service.proposeFromCase(contextFrom(principal, body), principal, {
      caseId: String(body.caseId ?? ''),
      contributionConfirmed: body.contributionConfirmed === true,
      idempotencyKey: String(body.idempotencyKey ?? ''),
      draft: (body.draft ?? {}) as Parameters<KnowledgeService['proposeFromCase']>[2]['draft'],
    }),
  '/releases/list': (service, principal, body) =>
    service.releasesList(principal, {
      pluginId: String(body.pluginId ?? ''),
      ...(typeof body.state === 'string' ? { state: body.state as KnowledgeReleaseRecord['state'] } : {}),
      ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
    }),
  '/releases/publish': (service, principal, body) =>
    service.publishRelease(principal, {
      pluginId: String(body.pluginId ?? ''),
      audience: String(body.audience ?? ''),
      entries: (body.entries ?? []) as Array<{ knowledgeId: string; revision: number }>,
      ...(typeof body.evalReportRef === 'string' ? { evalReportRef: body.evalReportRef } : {}),
      expectedVersion: Number(body.expectedVersion ?? 0),
    }),
  '/releases/withdraw': (service, principal, body) =>
    service.withdrawRelease(principal, String(body.releaseId ?? ''), String(body.reason ?? '')),
  '/releases/rollback': (service, principal, body) =>
    service.rollbackRelease(principal, {
      pluginId: String(body.pluginId ?? ''),
      expectedVersion: Number(body.expectedVersion ?? 0),
      ...(typeof body.toReleaseId === 'string' ? { toReleaseId: body.toReleaseId } : {}),
      reason: String(body.reason ?? ''),
    }),
  '/releases/pointer': (service, principal, body) => service.releasePointerInfo(principal, String(body.pluginId ?? '')),
  '/snapshot/resolve': (service, principal, body) => {
    const raw = body as Record<string, unknown>;
    const context: KnowledgeContext = {
      pluginId: String(raw.pluginId ?? ''),
      ...(typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {}),
      ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}),
      ...(principal.region !== undefined ? { region: principal.region } : {}),
    };
    if (raw.orgId !== undefined && raw.orgId !== principal.orgId) throw new Error('KNOWLEDGE_SCOPE_ESCALATION');
    if (raw.region !== undefined && raw.region !== principal.region) throw new Error('KNOWLEDGE_SCOPE_ESCALATION');
    return readSnapshot(service.storePath, context);
  },
};

export interface KnowledgeServiceServerOptions {
  service: KnowledgeService;
  authenticator: KnowledgeAuthenticator;
  /** 请求体上限（字节）。默认 1MB。 */
  maxBodyBytes?: number;
}

export function createKnowledgeServiceServer(options: KnowledgeServiceServerOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const server = createServer((request, response) => {
    void handleRequest(options, request, response);
  });
  return server;
}

async function handleRequest(
  options: KnowledgeServiceServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const respond = (status: number, payload: unknown): void => {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
  };
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'GET' && path === '/health') {
      respond(200, { ok: true });
      return;
    }
    if (request.method !== 'POST') {
      respond(405, { ok: false, error: 'KNOWLEDGE_HTTP_METHOD_NOT_ALLOWED' });
      return;
    }
    const route = ROUTES[path];
    if (!route) {
      respond(404, { ok: false, error: 'KNOWLEDGE_HTTP_ROUTE_NOT_FOUND' });
      return;
    }
    let principal: KnowledgePrincipal;
    try {
      principal = await options.authenticator(request);
    } catch {
      respond(401, { ok: false, error: 'KNOWLEDGE_AUTH_REQUIRED' });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    for await (const chunk of request) {
      bytes += (chunk as Buffer).length;
      if (bytes > maxBodyBytes) {
        aborted = true;
        break;
      }
      chunks.push(chunk as Buffer);
    }
    if (aborted) {
      respond(413, { ok: false, error: 'KNOWLEDGE_HTTP_BODY_TOO_LARGE' });
      return;
    }
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    const result = await route(options.service, principal, body);
    respond(200, { ok: true, result });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'KNOWLEDGE_HTTP_INTERNAL';
    const base = code.split(':')[0] ?? code;
    // 错误日志不含正文/查询词（§5）：只记代码与路径。
    respond(knowledgeErrorStatus(base), { ok: false, error: base });
  }
}
