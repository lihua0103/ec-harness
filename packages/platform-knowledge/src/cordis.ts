/** Platform adapter: installed once as its own Cordis bundle, independent of any business plugin.
 *  M1-01：工具参数只能收窄查询；插件身份/租户/区域/允许项目来自部署装配方声明的可信范围，
 *  未声明范围的插件调用一律失败关闭（KNOWLEDGE_SCOPE_UNAVAILABLE），不回落到模型自报身份。 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolve } from 'node:path';
import { KnowledgeService } from './service.js';
import { KnowledgeScopeBoundary, validateScopeDeclaration, type KnowledgeScopeDeclaration } from './scope.js';
import type { KnowledgeSnapshot } from './snapshot-readonly.js';
import type { KnowledgeDraft } from './schema.js';
import type { ProjectionOutcome } from './store.js';
import { createKnowledgeServiceServer, headerIdentityAuthenticator } from './http.js';
import type { Server } from 'node:http';

export const name = 'ec-platform-knowledge';
export const inject = ['tools'];
declare module '@deepseek-ai/cordis' {
  interface Context {
    clinicalKnowledge: KnowledgeService;
  }
}
export interface Config {
  /** Absolute, or relative to `DSH_HOME`. Defaults to `platform/knowledge.sqlite`. */
  storePath?: string;
  /** 可信授权范围（按插件）。未列出的插件不可通过工具访问知识服务。 */
  scopes?: KnowledgeScopeDeclaration[];
  /** 语料入口默认前缀；每个 scope 可覆盖。未声明则语料检索整体拒绝。 */
  corpusDocPrefixes?: string[];
  /** L1 权威服务 HTTP 面（可选）：让控制面/工作台经认证访问同一服务实例（§3）。
   *  token 校验通道；主体来自上游认证方转发的 x-dsh-subject 头（合同见 ADR-0004）。 */
  http?: { port: number; token?: string; host?: string };
}
const validateConfig = (
  config: Config,
): { storePath: string; scopes: KnowledgeScopeDeclaration[]; http?: { port: number; token?: string; host?: string } } => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('KNOWLEDGE_CONFIG_INVALID');
  for (const key of Object.keys(config))
    if (key !== 'storePath' && key !== 'scopes' && key !== 'corpusDocPrefixes' && key !== 'http')
      throw new Error(`KNOWLEDGE_CONFIG_INVALID:${key}`);
  if (config.storePath !== undefined && (typeof config.storePath !== 'string' || !config.storePath.trim())) {
    throw new Error('KNOWLEDGE_CONFIG_INVALID:storePath');
  }
  if (config.http !== undefined) {
    const http = config.http as Record<string, unknown>;
    if (!http || typeof http !== 'object' || Array.isArray(http)) throw new Error('KNOWLEDGE_CONFIG_INVALID:http');
    for (const key of Object.keys(http))
      if (key !== 'port' && key !== 'token' && key !== 'host') throw new Error(`KNOWLEDGE_CONFIG_INVALID:http.${key}`);
    if (!Number.isSafeInteger(http.port) || Number(http.port) < 1 || Number(http.port) > 65535)
      throw new Error('KNOWLEDGE_CONFIG_INVALID:http.port');
    if (http.token !== undefined && (typeof http.token !== 'string' || !http.token))
      throw new Error('KNOWLEDGE_CONFIG_INVALID:http.token');
    if (http.host !== undefined && (typeof http.host !== 'string' || !http.host))
      throw new Error('KNOWLEDGE_CONFIG_INVALID:http.host');
  }
  const scopes = config.scopes ?? [];
  if (!Array.isArray(scopes)) throw new Error('KNOWLEDGE_CONFIG_INVALID:scopes');
  const prefixDefaults = config.corpusDocPrefixes;
  if (prefixDefaults !== undefined && (!Array.isArray(prefixDefaults) || prefixDefaults.some((p) => typeof p !== 'string')))
    throw new Error('KNOWLEDGE_CONFIG_INVALID:corpusDocPrefixes');
  const byPlugin = new Map<string, KnowledgeScopeDeclaration>();
  for (const scope of scopes) {
    validateScopeDeclaration(scope);
    if (byPlugin.has(scope.pluginId)) throw new Error('KNOWLEDGE_CONFIG_INVALID:duplicate-scope');
    byPlugin.set(scope.pluginId, {
      ...scope,
      ...(scope.corpusDocPrefixes === undefined && prefixDefaults?.length ? { corpusDocPrefixes: prefixDefaults } : {}),
    });
  }
  const home = resolve(process.env.DSH_HOME ?? '.runtime/dsh-home');
  return {
    storePath: config.storePath ? resolve(home, config.storePath) : resolve(home, 'platform', 'knowledge.sqlite'),
    scopes: [...byPlugin.values()],
    ...(config.http !== undefined ? { http: config.http } : {}),
  };
};

export function apply(ctx: Context, config: Config = {}): void {
  // A profile may still carry a legacy business-plugin copy of this adapter. Never create a second
  // writable service: the first installed provider owns the store for the whole profile.
  if (ctx.get('clinicalKnowledge')) return;
  const validated = validateConfig(config);
  const service = new KnowledgeService(validated.storePath);
  ctx.provide('clinicalKnowledge', service);
  ctx.effect(() => () => service.close());
  // L1 权威服务 HTTP 面（可选）：控制面/工作台经认证访问同一服务实例（§3）。
  // token 校验通道；主体来自上游认证方转发的 x-dsh-subject 头（合同见 ADR-0004）。
  if (validated.http) {
    const server = createKnowledgeServiceServer({
      service,
      authenticator: headerIdentityAuthenticator({ token: validated.http.token }),
    });
    server.listen(validated.http.port, validated.http.host ?? '127.0.0.1');
    ctx.effect(() => () => server.close());
  }
  const boundaries = new Map<string, KnowledgeScopeBoundary>(
    validated.scopes.map((scope) => [scope.pluginId, new KnowledgeScopeBoundary(service, scope)]),
  );
  const boundaryFor = (pluginId: unknown): KnowledgeScopeBoundary => {
    if (typeof pluginId !== 'string' || !boundaries.has(pluginId)) throw new Error('KNOWLEDGE_SCOPE_UNAVAILABLE');
    return boundaries.get(pluginId)!;
  };
  const reachable = (): KnowledgeScopeBoundary | undefined => boundaries.values().next().value;
  const string = { type: 'string' as const };
  // 参数只保留收窄面：插件身份是范围选择器；org/region 不再暴露给模型。
  const scope = {
    pluginId: { ...string, required: true as const },
    projectId: string,
    scenario: string,
    edc: string,
    locale: string,
  };
  const output = {
    schema: { type: 'string' as const },
    render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
  };
  const request = (args: Record<string, unknown>) =>
    ({
      pluginId: args.pluginId,
      ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}),
      ...(typeof args.scenario === 'string' ? { scenario: args.scenario } : {}),
      ...(typeof args.edc === 'string' ? { edc: args.edc } : {}),
      ...(typeof args.locale === 'string' ? { locale: args.locale } : {}),
    }) as { pluginId: string; projectId?: string; scenario?: string; edc?: string; locale?: string };
  const run = async (action: () => unknown | Promise<unknown>) => {
    try {
      return JSON.stringify(await action());
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_search',
      description:
        '按插件/当前项目/场景检索经验。默认ACTIVE；includeCandidates显式查看未验证候选。范围由平台部署声明，参数只能收窄；无执行或数据读取门禁。',
      parameters: {
        ...scope,
        query: string,
        topic: string,
        includeCandidates: { type: 'boolean' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      output,
      execute: async (args) =>
        run(() =>
          boundaryFor(args.pluginId).search(request(args), {
            query: args.query,
            topics: args.topic ? [args.topic] : undefined,
            states: args.includeCandidates ? ['ACTIVE', 'CANDIDATE', 'CONFLICT'] : undefined,
            offset: args.offset,
            limit: args.limit,
          }),
        ),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_search_pinned',
      description:
        '在 Run 创建时绑定的知识快照内检索（snapshotJson=snapshot 对象）。返回 evidence：固定集合、实际返回、被排除（撤回/撤权/不可用）。不读取活库、不换新版。',
      parameters: {
        ...scope,
        snapshotJson: { ...string, required: true },
        query: string,
        topic: string,
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      output,
      execute: async (args) =>
        run(() => {
          const snapshot = JSON.parse(args.snapshotJson) as KnowledgeSnapshot;
          return boundaryFor(args.pluginId).searchPinned(request(args), snapshot, {
            query: args.query,
            topics: args.topic ? [args.topic] : undefined,
            offset: args.offset,
            limit: args.limit,
          });
        }),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_search_run',
      description:
        '在指定 Run 服务端绑定的知识快照内检索（runId）。快照由服务端按 Run 还原，不信任客户端自带快照；参数只能收窄查询。返回 evidence：实际返回与被排除（撤回/撤权/不可用/已发布撤回）逐条可对账。',
      parameters: {
        ...scope,
        runId: { ...string, required: true },
        query: string,
        topic: string,
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      output,
      execute: async (args) =>
        run(() =>
          boundaryFor(args.pluginId).searchPinnedForRun(request(args), args.runId, {
            query: args.query,
            topics: args.topic ? [args.topic] : undefined,
            offset: args.offset,
            limit: args.limit,
          }),
        ),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_cite',
      description:
        '记录答案最终引用了快照中的哪些修订（refsJson=[{knowledgeId,revision}]）。引用必须来自同一快照；未引用不冒称采纳。',
      parameters: {
        ...scope,
        runId: { ...string, required: true },
        snapshotJson: { ...string, required: true },
        refsJson: { ...string, required: true },
      },
      output,
      execute: async (args) =>
        run(() => {
          const snapshot = JSON.parse(args.snapshotJson) as KnowledgeSnapshot;
          const refs = JSON.parse(args.refsJson) as Array<{ knowledgeId: string; revision: number; contentDigest?: string }>;
          if (!Array.isArray(refs)) throw new Error('KNOWLEDGE_CITATION_INVALID');
          return boundaryFor(args.pluginId).cite(request(args), args.runId, snapshot, refs);
        }),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_get',
      description: '读取明确知识修订，返回实际状态/前提/反例/可验证claims。',
      parameters: { ...scope, knowledgeId: { ...string, required: true }, revision: { type: 'number' } },
      output,
      execute: async (args) => run(() => boundaryFor(args.pluginId).get(request(args), args.knowledgeId, args.revision)),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_capture',
      description:
        '保存项目纠错或通用方法候选，不接受testPassed或直接ACTIVE。draftJson可含claims（可由已安装验证器复现的具体断言）；没有claims的候选不会被激活。业务裁定使用project scope。',
      parameters: { ...scope, draftJson: { ...string, required: true }, expectedRevision: { type: 'number' } },
      output,
      execute: async (args) =>
        run(() => {
          if (args.draftJson.length > 200000) throw new Error('KNOWLEDGE_DRAFT_TOO_LARGE');
          return boundaryFor(args.pluginId).capture(
            request(args),
            JSON.parse(args.draftJson) as KnowledgeDraft,
            args.expectedRevision ?? 0,
          );
        }),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_validate',
      description:
        '执行已安装验证器的正/反/边界案例并绑定候选digest；仅当候选声明的全部claims都被套件覆盖且通过时激活，否则保持CANDIDATE并记录scope。不能提交模型自报通过。',
      parameters: {
        ...scope,
        knowledgeId: { ...string, required: true },
        revision: { type: 'number', required: true },
        validatorId: { ...string, required: true },
      },
      output,
      execute: async (args) =>
        run(() => boundaryFor(args.pluginId).validate(request(args), args.knowledgeId, args.revision, args.validatorId)),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_check_snapshot',
      description:
        '检查知识快照引用的方法是否已被撤回/冲突/新修订替代（KA14）。传入 snapshot.records=[{knowledgeId,revision}]；不修改快照与历史。',
      parameters: { ...scope, snapshotJson: { ...string, required: true, description: 'KnowledgeService.snapshot() 结果 JSON' } },
      output,
      execute: async (args) =>
        run(() => {
          const parsed = JSON.parse(args.snapshotJson) as { records?: Array<{ knowledgeId: string; revision: number }> };
          if (!parsed || !Array.isArray(parsed.records)) throw new Error('KNOWLEDGE_SNAPSHOT_INVALID');
          return boundaryFor(args.pluginId).checkSnapshotImpact(request(args), { records: parsed.records });
        }),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_docs_search',
      description:
        '检索平台文档语料（受声明前缀约束的分片）。返回带 doc_path#行号 的可点击引用与摘录；引用不替代原文，重要结论应打开原文件核对。',
      parameters: {
        query: { ...string, required: true, description: '检索词（≥3 个字符走全文索引；短词走降级扫描）' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      output,
      execute: async (args) =>
        run(() => {
          const boundary = reachable();
          if (!boundary) throw new Error('KNOWLEDGE_SCOPE_UNAVAILABLE');
          return boundary.searchCorpus({ query: args.query, offset: args.offset, limit: args.limit });
        }),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_agent',
      description:
        '已注册插件知识智能体定义清单（身份/版本/负责人/激活状态）。多版本并存时按发布版本解析；Run 不默认换用新版。',
      parameters: { pluginId: string },
      output,
      execute: async (args) =>
        run(() => {
          const agents = service.agents.list();
          return { agents: args.pluginId ? agents.filter((agent) => agent.pluginId === args.pluginId) : agents };
        }),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_projections',
      description:
        '本插件的可信事件投影台账（M2-02）：run 失败/未知或复核决定会留下 PENDING_ANALYSIS，供智能体提炼候选。只读；同 (eventId,contributor,version) 只记一次；提出候选仍走 capture 与验证器，不接受自报通过。',
      parameters: {
        ...scope,
        outcome: { type: 'string', enum: ['PENDING_ANALYSIS', 'CANDIDATE', 'NO_REUSABLE_CONCLUSION', 'CONFLICT', 'RETRY_REQUIRED'] },
        limit: { type: 'number' },
      },
      output,
      execute: async (args) =>
        run(() => {
          const boundary = boundaryFor(args.pluginId);
          const projections = service.listProjections(request(args), {
            ...(args.outcome ? { outcome: args.outcome as ProjectionOutcome } : {}),
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          });
          // 边界只负责建立/校验范围；投影本身按 pluginId 过滤，不回传其他插件的事故。
          void boundary;
          return { projections };
        }),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_status',
      description: '当前插件/项目知识状态与检索实现，不代表业务已验证。',
      parameters: scope,
      output,
      execute: async (args) =>
        run(() => {
          const boundary = boundaryFor(args.pluginId);
          return {
            active: boundary.search(request(args)).total,
            candidates: boundary.search(request(args), { states: ['CANDIDATE'] }).total,
            searchMode: service.searchMode,
            learning: 'activation requires declared claims fully covered by an installed validator',
          };
        }),
    }),
  );
}