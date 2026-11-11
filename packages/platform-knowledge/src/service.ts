import { randomUUID } from 'node:crypto';
import { KnowledgeStore } from './store.js';
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
  constructor(path: string) {
    this.store = new KnowledgeStore(path);
  }
  close(): void {
    this.store.close();
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
      return Object.freeze({ knowledgeId: entry.knowledgeId, candidateDigest: entry.candidateDigest, claims: Object.freeze(claims) });
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
    if (!this.visible(context, { ...body, revision: 0, contentDigest: '', state: 'CANDIDATE', createdAt: '' }))
      throw new Error('KNOWLEDGE_CONTEXT_MISMATCH');
    return this.store.transaction(() => this.store.insert(body, expectedRevision));
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
    const rows = this.store.scoped(context.pluginId, context.projectId);
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
    const contentActivation = testsPassed && contentBindingMatches === true && declaredClaims.length > 0 && uncoveredClaims.length === 0;
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
          reason: declaredClaims.length === 0 ? 'NO_DECLARED_CLAIMS' : contentBindingMatches !== true ? 'CONTENT_BINDING_MISMATCH' : 'UNCOVERED_CLAIMS',
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
        .scoped(context.pluginId, context.projectId)
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
  private createSnapshot(context: KnowledgeContext, runId: string) {
    const records = this.search(context, { limit: 100 });
    // Never silently truncate the snapshot when there are more than 100 matching methods.
    const refs = records.items.map((r) => ({
      knowledgeId: r.knowledgeId,
      revision: r.revision,
      contentDigest: r.contentDigest,
    }));
    for (let offset = 100; offset < records.total; offset += 100)
      refs.push(
        ...this.search(context, { limit: 100, offset }).items.map((r) => ({
          knowledgeId: r.knowledgeId,
          revision: r.revision,
          contentDigest: r.contentDigest,
        })),
      );
    const cleanContext = Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined));
    const body = { context: cleanContext, records: refs },
      snapshot = { ...body, snapshotDigest: digest(body) };
    this.store.saveSnapshot(JSON.stringify([context.pluginId, context.projectId ?? null, runId]), snapshot);
    return snapshot;
  }
  readSnapshot(context: KnowledgeContext, runId: string): unknown {
    validateContext(context);
    identifier(runId);
    return this.store.snapshot(JSON.stringify([context.pluginId, context.projectId ?? null, runId]));
  }
}
