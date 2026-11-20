/** DSH Cordis bundle for the platform control plane. It exposes registry/run tools only; model JSON
 *  cannot dispatch a worker or self-report completion. */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import { PlatformControlService, type ControlStatus } from './service.js';
import { PlatformError } from './registry.js';
import { AuthorizationError, LocalOperatorPolicy, type Principal } from './policy.js';
import { RunError } from '../../platform-runtime/src/run.js';
import { resolve } from 'node:path';
import { resolveKnowledgeStorePath, resolveControlHome, resolveStorePath, validateConfig, type Config } from './config.js';
import { readSnapshot } from '../../platform-knowledge/src/snapshot-readonly.js';
import { publicCatalog } from './models.js';
import { DshProfileExecutor } from './worker.js';
import { ChildProcessWorkerExecutor } from './child-worker.js';
import { RunScheduler } from './scheduler.js';
import type { AppState, AppReleaseDraft, WorkState } from './store.js';

export type { Config } from './config.js';

export const name = 'ec-platform-control';
export const inject = ['tools'];
declare module '@deepseek-ai/cordis' {
  interface Context {
    platformControl: PlatformControlService;
  }
}

const string = { type: 'string' as const };
const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
};
const parseJson = (value: string, max: number, code: string): unknown => {
  if (value.length > max) throw new PlatformError(code, `>${max}`);
  try {
    return JSON.parse(value);
  } catch {
    throw new PlatformError(code, 'JSON 无效');
  }
};
const operator = (exec?: ToolExecution): Principal => {
  const id = exec?.agent?.session?.header?.id;
  if (id === undefined || id === null) throw new PlatformError('LIVE_AGENT_REQUIRED');
  return { actorId: `session:${String(id)}`, kind: 'operator' };
};
/** Tool projections never re-expose raw run input; workers read it through the control service. */
const publicRun = <T extends { input?: unknown }>(record: T): Omit<T, 'input'> => {
  const { input: _input, ...rest } = record;
  return rest;
};

export function apply(ctx: Context, config: Config = {}): void {
  const validated = validateConfig(config);
  const service = new PlatformControlService(
    resolveStorePath(validated),
    null,
    validated.allowedApps ? new LocalOperatorPolicy({ allowedApps: validated.allowedApps }) : undefined,
    {
      requireArtifacts: validated.requireArtifacts,
      requireReleaseApproval: validated.requireReleaseApproval,
      requireModelHealth: validated.requireModelHealth,
      requireModelApproval: validated.requireModelApproval,
      ...(validated.quotas !== undefined ? { quotas: validated.quotas } : {}),
      ...(validated.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: validated.maxConcurrentRuns } : {}),
    },
  );
  if (validated.worker) {
    // Persist exit evidence in launch_attempts so it survives control-process restarts.
    const evidence = {
      record: (launchId: string, proven: boolean) => service.recordExitEvidence(launchId, proven),
      read: (launchId: string) => service.readExitEvidence(launchId),
    };
    service.setExecutor(
      validated.worker.mode === 'child-process'
        ? new ChildProcessWorkerExecutor(validated.worker, evidence)
        : new DshProfileExecutor(validated.worker, undefined, evidence),
    );
  }
  // KA11：Run 创建时绑定知识快照（默认路径 = DSH_HOME/platform/knowledge.sqlite，与知识 bundle 一致）。
  // 控制面只读知识库（摘要与服务端逐字节一致）；知识库唯一写者仍是 KnowledgeService。
  const knowledgeStorePath =
    resolveKnowledgeStorePath(validated) ?? resolve(resolveControlHome(), 'platform', 'knowledge.sqlite');
  if (knowledgeStorePath) {
    service.setKnowledgeSnapshotSource((app, projectId) => {
      const pluginId = app.draft.descriptor.knowledgePluginId;
      if (!pluginId) return undefined;
      const snapshot = readSnapshot(knowledgeStorePath, { pluginId, projectId });
      if (!snapshot) return undefined;
      return {
        snapshotDigest: snapshot.snapshotDigest,
        total: snapshot.total,
        pluginId,
        projectId,
        boundAt: new Date().toISOString(),
        // 实际修订集合（M1-02）：Run 可据此重放固定知识，而不只是一个完整性摘要。
        records: snapshot.records.map((record) => ({
          knowledgeId: record.knowledgeId,
          revision: record.revision,
          contentDigest: record.contentDigest,
        })),
      };
    });
  }
  // KA12/M2-02：把终端运行事实投影为“待分析”事件——不是候选，也不改写 Run 状态。
  // 知识智能体随后按同一 eventId 提出候选；重复投递由知识服务按 (eventId, contributor, version) 去重。
  service.setKnowledgeCaptureSink((event) => {
    if (event.kind !== 'run.failed' && event.kind !== 'run.unknown') return;
    if (!event.pluginId || !event.projectId) return;
    const knowledge = ctx.get('clinicalKnowledge') as
      | { captureFromProjection: (context: { pluginId: string; projectId: string }, input: unknown) => unknown }
      | undefined;
    if (!knowledge) return;
    knowledge.captureFromProjection(
      { pluginId: event.pluginId, projectId: event.projectId },
      {
        event: {
          eventId: event.runId,
          contributor: 'platform-control',
          projectionVersion: '1',
          kind: 'run.failed',
          runId: event.runId,
          inputDigest: event.inputDigest,
        },
        disposition: 'PENDING_ANALYSIS',
      },
    );
  });
  ctx.provide('platformControl', service);
  ctx.effect(() => () => service.close());
  if (validated.reconcileOnStartup) {
    service.reconcileOrphans({ actorId: 'service:startup', kind: 'service' });
  }
  if (validated.worker && validated.scheduler?.enabled !== false) {
    const scheduler = new RunScheduler(service, validated.scheduler?.intervalMs ?? 5000, {
      actorId: 'service:scheduler',
      kind: 'service',
    });
    const stop = scheduler.start();
    ctx.effect(() => stop);
  }
  const run = async (action: () => unknown | Promise<unknown>): Promise<string> => {
    try {
      return JSON.stringify(await action());
    } catch (error) {
      if (error instanceof PlatformError || error instanceof AuthorizationError || error instanceof RunError) {
        return JSON.stringify({ ok: false, code: error.code, detail: error.message });
      }
      return JSON.stringify({
        ok: false,
        code: 'PLATFORM_OPERATION_FAILED',
        notice: '未知错误正文未直接返回；请查看运行日志。',
      });
    }
  };
  ctx.tools.register(
    defineTool({
      name: 'platform_control_status',
      description:
        '平台控制面状态：已登记应用、运行计数、执行器类型与审计条数。执行器未配置时只能创建/取消排队运行，不能派发 Worker。',
      parameters: {},
      output,
      async execute(_args, exec) {
        return run(() => {
          operator(exec);
          return service.status();
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_workbench_snapshot',
      description: '工作台快照：应用发布摘要、最近运行与平台状态。用于前端展示，不返回运行输入正文。',
      parameters: {},
      output,
      async execute(_args, exec) {
        return run(() => {
          const principal = operator(exec);
          const apps = service.listApps(undefined, principal).map((app) => ({
            appId: app.appId,
            appVersion: app.appVersion,
            state: app.state,
            descriptor: app.draft.descriptor,
            planDigest: app.plan.planDigest,
            releaseDigest: app.releaseDigest,
            createdAt: app.createdAt,
          }));
          const runs = service.listRuns(undefined, 0, 50, principal);
          const works = service.listWorks(undefined, 0, 50, principal);
          return {
            apps,
            works: { total: works.total, items: works.items },
            runs: { total: runs.total, items: runs.items.map(publicRun) },
            models: {
              catalog: publicCatalog(service.modelCatalog(principal)),
              preference: service.modelPreference(principal),
            },
            status: service.status(),
          };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_app_register',
      description:
        '登记一个已批准的应用发布（数据-only）：descriptor、requiredCapabilities、providers、runtimeBundleDigest。平台解析确定性执行计划并保存摘要；不加载或执行应用代码。同版本内容不同即冲突。',
      parameters: { releaseJson: { ...string, required: true, description: 'AppReleaseDraft JSON；≤200KB。' } },
      output,
      async execute(args, exec) {
        return run(() => {
          const principal = operator(exec);
          const draft = parseJson(args.releaseJson, 200_000, 'APP_RELEASE_TOO_LARGE') as AppReleaseDraft;
          return service.registerApp(draft, principal);
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_app_list',
      description: '列出应用发布（默认全部；state 可筛 ACTIVE/REVOKED）。',
      parameters: { state: { ...string, enum: ['ACTIVE', 'REVOKED'] } },
      output,
      async execute(args, exec) {
        return run(() => {
          const principal = operator(exec);
          return { items: service.listApps(args.state as AppState | undefined, principal) };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_app_get',
      description: '读取一个明确版本的应用发布及其确定性执行计划；不按 latest 隐式选择。',
      parameters: { appId: { ...string, required: true }, appVersion: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => service.getApp(args.appId, args.appVersion, operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_app_revoke',
      description: '撤下应用发布：新运行不能再创建，既有运行不回溯改写。',
      parameters: {
        appId: { ...string, required: true },
        appVersion: { ...string, required: true },
        reason: { ...string, required: true },
      },
      output,
      async execute(args, exec) {
        return run(() => service.revokeApp(args.appId, args.appVersion, args.reason, operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_app_approve',
      description:
        '为已登记发布的精确 releaseDigest 记录部署审批（审批人、证据引用、可选回滚目标与到期时间）。摘要不一致即拒绝：审批的是字节，不是版本名。',
      parameters: {
        appId: { ...string, required: true },
        appVersion: { ...string, required: true },
        releaseDigest: { ...string, required: true },
        approvedBy: { ...string, required: true },
        evidence: string,
        rollbackTarget: string,
        expiresAt: string,
      },
      output,
      async execute(args, exec) {
        return run(() =>
          service.approveRelease(
            {
              appId: args.appId,
              appVersion: args.appVersion,
              releaseDigest: args.releaseDigest,
              approvedBy: args.approvedBy,
              ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
              ...(args.rollbackTarget !== undefined ? { rollbackTarget: args.rollbackTarget } : {}),
              ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
            },
            operator(exec),
          ),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_app_approval',
      description: '读取应用版本的部署审批（状态、摘要、审批人、回滚目标、到期）；无审批返回 null。',
      parameters: { appId: { ...string, required: true }, appVersion: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => service.releaseApproval(args.appId, args.appVersion, operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_model_catalog_register',
      description:
        '登记/替换部署审定的模型目录快照（metadata-only）：目录 ID、批准 RuntimeBundle 摘要、默认选择与模型项。不接收密钥、任意 baseURL 或性能排名；同一内容幂等，变更留审计。',
      parameters: { catalogJson: { ...string, required: true, description: 'ModelCatalogDraft JSON；≤200KB。' } },
      output,
      async execute(args, exec) {
        return run(() => {
          const principal = operator(exec);
          const draft = parseJson(args.catalogJson, 200_000, 'MODEL_CATALOG_TOO_LARGE');
          return service.registerModelCatalog(draft, principal);
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_model_catalog',
      description:
        '读取当前模型目录（含可用性/停用原因、能力元数据与来源验证标记）与调用者偏好；不返回凭据或密钥。目录为空时返回 null。',
      parameters: {},
      output,
      async execute(_args, exec) {
        return run(() => {
          const principal = operator(exec);
          return {
            catalog: publicCatalog(service.modelCatalog(principal)),
            preference: service.modelPreference(principal),
          };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_model_preference_set',
      description:
        '保存调用者默认模型偏好（目录内可用的 selectionId）。偏好只影响后续新运行；运行快照不会被改写，也不授予任何业务或数据权限。',
      parameters: { selectionId: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => service.setModelPreference(args.selectionId, operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_model_health_record',
      description:
        '记录部署探测到的模型路由健康事实（healthy/degraded/unavailable/unknown）。平台不自行探测提供方；未探测即 unknown，绝不猜测为健康。',
      parameters: {
        selectionId: { ...string, required: true },
        state: { ...string, required: true, enum: ['healthy', 'degraded', 'unavailable', 'unknown'] },
        reason: string,
      },
      output,
      async execute(args, exec) {
        return run(() =>
          service.recordModelHealth(
            {
              selectionId: args.selectionId,
              state: args.state as 'healthy' | 'degraded' | 'unavailable' | 'unknown',
              ...(args.reason !== undefined ? { reason: args.reason } : {}),
            },
            operator(exec),
          ),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_model_health',
      description: '读取已记录的模型健康事实；没有记录不代表健康。',
      parameters: {},
      output,
      async execute(_args, exec) {
        return run(() => ({ items: service.modelHealth(operator(exec)) }));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_outbox',
      description: '读取一次运行的持久派发消息（状态、尝试次数、下次重试、最近错误）；未入队返回 null。',
      parameters: { runId: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => service.outboxForRun(args.runId, operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_review_request',
      description:
        '对一次 SUCCEEDED 运行的封存成果发起业务复核（每运行最多一个未结请求；无已封存工件不可发起）。请求时服务端从已封存工件构造不可变清单并固定摘要；技术成功不代表业务批准；复核记录不改变运行状态。',
      parameters: { runId: { ...string, required: true }, note: string },
      output,
      async execute(args, exec) {
        return run(() => service.requestReview(args.runId, operator(exec), args.note));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_review_decision',
      description:
        '对未结复核做出 APPROVED/REJECTED 决定（CAS 绑定 revision 与请求冻结的目标清单摘要 expectedManifestDigest；驳回必须写明原因）。决定不可改写。',
      parameters: {
        reviewId: { ...string, required: true },
        decision: { ...string, required: true, enum: ['APPROVED', 'REJECTED'] },
        expectedRevision: { type: 'number', required: true },
        expectedManifestDigest: string,
        note: string,
      },
      output,
      async execute(args, exec) {
        return run(() =>
          service.recordReviewDecision(
            args.reviewId,
            args.decision as 'APPROVED' | 'REJECTED',
            args.note,
            args.expectedRevision,
            args.expectedManifestDigest,
            operator(exec),
          ),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_reviews',
      description: '读取一次运行的业务复核记录（请求、决定、复核人与备注）。',
      parameters: { runId: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => ({ items: service.reviewsForRun(args.runId, operator(exec)) }));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_app_rollback',
      description:
        '普通回退：把应用默认发布指向往回切到 toVersion（须 ACTIVE，启用审批时须已批准）。只改变新 Work 的路由，不撤销 fromVersion、不改历史；安全撤权走 platform_app_revoke。',
      parameters: {
        appId: { ...string, required: true },
        fromVersion: { ...string, required: true },
        toVersion: { ...string, required: true },
        reason: { ...string, required: true },
      },
      output,
      async execute(args, exec) {
        return run(() =>
          service.rollbackRelease(args.appId, args.fromVersion, args.toVersion, args.reason, operator(exec)),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_work_create',
      description:
        '创建一项员工工作（Work）：项目、ACTIVE 应用版本与标题。Run 是这项工作下的执行尝试；同一 Work 同时最多一个非终态 Run。',
      parameters: {
        projectId: { ...string, required: true },
        appId: { ...string, required: true },
        appVersion: { ...string, required: true },
        title: { ...string, required: true, description: '≤200 字符。' },
      },
      output,
      async execute(args, exec) {
        return run(() =>
          service.createWork(
            { projectId: args.projectId, appId: args.appId, appVersion: args.appVersion, title: args.title },
            operator(exec),
          ),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_work_list',
      description: '列出工作（可按 ACTIVE/ARCHIVED 筛选），最近更新在前。',
      parameters: { state: { ...string, enum: ['ACTIVE', 'ARCHIVED'] }, offset: { type: 'number' }, limit: { type: 'number' } },
      output,
      async execute(args, exec) {
        return run(() =>
          service.listWorks(
            args.state as WorkState | undefined,
            args.offset ?? 0,
            Math.min(args.limit ?? 20, 100),
            operator(exec),
          ),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_work_get',
      description: '读取一项工作的归属、应用版本与状态。',
      parameters: { workId: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => service.getWork(args.workId, operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_work_archive',
      description: '归档工作：之后不能在该 Work 下创建新 Run；历史 Run 与输入不回写。',
      parameters: { workId: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => service.archiveWork(args.workId, operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_work_runs',
      description: '列出一项工作下的执行尝试，最新创建在前。',
      parameters: { workId: { ...string, required: true }, offset: { type: 'number' }, limit: { type: 'number' } },
      output,
      async execute(args, exec) {
        return run(() => {
          const page = service.runsForWork(
            args.workId,
            args.offset ?? 0,
            Math.min(args.limit ?? 20, 100),
            operator(exec),
          );
          return { total: page.total, items: page.items.map(publicRun) };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_work_run_create',
      description:
        '在 ACTIVE Work 下创建一次执行尝试：冻结应用版本、输入与模型路由快照；同 Work 已有非终态 Run 时拒绝。创建不等于执行。',
      parameters: {
        workId: { ...string, required: true },
        inputJson: { ...string, required: true, description: '运行输入 JSON；≤1MB。' },
        modelSelectionId: { ...string, description: '平台模型目录中的 selectionId。' },
        modelOptionsJson: { ...string, description: '可选模型参数 JSON。' },
      },
      output,
      async execute(args, exec) {
        return run(() => {
          const principal = operator(exec);
          const input = parseJson(args.inputJson, 1024 * 1024, 'RUN_INPUT_TOO_LARGE');
          const modelOptions = args.modelOptionsJson
            ? parseJson(args.modelOptionsJson, 20_000, 'MODEL_OPTIONS_INVALID')
            : undefined;
          return publicRun(
            service.createWorkRun(args.workId, input, principal, {
              ...(args.modelSelectionId !== undefined ? { modelSelectionId: args.modelSelectionId } : {}),
              ...(modelOptions !== undefined ? { modelOptions } : {}),
            }),
          );
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_create',
      description:
        '为 ACTIVE 应用版本创建一个 QUEUED 运行，冻结 releaseDigest/planDigest、输入摘要与模型路由快照。可选 modelSelectionId（目录内可用项）；缺省时使用保存的偏好，再无则用部署默认。未知/停用模型明确失败，不会静默改用其他模型。创建不等于执行。',
      parameters: {
        appId: { ...string, required: true },
        appVersion: { ...string, required: true },
        inputJson: { ...string, required: true, description: '运行输入 JSON；≤1MB。' },
        modelSelectionId: { ...string, description: '平台模型目录中的 selectionId；不接受 provider/model 字符串路由。' },
        modelOptionsJson: { ...string, description: '可选模型参数 JSON（如 reasoningEffort/maxTokens）；须在目录项允许范围内。' },
      },
      output,
      async execute(args, exec) {
        return run(() => {
          const principal = operator(exec);
          const input = parseJson(args.inputJson, 1024 * 1024, 'RUN_INPUT_TOO_LARGE');
          const modelOptions = args.modelOptionsJson
            ? parseJson(args.modelOptionsJson, 20_000, 'MODEL_OPTIONS_INVALID')
            : undefined;
          return publicRun(
            service.createRun(args.appId, args.appVersion, input, principal, {
              ...(args.modelSelectionId !== undefined ? { modelSelectionId: args.modelSelectionId } : {}),
              ...(modelOptions !== undefined ? { modelOptions } : {}),
            }),
          );
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_retry',
      description:
        '从 FAILED/CANCELLED 运行创建新的 QUEUED 运行；不复用旧 Run、旧会话或残留输出。应用发布必须仍为 ACTIVE。',
      parameters: { runId: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => publicRun(service.retryRun(args.runId, operator(exec))));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_get',
      description: '读取运行的当前状态、revision、launchId、fencingToken、完成屏障与输入摘要。',
      parameters: { runId: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => publicRun(service.getRun(args.runId, operator(exec))));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_list',
      description: '列出运行（可按 appId 过滤），最新更新在前。',
      parameters: { appId: string, offset: { type: 'number' }, limit: { type: 'number' } },
      output,
      async execute(args, exec) {
        return run(() => {
          const page = service.listRuns(args.appId, args.offset ?? 0, Math.min(args.limit ?? 20, 100), operator(exec));
          return { total: page.total, items: page.items.map(publicRun) };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_cancel',
      description:
        '请求取消运行：QUEUED 立即 CANCELLED；已派发则持久 cancelRequested，只有监督器确认进程停止后才 CANCELLED。不能凭本工具把运行标成成功或已完成。',
      parameters: { runId: { ...string, required: true }, expectedRevision: { type: 'number', required: true } },
      output,
      async execute(args, exec) {
        return run(async () => {
          const result = await service.cancelRun(args.runId, args.expectedRevision, operator(exec));
          return { record: publicRun(result.record), cancelSettled: result.cancelSettled };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_artifacts',
      description: '读取运行已登记的产物清单（名称、SHA-256、字节数、媒体类型）；不返回本地路径或文件正文。',
      parameters: { runId: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => service.artifacts(args.runId, operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_append_input',
      description:
        '向非终态运行追加一条输入提交；保存为 PENDING 并记录摘要/序号。是否被 Worker 消费由后续监督事实决定，不能由本工具标记 CONSUMED。',
      parameters: {
        runId: { ...string, required: true },
        inputJson: { ...string, required: true, description: '输入 JSON；≤1MB。' },
      },
      output,
      async execute(args, exec) {
        return run(() => {
          const input = parseJson(args.inputJson, 1024 * 1024, 'RUN_INPUT_TOO_LARGE');
          return service.appendInput(args.runId, input, operator(exec));
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_inputs',
      description: '按提交顺序读取运行输入提交（序号、摘要、状态、正文）；默认第一页。',
      parameters: { runId: { ...string, required: true }, offset: { type: 'number' }, limit: { type: 'number' } },
      output,
      async execute(args, exec) {
        return run(() => service.inputs(args.runId, args.offset ?? 0, Math.min(args.limit ?? 20, 100), operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_attempts',
      description:
        '读取运行的 launch 尝试记录（launchId、fencing token、开始/结束、状态、诊断）。重启对账会把未结尝试标为 UNKNOWN。',
      parameters: { runId: { ...string, required: true } },
      output,
      async execute(args, exec) {
        return run(() => service.attempts(args.runId, operator(exec)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_run_events',
      description: '读取运行的状态变更事件（含 actor、revision、事件正文），最新在前。',
      parameters: { runId: { ...string, required: true }, offset: { type: 'number' }, limit: { type: 'number' } },
      output,
      async execute(args, exec) {
        return run(() =>
          service.runEvents(args.runId, args.offset ?? 0, Math.min(args.limit ?? 50, 100), operator(exec)),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'platform_audit_events',
      description: '读取平台审计事件（应用登记/撤销、运行创建/取消等），最新在前。',
      parameters: { offset: { type: 'number' }, limit: { type: 'number' } },
      output,
      async execute(args, exec) {
        return run(() => service.audit(args.offset ?? 0, Math.min(args.limit ?? 50, 100), operator(exec)));
      },
    }),
  );
}
export type { ControlStatus };
