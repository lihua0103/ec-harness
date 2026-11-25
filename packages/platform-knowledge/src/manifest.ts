/** M2-01：插件知识智能体注册合同（schemaVersion 2）。
 *  一个纳管插件身份对应一个可发现、可版本化、可独立验收的智能体定义；本模块只做定义的解析/校验、
 *  版本并存与注册表，不认证调用者身份（注册权限由平台装配方提供）。
 *  定义缺失、字段未知或证据不足一律拒绝，不做静默补全。 */
import { readFileSync } from 'node:fs';
import { digest, identifier } from './schema.js';

export const KNOWLEDGE_MANIFEST_SCHEMA_VERSION = 2 as const;
export type FeedbackEventKind =
  | 'run.failed'
  | 'run.succeeded'
  | 'qc.completed'
  | 'program.revised'
  | 'business.clarified';
const FEEDBACK_EVENTS: readonly FeedbackEventKind[] = [
  'run.failed',
  'run.succeeded',
  'qc.completed',
  'program.revised',
  'business.clarified',
];

export interface KnowledgeSeedDeclaration {
  knowledgeId: string;
  topics: string[];
  claims?: number;
  validator?: string;
}
export interface KnowledgeValidatorDeclaration {
  id: string;
  version: string;
  covers: string[];
}
export interface GoldenCase {
  query: string;
  expect: string[];
  /** 允许的负例：查询应返回空集合（未命中诚实性）。 */
  expectEmpty?: boolean;
}
export interface KnowledgeAgentDeclaration {
  /** 智能体身份（与插件身份分离）与定义版本；Run 按发布版本解析，不默认换用新版。 */
  id: string;
  version: string;
  owner: string;
  topics: string[];
  tools: Array<{ tool: string; topics: string[] }>;
  noMethodTools: Array<{ tool: string; reason: string }>;
}
export interface KnowledgeScopeDeclarationV2 {
  orgId?: string;
  region?: string;
  /** 'all' 仅用于显式声明的平台级插件；具体项目列表用于项目级智能体。 */
  projects?: 'all' | string[];
}
export interface KnowledgeManifest {
  schemaVersion: typeof KNOWLEDGE_MANIFEST_SCHEMA_VERSION;
  pluginId: string;
  owner: string;
  source: string;
  taxonomy: { topics: string[]; scenarioAliases?: Record<string, string[]> };
  seeds: KnowledgeSeedDeclaration[];
  validators: KnowledgeValidatorDeclaration[];
  capabilities: Array<{ tool: string; topics: string[] }>;
  noMethodKnowledge: Array<{ tool: string; reason: string }>;
  agent: KnowledgeAgentDeclaration;
  feedback: { events: FeedbackEventKind[]; projectionVersion: string };
  goldenSet: { id: string; version: string; cases: GoldenCase[] };
  corpus?: { source: string; docPrefixes: string[] };
  scope: KnowledgeScopeDeclarationV2;
}

const TOP_LEVEL = new Set([
  'schemaVersion', 'pluginId', 'owner', 'source', 'taxonomy', 'seeds', 'validators',
  'capabilities', 'noMethodKnowledge', 'agent', 'feedback', 'goldenSet', 'corpus', 'scope',
]);
function fail(code: string): never {
  throw new Error(code);
}
const object = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    fail(code);
  return value as Record<string, unknown>;
};
const unknownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, code: string): void => {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${code}:${key}`);
};
const nonEmpty = (value: unknown, max = 4096): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('KNOWLEDGE_MANIFEST_TEXT_INVALID');
  return value.trim();
};
const identifierList = (value: unknown, code: string, max = 128): string[] => {
  if (!Array.isArray(value) || value.length > max) fail(code);
  for (const item of value) identifier(item);
  return [...new Set(value as string[])];
};
const identifierValue = (value: unknown): string => {
  identifier(value);
  return value;
};
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

/** 严格解析：未知字段、空定义、断链的验证器/黄金集都拒绝，不把“缺声明”当作无方法。 */
export function parseKnowledgeManifest(value: unknown): KnowledgeManifest {
  const raw = object(value, 'KNOWLEDGE_MANIFEST_INVALID');
  unknownKeys(raw, TOP_LEVEL, 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
  if (raw.schemaVersion !== KNOWLEDGE_MANIFEST_SCHEMA_VERSION) fail('KNOWLEDGE_MANIFEST_SCHEMA_UNSUPPORTED');
  const pluginId = identifierValue(raw.pluginId);
  const owner = nonEmpty(raw.owner, 200);
  const source = nonEmpty(raw.source, 512);

  const taxonomyRaw = object(raw.taxonomy, 'KNOWLEDGE_MANIFEST_TAXONOMY_INVALID');
  unknownKeys(taxonomyRaw, new Set(['topics', 'scenarioAliases']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
  const topics = identifierList(taxonomyRaw.topics, 'KNOWLEDGE_MANIFEST_TOPICS_INVALID');
  if (!topics.length) fail('KNOWLEDGE_MANIFEST_TOPICS_INVALID');
  const scenarioAliases: Record<string, string[]> = {};
  if (taxonomyRaw.scenarioAliases !== undefined) {
    const aliases = object(taxonomyRaw.scenarioAliases, 'KNOWLEDGE_MANIFEST_ALIAS_INVALID');
    for (const [key, values] of Object.entries(aliases)) {
      identifier(key);
      scenarioAliases[key] = identifierList(values, 'KNOWLEDGE_MANIFEST_ALIAS_INVALID');
    }
  }

  const seedsRaw = raw.seeds;
  if (!Array.isArray(seedsRaw) || seedsRaw.length > 512) fail('KNOWLEDGE_MANIFEST_SEEDS_INVALID');
  const seeds: KnowledgeSeedDeclaration[] = [];
  for (const entry of seedsRaw) {
    const seed = object(entry, 'KNOWLEDGE_MANIFEST_SEEDS_INVALID');
    unknownKeys(seed, new Set(['knowledgeId', 'topics', 'claims', 'validator']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
    const knowledgeId = identifierValue(seed.knowledgeId);
    const seedTopics = identifierList(seed.topics, 'KNOWLEDGE_MANIFEST_SEEDS_INVALID');
    if (seed.claims !== undefined && (!Number.isSafeInteger(seed.claims) || (seed.claims as number) < 0))
      fail('KNOWLEDGE_MANIFEST_SEEDS_INVALID');
    if (seed.validator !== undefined) identifier(seed.validator);
    seeds.push({
      knowledgeId,
      topics: seedTopics,
      ...(seed.claims !== undefined ? { claims: seed.claims as number } : {}),
      ...(seed.validator !== undefined ? { validator: seed.validator as string } : {}),
    });
  }
  if (new Set(seeds.map((seed) => seed.knowledgeId)).size !== seeds.length) fail('KNOWLEDGE_MANIFEST_SEEDS_DUPLICATE');

  const validatorsRaw = raw.validators;
  if (!Array.isArray(validatorsRaw) || validatorsRaw.length > 64) fail('KNOWLEDGE_MANIFEST_VALIDATORS_INVALID');
  const validators: KnowledgeValidatorDeclaration[] = [];
  for (const entry of validatorsRaw) {
    const validator = object(entry, 'KNOWLEDGE_MANIFEST_VALIDATORS_INVALID');
    unknownKeys(validator, new Set(['id', 'version', 'covers']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
    const covers = identifierList(validator.covers, 'KNOWLEDGE_MANIFEST_VALIDATORS_INVALID');
    if (!covers.length) fail('KNOWLEDGE_MANIFEST_VALIDATORS_INVALID');
    validators.push({
      id: identifierValue(validator.id),
      version: identifierValue(validator.version),
      covers,
    });
  }
  if (new Set(validators.map((validator) => validator.id)).size !== validators.length)
    fail('KNOWLEDGE_MANIFEST_VALIDATORS_DUPLICATE');
  for (const seed of seeds) {
    if (!seed.validator) continue;
    // 声明了验证器的种子必须由该验证器覆盖，不能指向不存在的套件。
    const validator = validators.find((entry) => entry.id === seed.validator);
    if (!validator || !validator.covers.includes(seed.knowledgeId)) fail('KNOWLEDGE_MANIFEST_VALIDATOR_UNBOUND');
  }

  const capabilitiesRaw = raw.capabilities;
  if (!Array.isArray(capabilitiesRaw) || capabilitiesRaw.length > 128) fail('KNOWLEDGE_MANIFEST_CAPABILITIES_INVALID');
  const capabilities = capabilitiesRaw.map((entry) => {
    const capability = object(entry, 'KNOWLEDGE_MANIFEST_CAPABILITIES_INVALID');
    unknownKeys(capability, new Set(['tool', 'topics']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
    return { tool: identifierValue(capability.tool), topics: identifierList(capability.topics, 'KNOWLEDGE_MANIFEST_CAPABILITIES_INVALID') };
  });
  const noMethodRaw = raw.noMethodKnowledge ?? [];
  if (!Array.isArray(noMethodRaw) || noMethodRaw.length > 128) fail('KNOWLEDGE_MANIFEST_CAPABILITIES_INVALID');
  const noMethodKnowledge = noMethodRaw.map((entry) => {
    const capability = object(entry, 'KNOWLEDGE_MANIFEST_CAPABILITIES_INVALID');
    unknownKeys(capability, new Set(['tool', 'reason']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
    return { tool: identifierValue(capability.tool), reason: nonEmpty(capability.reason, 512) };
  });
  // “无方法知识”是逐能力说明，不能让整插件跳过接入。
  if (!seeds.length && !capabilities.length) fail('KNOWLEDGE_MANIFEST_EMPTY');

  const agentRaw = object(raw.agent, 'KNOWLEDGE_MANIFEST_AGENT_INVALID');
  unknownKeys(agentRaw, new Set(['id', 'version', 'owner', 'topics', 'tools', 'noMethodTools']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
  const agentTopics = identifierList(agentRaw.topics, 'KNOWLEDGE_MANIFEST_AGENT_INVALID');
  if (!agentTopics.length) fail('KNOWLEDGE_MANIFEST_AGENT_INVALID');
  const agentTools = Array.isArray(agentRaw.tools) ? agentRaw.tools.map((entry) => {
    const tool = object(entry, 'KNOWLEDGE_MANIFEST_AGENT_INVALID');
    unknownKeys(tool, new Set(['tool', 'topics']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
    return { tool: identifierValue(tool.tool), topics: identifierList(tool.topics, 'KNOWLEDGE_MANIFEST_AGENT_INVALID') };
  }) : fail('KNOWLEDGE_MANIFEST_AGENT_INVALID');
  const agentNoMethod = Array.isArray(agentRaw.noMethodTools) ? agentRaw.noMethodTools.map((entry) => {
    const tool = object(entry, 'KNOWLEDGE_MANIFEST_AGENT_INVALID');
    unknownKeys(tool, new Set(['tool', 'reason']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
    return { tool: identifierValue(tool.tool), reason: nonEmpty(tool.reason, 512) };
  }) : fail('KNOWLEDGE_MANIFEST_AGENT_INVALID');
  const agent: KnowledgeAgentDeclaration = {
    id: identifierValue(agentRaw.id),
    version: identifierValue(agentRaw.version),
    owner: nonEmpty(agentRaw.owner, 200),
    topics: agentTopics,
    tools: agentTools,
    noMethodTools: agentNoMethod,
  };

  const feedbackRaw = object(raw.feedback, 'KNOWLEDGE_MANIFEST_FEEDBACK_INVALID');
  unknownKeys(feedbackRaw, new Set(['events', 'projectionVersion']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
  if (!Array.isArray(feedbackRaw.events) || !feedbackRaw.events.length) fail('KNOWLEDGE_MANIFEST_FEEDBACK_INVALID');
  for (const event of feedbackRaw.events) {
    if (!FEEDBACK_EVENTS.includes(event as FeedbackEventKind)) fail('KNOWLEDGE_MANIFEST_FEEDBACK_INVALID');
  }
  const feedback = {
    events: [...new Set(feedbackRaw.events as FeedbackEventKind[])],
    projectionVersion: identifierValue(feedbackRaw.projectionVersion),
  };

  const goldenRaw = object(raw.goldenSet, 'KNOWLEDGE_MANIFEST_GOLDEN_INVALID');
  unknownKeys(goldenRaw, new Set(['id', 'version', 'cases']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
  if (!Array.isArray(goldenRaw.cases) || !goldenRaw.cases.length || goldenRaw.cases.length > 256)
    fail('KNOWLEDGE_MANIFEST_GOLDEN_INVALID');
  const cases = goldenRaw.cases.map((entry) => {
    const item = object(entry, 'KNOWLEDGE_MANIFEST_GOLDEN_INVALID');
    unknownKeys(item, new Set(['query', 'expect', 'expectEmpty']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
    const query = nonEmpty(item.query, 512);
    const expect = item.expect === undefined ? [] : identifierList(item.expect, 'KNOWLEDGE_MANIFEST_GOLDEN_INVALID');
    const expectEmpty = item.expectEmpty === true;
    if (!expect.length && !expectEmpty) fail('KNOWLEDGE_MANIFEST_GOLDEN_INVALID');
    if (expect.length && expectEmpty) fail('KNOWLEDGE_MANIFEST_GOLDEN_INVALID');
    return { query, expect, ...(expectEmpty ? { expectEmpty } : {}) };
  });

  let corpus: KnowledgeManifest['corpus'];
  if (raw.corpus !== undefined) {
    const corpusRaw = object(raw.corpus, 'KNOWLEDGE_MANIFEST_CORPUS_INVALID');
    unknownKeys(corpusRaw, new Set(['source', 'docPrefixes']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
    const docPrefixes = nonEmptyList(corpusRaw.docPrefixes, 'KNOWLEDGE_MANIFEST_CORPUS_INVALID');
    corpus = { source: nonEmpty(corpusRaw.source, 512), docPrefixes };
  }

  const scopeRaw = object(raw.scope, 'KNOWLEDGE_MANIFEST_SCOPE_INVALID');
  unknownKeys(scopeRaw, new Set(['orgId', 'region', 'projects']), 'KNOWLEDGE_MANIFEST_UNKNOWN_FIELD');
  const scope: KnowledgeScopeDeclarationV2 = {};
  if (scopeRaw.orgId !== undefined) scope.orgId = identifierValue(scopeRaw.orgId);
  if (scopeRaw.region !== undefined) scope.region = identifierValue(scopeRaw.region);
  if (scopeRaw.projects !== undefined) {
    if (scopeRaw.projects === 'all') scope.projects = 'all';
    else {
      const projects = identifierList(scopeRaw.projects, 'KNOWLEDGE_MANIFEST_SCOPE_INVALID');
      if (!projects.length) fail('KNOWLEDGE_MANIFEST_SCOPE_INVALID');
      scope.projects = projects;
    }
  }
  if (!scope.orgId && !scope.region && scope.projects === undefined) fail('KNOWLEDGE_MANIFEST_SCOPE_INVALID');

  return deepFreeze({
    schemaVersion: KNOWLEDGE_MANIFEST_SCHEMA_VERSION,
    pluginId,
    owner,
    source,
    taxonomy: { topics, ...(Object.keys(scenarioAliases).length ? { scenarioAliases } : {}) },
    seeds,
    validators,
    capabilities,
    noMethodKnowledge,
    agent,
    feedback,
    goldenSet: {
      id: identifierValue(goldenRaw.id),
      version: identifierValue(goldenRaw.version),
      cases,
    },
    ...(corpus ? { corpus } : {}),
    scope,
  });
}

function nonEmptyList(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) fail(code);
  const list = value.map((item) => nonEmpty(item, 512));
  return [...new Set(list)];
}

export function manifestDigest(manifest: KnowledgeManifest): string {
  return digest(manifest);
}

export function readKnowledgeManifest(path: string): KnowledgeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('KNOWLEDGE_MANIFEST_UNREADABLE');
  }
  return parseKnowledgeManifest(parsed);
}

export interface RegisteredKnowledgeAgent {
  manifest: KnowledgeManifest;
  digest: string;
  registeredAt: string;
}
export type AgentRegistryEvent =
  | { operation: 'REGISTERED'; pluginId: string; version: string; digest: string; at: string }
  | { operation: 'DUPLICATE_IGNORED'; pluginId: string; version: string; digest: string; at: string }
  | { operation: 'ACTIVATED'; pluginId: string; version: string; at: string }
  | { operation: 'UNREGISTERED'; pluginId: string; version: string; at: string };

/** 注册表：同一插件可并存多个智能体版本（蓝绿/新旧同时运行），Run 按显式版本解析；
 *  重复的 (pluginId, agentVersion) 只有内容一致才算幂等，内容不同直接拒绝。 */
export class KnowledgeAgentRegistry {
  private readonly versions = new Map<string, Map<string, RegisteredKnowledgeAgent>>();
  private readonly active = new Map<string, string>();
  private readonly log: AgentRegistryEvent[] = [];

  register(value: unknown, options: { activate?: boolean } = {}): { pluginId: string; version: string; digest: string; status: 'REGISTERED' | 'EXISTING' } {
    // 无论调用方传的是 JSON 还是已解析对象，都重新走完整校验（不接受未校验的强制断言）。
    const checked = parseKnowledgeManifest(value);
    const pluginId = checked.pluginId;
    const version = checked.agent.version;
    const hash = manifestDigest(checked);
    const byVersion = this.versions.get(pluginId) ?? new Map<string, RegisteredKnowledgeAgent>();
    const existing = byVersion.get(version);
    const at = new Date().toISOString();
    if (existing) {
      if (existing.digest !== hash) throw new Error('KNOWLEDGE_AGENT_VERSION_CONFLICT');
      this.log.push({ operation: 'DUPLICATE_IGNORED', pluginId, version, digest: hash, at });
      return { pluginId, version, digest: hash, status: 'EXISTING' };
    }
    byVersion.set(version, { manifest: checked, digest: hash, registeredAt: at });
    this.versions.set(pluginId, byVersion);
    this.log.push({ operation: 'REGISTERED', pluginId, version, digest: hash, at });
    if (options.activate !== false && !this.active.has(pluginId)) {
      this.active.set(pluginId, version);
      this.log.push({ operation: 'ACTIVATED', pluginId, version, at });
    }
    return { pluginId, version, digest: hash, status: 'REGISTERED' };
  }

  /** 显式激活某版本（蓝绿切换）；Run 创建时必须按发布版本显式解析，不能依赖“最新”。 */
  activate(pluginId: string, version: string): void {
    identifier(pluginId);
    identifier(version);
    if (!this.versions.get(pluginId)?.has(version)) throw new Error('KNOWLEDGE_AGENT_NOT_REGISTERED');
    this.active.set(pluginId, version);
    this.log.push({ operation: 'ACTIVATED', pluginId, version, at: new Date().toISOString() });
  }

  unregister(pluginId: string, version?: string): number {
    identifier(pluginId);
    const byVersion = this.versions.get(pluginId);
    if (!byVersion) return 0;
    const targets = version === undefined ? [...byVersion.keys()] : (identifier(version), [version]);
    let removed = 0;
    for (const target of targets) {
      if (byVersion.delete(target)) {
        removed++;
        this.log.push({ operation: 'UNREGISTERED', pluginId, version: target, at: new Date().toISOString() });
      }
      if (this.active.get(pluginId) === target) this.active.delete(pluginId);
    }
    if (!byVersion.size) this.versions.delete(pluginId);
    return removed;
  }

  /** 不传版本时只解析“当前激活版本”；没有激活版本就不猜最新。 */
  resolve(pluginId: string, version?: string): KnowledgeManifest | undefined {
    const byVersion = this.versions.get(pluginId);
    if (!byVersion) return undefined;
    if (version !== undefined) return byVersion.get(version)?.manifest;
    const active = this.active.get(pluginId);
    return active === undefined ? undefined : byVersion.get(active)?.manifest;
  }

  activeVersion(pluginId: string): string | undefined {
    return this.active.get(pluginId);
  }

  list(): Array<{ pluginId: string; version: string; digest: string; active: boolean; owner: string; registeredAt: string }> {
    const rows: Array<{ pluginId: string; version: string; digest: string; active: boolean; owner: string; registeredAt: string }> = [];
    for (const [pluginId, byVersion] of this.versions) {
      for (const [version, entry] of byVersion) {
        rows.push({
          pluginId,
          version,
          digest: entry.digest,
          active: this.active.get(pluginId) === version,
          owner: entry.manifest.agent.owner,
          registeredAt: entry.registeredAt,
        });
      }
    }
    return rows.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.version.localeCompare(b.version));
  }

  history(): AgentRegistryEvent[] {
    return this.log.map((entry) => ({ ...entry }));
  }
}