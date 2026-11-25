import { createHash } from 'node:crypto';
export type Scope = 'shared' | 'plugin' | 'project';
export type State = 'CANDIDATE' | 'ACTIVE' | 'CONFLICT' | 'SUPERSEDED' | 'REVOKED';
export type KnowledgeKind = 'technical_method' | 'edc_method' | 'scenario_method' | 'project_decision';
export interface KnowledgeContext {
  pluginId: string;
  projectId?: string;
  scenario?: string;
  edc?: string;
  /** 租户与区域（KA07/08）：服务端从 Principal 派生；工具参数只能收窄，永不扩大。 */
  orgId?: string;
  region?: string;
  /** 查询语言面（KA09）：'zh-CN' / 'en-US' 等；缺失时不按语言过滤。 */
  locale?: string;
}
/** 语言面（KA09）：语言与作用域正交；别名只参与检索召回，不替代正文。 */
export interface KnowledgeI18n {
  primaryLocale: string;
  locales: string[];
  aliases: Record<string, string[]>;
  translation?: { fromLocale: string; fromRevision: number; state: 'authored' | 'translated' | 'stale' };
}
/** 运行事件绑定（KA12）：候选必须带真实 runId 与输入/产物摘要，模型不能自报事件。 */
export interface KnowledgeEventRef {
  kind: 'run.failed' | 'program.revised' | 'qc.completed' | 'business.clarified';
  runId: string;
  inputDigest?: string;
  artifactDigest?: string;
  at?: string;
}
export interface KnowledgeDraft {
  knowledgeId: string;
  scope: Scope;
  pluginId?: string;
  projectId?: string;
  orgId?: string;
  region?: string;
  i18n?: KnowledgeI18n;
  eventRef?: KnowledgeEventRef;
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
export interface ClaimEvidence {
  /** 该 claim 必须由哪条已安装套件的哪些用例证明。模型不能自行提供 expected 或 execute。 */
  suiteId: string;
  suiteVersion: string;
  caseIds: readonly string[];
}
export interface ClaimCoverage {
  knowledgeId: string;
  candidateDigest: string;
  claims: readonly string[];
  evidence?: readonly ClaimEvidence[];
}
export interface ValidationSuite {
  id: string;
  version: string;
  knowledgeIds: readonly string[];
  cases: readonly MethodCase[];
  /** Claims reproduced for one exact normalized candidate draft. A missing or mismatched binding
   *  makes this suite tool-regression-only; bindings are installed metadata, never model input. */
  coverage?: readonly ClaimCoverage[];
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
  if (context.orgId !== undefined) identifier(context.orgId);
  if (context.region !== undefined) identifier(context.region);
  if (context.locale !== undefined && (typeof context.locale !== 'string' || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(context.locale)))
    throw new Error('KNOWLEDGE_LOCALE_INVALID');
}
/** 租户/区域：可选但一旦提供必须稳定；shared 记录归属平台租户。 */
function tenantFields(value: KnowledgeDraft, result: Record<string, unknown>): void {
  if (value.orgId !== undefined) {
    identifier(value.orgId);
    result.orgId = value.orgId;
  }
  if (value.region !== undefined) {
    identifier(value.region);
    result.region = value.region;
  }
  if (value.i18n !== undefined) {
    const i18n = value.i18n;
    if (!i18n || typeof i18n !== 'object' || Array.isArray(i18n)) throw new Error('KNOWLEDGE_I18N_INVALID');
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(i18n.primaryLocale ?? '')) throw new Error('KNOWLEDGE_I18N_INVALID');
    if (!Array.isArray(i18n.locales) || i18n.locales.length > 32 || i18n.locales.some((l) => typeof l !== 'string' || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(l)))
      throw new Error('KNOWLEDGE_I18N_INVALID');
    if (!i18n.aliases || typeof i18n.aliases !== 'object' || Array.isArray(i18n.aliases)) throw new Error('KNOWLEDGE_I18N_INVALID');
    const aliases: Record<string, string[]> = {};
    for (const [locale, values] of Object.entries(i18n.aliases)) {
      if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(locale) || !Array.isArray(values) || values.length > 128 || values.some((v) => typeof v !== 'string' || !v.trim() || v.length > 256))
        throw new Error('KNOWLEDGE_I18N_INVALID');
      aliases[locale] = [...new Set(values)];
    }
    result.i18n = { primaryLocale: i18n.primaryLocale, locales: [...new Set(i18n.locales)], aliases };
    if (i18n.translation !== undefined) {
      const translation = i18n.translation;
      if (!translation || typeof translation !== 'object' || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(translation.fromLocale ?? '') ||
        !Number.isSafeInteger(translation.fromRevision) || translation.fromRevision < 1 ||
        !['authored', 'translated', 'stale'].includes(translation.state))
        throw new Error('KNOWLEDGE_I18N_INVALID');
      (result.i18n as KnowledgeI18n).translation = { ...translation };
    }
  }
  if (value.eventRef !== undefined) {
    const ref = value.eventRef;
    if (!ref || typeof ref !== 'object' ||
      !['run.failed', 'program.revised', 'qc.completed', 'business.clarified'].includes(ref.kind) ||
      typeof ref.runId !== 'string' || !ref.runId || ref.runId.length > 160 ||
      (ref.inputDigest !== undefined && !/^[a-f0-9]{64}$/.test(ref.inputDigest)) ||
      (ref.artifactDigest !== undefined && !/^[a-f0-9]{64}$/.test(ref.artifactDigest)) ||
      (ref.at !== undefined && !Number.isFinite(Date.parse(ref.at))))
      throw new Error('KNOWLEDGE_EVENT_REF_INVALID');
    result.eventRef = { kind: ref.kind, runId: ref.runId,
      ...(ref.inputDigest !== undefined ? { inputDigest: ref.inputDigest } : {}),
      ...(ref.artifactDigest !== undefined ? { artifactDigest: ref.artifactDigest } : {}),
      ...(ref.at !== undefined ? { at: ref.at } : {}) };
  }
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
  tenantFields(value, result);
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
