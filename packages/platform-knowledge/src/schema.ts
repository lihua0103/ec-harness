import { createHash } from 'node:crypto';
export type Scope = 'shared' | 'plugin' | 'project';
export type State = 'CANDIDATE' | 'ACTIVE' | 'CONFLICT' | 'SUPERSEDED' | 'REVOKED';
export type KnowledgeKind = 'technical_method' | 'edc_method' | 'scenario_method' | 'project_decision';
export interface KnowledgeContext {
  pluginId: string;
  projectId?: string;
  scenario?: string;
  edc?: string;
}
export interface KnowledgeDraft {
  knowledgeId: string;
  scope: Scope;
  pluginId?: string;
  projectId?: string;
  kind: KnowledgeKind;
  title: string;
  problemSignal: string;
  cause: string;
  method: string;
  scenarios: string[];
  edc: string[];
  topics: string[];
  preconditions: string[];
  notApplicable: string[];
  counterexamples: string[];
  sources: string[];
  derivedFrom?: string;
  /** Machine-reproducible assertions this knowledge makes. Activation is limited to these claims;
   *  a method without claims may still be captured and reviewed but cannot become ACTIVE. */
  claims?: string[];
}
export interface KnowledgeRecord extends KnowledgeDraft {
  revision: number;
  contentDigest: string;
  state: State;
  createdAt: string;
}
export interface PluginContribution {
  pluginId: string;
  scenarioAliases: Record<string, string[]>;
}
export type CaseGroup = 'positive' | 'negative' | 'boundary';
export interface MethodCase {
  id: string;
  group: CaseGroup;
  input: unknown;
  expected: unknown;
}
export interface ValidationSuite {
  id: string;
  version: string;
  knowledgeIds: readonly string[];
  cases: readonly MethodCase[];
  /** Claims reproduced for one exact normalized candidate draft. A missing or mismatched binding
   *  makes this suite tool-regression-only; bindings are installed metadata, never model input. */
  coverage?: readonly { knowledgeId: string; candidateDigest: string; claims: readonly string[] }[];
  /** Installed code supplies actual execution; not callable or replaceable from model JSON. */
  execute: (record: Readonly<KnowledgeRecord>, testCase: Readonly<MethodCase>) => Promise<unknown>;
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  throw new Error('KNOWLEDGE_NON_JSON_VALUE');
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 160 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value))
    throw new Error('KNOWLEDGE_ID_INVALID');
}
export function validateContext(context: KnowledgeContext): void {
  identifier(context.pluginId);
  if (context.projectId !== undefined) identifier(context.projectId);
  if (context.scenario !== undefined) identifier(context.scenario);
  if (context.edc !== undefined) identifier(context.edc);
}
export function normalizeDraft(value: KnowledgeDraft): KnowledgeDraft {
  if (!value || typeof value !== 'object') throw new Error('KNOWLEDGE_DRAFT_INVALID');
  identifier(value.knowledgeId);
  if (
    !['shared', 'plugin', 'project'].includes(value.scope) ||
    !['technical_method', 'edc_method', 'scenario_method', 'project_decision'].includes(value.kind)
  )
    throw new Error('KNOWLEDGE_SCOPE_INVALID');
  if (value.scope === 'shared') {
    if (value.pluginId !== undefined || value.projectId !== undefined) throw new Error('KNOWLEDGE_SCOPE_INVALID');
  } else {
    identifier(value.pluginId);
    if (value.scope === 'project') identifier(value.projectId);
    else if (value.projectId !== undefined) throw new Error('KNOWLEDGE_SCOPE_INVALID');
  }
  if (value.kind === 'project_decision' && value.scope !== 'project')
    throw new Error('KNOWLEDGE_DECISION_SCOPE_INVALID');
  const result: Record<string, unknown> = { knowledgeId: value.knowledgeId, scope: value.scope, kind: value.kind };
  if (value.pluginId !== undefined) result.pluginId = value.pluginId;
  if (value.projectId !== undefined) result.projectId = value.projectId;
  for (const key of ['title', 'problemSignal', 'cause', 'method'] as const) {
    const text = value[key];
    if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new Error('KNOWLEDGE_TEXT_INVALID');
    result[key] = text;
  }
  for (const key of [
    'scenarios',
    'edc',
    'topics',
    'preconditions',
    'notApplicable',
    'counterexamples',
    'sources',
  ] as const) {
    const list = value[key];
    if (
      !Array.isArray(list) ||
      list.length > 128 ||
      list.some((v) => typeof v !== 'string' || !v.trim() || v.length > 4096)
    )
      throw new Error('KNOWLEDGE_LIST_INVALID');
    result[key] = [...new Set(list)];
  }
  if (value.claims !== undefined) {
    const claims = value.claims;
    if (
      !Array.isArray(claims) ||
      claims.length > 64 ||
      claims.some((c) => typeof c !== 'string' || !c.trim() || c.length > 512)
    )
      throw new Error('KNOWLEDGE_CLAIMS_INVALID');
    const unique = [...new Set(claims.map((c) => c.trim()))];
    if (unique.length) result.claims = unique;
  }
  if (value.derivedFrom !== undefined) {
    identifier(value.derivedFrom);
    result.derivedFrom = value.derivedFrom;
  }
  if (canonical(result).length > 200000) throw new Error('KNOWLEDGE_DRAFT_TOO_LARGE');
  return result as unknown as KnowledgeDraft;
}
export function draftFromRecord(record: KnowledgeRecord): KnowledgeDraft {
  return normalizeDraft(record);
}
