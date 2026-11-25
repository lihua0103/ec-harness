/** 平台知识服务（ec-platform-knowledge）技术知识种子。
 *
 *  来源是已实现的合同与代码行为：可信范围派生、快照固定集合、证据状态、验证回执、激活门槛与投影幂等。
 *  只登记可复述的合同与失败模式，不含业务正文；正文单一来源：本文件，manifest 只登记索引。 */
import type { KnowledgeDraft } from './schema.js';

export const KNOWLEDGE_PLUGIN_ID = 'ec-platform-knowledge';
export const KNOWLEDGE_SEED_VERSION = '2026.11.20.1';

const TOPICS = ['retrieval', 'governance', 'validate', 'degrade'] as const;

function seed(
  id: string, title: string, method: string, topics: string[],
  preconditions: string[], notApplicable: string[], counterexamples: string[], source: string,
): KnowledgeDraft {
  return {
    knowledgeId: id, scope: 'plugin', pluginId: KNOWLEDGE_PLUGIN_ID, kind: 'scenario_method', title,
    problemSignal: '知识检索"看起来有结果"，但范围、版本或证据无法与运行对上时，容易把参考当结论',
    cause: '把检索返回条数当授权与证据，或让模型自报身份代替部署声明的可信范围',
    method, scenarios: ['platform'], edc: [], topics,
    preconditions, notApplicable, counterexamples,
    sources: [source, '代码合同已实现；真实宿主与领域质量须另行验收取证。'],
  };
}

export const knowledgeSeeds: KnowledgeDraft[] = [
  seed('platform-knowledge.scope.trusted', '可信范围由部署声明而不是模型参数',
    '范围来自部署装配的 Config.scopes（pluginId/orgId/region/projectIds/allProjects/locale/corpusDocPrefixes），'
    + '工具参数只能收窄：projectId 必须在允许集合内，插件身份、组织与区域不得由模型改写。'
    + '未声明范围的插件调用失败关闭（KNOWLEDGE_SCOPE_UNAVAILABLE），越界抛 KNOWLEDGE_SCOPE_ESCALATION / '
    + 'KNOWLEDGE_PROJECT_OUT_OF_SCOPE；语料检索未声明前缀时整体拒绝（KNOWLEDGE_CORPUS_SCOPE_REQUIRED）。'
    + '任何"先查全库再过滤"的实现都违反该合同。',
    ['retrieval', 'governance'],
    ['部署方已按插件声明范围'],
    ['单插件单租户的开发夹具可不带 region，但仍必须显式声明 allProjects 或 projectIds'],
    ['用模型传入的 orgId 兜底', '未声明范围时回落到全量可见'],
    'docs/KNOWLEDGE-AGENT-CONTRACT.md §2'),
  seed('platform-knowledge.snapshot.pinned', '快照固定集合与重放',
    'Run 创建时只读计算 {context, records:[{knowledgeId,revision,contentDigest}], snapshotDigest} 存到 Run 的 knowledge 字段；'
    + 'searchPinned(context, snapshot, options) 只读绑定修订，后续升级不改变原 Run，摘要被篡改抛 KNOWLEDGE_SNAPSHOT_INVALID。'
    + '撤回（REVOKED/CONFLICT）与撤权（不可见）逐条进入 evidence.excluded，不读活库、不暗换新版。'
    + '摘要只作完整性证据，records 才是可重放的固定集合。',
    ['retrieval', 'governance', 'degrade'],
    ['Run 创建时已写入 knowledge 快照'],
    ['检索式探索（没有绑定 Run）时使用在线检索，不冒充固定集合'],
    ['重启后改用最新修订重放', '把 digest 相同当作内容已核验'],
    'docs/KNOWLEDGE-AGENT-CONTRACT.md §3'),
  seed('platform-knowledge.evidence.status', '证据状态与引用对账',
    '检索结果必须带 evidence.status：BOUND（固定集合有绑定命中）、EMPTY（范围内确实没有）、'
    + 'DEGRADED（索引或服务降级）、UNBOUND（没有绑定快照）。cite(context, runId, snapshot, refs) 记录答案最终引用，'
    + '引用必须来自同一快照且重复幂等；reconcileCitations 区分已引用、未引用与未知引用，未引用不得冒称采纳。'
    + '空结果要如实报 EMPTY，不能回落到"最新 N 条"。',
    ['retrieval', 'degrade', 'governance'],
    ['调用方传入 Run 的快照或显式在线检索'],
    ['纯列表浏览不需要引用台账，但也不能宣称答案有依据'],
    ['把检索条数当引用数', '用 DEGRADED 的结果生成确定性结论'],
    'docs/KNOWLEDGE-AGENT-CONTRACT.md §3'),
  seed('platform-knowledge.validation.receipt', '验证回执的幂等与激活条件',
    'validateWithReceipt 绑定请求、候选与套件摘要：重复回执幂等返回原结局；同一请求的第二份不同回执被拒绝'
    + '（KNOWLEDGE_RECEIPT_ALREADY_APPLIED）。无 claims、覆盖不足、过期修订、未批准执行器都不激活。'
    + '激活状态只能由权威写者按覆盖与修订一致性提交，候选不是批准。',
    ['validate', 'governance'],
    ['已安装验证套件并声明覆盖条目'],
    ['没有可机器复现断言的方法只能保留为候选并人工复核'],
    ['用同一请求换套件重发以"刷"出通过', '把模型自述的通过当验证证据'],
    'docs/KNOWLEDGE-AGENT-CONTRACT.md §4'),
  seed('platform-knowledge.activation.policy', '候选与激活的分界',
    '知识条目状态分候选与实际可用：kind/state 分离，只有带 claims 且证据到位的条目才能进入 ACTIVE；'
    + 'ACTIVE 默认结果与候选分开展示，工作台必须能区分撤回、不可用与未绑定。'
    + '入库条数不是收益，报告要同时给出通过/失败/未决计数。',
    ['governance', 'validate'],
    ['存在候选条目与验证套件'],
    ['一次性脚本经验在建立可复现窄声明前保持候选'],
    ['用"已入库"宣称"已被采用"', '把候选混进默认检索结果而不标注'],
    'docs/KNOWLEDGE-AGENT-CONTRACT.md §1、§5'),
  seed('platform-knowledge.projection.idempotent', '事件投影的去重与失败隔离',
    'captureFromProjection 以 (eventId, contributor, projectionVersion) 为去重键：重复投递返回原结局且不产生新修订；'
    + '无证据时显式记 NO_REUSABLE_CONCLUSION / PENDING_ANALYSIS，修订冲突记 CONFLICT，其余暂态失败记 RETRY_REQUIRED。'
    + '投影失败不改写业务 Run 状态，知识沉淀故障不得影响业务运行结论。',
    ['governance', 'degrade'],
    ['事件来自 Run/QC/复核的可信投影'],
    ['人工直接录入不经过事件投影，但仍需留痕'],
    ['重投事件生成第二条候选', '投影失败时把 Run 标成失败'],
    'docs/KNOWLEDGE-AGENT-CONTRACT.md §4'),
];

export const knowledgeKnowledgeContribution = {
  pluginId: KNOWLEDGE_PLUGIN_ID,
  scenarioAliases: {} as Record<string, string[]>,
};

export const KNOWLEDGE_TOPICS = TOPICS;