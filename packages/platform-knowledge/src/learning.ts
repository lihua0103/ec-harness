/** L3 复盘与发布：LearningCase（个案台账）与 KnowledgeRelease（不可变发布清单）的数据合同。
 *  个案沿用投影去重（(eventId, contributor, projectionVersion)），单事件可按 hypothesisKey 分多个假设；
 *  “未能判断（PENDING）”与“无需复用（NO_REUSABLE）”都是有效结局。
 *  发布清单不可变（manifest 内容寻址），当前指针按 (pluginId, org, region) 做 expectedVersion 原子切换；
 *  撤回走台账，撤回条目不得复活。 */
import { identifier } from './schema.js';

export type LearningCaseStatus = 'PENDING' | 'NO_REUSABLE' | 'PROPOSED' | 'CONFLICT';

/** 个案来源事件：与投影台账同一套标识（真实事件，不由模型自报）。 */
export interface LearningCaseSourceEvent {
  eventId: string;
  contributor: string;
  projectionVersion: string;
  kind: 'run.failed' | 'program.revised' | 'qc.completed' | 'business.clarified';
  runId: string;
  inputDigest?: string;
}

export interface LearningCaseProposal {
  knowledgeId: string;
  revision: number;
  proposedAt: string;
  proposedBy: string;
}

export interface LearningCaseRecord {
  caseId: string;
  /** '' = 未声明租户（本地部署）。 */
  orgId: string;
  region: string;
  pluginId: string;
  projectId?: string;
  sourceEvent: LearningCaseSourceEvent;
  hypothesisKey: string;
  category?: string;
  status: LearningCaseStatus;
  proposal?: LearningCaseProposal;
  createdAt: string;
  updatedAt: string;
}

export function parseLearningCaseSourceEvent(value: unknown): LearningCaseSourceEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LEARNING_CASE_SOURCE_INVALID');
  const event = value as Record<string, unknown>;
  if (
    typeof event.eventId !== 'string' ||
    typeof event.contributor !== 'string' ||
    typeof event.projectionVersion !== 'string' ||
    typeof event.runId !== 'string' ||
    !['run.failed', 'program.revised', 'qc.completed', 'business.clarified'].includes(String(event.kind))
  )
    throw new Error('LEARNING_CASE_SOURCE_INVALID');
  identifier(event.eventId);
  identifier(event.contributor);
  identifier(event.projectionVersion);
  if (event.runId.length > 160) throw new Error('LEARNING_CASE_SOURCE_INVALID');
  if (event.inputDigest !== undefined && !/^[a-f0-9]{64}$/.test(String(event.inputDigest)))
    throw new Error('LEARNING_CASE_SOURCE_INVALID');
  return {
    eventId: event.eventId,
    contributor: event.contributor,
    projectionVersion: event.projectionVersion,
    kind: event.kind as LearningCaseSourceEvent['kind'],
    runId: event.runId,
    ...(event.inputDigest !== undefined ? { inputDigest: String(event.inputDigest) } : {}),
  };
}

export interface KnowledgeReleaseEntry {
  knowledgeId: string;
  revision: number;
  contentDigest: string;
}

export interface KnowledgeReleaseRecord {
  releaseId: string;
  pluginId: string;
  orgId: string;
  region: string;
  /** 获授权受众标识（如 org:demo / region:cn-north / plugin-users:<id>）；不是“全公司可见”。 */
  audience: string;
  entries: KnowledgeReleaseEntry[];
  manifestDigest: string;
  evalReportRef?: string;
  approver: string;
  prevReleaseId?: string;
  state: 'CURRENT' | 'WITHDRAWN';
  createdAt: string;
}

export interface KnowledgeReleasePointer {
  releaseId: string;
  version: number;
  manifestDigest: string;
}
