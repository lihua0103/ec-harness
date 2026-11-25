/** M1-01 剩余：身份接线部署配置。
 *  可信 Principal（来自已验证的身份断言）→ 插件知识范围声明。
 *  本模块只做配置的解析/校验与 Principal → Scope 的纯函数派生；
 *  不认证身份、不读取凭据、不发起网络请求——这些由部署通道承担。
 *  配置由部署装配方提供，模型不能自报身份或范围。 */
import { identifier } from './schema.js';
import { validateScopeDeclaration, type KnowledgeScopeDeclaration } from './scope.js';

export interface KnowledgePrincipal {
  /** 已验证的主体标识（由平台身份服务派生，不是模型自报）。 */
  actorId: string;
  /** 组织/区域（可选，来自身份断言）。 */
  orgId?: string;
  region?: string;
  /** 主体被授权的插件集合；模型不能扩大。 */
  pluginIds?: readonly string[];
}

export interface ScopeBinding {
  /** 绑定键：插件身份。 */
  pluginId: string;
  /** 该插件允许的项目集合；与 allProjects 二选一。 */
  projectIds?: readonly string[];
  allProjects?: boolean;
  /** 该插件允许的组织/区域（可空 = 继承 Principal）。 */
  orgId?: string;
  region?: string;
  locale?: string;
  /** 语料入口前缀（可空 = 该插件不可检索语料）。 */
  corpusDocPrefixes?: readonly string[];
}

export interface IdentityScopeConfig {
  schemaVersion: 1;
  bindings: readonly ScopeBinding[];
}

function fail(code: string): never {
  throw new Error(code);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** 严格解析部署配置：未知字段、重复插件、缺授权来源一律拒绝。 */
export function parseIdentityScopeConfig(value: unknown): IdentityScopeConfig {
  if (!isObject(value)) fail('KNOWLEDGE_IDENTITY_CONFIG_INVALID');
  for (const key of Object.keys(value)) {
    if (key !== 'schemaVersion' && key !== 'bindings') fail(`KNOWLEDGE_IDENTITY_CONFIG_INVALID:${key}`);
  }
  if (value.schemaVersion !== 1) fail('KNOWLEDGE_IDENTITY_CONFIG_UNSUPPORTED');
  const bindingsRaw = value.bindings;
  if (!Array.isArray(bindingsRaw) || !bindingsRaw.length || bindingsRaw.length > 256)
    fail('KNOWLEDGE_IDENTITY_CONFIG_BINDINGS_INVALID');
  const seen = new Set<string>();
  const bindings: ScopeBinding[] = [];
  for (const raw of bindingsRaw) {
    if (!isObject(raw)) fail('KNOWLEDGE_IDENTITY_CONFIG_BINDINGS_INVALID');
    for (const key of Object.keys(raw)) {
      if (!['pluginId', 'projectIds', 'allProjects', 'orgId', 'region', 'locale', 'corpusDocPrefixes'].includes(key))
        fail(`KNOWLEDGE_IDENTITY_CONFIG_INVALID:${key}`);
    }
    identifier(raw.pluginId);
    if (seen.has(raw.pluginId)) fail('KNOWLEDGE_IDENTITY_CONFIG_DUPLICATE_PLUGIN');
    seen.add(raw.pluginId);
    if (raw.projectIds !== undefined && raw.allProjects !== undefined) fail('KNOWLEDGE_IDENTITY_CONFIG_BINDINGS_INVALID');
    if (raw.projectIds !== undefined && (!Array.isArray(raw.projectIds) || !raw.projectIds.length))
      fail('KNOWLEDGE_IDENTITY_CONFIG_BINDINGS_INVALID');
    if (raw.projectIds !== undefined) for (const project of raw.projectIds) identifier(project);
    if (raw.allProjects !== undefined && raw.allProjects !== true) fail('KNOWLEDGE_IDENTITY_CONFIG_BINDINGS_INVALID');
    if (raw.orgId !== undefined) identifier(raw.orgId);
    if (raw.region !== undefined) identifier(raw.region);
    if (raw.locale !== undefined && !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(raw.locale as string))
      fail('KNOWLEDGE_IDENTITY_CONFIG_INVALID');
    if (raw.corpusDocPrefixes !== undefined && (!Array.isArray(raw.corpusDocPrefixes) || raw.corpusDocPrefixes.some((p: unknown) => typeof p !== 'string')))
      fail('KNOWLEDGE_IDENTITY_CONFIG_INVALID');
    const binding: ScopeBinding = { pluginId: raw.pluginId as string };
    if (raw.projectIds !== undefined) binding.projectIds = [...(raw.projectIds as string[])];
    if (raw.allProjects === true) binding.allProjects = true;
    if (raw.orgId !== undefined) binding.orgId = raw.orgId as string;
    if (raw.region !== undefined) binding.region = raw.region as string;
    if (raw.locale !== undefined) binding.locale = raw.locale as string;
    if (raw.corpusDocPrefixes !== undefined) binding.corpusDocPrefixes = [...(raw.corpusDocPrefixes as string[])];
    bindings.push(binding);
  }
  return Object.freeze({ schemaVersion: 1, bindings: Object.freeze(bindings.map((b) => Object.freeze(b))) });
}

/** 从可信 Principal 与部署配置派生某个插件的检索范围。
 *  规则：Principal 的 pluginIds 是上限（未授权插件直接拒绝）；
 *  组织/区域来自 Principal（可空 = 不约束）；项目来自绑定声明。
 *  任何越界都显式失败，不做静默补全。 */
export function deriveScope(
  config: IdentityScopeConfig,
  principal: KnowledgePrincipal,
  pluginId: string,
): KnowledgeScopeDeclaration {
  identifier(principal.actorId);
  identifier(pluginId);
  const binding = config.bindings.find((entry) => entry.pluginId === pluginId);
  if (binding === undefined) fail('KNOWLEDGE_PLUGIN_NOT_BOUND');
  if (principal.pluginIds && !principal.pluginIds.includes(pluginId)) fail('KNOWLEDGE_PLUGIN_NOT_AUTHORIZED');
  const scope: KnowledgeScopeDeclaration = { pluginId };
  const orgId = binding.orgId ?? principal.orgId;
  const region = binding.region ?? principal.region;
  if (orgId !== undefined) scope.orgId = orgId;
  if (region !== undefined) scope.region = region;
  if (binding.allProjects === true) scope.allProjects = true;
  else if (binding.projectIds !== undefined) scope.projectIds = binding.projectIds;
  if (binding.locale !== undefined) scope.locale = binding.locale;
  if (binding.corpusDocPrefixes !== undefined) scope.corpusDocPrefixes = binding.corpusDocPrefixes;
  validateScopeDeclaration(scope);
  return scope;
}