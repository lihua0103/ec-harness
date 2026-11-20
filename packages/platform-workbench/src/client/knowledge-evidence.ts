/** M1-03 知识依据的展示层（工作台「知识依据/治理区」）。
 *
 *  只做呈现映射：快照固定集合、本次实际返回、被排除条目与答案引用必须分开展示，
 *  未绑定 / 空结果 / 降级 / 已撤回不得合并成一个"成功"。这里不读库、不推断，输入来自
 *  Run 的 `knowledge` 字段与检索结果自带的 `evidence`。 */

export interface RunKnowledgeSnapshot {
  snapshotDigest: string;
  total: number;
  pluginId: string;
  projectId?: string;
  boundAt: string;
  records?: Array<{ knowledgeId: string; revision: number; contentDigest: string }>;
}

export type ExclusionReason = 'REVOKED' | 'CONFLICT' | 'UNAVAILABLE' | 'NOT_VISIBLE' | 'TAMPERED';

export interface KnowledgeEvidenceView {
  status: 'BOUND' | 'UNBOUND' | 'EMPTY' | 'DEGRADED';
  snapshot: { digest: string; total: number } | null;
  returned: Array<{ knowledgeId: string; revision: number }>;
  excluded: Array<{ knowledgeId: string; revision: number; reason: ExclusionReason }>;
}

/** 快照行：有绑定时给出摘要与条目数；没有就是"未绑定"，不写成 0 条。 */
export function snapshotLine(snapshot: RunKnowledgeSnapshot | undefined): string {
  if (!snapshot) return '未绑定知识快照（本运行不做固定集合检索）';
  const digest = snapshot.snapshotDigest.slice(0, 12);
  const records = snapshot.records?.length;
  return `已绑定 ${snapshot.pluginId} 快照 ${digest}（${snapshot.total} 条${records !== undefined ? `，可重放 ${records} 条` : ''}，${snapshot.boundAt}）`;
}

const STATUS_LABEL: Record<KnowledgeEvidenceView['status'], string> = {
  BOUND: '固定集合有命中',
  EMPTY: '范围内无命中',
  DEGRADED: '降级：部分绑定条目被排除',
  UNBOUND: '未绑定快照（活库检索）',
};

export function evidenceLabel(evidence: KnowledgeEvidenceView): string {
  return STATUS_LABEL[evidence.status];
}

const REASON_LABEL: Record<ExclusionReason, string> = {
  REVOKED: '已撤回',
  CONFLICT: '修订冲突',
  UNAVAILABLE: '不可用',
  NOT_VISIBLE: '无权限（未可见）',
  TAMPERED: '摘要被篡改',
};

/** 被排除条目按原因归类；DEGRADED 时这是"为什么少了"的说明，不藏起来。 */
export function exclusionLines(evidence: KnowledgeEvidenceView): string[] {
  const byReason = new Map<ExclusionReason, string[]>();
  for (const item of evidence.excluded) {
    const list = byReason.get(item.reason) ?? [];
    list.push(`${item.knowledgeId}@${item.revision}`);
    byReason.set(item.reason, list);
  }
  return [...byReason.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, items]) => `${REASON_LABEL[reason]}：${items.join('、')}`);
}

/** 实际返回清单：与引用对账用，未引用不冒称采纳。 */
export function returnedLines(evidence: KnowledgeEvidenceView): string[] {
  return evidence.returned.map((item) => `${item.knowledgeId}@${item.revision}`);
}