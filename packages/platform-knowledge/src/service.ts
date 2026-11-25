import { randomUUID } from 'node:crypto';
import { KnowledgeStore } from './store.js';
import type { CitationRecord, ProjectionOutcome, ProjectionRecord } from './store.js';
import { documentEntry } from './corpus.js';
import { readSnapshot, verifySnapshotDigest, type KnowledgeSnapshot } from './snapshot-readonly.js';
import { KnowledgeAgentRegistry } from './manifest.js';
import type { ExclusionReason, KnowledgeEvidence, KnowledgeRef } from './evidence.js';
import {
  preferenceSchema,
  validatePreferenceValue,
  type PersonalDraftRecord,
  type PersonalSettingRecord,
  type PreferenceRef,
} from './preferences.js';
import {
  parseLearningCaseSourceEvent,
  type KnowledgeReleaseEntry,
  type KnowledgeReleasePointer,
  type KnowledgeReleaseRecord,
  type LearningCaseRecord,
  type LearningCaseSourceEvent,
  type LearningCaseStatus,
} from './learning.js';
import type { KnowledgePrincipal } from './identity-scope.js';
import {
  bindRequestCandidate,
  caseSetDigest,
  createValidationRequest,
  receiptDigest,
  validatorDigest,
  verifyValidationReceipt,
  type ValidationReceipt,
  type ValidationRequest,
  type ValidationResult,
} from './validation-protocol.js';
import {
  canonical,
  digest,
  identifier,
  normalizeDraft,
  validateContext,
  type KnowledgeContext,
  type KnowledgeDraft,
  type KnowledgeRecord,
  type PluginContribution,
  type State,
  type ValidationSuite,
} from './schema.js';
export interface SearchOptions {
  query?: string;
  topics?: string[];
  states?: State[];
  offset?: number;
  limit?: number;
}
/** Freeze copied JSON metadata recursively; execution receives its own mutable clone. */
function freezeMetadata<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}
export class KnowledgeService {
  private readonly store: KnowledgeStore;
  private readonly contributions = new Map<string, PluginContribution>();
  private readonly suites = new Map<string, ValidationSuite>();
  /** M2-01：已注册的插件知识智能体定义（按插件与版本解析）。 */
  private readonly agentRegistry = new KnowledgeAgentRegistry();
  constructor(path: string) {
    this.store = new KnowledgeStore(path);
  }
  get agents(): KnowledgeAgentRegistry {
    return this.agentRegistry;
  }
  /** 由插件 bundle 在装配时注册自己的 manifest；卸载时只撤销本次注册的版本。 */
  registerAgentManifest(value: unknown): () => void {
    const result = this.agentRegistry.register(value);
    return () => {
      if (result.status === 'REGISTERED') this.agentRegistry.unregister(result.pluginId, result.version);
    };
  }
  close(): void {
    this.store.close();
  }
  /** 库文件路径（快照公式与只读绑定口共用；HTTP /snapshot/resolve 用它读库）。 */
  get storePath(): string {
    return this.store.path;
  }
  registerContribution(value: PluginContribution): () => void {
    identifier(value.pluginId);
    if (this.contributions.has(value.pluginId)) throw new Error('KNOWLEDGE_PLUGIN_ALREADY_REGISTERED');
    const contribution = structuredClone(value);
    for (const [key, values] of Object.entries(contribution.scenarioAliases)) {
      identifier(key);
      if (!Array.isArray(values)) throw new Error('KNOWLEDGE_ALIAS_INVALID');
      values.forEach(identifier);
    }
    this.contributions.set(value.pluginId, contribution);
    return () => {
      if (this.contributions.get(value.pluginId) === contribution) this.contributions.delete(value.pluginId);
    };
  }
  /** Only installed plugin code supplies executable validation. Never accept a validator from capture JSON. */
  registerValidator(pluginId: string, suite: ValidationSuite): () => void {
    identifier(pluginId);
    identifier(suite.id);
    identifier(suite.version);
    const key = `${pluginId}:${suite.id}`;
    if (this.suites.has(key)) throw new Error('KNOWLEDGE_VALIDATOR_ALREADY_REGISTERED');
    const cases = structuredClone(suite.cases),
      knowledgeIds = [...suite.knowledgeIds];
    if (!knowledgeIds.length) throw new Error('KNOWLEDGE_VALIDATOR_TARGET_REQUIRED');
    knowledgeIds.forEach(identifier);
    if (
      !cases.length ||
      new Set(cases.map((c) => c.id)).size !== cases.length ||
      cases.some((c) => !['positive', 'negative', 'boundary'].includes(c.group))
    )
      throw new Error('KNOWLEDGE_CASES_INVALID');
    for (const c of cases) {
      identifier(c.id);
      canonical(c.input);
      canonical(c.expected);
    }
    const coverage = (suite.coverage ?? []).map((entry) => {
      identifier(entry.knowledgeId);
      if (!knowledgeIds.includes(entry.knowledgeId)) throw new Error('KNOWLEDGE_COVERAGE_TARGET_MISMATCH');
      if (typeof entry.candidateDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.candidateDigest))
        throw new Error('KNOWLEDGE_COVERAGE_DIGEST_INVALID');
      const claims = [...new Set(entry.claims.map((claim) => (typeof claim === 'string' ? claim.trim() : claim)))];
      if (claims.some((claim) => typeof claim !== 'string' || !claim.trim() || claim.length > 512))
        throw new Error('KNOWLEDGE_COVERAGE_INVALID');
      const suiteCaseIds = new Set(suite.cases.map((c) => c.id));
      const evidence = (entry.evidence ?? []).map((item) => {
        identifier(item.suiteId);
        if (typeof item.suiteVersion !== 'string' || !item.suiteVersion.trim() || item.suiteVersion.length > 64)
          throw new Error('KNOWLEDGE_CLAIM_EVIDENCE_INVALID');
        if (!Array.isArray(item.caseIds) || !item.caseIds.length || item.caseIds.length > 128 ||
          item.caseIds.some((caseId) => typeof caseId !== 'string' || !suiteCaseIds.has(caseId)))
          throw new Error('KNOWLEDGE_CLAIM_EVIDENCE_CASE_INVALID');
        return Object.freeze({ suiteId: item.suiteId, suiteVersion: item.suiteVersion, caseIds: Object.freeze([...new Set(item.caseIds)]) });
      });
      if (new Set(evidence.map((item) => item.suiteId)).size !== evidence.length)
        throw new Error('KNOWLEDGE_CLAIM_EVIDENCE_DUPLICATE');
      return Object.freeze({
        knowledgeId: entry.knowledgeId,
        candidateDigest: entry.candidateDigest,
        claims: Object.freeze(claims),
        evidence: Object.freeze(evidence),
      });
    });
    if (new Set(coverage.map((entry) => entry.knowledgeId)).size !== coverage.length)
      throw new Error('KNOWLEDGE_COVERAGE_DUPLICATE');
    const registered = freezeMetadata({ ...suite, knowledgeIds, cases, coverage });
    this.suites.set(key, registered);
    return () => {
      if (this.suites.get(key) === registered) this.suites.delete(key);
    };
  }
  private visible(context: KnowledgeContext, record: KnowledgeRecord): boolean {
    // 租户/区域来自可信上下文：非空记录必须匹配；NULL 旧行保留本地兼容可见性（未猜测归属）。
    if (record.orgId !== undefined && record.orgId !== context.orgId) return false;
    if (record.region !== undefined && record.region !== context.region) return false;
    return (
      record.scope === 'shared' ||
      (record.pluginId === context.pluginId && (record.scope === 'plugin' || record.projectId === context.projectId))
    );
  }
  get(context: KnowledgeContext, id: string, revision?: number): KnowledgeRecord {
    validateContext(context);
    identifier(id);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      throw new Error('KNOWLEDGE_REVISION_INVALID');
    const record = this.store.get(id, revision);
    if (!record || !this.visible(context, record)) throw new Error('KNOWLEDGE_NOT_FOUND');
    return record;
  }
  capture(context: KnowledgeContext, value: KnowledgeDraft, expectedRevision = 0): KnowledgeRecord {
    validateContext(context);
    const body = normalizeDraft(value);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('KNOWLEDGE_REVISION_INVALID');
    // 租户/区域以可信上下文为准：候选未声明时盖章，已声明时必须与上下文一致（不得靠工具参数跨租户写入）。
    if (body.orgId === undefined && context.orgId !== undefined) body.orgId = context.orgId;
    else if (body.orgId !== undefined && body.orgId !== context.orgId) throw new Error('KNOWLEDGE_CONTEXT_MISMATCH');
    if (body.region === undefined && context.region !== undefined) body.region = context.region;
    else if (body.region !== undefined && body.region !== context.region) throw new Error('KNOWLEDGE_CONTEXT_MISMATCH');
    if (!this.visible(context, { ...body, revision: 0, contentDigest: '', state: 'CANDIDATE', createdAt: '' }))
      throw new Error('KNOWLEDGE_CONTEXT_MISMATCH');
    return this.store.transaction(() => this.store.insert(body, expectedRevision));
  }
  /** KA12：从可信运行事件自动提炼候选。事件由平台/Worker 提供，模型只可补充方法语义；
   *  runId 与摘要不可由模型自报为“已验证”。候选仍为 CANDIDATE，激活仍走 claims/coverage。 */
  captureFromRunEvent(
    context: KnowledgeContext,
    event: { kind: NonNullable<KnowledgeDraft['eventRef']>['kind']; runId: string; inputDigest?: string; artifactDigest?: string },
    draft: Omit<KnowledgeDraft, 'eventRef'>,
  ): KnowledgeRecord {
    if (!context.orgId || !context.projectId) throw new Error('KNOWLEDGE_EVENT_CONTEXT_REQUIRED');
    return this.capture(context, {
      ...draft,
      eventRef: {
        kind: event.kind,
        runId: event.runId,
        ...(event.inputDigest !== undefined ? { inputDigest: event.inputDigest } : {}),
        ...(event.artifactDigest !== undefined ? { artifactDigest: event.artifactDigest } : {}),
        at: new Date().toISOString(),
      },
    });
  }
  /** 运行事件投影（M2-02）：同一 (eventId, contributor, projectionVersion) 只产生一个结局。
   *  重复投递返回原结局；无证据时显式记录待处理/无法提炼；失败只记台账，不改写业务 Run 状态。
   *  候选仍是 CANDIDATE，激活仍走 claims/coverage 与验证回执。 */
  captureFromProjection(
    context: KnowledgeContext,
    input: {
      event: {
        eventId: string;
        contributor: string;
        projectionVersion: string;
        kind: NonNullable<KnowledgeDraft['eventRef']>['kind'];
        runId: string;
        inputDigest?: string;
        artifactDigest?: string;
      };
      draft?: Omit<KnowledgeDraft, 'eventRef'>;
      disposition?: 'PENDING_ANALYSIS' | 'NO_REUSABLE_CONCLUSION';
    },
  ): { projectionKey: string; outcome: ProjectionOutcome; duplicate: boolean; knowledgeId?: string; reason?: string } {
    validateContext(context);
    identifier(input.event.eventId);
    identifier(input.event.contributor);
    identifier(input.event.projectionVersion);
    if (!context.projectId) throw new Error('KNOWLEDGE_EVENT_CONTEXT_REQUIRED');
    const projectionKey = digest({
      eventId: input.event.eventId,
      contributor: input.event.contributor,
      projectionVersion: input.event.projectionVersion,
    });
    const existing = this.store.projection(projectionKey);
    if (existing) {
      return {
        projectionKey,
        outcome: existing.outcome,
        duplicate: true,
        ...(existing.knowledgeId !== undefined ? { knowledgeId: existing.knowledgeId } : {}),
      };
    }
    const createdAt = new Date().toISOString();
    const record = (outcome: ProjectionOutcome, detail: unknown, knowledgeId?: string) =>
      this.store.recordProjection({
        projectionKey,
        pluginId: context.pluginId,
        eventId: input.event.eventId,
        contributor: input.event.contributor,
        projectionVersion: input.event.projectionVersion,
        outcome,
        ...(knowledgeId !== undefined ? { knowledgeId } : {}),
        detail,
        createdAt,
      });
    if (!input.draft) {
      const outcome: ProjectionOutcome = input.disposition ?? 'NO_REUSABLE_CONCLUSION';
      record(outcome, { reason: 'NO_DRAFT_SUPPLIED', runId: input.event.runId });
      return { projectionKey, outcome, duplicate: false };
    }
    try {
      const captured = this.capture(context, {
        ...input.draft,
        eventRef: {
          kind: input.event.kind,
          runId: input.event.runId,
          ...(input.event.inputDigest !== undefined ? { inputDigest: input.event.inputDigest } : {}),
          ...(input.event.artifactDigest !== undefined ? { artifactDigest: input.event.artifactDigest } : {}),
          at: createdAt,
        },
      });
      record('CANDIDATE', { runId: input.event.runId, revision: captured.revision }, captured.knowledgeId);
      return { projectionKey, outcome: 'CANDIDATE', duplicate: false, knowledgeId: captured.knowledgeId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 修订冲突是可裁决的显式结局；其余暂态失败保留重试线索，而不是静默丢弃。
      const outcome: ProjectionOutcome =
        reason.includes('KNOWLEDGE_REVISION_STALE') || reason.includes('KNOWLEDGE_PROMOTION_REQUIRES_NEW_ID')
          ? 'CONFLICT'
          : 'RETRY_REQUIRED';
      record(outcome, { runId: input.event.runId, reason });
      return { projectionKey, outcome, duplicate: false, reason };
    }
  }
  /** M2-02 智能体侧链路：按插件读取最近的投影台账，供智能体把 PENDING_ANALYSIS 事故
   *  提炼为候选（候选仍走 capture/validate，不可由模型自报通过）。只读，按上下文插件过滤。 */
  listProjections(
    context: KnowledgeContext,
    options: { outcome?: ProjectionOutcome; limit?: number } = {},
  ): ProjectionRecord[] {
    validateContext(context);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    return this.store.projectionsFor(context.pluginId, limit, options.outcome);
  }
  /** R5：分析主体认领一条待分析投影（经认证的 principal 派生 claimant，不接受请求体自报）。
   *  认领后仍需产出候选或显式 NO_REUSABLE_CONCLUSION；outbox delivered 不等于学习完成。 */
  claimProjection(context: KnowledgeContext, projectionKey: string, principal: KnowledgePrincipal): ProjectionRecord | undefined {
    validateContext(context);
    identifier(projectionKey);
    identifier(principal.actorId);
    const existing = this.store.projection(projectionKey);
    if (!existing || existing.pluginId !== context.pluginId) return undefined;
    this.store.claimProjection(projectionKey, principal.actorId, new Date().toISOString());
    return this.store.projection(projectionKey);
  }
  /** R5 指标：投递数、待分析（未认领）、已认领、候选产出、明确不产出。不把 delivered 当完成。 */
  projectionMetrics(context: KnowledgeContext): { delivered: number; pendingAnalysis: number; claimed: number; candidate: number; noReusable: number } {
    validateContext(context);
    return this.store.projectionMetrics(context.pluginId);
  }
  importSeeds(pluginId: string, packageVersion: string, records: KnowledgeDraft[]) {
    identifier(pluginId);
    identifier(packageVersion);
    const normalized = records.map(normalizeDraft);
    if (
      normalized.some((r) => r.scope !== 'plugin' || r.pluginId !== pluginId) ||
      new Set(normalized.map((r) => r.knowledgeId)).size !== normalized.length
    )
      throw new Error('KNOWLEDGE_SEED_SCOPE_INVALID');
    const hash = digest(normalized);
    return this.store.transaction(() => {
      if (this.store.seedImport(pluginId, packageVersion, hash) === 'existing')
        return { imported: 0, revised: 0, conflicts: [], digest: hash };
      let imported = 0,
        revised = 0;
      const conflicts: Array<{ knowledgeId: string; reason: string }> = [];
      const conflictsRef = conflicts;
      for (const record of normalized) {
        const recordDigest = digest(record);
        const previous = this.store.get(record.knowledgeId);
        if (previous?.contentDigest === recordDigest) {
          this.store.setSeedState(pluginId, record.knowledgeId, recordDigest, packageVersion);
          continue;
        }
        // A seed whose live revision differs from the last imported digest was dynamically revised;
        // never overwrite it silently — record a conflict and keep the human edit in place.
        const lastImport = this.store.seedState(pluginId, record.knowledgeId);
        if (previous && (!lastImport || lastImport.digest !== previous.contentDigest)) {
          this.store.event(record.knowledgeId, previous.revision, 'SEED_CONFLICT_DYNAMIC_REVISION', {
            packageVersion,
            seedDigest: recordDigest,
            currentDigest: previous.contentDigest,
            seedLastImported: lastImport?.digest ?? null,
          });
          conflictsRef.push({ knowledgeId: record.knowledgeId, reason: 'DYNAMICALLY_REVISED' });
          continue;
        }
        this.store.insert(record, previous ? previous.revision : 0);
        if (previous) revised++;
        else imported++;
        this.store.setSeedState(pluginId, record.knowledgeId, recordDigest, packageVersion);
      }
      return { imported, revised, conflicts, digest: hash };
    });
  }
  /** 检索能力标识：FTS5/trigram 可用时为全文召回；否则为作用域子串降级扫描。 */
  get searchMode(): 'FTS5_TRIGRAM' | 'SCOPED_UNICODE_SUBSTRING' {
    return this.store.ftsEnabled ? 'FTS5_TRIGRAM' : 'SCOPED_UNICODE_SUBSTRING';
  }
  search(context: KnowledgeContext, options: SearchOptions = {}) {
    validateContext(context);
    const { offset = 0, limit = 20 } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('KNOWLEDGE_PAGE_INVALID');
    const states = options.states ?? ['ACTIVE'];
    if (!states.length || states.some((s) => !['CANDIDATE', 'ACTIVE', 'CONFLICT', 'SUPERSEDED', 'REVOKED'].includes(s)))
      throw new Error('KNOWLEDGE_STATE_INVALID');
    const aliases = this.contributions.get(context.pluginId)?.scenarioAliases ?? {};
    const scenarios = context.scenario ? new Set([context.scenario, ...(aliases[context.scenario] ?? [])]) : undefined;
    const terms = (options.query ?? '').normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    // trigram 全文召回要求每个词 ≥3 个码位且不含短语引号；不满足时走作用域子串扫描（语义与 v1 完全一致）。
    const ftsEligible =
      this.store.ftsEnabled &&
      terms.length > 0 &&
      terms.every((term) => [...term].length >= 3 && !term.includes('"'));
    if (ftsEligible) {
      // FTS 路径：匹配/过滤/去重/排序/分页全部在 SQL 内完成，只解码当前页。
      // 命中语义为 trigram 短语包含于记录字段值；降级路径保持 canonical 子串语义（searchMode 如实区分）。
      const match = terms.map((term) => `"${term}"`).join(' ');
      const facets: { scenarios?: string[]; edc?: string[]; topics?: string[] } = {};
      if (scenarios) facets.scenarios = [...scenarios];
      if (context.edc) facets.edc = [context.edc];
      if (options.topics?.length) facets.topics = [...new Set(options.topics)];
      const page = this.store.ftsPage(
        match,
        states,
        context.pluginId,
        context.projectId,
        facets,
        offset,
        limit,
        { orgId: context.orgId, region: context.region },
      );
      return {
        items: page.items,
        total: page.total,
        offset,
        nextOffset: offset + limit < page.total ? offset + limit : null,
        resultDigest: digest(
          page.refs.map((r) => ({ id: r.id, revision: r.revision, digest: r.digest, state: r.state })),
        ),
        searchMode: 'FTS5_TRIGRAM' as const,
      };
    }
    const rows = this.store.scoped(context.pluginId, context.projectId, {
      orgId: context.orgId,
      region: context.region,
    });
    // Keep the newest eligible revision per id: a new CANDIDATE never silently masks an old ACTIVE.
    const seen = new Set<string>(),
      matching: KnowledgeRecord[] = [];
    for (const row of rows) {
      if (!states.includes(row.state) || seen.has(row.knowledgeId)) continue;
      if (scenarios && row.scenarios.length && !row.scenarios.some((s) => scenarios.has(s))) continue;
      if (context.edc && row.edc.length && !row.edc.includes(context.edc)) continue;
      if (options.topics?.length && !options.topics.some((t) => row.topics.includes(t))) continue;
      const text = canonical(row).normalize('NFKC').toLocaleLowerCase();
      if (!terms.every((term) => text.includes(term))) continue;
      seen.add(row.knowledgeId);
      matching.push(row);
    }
    matching.sort((a, b) => {
      const rank = (r: KnowledgeRecord) => (r.scope === 'project' ? 0 : r.scope === 'plugin' ? 1 : 2);
      return rank(a) - rank(b) || a.knowledgeId.localeCompare(b.knowledgeId);
    });
    return {
      items: matching.slice(offset, offset + limit),
      total: matching.length,
      offset,
      nextOffset: offset + limit < matching.length ? offset + limit : null,
      resultDigest: digest(
        matching.map((r) => ({ id: r.knowledgeId, revision: r.revision, digest: r.contentDigest, state: r.state })),
      ),
      searchMode: 'SCOPED_UNICODE_SUBSTRING' as const,
    };
  }
  /** 绑定快照必须来自同一可信上下文，且摘要可由实际修订集合重新计算。 */
  private boundSnapshot(context: KnowledgeContext, snapshot: KnowledgeSnapshot): void {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.records))
      throw new Error('KNOWLEDGE_SNAPSHOT_INVALID');
    if (!verifySnapshotDigest(snapshot)) throw new Error('KNOWLEDGE_SNAPSHOT_INVALID');
    const bound = snapshot.context;
    if (
      !bound ||
      bound.pluginId !== context.pluginId ||
      (bound.orgId ?? undefined) !== (context.orgId ?? undefined) ||
      (bound.region ?? undefined) !== (context.region ?? undefined) ||
      (bound.projectId ?? undefined) !== (context.projectId ?? undefined)
    )
      throw new Error('KNOWLEDGE_SNAPSHOT_CONTEXT_MISMATCH');
  }
  /** M1-02：在 Run 创建时绑定的固定修订集合内检索。
   *  新修订/升级不改变原 Run（原修订照常读取）；撤权（不可见）与撤回（REVOKED/CONFLICT）失败关闭，
   *  逐条进入 evidence.excluded，绝不改读活库或暗换新版。 */
  searchPinned(context: KnowledgeContext, snapshot: KnowledgeSnapshot, options: SearchOptions = {}) {
    validateContext(context);
    this.boundSnapshot(context, snapshot);
    const { offset = 0, limit = 20 } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('KNOWLEDGE_PAGE_INVALID');
    const states = options.states;
    if (states && (!states.length || states.some((s) => !['CANDIDATE', 'ACTIVE', 'CONFLICT', 'SUPERSEDED', 'REVOKED'].includes(s))))
      throw new Error('KNOWLEDGE_STATE_INVALID');
    const aliases = this.contributions.get(context.pluginId)?.scenarioAliases ?? {};
    const scenarios = context.scenario ? new Set([context.scenario, ...(aliases[context.scenario] ?? [])]) : undefined;
    const terms = (options.query ?? '').normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matching: KnowledgeRecord[] = [];
    const excluded: Array<KnowledgeRef & { reason: ExclusionReason }> = [];
    for (const ref of snapshot.records) {
      const record = this.store.get(ref.knowledgeId, ref.revision);
      if (!record) {
        excluded.push({ ...ref, reason: 'UNAVAILABLE' });
        continue;
      }
      if (record.contentDigest !== ref.contentDigest) {
        excluded.push({ ...ref, reason: 'TAMPERED' });
        continue;
      }
      if (!this.visible(context, record)) {
        excluded.push({ ...ref, reason: 'NOT_VISIBLE' });
        continue;
      }
      // 撤回/冲突是显式失效：保留审计事实，但不再返回失效正文。
      const latest = this.store.get(ref.knowledgeId);
      if (latest && (latest.state === 'REVOKED' || latest.state === 'CONFLICT')) {
        excluded.push({ ...ref, reason: latest.state });
        continue;
      }
      // 发布撤回（T06）：台账中的 (id, rev) 对新旧 Run 都失效——撤回后不能重取失效正文。
      const withdrawal = this.store.releaseWithdrawal(ref.knowledgeId, ref.revision);
      if (withdrawal) {
        excluded.push({ ...ref, reason: 'WITHDRAWN' });
        continue;
      }
      if (states && !states.includes(record.state)) continue;
      if (scenarios && record.scenarios.length && !record.scenarios.some((s) => scenarios.has(s))) continue;
      if (context.edc && record.edc.length && !record.edc.includes(context.edc)) continue;
      if (options.topics?.length && !options.topics.some((t) => record.topics.includes(t))) continue;
      if (terms.length) {
        const text = canonical(record).normalize('NFKC').toLocaleLowerCase();
        if (!terms.every((term) => text.includes(term))) continue;
      }
      matching.push(record);
    }
    matching.sort((a, b) => {
      const rank = (r: KnowledgeRecord) => (r.scope === 'project' ? 0 : r.scope === 'plugin' ? 1 : 2);
      return rank(a) - rank(b) || a.knowledgeId.localeCompare(b.knowledgeId);
    });
    const returned = matching.map((record) => ({
      knowledgeId: record.knowledgeId,
      revision: record.revision,
      contentDigest: record.contentDigest,
      state: record.state,
    }));
    const evidence: KnowledgeEvidence = {
      status: excluded.length ? 'DEGRADED' : matching.length ? 'BOUND' : 'EMPTY',
      snapshot: { digest: snapshot.snapshotDigest, total: snapshot.records.length },
      returned,
      excluded,
    };
    return {
      items: matching.slice(offset, offset + limit),
      total: matching.length,
      offset,
      nextOffset: offset + limit < matching.length ? offset + limit : null,
      resultDigest: digest(returned.map((ref) => ({ id: ref.knowledgeId, revision: ref.revision, digest: ref.contentDigest, state: ref.state }))),
      searchMode: 'PINNED_SNAPSHOT' as const,
      evidence,
    };
  }
  /** 服务端按 runRef 解析快照的接缝（§5 run.bindLearning/knowledge.searchPinned：不信任客户端自带快照）。
   *  由控制面装配注入（从自身 Run 存储还原绑定）；未注入或 Run 无绑定 → 调用失败，不回落到客户端快照。 */
  private runBindingResolver?: (runId: string) => { snapshot: KnowledgeSnapshot; context: KnowledgeContext } | undefined;
  setRunSnapshotResolver(
    resolver: ((runId: string) => { snapshot: KnowledgeSnapshot; context: KnowledgeContext } | undefined) | undefined,
  ): void {
    this.runBindingResolver = resolver;
  }
  /** 在服务端还原的 Run 绑定快照内检索。调用方上下文只能收窄：插件/租户/项目必须与绑定一致，
   *  scenario/edc/locale/query 自由收窄。越界显式失败（KNOWLEDGE_SNAPSHOT_CONTEXT_MISMATCH）。 */
  searchPinnedForRun(context: KnowledgeContext, runId: string, options: SearchOptions & { topics?: string[] } = {}) {
    validateContext(context);
    identifier(runId);
    const resolved = this.runBindingResolver?.(runId);
    if (!resolved) throw new Error('KNOWLEDGE_RUN_BINDING_UNAVAILABLE');
    const bound = resolved.context;
    if (
      bound.pluginId !== context.pluginId ||
      (bound.orgId ?? undefined) !== (context.orgId ?? undefined) ||
      (bound.region ?? undefined) !== (context.region ?? undefined) ||
      (bound.projectId ?? undefined) !== (context.projectId ?? undefined)
    )
      throw new Error('KNOWLEDGE_SNAPSHOT_CONTEXT_MISMATCH');
    return this.searchPinned(bound, resolved.snapshot, options);
  }
  /** M1-03：记录答案最终引用了哪些实际返回的修订。引用必须来自同一快照，未引用不冒称采纳。 */
  cite(
    context: KnowledgeContext,
    runId: string,
    snapshot: KnowledgeSnapshot,
    refs: ReadonlyArray<{ knowledgeId: string; revision: number; contentDigest?: string }>,
    citedBy?: string,
  ): { recorded: KnowledgeRef[]; existing: KnowledgeRef[]; rejected: Array<{ knowledgeId: string; revision: number; reason: string }> } {
    validateContext(context);
    identifier(runId);
    this.boundSnapshot(context, snapshot);
    const actor = citedBy ?? `plugin:${context.pluginId}`;
    identifier(actor);
    if (!Array.isArray(refs) || refs.length > 256) throw new Error('KNOWLEDGE_CITATION_INVALID');
    const byKey = new Map(snapshot.records.map((ref) => [`${ref.knowledgeId}@${ref.revision}`, ref]));
    const recorded: KnowledgeRef[] = [];
    const existing: KnowledgeRef[] = [];
    const rejected: Array<{ knowledgeId: string; revision: number; reason: string }> = [];
    for (const ref of refs) {
      if (!ref || typeof ref.knowledgeId !== 'string' || !Number.isSafeInteger(ref.revision))
        throw new Error('KNOWLEDGE_CITATION_INVALID');
      identifier(ref.knowledgeId);
      const bound = byKey.get(`${ref.knowledgeId}@${ref.revision}`);
      if (!bound) {
        rejected.push({ knowledgeId: ref.knowledgeId, revision: ref.revision, reason: 'NOT_IN_SNAPSHOT' });
        continue;
      }
      if (ref.contentDigest !== undefined && ref.contentDigest !== bound.contentDigest) {
        rejected.push({ knowledgeId: ref.knowledgeId, revision: ref.revision, reason: 'DIGEST_MISMATCH' });
        continue;
      }
      const key = this.store.recordCitation({
        runId,
        snapshotDigest: snapshot.snapshotDigest,
        knowledgeId: bound.knowledgeId,
        revision: bound.revision,
        contentDigest: bound.contentDigest,
        citedBy: actor,
        citedAt: new Date().toISOString(),
      });
      if (key === 'new') recorded.push(bound);
      else existing.push(bound);
    }
    return { recorded, existing, rejected };
  }
  citations(context: KnowledgeContext, runId: string): CitationRecord[] {
    validateContext(context);
    identifier(runId);
    return this.store.citationsForRun(runId);
  }
  // ================= L2 个人记忆（§5 preferences.* 操作合同） =================
  /** owner 永远从可信身份派生；租户来自身份断言（orgId/region），不从参数取。 */
  private principalTenant(principal: KnowledgePrincipal): { orgId?: string; region?: string } {
    identifier(principal.actorId);
    if (principal.orgId !== undefined) identifier(principal.orgId);
    if (principal.region !== undefined) identifier(principal.region);
    return {
      ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}),
      ...(principal.region !== undefined ? { region: principal.region } : {}),
    };
  }
  /** 本人偏好清单：乙永远查不到甲的条目——查询键里的 owner 来自身份，API 没有 owner 参数可传。 */
  preferencesGetMine(principal: KnowledgePrincipal, options: { pluginId?: string } = {}): PersonalSettingRecord[] {
    const items = this.store.personalSettingsForOwner(this.principalTenant(principal), principal.actorId);
    if (!options.pluginId) return items;
    identifier(options.pluginId);
    return items.filter((item) => item.pluginKey === '' || item.pluginKey === options.pluginId);
  }
  /** 保存偏好：值按封闭注册表 schema 校验；版本比较更新（同键过期修订拒绝，不用最后写入覆盖）。
   *  暂停中的键再次保存即恢复 ACTIVE（本人明确选择）。 */
  preferencesSetMine(
    principal: KnowledgePrincipal,
    input: { key: string; value: unknown; pluginId?: string; expectedRevision: number },
  ): PersonalSettingRecord {
    const schema = preferenceSchema(input.key);
    const value = validatePreferenceValue(schema, input.value);
    let pluginKey = '';
    if (input.pluginId !== undefined) {
      identifier(input.pluginId);
      if (!schema.pluginScopeAllowed) throw new Error('PREFERENCE_PLUGIN_SCOPE_INVALID');
      pluginKey = input.pluginId;
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw new Error('PREFERENCE_REVISION_INVALID');
    const tenant = this.principalTenant(principal);
    return this.store.personalSettingUpsert(
      { ...tenant, owner: principal.actorId, pluginKey, key: schema.key, value },
      input.expectedRevision,
    );
  }
  preferencesPauseMine(principal: KnowledgePrincipal, key: string, pluginId?: string): PersonalSettingRecord {
    return this.preferenceTransition(principal, key, pluginId, 'PAUSED');
  }
  /** 删除=墓碑（值清理、备份恢复先重放墓碑）；重复删除幂等返回原墓碑。 */
  preferencesDeleteMine(principal: KnowledgePrincipal, key: string, pluginId?: string): PersonalSettingRecord {
    return this.preferenceTransition(principal, key, pluginId, 'DELETED');
  }
  private preferenceTransition(
    principal: KnowledgePrincipal,
    key: string,
    pluginId: string | undefined,
    state: 'PAUSED' | 'DELETED',
  ): PersonalSettingRecord {
    const schema = preferenceSchema(key);
    let pluginKey = '';
    if (pluginId !== undefined) {
      identifier(pluginId);
      if (!schema.pluginScopeAllowed) throw new Error('PREFERENCE_PLUGIN_SCOPE_INVALID');
      pluginKey = pluginId;
    }
    return this.store.personalSettingSetState(this.principalTenant(principal), principal.actorId, pluginKey, schema.key, state);
  }
  /** 注入 Run 的受限引用：只含 key/pluginKey/revision，永不携带值（LearningBinding §4）。
   *  仅 ACTIVE 参与（PAUSED/DELETED 不注入）；全局键与插件覆盖都适用。 */
  preferencesForRunBinding(principal: KnowledgePrincipal, pluginId: string): PreferenceRef[] {
    identifier(pluginId);
    return this.store
      .personalSettingsForOwner(this.principalTenant(principal), principal.actorId)
      .filter((item) => item.state === 'ACTIVE' && (item.pluginKey === '' || item.pluginKey === pluginId))
      .map((item) => ({ key: item.key, pluginKey: item.pluginKey, revision: item.revision }));
  }
  // ================= L2 私人方法草稿：私有记录，不当作事实或组织标准 =================
  personalDraftCreate(
    principal: KnowledgePrincipal,
    input: { pluginId?: string; title: string; body: string },
  ): PersonalDraftRecord {
    const tenant = this.principalTenant(principal);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)
      throw new Error('PERSONAL_DRAFT_INVALID');
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 50000)
      throw new Error('PERSONAL_DRAFT_INVALID');
    if (input.pluginId !== undefined) identifier(input.pluginId);
    const body = {
      title: input.title,
      body: input.body,
      ...(input.pluginId !== undefined ? { pluginId: input.pluginId } : {}),
    };
    return this.store.personalDraftInsert({
      draftId: randomUUID(),
      ...tenant,
      owner: principal.actorId,
      ...(input.pluginId !== undefined ? { pluginId: input.pluginId } : {}),
      title: input.title,
      body: input.body,
      digest: digest(body),
    });
  }
  personalDraftsListMine(principal: KnowledgePrincipal): PersonalDraftRecord[] {
    return this.store.personalDraftsForOwner(this.principalTenant(principal), principal.actorId);
  }
  personalDraftUpdateMine(
    principal: KnowledgePrincipal,
    draftId: string,
    expectedRevision: number,
    patch: { title?: string; body?: string },
  ): PersonalDraftRecord {
    identifier(draftId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('PERSONAL_DRAFT_REVISION_INVALID');
    const existing = this.store.personalDraftGet(draftId);
    // 越权与不存在对无权限方不可区分（§5）：owner 不符一律 NOT_FOUND，不泄露存在性。
    if (!existing || existing.owner !== principal.actorId || existing.state !== 'ACTIVE')
      throw new Error('PERSONAL_DRAFT_NOT_FOUND');
    const title = patch.title ?? existing.title;
    const body = patch.body ?? existing.body;
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('PERSONAL_DRAFT_INVALID');
    if (typeof body !== 'string' || !body.trim() || body.length > 50000) throw new Error('PERSONAL_DRAFT_INVALID');
    return this.store.personalDraftUpdate(draftId, principal.actorId, expectedRevision, {
      title,
      body,
      digest: digest({
        title,
        body,
        ...(existing.pluginId !== undefined ? { pluginId: existing.pluginId } : {}),
      }),
    });
  }
  personalDraftDeleteMine(principal: KnowledgePrincipal, draftId: string): PersonalDraftRecord {
    identifier(draftId);
    return this.store.personalDraftDelete(draftId, principal.actorId);
  }
  // ================= L3 学习个案与提案（§5 learning.proposeFromCase 行为合同） =================
  /** 打开个案：幂等键 (tenant, pluginId, eventId, hypothesisKey)；重复打开返回原个案（duplicate=true）。 */
  learningCaseOpen(
    context: KnowledgeContext,
    input: { sourceEvent: LearningCaseSourceEvent; hypothesisKey: string; category?: string },
  ): { case: LearningCaseRecord; duplicate: boolean } {
    validateContext(context);
    const sourceEvent = parseLearningCaseSourceEvent(input.sourceEvent);
    identifier(input.hypothesisKey);
    if (
      input.category !== undefined &&
      (typeof input.category !== 'string' || !input.category.trim() || input.category.length > 160)
    )
      throw new Error('LEARNING_CASE_INVALID');
    const existing = this.store.learningCaseByEventKey(context, context.pluginId, sourceEvent.eventId, input.hypothesisKey);
    if (existing) return { case: existing, duplicate: true };
    const now = new Date().toISOString();
    const record: LearningCaseRecord = {
      caseId: randomUUID(),
      orgId: context.orgId ?? '',
      region: context.region ?? '',
      pluginId: context.pluginId,
      ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
      sourceEvent,
      hypothesisKey: input.hypothesisKey,
      ...(input.category !== undefined ? { category: input.category } : {}),
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.store.learningCaseInsert(record);
    } catch (error) {
      // 并发打开同键个案：唯一索引兜底，返回已存在的个案（与投影台账同样的幂等语义）。
      const raced = this.store.learningCaseByEventKey(context, context.pluginId, sourceEvent.eventId, input.hypothesisKey);
      if (raced) return { case: raced, duplicate: true };
      throw error;
    }
    return { case: record, duplicate: false };
  }
  /** 个案清单：按上下文插件与租户过滤；PENDING/NO_REUSABLE 都是有效结局，不隐瞒。 */
  learningCases(context: KnowledgeContext, options: { status?: LearningCaseStatus; limit?: number } = {}): LearningCaseRecord[] {
    validateContext(context);
    return this.store.learningCasesList(context, context.pluginId, options);
  }
  /** 个案处置：无需复用（NO_REUSABLE）与暂挂（PENDING）都是有效结局；已提案个案不可改判。 */
  learningCaseDispose(
    context: KnowledgeContext,
    caseId: string,
    disposition: 'NO_REUSABLE' | 'PENDING' | 'CONFLICT',
    reason?: string,
  ): LearningCaseRecord {
    validateContext(context);
    identifier(caseId);
    const record = this.learningCaseVisible(context, caseId);
    if (record.status === 'PROPOSED') throw new Error('LEARNING_CASE_ALREADY_PROPOSED');
    if (!['NO_REUSABLE', 'PENDING', 'CONFLICT'].includes(disposition)) throw new Error('LEARNING_DISPOSITION_INVALID');
    if (disposition === 'CONFLICT' && (typeof reason !== 'string' || !reason.trim()))
      throw new Error('LEARNING_DISPOSITION_INVALID');
    return this.store.learningCaseUpdateStatus(caseId, disposition, record.proposal);
  }
  private learningCaseVisible(context: KnowledgeContext, caseId: string): LearningCaseRecord {
    const record = this.store.learningCaseGet(caseId);
    if (
      !record ||
      record.orgId !== (context.orgId ?? '') ||
      record.region !== (context.region ?? '') ||
      record.pluginId !== context.pluginId
    )
      throw new Error('LEARNING_CASE_NOT_FOUND');
    return record;
  }
  /** 从个案提出公共候选：去项目化**新建**记录，不原地改可见性；拒绝直接 ACTIVE、拒绝携带项目身份。
   *  幂等：同幂等键同内容返回原 candidateRef；同键不同内容返回冲突（不用最后写入覆盖）。
   *  eventRef 用个案来源事件的真实 runId 与摘要（KA12），候选仍是 CANDIDATE，激活仍走 claims/coverage。 */
  proposeFromCase(
    context: KnowledgeContext,
    principal: KnowledgePrincipal,
    input: {
      caseId: string;
      /** 私人贡献必须显式选择（§2 界面例子：先看到将提议的去项目化文本、范围和用途）。 */
      contributionConfirmed: boolean;
      idempotencyKey: string;
      draft: Omit<KnowledgeDraft, 'eventRef' | 'scope' | 'pluginId' | 'projectId'> & { scope?: string; projectId?: string };
    },
  ): { knowledgeId: string; revision: number; contentDigest: string; duplicate: boolean; caseId: string } {
    validateContext(context);
    identifier(principal.actorId);
    identifier(input.idempotencyKey);
    if (input.contributionConfirmed !== true) throw new Error('LEARNING_CONTRIBUTION_NOT_CONFIRMED');
    const source = this.learningCaseVisible(context, input.caseId);
    const raw = input.draft as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('KNOWLEDGE_DRAFT_INVALID');
    if (raw.state !== undefined) throw new Error('LEARNING_STATE_OVERRIDE_NOT_ALLOWED');
    if (raw.projectId !== undefined) throw new Error('LEARNING_PROPOSAL_PROJECT_LEAK');
    if (raw.scope !== undefined && raw.scope !== 'plugin') throw new Error('LEARNING_SCOPE_ESCALATION_NOT_ALLOWED');
    const normalized = normalizeDraft({
      ...(raw as unknown as Omit<KnowledgeDraft, 'eventRef' | 'scope' | 'pluginId' | 'projectId'>),
      scope: 'plugin',
      pluginId: context.pluginId,
    });
    const draftDigest = digest(normalized);
    // 幂等台账先于个案状态门：同一人工纠错的重复投递（即使个案已转为 PROPOSED）返回原回执（§5），
    // 相同键不同内容返回冲突——两种情况都不用最后写入覆盖。
    const tenant = { orgId: context.orgId, region: context.region };
    const existing = this.store.learningProposalGet(tenant, input.idempotencyKey);
    if (existing) {
      if (existing.draftDigest !== draftDigest) throw new Error('LEARNING_PROPOSAL_CONFLICT');
      return {
        knowledgeId: existing.knowledgeId,
        revision: existing.revision,
        contentDigest: existing.contentDigest,
        duplicate: true,
        caseId: existing.caseId,
      };
    }
    // 仅 PENDING 个案可提案：PROPOSED 已绑定候选，NO_REUSABLE/CONFLICT 是显式处置结局
    //（可先经 learningCaseDispose(…,'PENDING') 复位再提案，处置留台账）。
    if (source.status !== 'PENDING') throw new Error(source.status === 'PROPOSED' ? 'LEARNING_CASE_ALREADY_PROPOSED' : 'LEARNING_CASE_NOT_OPEN');
    const candidate = this.capture(context, {
      ...normalized,
      eventRef: {
        kind: source.sourceEvent.kind,
        runId: source.sourceEvent.runId,
        ...(source.sourceEvent.inputDigest !== undefined ? { inputDigest: source.sourceEvent.inputDigest } : {}),
        at: new Date().toISOString(),
      },
    });
    this.store.learningProposalInsert({
      orgId: context.orgId,
      region: context.region,
      idempotencyKey: input.idempotencyKey,
      caseId: source.caseId,
      knowledgeId: candidate.knowledgeId,
      revision: candidate.revision,
      contentDigest: candidate.contentDigest,
      draftDigest,
    });
    this.store.learningCaseUpdateStatus(source.caseId, 'PROPOSED', {
      knowledgeId: candidate.knowledgeId,
      revision: candidate.revision,
      proposedAt: new Date().toISOString(),
      proposedBy: principal.actorId,
    });
    return {
      knowledgeId: candidate.knowledgeId,
      revision: candidate.revision,
      contentDigest: candidate.contentDigest,
      duplicate: false,
      caseId: source.caseId,
    };
  }
  // ================= L3 发布清单（§4 KnowledgeRelease / §5 release.* 行为合同） =================
  /** 发布：entries 必须是本插件、本租户、当前 ACTIVE 的修订；清单不可变（内容寻址），
   *  当前指针按 expectedVersion 原子切换。发布角色（授权在控制面）决定目标受众，不凭模型评分放行。 */
  publishRelease(
    principal: KnowledgePrincipal,
    input: {
      pluginId: string;
      audience: string;
      entries: Array<{ knowledgeId: string; revision: number }>;
      evalReportRef?: string;
      expectedVersion: number;
    },
  ): { release: KnowledgeReleaseRecord; pointer: KnowledgeReleasePointer } {
    const tenant = this.principalTenant(principal);
    identifier(input.pluginId);
    if (typeof input.audience !== 'string' || !input.audience.trim() || input.audience.length > 160)
      throw new Error('RELEASE_AUDIENCE_INVALID');
    identifier(input.audience);
    if (input.evalReportRef !== undefined && (typeof input.evalReportRef !== 'string' || !input.evalReportRef.trim() || input.evalReportRef.length > 512))
      throw new Error('RELEASE_EVAL_REF_INVALID');
    if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 256)
      throw new Error('RELEASE_ENTRIES_INVALID');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
      throw new Error('RELEASE_VERSION_INVALID');
    const entries: KnowledgeReleaseEntry[] = [];
    const seen = new Set<string>();
    for (const raw of input.entries) {
      if (typeof raw?.knowledgeId !== 'string' || !Number.isSafeInteger(raw?.revision) || raw.revision < 1)
        throw new Error('RELEASE_ENTRIES_INVALID');
      if (seen.has(raw.knowledgeId)) throw new Error('RELEASE_ENTRY_DUPLICATE');
      seen.add(raw.knowledgeId);
      const record = this.store.get(raw.knowledgeId, raw.revision);
      if (!record || record.state !== 'ACTIVE') throw new Error('RELEASE_ENTRY_NOT_ACTIVE');
      if (record.scope !== 'plugin' || record.pluginId !== input.pluginId) throw new Error('RELEASE_ENTRY_PLUGIN_MISMATCH');
      if ((record.orgId ?? '') !== (principal.orgId ?? '') || (record.region ?? '') !== (principal.region ?? ''))
        throw new Error('RELEASE_ENTRY_TENANT_MISMATCH');
      entries.push({ knowledgeId: record.knowledgeId, revision: record.revision, contentDigest: record.contentDigest });
    }
    const currentPointer = this.store.releasePointer(input.pluginId, tenant);
    const prevReleaseId = currentPointer?.releaseId;
    const manifestBody = {
      schemaVersion: 1,
      pluginId: input.pluginId,
      orgId: principal.orgId ?? '',
      region: principal.region ?? '',
      audience: input.audience,
      entries,
      ...(prevReleaseId !== undefined ? { prevReleaseId } : {}),
    };
    const manifestDigest = digest(manifestBody);
    const release: KnowledgeReleaseRecord = {
      releaseId: randomUUID(),
      pluginId: input.pluginId,
      orgId: principal.orgId ?? '',
      region: principal.region ?? '',
      audience: input.audience,
      entries,
      manifestDigest,
      ...(input.evalReportRef !== undefined ? { evalReportRef: input.evalReportRef } : {}),
      approver: principal.actorId,
      ...(prevReleaseId !== undefined ? { prevReleaseId } : {}),
      state: 'CURRENT',
      createdAt: new Date().toISOString(),
    };
    return this.store.transaction(() => {
      this.store.releaseInsert(release);
      const pointer = this.store.releasePointerSwitch(input.pluginId, tenant, release.releaseId, manifestDigest, input.expectedVersion);
      return { release, pointer };
    });
  }
  /** 撤回：先阻止新取用（台账逐条失效），返回影响范围供控制面列出待复核 Run；不改写历史事实。 */
  withdrawRelease(principal: KnowledgePrincipal, releaseId: string, reason: string): {
    releaseId: string;
    entries: KnowledgeReleaseEntry[];
    affectedReleases: string[];
  } {
    identifier(principal.actorId);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new Error('RELEASE_REASON_INVALID');
    const release = this.store.releaseGet(releaseId);
    // 跨租户与不存在对无权限方不可区分。
    if (!release || release.orgId !== (principal.orgId ?? '') || release.region !== (principal.region ?? ''))
      throw new Error('RELEASE_NOT_FOUND');
    if (release.state !== 'CURRENT') throw new Error('RELEASE_ALREADY_WITHDRAWN');
    this.store.releaseWithdraw(releaseId, release.entries, reason);
    const withdrawnKeys = new Set(release.entries.map((entry) => `${entry.knowledgeId}@${entry.revision}`));
    const affectedReleases = this.store
      .releasesList({ orgId: principal.orgId, region: principal.region }, release.pluginId, { state: 'CURRENT' })
      .filter((other) => other.releaseId !== releaseId && other.entries.some((entry) => withdrawnKeys.has(`${entry.knowledgeId}@${entry.revision}`)))
      .map((other) => other.releaseId);
    return { releaseId, entries: release.entries, affectedReleases };
  }
  /** 回滚：只切换到仍获准（CURRENT）的清单；撤回条目不因回滚复活（台账继续生效）。 */
  rollbackRelease(
    principal: KnowledgePrincipal,
    input: { pluginId: string; expectedVersion: number; toReleaseId?: string; reason: string },
  ): { pointer: KnowledgeReleasePointer; release: KnowledgeReleaseRecord } {
    this.principalTenant(principal);
    identifier(input.pluginId);
    if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('RELEASE_REASON_INVALID');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('RELEASE_VERSION_INVALID');
    const tenant = { orgId: principal.orgId, region: principal.region };
    const current = this.store.releasePointer(input.pluginId, tenant);
    if (!current) throw new Error('RELEASE_POINTER_MISSING');
    if (current.version !== input.expectedVersion) throw new Error('RELEASE_VERSION_STALE');
    let target: KnowledgeReleaseRecord | undefined;
    if (input.toReleaseId !== undefined) {
      identifier(input.toReleaseId);
      target = this.store.releaseGet(input.toReleaseId);
      if (!target || target.pluginId !== input.pluginId || target.orgId !== (principal.orgId ?? '') || target.region !== (principal.region ?? ''))
        throw new Error('RELEASE_NOT_FOUND');
    } else {
      const currentRelease = this.store.releaseGet(current.releaseId);
      target = currentRelease?.prevReleaseId !== undefined ? this.store.releaseGet(currentRelease.prevReleaseId) : undefined;
    }
    if (!target) throw new Error('RELEASE_ROLLBACK_TARGET_MISSING');
    if (target.state !== 'CURRENT') throw new Error('RELEASE_ROLLBACK_TARGET_WITHDRAWN');
    const pointer = this.store.releasePointerSwitch(input.pluginId, tenant, target.releaseId, target.manifestDigest, input.expectedVersion);
    return { pointer, release: target };
  }
  releasesList(
    principal: KnowledgePrincipal,
    input: { pluginId: string; state?: KnowledgeReleaseRecord['state']; limit?: number },
  ): KnowledgeReleaseRecord[] {
    identifier(input.pluginId);
    if (input.state !== undefined && !['CURRENT', 'WITHDRAWN'].includes(input.state)) throw new Error('RELEASE_STATE_INVALID');
    return this.store.releasesList({ orgId: principal.orgId, region: principal.region }, input.pluginId, {
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }
  releasePointerInfo(principal: KnowledgePrincipal, pluginId: string): KnowledgeReleasePointer | undefined {
    identifier(pluginId);
    return this.store.releasePointer(pluginId, { orgId: principal.orgId, region: principal.region });
  }
  /** 读取单个发布（租户掩蔽：跨租户与不存在对无权限方不可区分）。 */
  getRelease(principal: KnowledgePrincipal, releaseId: string): KnowledgeReleaseRecord | undefined {
    identifier(principal.actorId);
    const release = this.store.releaseGet(releaseId);
    if (!release || release.orgId !== (principal.orgId ?? '') || release.region !== (principal.region ?? '')) return undefined;
    return release;
  }
  /** Runs installed actual tests, binds their results to the exact candidate, and activates only when
   *  every claim the knowledge declares is covered by the installed suite. A suite without coverage is a
   *  tool-regression check: its receipt is recorded, but the knowledge stays CANDIDATE. */
  async validate(context: KnowledgeContext, id: string, revision: number, validatorId: string) {
    const record = this.get(context, id, revision);
    if (record.state !== 'CANDIDATE' || record.kind === 'project_decision')
      throw new Error('KNOWLEDGE_NOT_TECHNICAL_CANDIDATE');
    if (!record.preconditions.length || !record.counterexamples.length || !record.sources.length)
      throw new Error('KNOWLEDGE_EVIDENCE_INCOMPLETE');
    const suite = this.suites.get(`${context.pluginId}:${validatorId}`);
    if (!suite) throw new Error('KNOWLEDGE_VALIDATOR_NOT_REGISTERED');
    if (!suite.knowledgeIds.includes(id)) throw new Error('KNOWLEDGE_VALIDATOR_TARGET_MISMATCH');
    if (!['positive', 'negative', 'boundary'].every((g) => suite.cases.some((c) => c.group === g)))
      throw new Error('KNOWLEDGE_CASE_GROUPS_INCOMPLETE');
    const results = [];
    for (const testCase of suite.cases) {
      try {
        const actual = await suite.execute(structuredClone(record), structuredClone(testCase));
        results.push({
          id: testCase.id,
          group: testCase.group,
          passed: canonical(actual) === canonical(testCase.expected),
          actualDigest: digest(actual),
          expectedDigest: digest(testCase.expected),
        });
      } catch {
        results.push({ id: testCase.id, group: testCase.group, passed: false, error: 'VALIDATION_EXECUTION_FAILED' });
      }
    }
    const declaredClaims = [...(record.claims ?? [])];
    const binding = suite.coverage?.find((entry) => entry.knowledgeId === id);
    const contentBindingMatches = binding?.candidateDigest === record.contentDigest;
    const coveredClaims = contentBindingMatches ? [...(binding?.claims ?? [])] : [];
    const uncoveredClaims = declaredClaims.filter((claim) => !coveredClaims.includes(claim));
    const testsPassed = results.every((r) => r.passed);
    const evidenceEntries = binding?.evidence ?? [];
    const passedCaseIds = new Set(results.filter((r) => r.passed).map((r) => r.id));
    // 向后兼容：未声明 evidence 的已安装套件沿用既有 claims/coverage 语义；
    // 一旦声明 evidence，则必须全部指向当前套件且 caseIds 均为本次实际通过的用例。
    const evidenceValid = evidenceEntries.length === 0 || evidenceEntries.every((entry) =>
      entry.suiteId === suite.id && entry.suiteVersion === suite.version &&
      entry.caseIds.length > 0 && entry.caseIds.every((caseId) => passedCaseIds.has(caseId)));
    const contentActivation = testsPassed && contentBindingMatches === true && declaredClaims.length > 0 &&
      uncoveredClaims.length === 0 && evidenceValid;
    const validationScope = contentActivation ? ('CONTENT_CLAIMS' as const) : ('TOOL_REGRESSION_ONLY' as const);
    const receipt = {
      id: randomUUID(),
      candidateId: id,
      revision,
      candidateDigest: record.contentDigest,
      validatorId: suite.id,
      validatorVersion: suite.version,
      caseDigest: digest(suite.cases),
      passed: testsPassed,
      contentBinding: { matched: contentBindingMatches, candidateDigest: record.contentDigest, boundDigest: binding?.candidateDigest ?? null },
      claimEvidence: { valid: evidenceValid, entries: evidenceEntries },
      validationScope,
      claims: { declared: declaredClaims, covered: coveredClaims, uncovered: uncoveredClaims },
      results,
      recordedAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.validation(receipt.id, record, receipt);
      const latest = this.get(context, id);
      if (
        latest.revision !== revision ||
        latest.contentDigest !== record.contentDigest ||
        latest.state !== 'CANDIDATE'
      ) {
        this.store.event(id, revision, 'VALIDATION_STALE_NOT_ACTIVATED', { receiptId: receipt.id });
        return;
      }
      // Contribution disposal or validator replacement while awaiting tests cannot activate old code.
      if (this.suites.get(`${context.pluginId}:${validatorId}`) !== suite) {
        this.store.event(id, revision, 'VALIDATOR_CHANGED_NOT_ACTIVATED', { receiptId: receipt.id });
        return;
      }
      if (!testsPassed) {
        this.store.event(id, revision, 'VALIDATION_FAILED', { receiptId: receipt.id });
        return;
      }
      if (!contentActivation) {
        // Fixed helper tests passing is not evidence that the knowledge text is correct.
        this.store.event(id, revision, 'VALIDATION_SCOPE_INSUFFICIENT', {
          receiptId: receipt.id,
          reason: declaredClaims.length === 0 ? 'NO_DECLARED_CLAIMS' : contentBindingMatches !== true ? 'CONTENT_BINDING_MISMATCH' : uncoveredClaims.length > 0 ? 'UNCOVERED_CLAIMS' : 'CLAIM_EVIDENCE_INVALID',
          declaredClaims,
          coveredClaims,
          uncoveredClaims,
        });
        return;
      }
      this.store.supersedeActive(id, revision);
      this.store.setState(id, revision, 'ACTIVE', {
        receiptId: receipt.id,
        validationScope,
        validatedClaims: declaredClaims,
      });
    });
    return { ...receipt, state: this.get(context, id, revision).state };
  }
  /** KA13：为已安装套件签发跨进程验证请求；候选与套件摘要都从 store 读取，不接受模型自报。 */
  createValidationRequestFor(
    context: KnowledgeContext,
    id: string,
    revision: number,
    validatorId: string,
    actor: string,
    executionEpoch = 1,
  ): ValidationRequest {
    validateContext(context);
    identifier(id);
    identifier(actor);
    const record = this.get(context, id, revision);
    if (record.state !== 'CANDIDATE' || record.kind === 'project_decision') {
      throw new Error('KNOWLEDGE_NOT_TECHNICAL_CANDIDATE');
    }
    if (!record.preconditions.length || !record.counterexamples.length || !record.sources.length) {
      throw new Error('KNOWLEDGE_EVIDENCE_INCOMPLETE');
    }
    const suite = this.suites.get(`${context.pluginId}:${validatorId}`);
    if (!suite) throw new Error('KNOWLEDGE_VALIDATOR_NOT_REGISTERED');
    if (!suite.knowledgeIds.includes(id)) throw new Error('KNOWLEDGE_VALIDATOR_TARGET_MISMATCH');
    if (!['positive', 'negative', 'boundary'].every((group) => suite.cases.some((c) => c.group === group))) {
      throw new Error('KNOWLEDGE_CASE_GROUPS_INCOMPLETE');
    }
    if (!Number.isSafeInteger(executionEpoch) || executionEpoch < 1) throw new Error('KNOWLEDGE_EPOCH_INVALID');
    return createValidationRequest({
      requestId: randomUUID(),
      actor,
      pluginId: context.pluginId,
      knowledgeId: id,
      revision,
      candidateDigest: record.contentDigest,
      validatorId: suite.id,
      validatorVersion: suite.version,
      validatorDigest: validatorDigest(suite),
      caseSetDigest: caseSetDigest(suite),
      executionEpoch,
      issuedAt: new Date().toISOString(),
    });
  }

  /**
   * Apply an out-of-process validation receipt. The center never trusts the executor's prose: the
   * request must bind this candidate revision/digest and the installed suite, every declared case
   * must have exactly one result, and activation follows the same claims/coverage rules as the
   * in-process path. A receipt is recorded as evidence even when activation is refused.
   */
  validateWithReceipt(
    context: KnowledgeContext,
    id: string,
    revision: number,
    request: ValidationRequest,
    receipt: ValidationReceipt,
    allowedExecutors: readonly string[],
  ): { receiptDigest: string; state: State; reason?: string; validationScope: 'CONTENT_CLAIMS' | 'TOOL_REGRESSION_ONLY'; duplicate: boolean } {
    validateContext(context);
    identifier(id);
    const record = this.get(context, id, revision);
    const suite = this.suites.get(`${context.pluginId}:${request.validatorId}`);
    if (!suite) throw new Error('KNOWLEDGE_VALIDATOR_NOT_REGISTERED');
    if (request.pluginId !== context.pluginId || request.knowledgeId !== id || request.revision !== revision) {
      throw new Error('KNOWLEDGE_REQUEST_TARGET_MISMATCH');
    }
    if (!bindRequestCandidate(request, record)) throw new Error('KNOWLEDGE_REQUEST_DIGEST_MISMATCH');
    // The request must describe the currently installed suite, not an older one the executor kept.
    if (request.validatorVersion !== suite.version || request.validatorDigest !== validatorDigest(suite)) {
      throw new Error('KNOWLEDGE_VALIDATOR_CHANGED');
    }
    if (request.caseSetDigest !== caseSetDigest(suite)) throw new Error('KNOWLEDGE_CASE_SET_CHANGED');
    const verified = verifyValidationReceipt(request, receipt, [...allowedExecutors]);
    if (!verified.ok) throw new Error(`KNOWLEDGE_RECEIPT_REJECTED:${verified.reason}`);
    const expectedCases = new Map(suite.cases.map((testCase) => [testCase.id, testCase]));
    if (receipt.results.length !== suite.cases.length) throw new Error('KNOWLEDGE_RECEIPT_CASE_COUNT_MISMATCH');
    const seen = new Set<string>();
    const results: ValidationResult[] = receipt.results.map((result) => {
      const expected = expectedCases.get(result.id);
      if (!expected || seen.has(result.id)) throw new Error('KNOWLEDGE_RECEIPT_CASE_MISMATCH');
      seen.add(result.id);
      if (result.group !== expected.group) throw new Error('KNOWLEDGE_RECEIPT_GROUP_MISMATCH');
      if (result.expectedDigest !== digest(expected.expected)) throw new Error('KNOWLEDGE_RECEIPT_EXPECTATION_MISMATCH');
      return { ...result };
    });
    const declaredClaims = [...(record.claims ?? [])];
    const binding = suite.coverage?.find((entry) => entry.knowledgeId === id);
    const contentBindingMatches = binding?.candidateDigest === record.contentDigest;
    const coveredClaims = contentBindingMatches ? [...(binding?.claims ?? [])] : [];
    const uncoveredClaims = declaredClaims.filter((claim) => !coveredClaims.includes(claim));
    const testsPassed = results.every((result) => result.passed);
    const passedCaseIds = new Set(results.filter((result) => result.passed).map((result) => result.id));
    const evidenceEntries = binding?.evidence ?? [];
    const evidenceValid = evidenceEntries.length === 0 || evidenceEntries.every((entry) =>
      entry.suiteId === suite.id && entry.suiteVersion === suite.version &&
      entry.caseIds.length > 0 && entry.caseIds.every((caseId) => passedCaseIds.has(caseId)));
    const contentActivation = testsPassed && contentBindingMatches === true && declaredClaims.length > 0 &&
      uncoveredClaims.length === 0 && evidenceValid;
    const validationScope = contentActivation ? ('CONTENT_CLAIMS' as const) : ('TOOL_REGRESSION_ONLY' as const);
    const receiptId = receiptDigest(receipt);
    // 一次性回执（M2-03）：同一回执重复投递幂等返回原结局；同一请求的第二份不同回执拒绝。
    const already = this.store.receiptByDigest(receiptId);
    if (already) {
      const current = this.get(context, id);
      return {
        receiptDigest: receiptId,
        state: current.state,
        ...(already.outcome === 'ACTIVATED' ? {} : { reason: already.outcome }),
        validationScope: already.validationScope as 'CONTENT_CLAIMS' | 'TOOL_REGRESSION_ONLY',
        duplicate: true,
      };
    }
    if (this.store.receiptByRequest(request.requestId)) throw new Error('KNOWLEDGE_RECEIPT_ALREADY_APPLIED');
    let state: State = record.state;
    let reason: string | undefined;
    let outcome = 'NOT_APPLIED';
    this.store.transaction(() => {
      this.store.validation(receiptId, record, {
        source: 'cross-process',
        requestDigest: receipt.requestDigest,
        executorId: receipt.executorId,
        results,
        validationScope,
        passed: testsPassed,
      });
      const latest = this.get(context, id);
      if (latest.revision !== revision || latest.contentDigest !== record.contentDigest || latest.state !== 'CANDIDATE') {
        this.store.event(id, revision, 'VALIDATION_RECEIPT_STALE', { receiptId });
        state = latest.state;
        reason = 'VALIDATION_STALE_NOT_ACTIVATED';
        outcome = reason;
        return;
      }
      if (!testsPassed) {
        this.store.event(id, revision, 'VALIDATION_FAILED', { receiptId, source: 'cross-process' });
        state = latest.state;
        reason = 'VALIDATION_FAILED';
        outcome = reason;
        return;
      }
      if (!contentActivation) {
        this.store.event(id, revision, 'VALIDATION_SCOPE_INSUFFICIENT', {
          receiptId,
          source: 'cross-process',
          reason: declaredClaims.length === 0
            ? 'NO_DECLARED_CLAIMS'
            : contentBindingMatches !== true
              ? 'CONTENT_BINDING_MISMATCH'
              : uncoveredClaims.length > 0
                ? 'UNCOVERED_CLAIMS'
                : 'CLAIM_EVIDENCE_INVALID',
          declaredClaims,
          coveredClaims,
          uncoveredClaims,
        });
        state = latest.state;
        reason = 'VALIDATION_SCOPE_INSUFFICIENT';
        outcome = reason;
        return;
      }
      this.store.supersedeActive(id, revision);
      this.store.setState(id, revision, 'ACTIVE', {
        receiptId,
        source: 'cross-process',
        executorId: receipt.executorId,
        validationScope,
        validatedClaims: declaredClaims,
      });
      state = 'ACTIVE';
      outcome = 'ACTIVATED';
    });
    this.store.recordReceipt({
      receiptDigest: receiptId,
      requestId: request.requestId,
      pluginId: context.pluginId,
      knowledgeId: id,
      revision,
      executorId: receipt.executorId,
      outcome,
      validationScope,
      detail: reason ? { reason } : {},
      appliedAt: new Date().toISOString(),
    });
    return { receiptDigest: receiptId, state, ...(reason ? { reason } : {}), validationScope, duplicate: false };
  }
  /** Learning/validation event feed for one knowledge id; visibility is enforced before any row loads. */
  events(
    context: KnowledgeContext,
    knowledgeId: string,
    offset = 0,
    limit = 50,
  ): { items: ReturnType<KnowledgeStore['recentEvents']>; total: number; offset: number } {
    validateContext(context);
    identifier(knowledgeId);
    this.get(context, knowledgeId); // throws KNOWLEDGE_NOT_FOUND when invisible
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('KNOWLEDGE_PAGE_INVALID');
    const items = this.store.recentEvents(knowledgeId, offset, limit);
    // SQL COUNT keeps total exact past any page size; a fetched-length total would cap paging silently.
    return { items, total: this.store.countEvents(knowledgeId), offset };
  }
  /** KA14：检查运行快照所绑定的知识引用是否已被撤回/冲突/替代，便于工作台如实提示重新评估。
   *  不修改快照、不改写历史；运行事实仍由控制面拥有。 */
  checkSnapshotImpact(
    context: KnowledgeContext,
    snapshot: { records: Array<{ knowledgeId: string; revision: number }> },
  ): { affected: Array<{ knowledgeId: string; boundRevision: number; currentState: string; currentRevision: number }>; unchanged: number } {
    validateContext(context);
    const affected: Array<{ knowledgeId: string; boundRevision: number; currentState: string; currentRevision: number }> = [];
    let unchanged = 0;
    for (const ref of snapshot.records ?? []) {
      if (typeof ref?.knowledgeId !== 'string' || !Number.isSafeInteger(ref.revision)) continue;
      let current: KnowledgeRecord | undefined;
      try {
        current = this.get(context, ref.knowledgeId);
      } catch {
        // 跨租户/项目或已删除的引用不得泄露存在性；不计入受影响（工作台仍可使用原快照）。
        unchanged++;
        continue;
      }
      if (current.state === 'REVOKED' || current.state === 'CONFLICT' || current.revision > ref.revision)
        affected.push({
          knowledgeId: ref.knowledgeId,
          boundRevision: ref.revision,
          currentState: current.state,
          currentRevision: current.revision,
        });
      else unchanged++;
    }
    return { affected, unchanged };
  }
  setState(
    context: KnowledgeContext,
    id: string,
    expectedRevision: number,
    state: 'CONFLICT' | 'REVOKED',
    reason: string,
  ): void {
    if (!['CONFLICT', 'REVOKED'].includes(state) || !reason.trim()) throw new Error('KNOWLEDGE_TRANSITION_INVALID');
    this.store.transaction(() => {
      const record = this.get(context, id);
      if (record.revision !== expectedRevision) throw new Error('KNOWLEDGE_REVISION_STALE');
      // Revocation/conflict removes all formerly active revisions from new default retrieval.
      for (const row of this.store
        .scoped(context.pluginId, context.projectId, { orgId: context.orgId, region: context.region })
        .filter((r) => r.knowledgeId === id && (r.state === 'ACTIVE' || r.revision === expectedRevision))) {
        this.store.setState(id, row.revision, state, { reason });
      }
    });
  }
  snapshot(context: KnowledgeContext, runId: string) {
    validateContext(context);
    identifier(runId);
    return this.store.transaction(() => this.createSnapshot(context, runId));
  }
  /** 文档语料摄入（KA10）：按文档整体幂等重导；digest 与分片数不变时跳过写入。 */
  ingestDocument(docPath: string, text: string): { docPath: string; docDigest: string; chunks: number; skipped: boolean } {
    if (
      typeof docPath !== 'string' ||
      !docPath ||
      docPath.length > 512 ||
      docPath.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(docPath) ||
      docPath.split(/[\\/]/).some((segment) => segment === '..' || segment === '')
    )
      throw new Error('KNOWLEDGE_DOC_PATH_INVALID');
    if (typeof text !== 'string' || !text.trim()) throw new Error('KNOWLEDGE_DOC_BODY_INVALID');
    if (text.length > 2_000_000) throw new Error('KNOWLEDGE_DOC_BODY_TOO_LARGE');
    const entry = documentEntry(docPath, text);
    const state = this.store.corpusDocState(docPath);
    if (state && state.docDigest === entry.docDigest && state.chunks === entry.chunks.length)
      return { docPath, docDigest: entry.docDigest, chunks: entry.chunks.length, skipped: true };
    const result = this.store.replaceDocChunks(docPath, entry.docDigest, entry.chunks);
    return { ...result, skipped: false };
  }
  /** 文档语料检索：返回可点击引用（doc_path + 行号 + 标题路径），引用不替代原文。 */
  searchCorpus(options: { query: string; offset?: number; limit?: number; docPrefixes?: readonly string[] }) {
    const { offset = 0, limit = 20 } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('KNOWLEDGE_PAGE_INVALID');
    const terms = (options.query ?? '').normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error('KNOWLEDGE_QUERY_REQUIRED');
    const mapRow = (row: Record<string, unknown>) => {
      const body = String(row.body ?? '');
      return {
        docPath: String(row.doc_path),
        docDigest: String(row.doc_digest),
        lineStart: Number(row.line_start),
        lineEnd: Number(row.line_end),
        heading: String(row.heading),
        headingPath: String(row.heading_path ?? '').split(' / '),
        locale: String(row.locale),
        bodyChars: body.length,
        excerpt: body.length > 240 ? body.slice(0, 240) + '…' : body,
        citation: `${String(row.doc_path)}#L${Number(row.line_start)}-L${Number(row.line_end)}`,
      };
    };
    const ftsEligible =
      this.store.chunksFtsEnabled && terms.length > 0 && terms.every((term) => [...term].length >= 3 && !term.includes('"'));
    if (ftsEligible) {
      const match = terms.map((term) => `"${term}"`).join(' ');
      const page = this.store.searchChunksFts(match, offset, limit, options.docPrefixes);
      return {
        items: page.items.map(mapRow),
        total: page.total,
        offset,
        nextOffset: offset + limit < page.total ? offset + limit : null,
        searchMode: 'FTS5_TRIGRAM' as const,
      };
    }
    // 短词/含引号降级：SQL LIKE（不折叠 NFKC，语义弱于 FTS 路径）。
    const page = this.store.searchChunksLike(terms, offset, limit, options.docPrefixes);
    return {
      items: page.items.map(mapRow),
      total: page.total,
      offset,
      nextOffset: offset + limit < page.total ? offset + limit : null,
      searchMode: 'SQL_LIKE' as const,
    };
  }
  private createSnapshot(context: KnowledgeContext, runId: string) {
    // 与只读绑定口共用同一实现（snapshot-readonly.readSnapshot）：发布清单/撤回台账语义一处维护，
    // tests/snapshot-readonly.test.mjs 保证两条入口逐字节一致。发布指针存在时快照取清单条目
    // （剔除已撤回/非 ACTIVE/不可见条目）——新 Run 绑定新版，同一旧 Run 不漂移。
    const resolved = readSnapshot(this.store.path, context);
    if (!resolved) throw new Error('KNOWLEDGE_SNAPSHOT_UNAVAILABLE');
    const snapshot = { context: resolved.context, records: resolved.records, snapshotDigest: resolved.snapshotDigest };
    // 键包含租户（L1）：不同组织同 runId 的快照不得碰撞。
    this.store.saveSnapshot(this.snapshotKey(context, runId), snapshot);
    return snapshot;
  }
  private snapshotKey(context: KnowledgeContext, runId: string): string {
    return JSON.stringify([context.pluginId, context.projectId ?? null, context.orgId ?? '', context.region ?? '', runId]);
  }
  /** KA16：一致备份（由部署/运维调用；知识服务仍是唯一写者，备份只读源库）。 */
  backup(targetPath: string): void {
    if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('KNOWLEDGE_BACKUP_PATH_INVALID');
    this.store.backup(targetPath);
  }
  readSnapshot(context: KnowledgeContext, runId: string): unknown {
    validateContext(context);
    identifier(runId);
    return this.store.snapshot(this.snapshotKey(context, runId));
  }
}
