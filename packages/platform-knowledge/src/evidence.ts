/** M1-03：证据与降级。
 *  固定集合（快照）、本次实际返回与答案最终引用三者必须可区分、可对账；
 *  未绑定、空结果、不可用、已撤回不得合并成同一个“成功”状态。 */
import type { State } from './schema.js';

export interface KnowledgeRef {
  knowledgeId: string;
  revision: number;
  contentDigest: string;
}
export type ExclusionReason = 'REVOKED' | 'CONFLICT' | 'UNAVAILABLE' | 'NOT_VISIBLE' | 'TAMPERED';
export interface KnowledgeEvidence {
  /** BOUND：快照固定集合可用；EMPTY：集合可用但无命中；DEGRADED：存在被排除的绑定修订；
   *  UNBOUND：未绑定快照（只做活库检索时如实标注）。 */
  status: 'BOUND' | 'UNBOUND' | 'EMPTY' | 'DEGRADED';
  snapshot: { digest: string; total: number } | null;
  /** 本次实际返回的修订（服务端结果集，而非模型声称采纳的部分）。 */
  returned: Array<KnowledgeRef & { state: State }>;
  excluded: Array<KnowledgeRef & { reason: ExclusionReason }>;
}

const refKey = (ref: KnowledgeRef) => `${ref.knowledgeId}@${ref.revision}#${ref.contentDigest}`;

/** 实际返回与最终引用对账：未引用不等于采纳，未知引用不得冒称来自本次返回。 */
export function reconcileCitations(
  returned: readonly KnowledgeRef[],
  cited: readonly KnowledgeRef[],
): { cited: KnowledgeRef[]; uncited: KnowledgeRef[]; unknown: KnowledgeRef[] } {
  const available = new Map(returned.map((ref) => [refKey(ref), ref]));
  const knownCited: KnowledgeRef[] = [];
  const unknown: KnowledgeRef[] = [];
  const seen = new Set<string>();
  for (const ref of cited) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if (available.has(key)) knownCited.push(available.get(key)!);
    else unknown.push({ knowledgeId: ref.knowledgeId, revision: ref.revision, contentDigest: ref.contentDigest });
  }
  const citedKeys = new Set(knownCited.map(refKey));
  const uncited = [...available.values()].filter((ref) => !citedKeys.has(refKey(ref)));
  return { cited: knownCited, uncited, unknown };
}