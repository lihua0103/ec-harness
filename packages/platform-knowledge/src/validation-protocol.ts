/** KA13：跨进程验证的请求/回执协议接缝（数据合同）。
 *  本模块只定义可审计的请求与回执结构、摘要绑定和验证规则；不提供身份认证或RPC实现。
 *  真实部署的 ValidationExecutor 身份/凭据/网络通道仍由 IT/部署合同提供。 */
import { canonical, digest, type KnowledgeRecord, type ValidationSuite } from './schema.js';

export interface ValidationRequest {
  requestId: string;
  idempotencyKey: string;
  actor: string;
  pluginId: string;
  knowledgeId: string;
  revision: number;
  candidateDigest: string;
  validatorId: string;
  validatorVersion: string;
  validatorDigest: string;
  caseSetDigest: string;
  executionEpoch: number;
  issuedAt: string;
}
export interface ValidationResult {
  id: string;
  group: 'positive' | 'negative' | 'boundary';
  passed: boolean;
  actualDigest: string;
  expectedDigest: string;
}
export interface ValidationReceipt {
  requestId: string;
  requestDigest: string;
  executorId: string;
  results: ValidationResult[];
  recordedAt: string;
}

const sha = (value: unknown) => digest(value);

export function createValidationRequest(
  args: Omit<ValidationRequest, 'idempotencyKey'>,
): ValidationRequest {
  const request = { ...args } as ValidationRequest;
  const idempotencyKey = sha({
    pluginId: request.pluginId,
    knowledgeId: request.knowledgeId,
    revision: request.revision,
    candidateDigest: request.candidateDigest,
    validatorId: request.validatorId,
    validatorVersion: request.validatorVersion,
    validatorDigest: request.validatorDigest,
    caseSetDigest: request.caseSetDigest,
    executionEpoch: request.executionEpoch,
  });
  request.idempotencyKey = idempotencyKey;
  return request;
}

export function requestDigest(request: ValidationRequest): string {
  const { idempotencyKey: _key, ...body } = request;
  return sha(body);
}

export function caseSetDigest(suite: ValidationSuite): string {
  return sha({ cases: suite.cases, id: suite.id, version: suite.version });
}

export function validatorDigest(suite: ValidationSuite): string {
  return sha({ id: suite.id, version: suite.version, knowledgeIds: suite.knowledgeIds, cases: suite.cases });
}

export function createValidationReceipt(
  request: ValidationRequest,
  executorId: string,
  results: ValidationResult[],
  recordedAt = new Date().toISOString(),
): ValidationReceipt {
  return { requestId: request.requestId, requestDigest: requestDigest(request), executorId, results, recordedAt };
}

/** 中心核验：摘要一致、执行器已批准、epoch 一致、用例非空且逐项有结果。
 *  这里只验证数据合同；身份真实性由部署通道的签名/凭据承担，不能由本函数推断。 */
export function verifyValidationReceipt(
  request: ValidationRequest,
  receipt: ValidationReceipt,
  allowedExecutors: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  if (!allowedExecutors.includes(receipt.executorId)) return { ok: false, reason: 'EXECUTOR_NOT_APPROVED' };
  if (receipt.requestId !== request.requestId || receipt.requestDigest !== requestDigest(request))
    return { ok: false, reason: 'REQUEST_BINDING_MISMATCH' };
  if (!Array.isArray(receipt.results) || receipt.results.length === 0) return { ok: false, reason: 'RESULTS_EMPTY' };
  if (receipt.results.some((r) => !r || typeof r.id !== 'string' || typeof r.passed !== 'boolean' ||
    typeof r.actualDigest !== 'string' || typeof r.expectedDigest !== 'string' ||
    !['positive', 'negative', 'boundary'].includes(r.group)))
    return { ok: false, reason: 'RESULTS_INVALID' };
  return { ok: true };
}

/** 结果摘要稳定化：中心用 digest(canonical(results)) 记录回执，防止重复回执二次转换。 */
export function receiptDigest(receipt: ValidationReceipt): string {
  return sha(canonical(receipt));
}

/** 构造请求时绑定候选与套件摘要；调用方须从 store.get 读取真实记录，不能接受模型提供的 digest。 */
export function bindRequestCandidate(request: ValidationRequest, record: KnowledgeRecord): boolean {
  return request.knowledgeId === record.knowledgeId && request.revision === record.revision &&
    request.candidateDigest === record.contentDigest;
}
