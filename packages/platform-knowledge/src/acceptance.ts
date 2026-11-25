/** 证据验收（操作者侧，可信调用）：把运行期沉淀的候选按「每条 claim 绑定一项证据检查」激活为 ACTIVE。
 *
 *  为什么需要：validate() 的激活条件是候选内容摘要与套件预先安装的 coverage 绑定逐字一致，而运行期
 *  capture 出来的候选，摘要只有在写入之后才存在——随包套件永远绑不上，候选只能停在 CANDIDATE。
 *  本模块在验收时从库内候选项派生绑定，并强制两条纪律，避免「把候选自己的 claims 抄进覆盖表」式的同义反复：
 *    1. 候选声明的每条 claim 恰好对应一项检查；检查的期望值来自操作者给出的证据文件（JSON 指针 + 比较），
 *       证据文件的 sha256 写进用例输入，随回执的 caseDigest 一并落账；
 *    2. 必须另带负例与边界守护检查（例如「证据不是候选自身」「对比行数非零」），全部通过才激活。
 *  信任边界：入口只提供给可信的操作者侧工具（scripts/knowledge-accept.mjs），模型侧工具拿不到，仍不能自批；
 *  激活仍走 validate() 的标准事务路径，回执与事件照常落库。套件只验收构建时锁定的那个候选修订。 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonical } from './schema.js';
import type { CaseGroup, KnowledgeRecord, ValidationSuite } from './schema.js';

export const ACCEPTANCE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'type'] as const;
export type AcceptanceOp = (typeof ACCEPTANCE_OPS)[number];

export interface AcceptanceCheck {
  /** 候选声明的 claim 原文（逐字）；每条 claim 恰好一项检查。 */
  claim: string;
  /** 证据文件键（相对 spec 文件的路径或绝对路径）。 */
  evidence: string;
  /** 证据文档内的 JSON 指针（RFC 6900）。 */
  pointer: string;
  op: AcceptanceOp;
  /** exists 不需要；其余比较必须给出。 */
  value?: unknown;
}
export interface AcceptanceGuard {
  id: string;
  /** 负例与边界守护各至少一项：负例=「必须不成立」的事实，边界=「恰好成立」的事实。 */
  group: Extract<CaseGroup, 'negative' | 'boundary'>;
  evidence: string;
  pointer: string;
  op: AcceptanceOp;
  value?: unknown;
}
export interface AcceptanceSpec {
  suiteId: string;
  suiteVersion?: string;
  checks: AcceptanceCheck[];
  guards?: AcceptanceGuard[];
}
export interface AcceptanceEvidence {
  /** 证据键 → 已解析的 JSON 文档。 */
  documents: Record<string, unknown>;
  /** 证据键 → 原始字节 sha256。 */
  sha256: Record<string, string>;
}

export class AcceptanceError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = 'AcceptanceError';
    this.code = code;
  }
}

const IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

/** RFC 6900 JSON 指针（~0 ~1 转义、数组下标）；路径不存在返回 undefined，语法非法抛错。 */
export function jsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new AcceptanceError('ACCEPTANCE_POINTER_INVALID');
  let node: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      node = node[Number(token)];
    } else {
      node = (node as Record<string, unknown>)[token];
    }
  }
  return node;
}

const sameJson = (left: unknown, right: unknown): boolean => {
  try {
    return canonical(left) === canonical(right);
  } catch {
    return false;
  }
};

/** 一次证据比较。数值比较只对两个有限数成立；eq/ne 按规范 JSON 逐字比较。 */
export function evaluateAcceptance(actual: unknown, op: AcceptanceOp, value: unknown): boolean {
  switch (op) {
    case 'eq':
      return sameJson(actual, value);
    case 'ne':
      return !sameJson(actual, value);
    case 'exists':
      return actual !== undefined;
    case 'type': {
      const kind = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
      return kind === value;
    }
    case 'contains':
      return Array.isArray(actual)
        ? actual.some((item) => sameJson(item, value))
        : typeof actual === 'string' && typeof value === 'string' && actual.includes(value);
    default: {
      if (typeof actual !== 'number' || typeof value !== 'number' || !Number.isFinite(actual) || !Number.isFinite(value)) return false;
      if (op === 'gt') return actual > value;
      if (op === 'gte') return actual >= value;
      if (op === 'lt') return actual < value;
      return actual <= value;
    }
  }
}

interface BoundCheck {
  evidence: string;
  evidenceSha256: string;
  pointer: string;
  op: AcceptanceOp;
  value?: unknown;
}

/** 由库内候选 + 验收说明 + 证据文档构建一次性验证套件（注册与激活由调用方走 service 标准路径）。 */
export function buildAcceptanceSuite(input: {
  record: Readonly<KnowledgeRecord>;
  spec: AcceptanceSpec;
  evidence: AcceptanceEvidence;
}): ValidationSuite {
  const { record, spec, evidence } = input;
  const claims = [...(record.claims ?? [])];
  if (!claims.length) throw new AcceptanceError('ACCEPTANCE_NO_CLAIMS', record.knowledgeId);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new AcceptanceError('ACCEPTANCE_SPEC_INVALID');
  if (typeof spec.suiteId !== 'string' || !IDENTITY.test(spec.suiteId) || spec.suiteId.length > 160)
    throw new AcceptanceError('ACCEPTANCE_SUITE_ID_INVALID');
  const suiteVersion = spec.suiteVersion ?? '1.0.0';
  if (typeof suiteVersion !== 'string' || !suiteVersion.trim() || suiteVersion.length > 64)
    throw new AcceptanceError('ACCEPTANCE_SUITE_VERSION_INVALID');
  if (!Array.isArray(spec.checks) || !spec.checks.length) throw new AcceptanceError('ACCEPTANCE_CHECKS_REQUIRED');
  const guards = Array.isArray(spec.guards) ? spec.guards : [];

  // 纪律 1：声明与检查一一对应——多出的检查不是声明，缺检查的声明不许蒙混激活。
  const bound = new Set<string>();
  for (const check of spec.checks) {
    if (!claims.includes(check.claim)) throw new AcceptanceError('ACCEPTANCE_CHECK_NOT_A_CLAIM');
    if (bound.has(check.claim)) throw new AcceptanceError('ACCEPTANCE_CLAIM_WITH_MULTIPLE_CHECKS', String(check.claim).slice(0, 80));
    bound.add(check.claim);
  }
  const unbound = claims.filter((claim) => !bound.has(claim)).length;
  if (unbound) throw new AcceptanceError('ACCEPTANCE_CLAIM_WITHOUT_CHECK', `${unbound} claim(s)`);

  // 纪律 2：负例与边界守护各至少一项。
  const groups = new Set<CaseGroup>();
  const guardIds = new Set<string>();
  for (const guard of guards) {
    if (typeof guard.id !== 'string' || !IDENTITY.test(guard.id) || guard.id.length > 160) throw new AcceptanceError('ACCEPTANCE_GUARD_ID_INVALID');
    if (guardIds.has(guard.id)) throw new AcceptanceError('ACCEPTANCE_GUARD_DUPLICATE', guard.id);
    if (guard.group !== 'negative' && guard.group !== 'boundary') throw new AcceptanceError('ACCEPTANCE_GUARD_GROUP_INVALID', guard.id);
    guardIds.add(guard.id);
    groups.add(guard.group);
  }
  if (!groups.has('negative') || !groups.has('boundary')) throw new AcceptanceError('ACCEPTANCE_GUARDS_INCOMPLETE');

  const toBound = (check: { evidence: string; pointer: string; op: AcceptanceOp; value?: unknown }, label: string): BoundCheck => {
    if (typeof check.evidence !== 'string' || !(check.evidence in evidence.documents)) throw new AcceptanceError('ACCEPTANCE_EVIDENCE_MISSING', label);
    const digest = evidence.sha256[check.evidence];
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new AcceptanceError('ACCEPTANCE_EVIDENCE_DIGEST_MISSING', check.evidence);
    if (!ACCEPTANCE_OPS.includes(check.op)) throw new AcceptanceError('ACCEPTANCE_OP_INVALID', `${label}:${String(check.op)}`);
    if (check.op !== 'exists' && check.value === undefined) throw new AcceptanceError('ACCEPTANCE_VALUE_REQUIRED', label);
    jsonPointer(evidence.documents[check.evidence], check.pointer); // 语法在构建时校验
    return { evidence: check.evidence, evidenceSha256: digest, pointer: check.pointer, op: check.op, ...(check.value !== undefined ? { value: check.value } : {}) };
  };

  const claimCases = spec.checks.map((check, index) => ({
    id: `claim-${index + 1}`,
    group: 'positive' as const,
    input: toBound(check, `claim-${index + 1}`),
    expected: true,
  }));
  const guardCases = guards.map((guard) => ({ id: guard.id, group: guard.group, input: toBound(guard, guard.id), expected: true }));

  return {
    id: spec.suiteId,
    version: suiteVersion,
    knowledgeIds: [record.knowledgeId],
    cases: [...claimCases, ...guardCases],
    coverage: [
      {
        knowledgeId: record.knowledgeId,
        candidateDigest: record.contentDigest,
        claims,
        evidence: [{ suiteId: spec.suiteId, suiteVersion, caseIds: claimCases.map((testCase) => testCase.id) }],
      },
    ],
    async execute(candidate, testCase) {
      // 只验收构建时锁定的那个候选修订：换一份正文即失败，不把证据套到别的候选上。
      if (candidate.contentDigest !== record.contentDigest) return false;
      const boundCheck = testCase.input as BoundCheck;
      return evaluateAcceptance(jsonPointer(evidence.documents[boundCheck.evidence], boundCheck.pointer), boundCheck.op, boundCheck.value);
    },
  };
}

/** 读取证据文件：按 spec 所在目录解析相对路径；原始字节做 sha256，内容按 JSON 解析。 */
export function loadAcceptanceEvidence(paths: ReadonlyArray<string>, baseDir: string): AcceptanceEvidence {
  const result: AcceptanceEvidence = { documents: {}, sha256: {} };
  for (const key of new Set(paths)) {
    if (typeof key !== 'string' || !key.trim()) throw new AcceptanceError('ACCEPTANCE_EVIDENCE_MISSING', String(key).slice(0, 80));
    const bytes = readFileSync(resolve(baseDir, key));
    result.sha256[key] = createHash('sha256').update(bytes).digest('hex');
    try {
      result.documents[key] = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new AcceptanceError('ACCEPTANCE_EVIDENCE_NOT_JSON', key);
    }
  }
  return result;
}
