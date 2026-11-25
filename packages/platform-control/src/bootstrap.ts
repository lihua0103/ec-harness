/** Shared control-plane bootstrap (WP4): one assembly/startup sequence for both entry points.
 *  api-cli.ts (HTTP workbench server) and cordis.ts (DSH bundle) must agree on executor
 *  registration, knowledge snapshot wiring, startup reconciliation and scheduler assembly —
 *  the run lifecycle contract does not allow the two entries to drift on dispatch or
 *  reconciliation semantics.
 *
 *  Ordering guarantee: startup reconciliation completes before the scheduler is started, so a
 *  run orphaned by a previous control process is closed out (UNKNOWN evidence) before any new
 *  dispatch can race the crash reconciliation. [运行合同](../../docs/PLATFORM-RUN-LIFECYCLE-CONTRACT.md)
 */
import { resolve } from 'node:path';
import { readActivePreferenceRefs, readReleasePointer, readSnapshot } from '../../platform-knowledge/src/snapshot-readonly.js';
import { HttpKnowledgeAccess } from '../../platform-knowledge/src/access.js';
import { resolveControlHome, resolveKnowledgeStorePath, type Config } from './config.js';
import { ChildProcessWorkerExecutor } from './child-worker.js';
import { DshProfileExecutor } from './worker.js';
import { RunScheduler } from './scheduler.js';
import type { PlatformControlService } from './service.js';
import type { AppRecord, RunRecord } from './store.js';
import type { KnowledgeTenantScope } from './policy.js';

/** KA11/WP2 shared Run knowledge binding: a read-only snapshot of the app's knowledge domain
 *  taken under the trusted tenant scope, with the same digest formula as KnowledgeService.snapshot.
 *  v6 发布感知（L3）：readSnapshot 在发布指针存在时取发布清单条目——新 Run 绑定新版，旧 Run 不漂移。
 *  LearningBinding（开发设计 §4）：附加发布指针引用与本人 ACTIVE 偏好的受限引用（只有键与修订，
 *  永不携带偏好正文）；服务不可用/库缺失时如实缺省，控制面从不伪造绑定、从不写知识库。 */
export function bindKnowledgeSnapshot(
  knowledgeStorePath: string,
  app: AppRecord,
  projectId: string,
  scope: KnowledgeTenantScope,
  options: { actorId?: string } = {},
): RunRecord['knowledge'] {
  const pluginId = app.draft.descriptor.knowledgePluginId;
  if (!pluginId) return undefined;
  const snapshot = readSnapshot(knowledgeStorePath, { pluginId, projectId, ...scope });
  if (!snapshot) return undefined;
  const pointer = readReleasePointer(knowledgeStorePath, pluginId, scope);
  const preferences =
    options.actorId !== undefined ? readActivePreferenceRefs(knowledgeStorePath, scope, options.actorId, pluginId) : [];
  return {
    snapshotDigest: snapshot.snapshotDigest,
    total: snapshot.total,
    pluginId,
    projectId,
    ...scope,
    boundAt: new Date().toISOString(),
    // 实际修订集合（M1-02）：Run 可据此重放固定知识，而不只是一个完整性摘要。
    records: snapshot.records.map((record) => ({
      knowledgeId: record.knowledgeId,
      revision: record.revision,
      contentDigest: record.contentDigest,
    })),
    ...(pointer ? { release: { releaseId: pointer.releaseId, version: pointer.version, manifestDigest: pointer.manifestDigest } } : {}),
    ...(preferences.length ? { preferences } : {}),
  };
}

/** Register the deployment-scoped executor, tenant scope and knowledge snapshot source on a
 *  freshly constructed service. Both entry points call this instead of duplicating the wiring. */
export function configureControlService(service: PlatformControlService, config: Config): void {
  if (config.worker) {
    // Persist exit evidence in launch_attempts so it survives control-process restarts.
    const evidence = {
      record: (launchId: string, proven: boolean) => service.recordExitEvidence(launchId, proven),
      read: (launchId: string) => service.readExitEvidence(launchId),
    };
    service.setExecutor(
      config.worker.mode === 'child-process'
        ? new ChildProcessWorkerExecutor(config.worker, evidence)
        : new DshProfileExecutor(config.worker, undefined, evidence),
    );
  }
  service.setKnowledgeScope(config.knowledgeScope);
  // L1/L2/L3：配置 knowledgeServiceUrl 时控制面经认证 HTTP 访问同一权威服务实例（§3）；
  // 未配置且运行在 DSH bundle 同进程时，由 cordis 装配注入 InProcessKnowledgeAccess。
  if (config.knowledgeServiceUrl) {
    service.setKnowledgeAccess(new HttpKnowledgeAccess(config.knowledgeServiceUrl, config.knowledgeServiceToken));
  }
  // KA11：默认路径 = DSH_HOME/platform/knowledge.sqlite，与知识 bundle 一致；控制面只读知识库，
  // 知识库唯一写者仍是 KnowledgeService。
  const knowledgeStorePath =
    resolveKnowledgeStorePath(config) ?? resolve(resolveControlHome(), 'platform', 'knowledge.sqlite');
  service.setKnowledgeSnapshotSource((app, projectId, scope, options) =>
    bindKnowledgeSnapshot(knowledgeStorePath, app, projectId, scope, options),
  );
}

export interface ControlRuntime {
  /** True when a platform-owned scheduler was assembled (worker configured and enabled). */
  readonly schedulerStarted: boolean;
  /** Stop the scheduler; safe to call when none was started. */
  stop(): void;
}

/** Shared startup sequence: reconcile-then-schedule under the fixed service principals so both
 *  entries leave identical audit provenance. Scheduler-disabled configurations start zero
 *  dispatch loops. */
export function startControlRuntime(service: PlatformControlService, config: Config): ControlRuntime {
  if (config.reconcileOnStartup) {
    service.reconcileOrphans({ actorId: 'service:startup', kind: 'service' });
  }
  if (config.worker && config.scheduler?.enabled !== false) {
    const scheduler = new RunScheduler(
      service,
      config.scheduler?.intervalMs ?? 5000,
      { actorId: 'service:scheduler', kind: 'service' },
    );
    const stopScheduler = scheduler.start();
    return { schedulerStarted: true, stop: stopScheduler };
  }
  return { schedulerStarted: false, stop: () => {} };
}
