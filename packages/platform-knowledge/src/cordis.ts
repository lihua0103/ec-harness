/** Platform adapter: installed once as its own Cordis bundle, independent of any business plugin. */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolve } from 'node:path';
import { KnowledgeService } from './service.js';
import type { KnowledgeContext, KnowledgeDraft } from './schema.js';

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
}
const validateConfig = (config: Config): string => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('KNOWLEDGE_CONFIG_INVALID');
  for (const key of Object.keys(config)) if (key !== 'storePath') throw new Error(`KNOWLEDGE_CONFIG_INVALID:${key}`);
  if (config.storePath !== undefined && (typeof config.storePath !== 'string' || !config.storePath.trim())) {
    throw new Error('KNOWLEDGE_CONFIG_INVALID:storePath');
  }
  const home = resolve(process.env.DSH_HOME ?? '.runtime/dsh-home');
  return config.storePath ? resolve(home, config.storePath) : resolve(home, 'platform', 'knowledge.sqlite');
};

export function apply(ctx: Context, config: Config = {}): void {
  // A profile may still carry a legacy business-plugin copy of this adapter. Never create a second
  // writable service: the first installed provider owns the store for the whole profile.
  if (ctx.get('clinicalKnowledge')) return;
  const service = new KnowledgeService(validateConfig(config));
  ctx.provide('clinicalKnowledge', service);
  ctx.effect(() => () => service.close());
  const string = { type: 'string' as const };
  const scope = { pluginId: { ...string, required: true as const }, projectId: string, scenario: string, edc: string };
  const output = {
    schema: { type: 'string' as const },
    render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
  };
  const context = (args: Record<string, unknown>): KnowledgeContext =>
    Object.fromEntries(
      ['pluginId', 'projectId', 'scenario', 'edc']
        .filter((key) => typeof args[key] === 'string' && args[key] !== '')
        .map((key) => [key, args[key]]),
    ) as unknown as KnowledgeContext;
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
        '按插件/当前项目/场景检索经验。默认ACTIVE；includeCandidates显式查看未验证候选。无执行或数据读取门禁。',
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
          service.search(context(args), {
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
      name: 'platform_knowledge_get',
      description: '读取明确知识修订，返回实际状态/前提/反例/可验证claims。',
      parameters: { ...scope, knowledgeId: { ...string, required: true }, revision: { type: 'number' } },
      output,
      execute: async (args) => run(() => service.get(context(args), args.knowledgeId, args.revision)),
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
          return service.capture(
            context(args),
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
        run(() => service.validate(context(args), args.knowledgeId, args.revision, args.validatorId)),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_knowledge_status',
      description: '当前插件/项目知识状态与检索实现，不代表业务已验证。',
      parameters: scope,
      output,
      execute: async (args) =>
        run(() => ({
          active: service.search(context(args)).total,
          candidates: service.search(context(args), { states: ['CANDIDATE'] }).total,
          searchMode: 'SCOPED_UNICODE_SUBSTRING',
          learning: 'activation requires declared claims fully covered by an installed validator',
        })),
    }),
  );
}
