/** 平台控制面（ec-platform-control）技术知识种子。
 *
 *  来源是已交付的平台文档与实测代码行为：故障排查按症状、配额与模型拒绝码、备份恢复、交付包状态机、
 *  升级迁移。这里只登记可复述的**运行/故障处置契约**，不含任何临床内容，也不把某次演练的偶然现象写成通用规则。
 *  正文单一来源：本文件；knowledge/manifest.json 只登记索引，不复制正文。 */
import type { KnowledgeDraft } from '../../platform-knowledge/src/schema.js';

export const CONTROL_PLUGIN_ID = 'ec-platform-control';
export const CONTROL_SEED_VERSION = '2026.11.20.1';

const TOPICS = ['publish', 'dispatch', 'recover', 'identity', 'knowledge'] as const;

function seed(
  id: string, title: string, method: string, topics: string[],
  preconditions: string[], notApplicable: string[], counterexamples: string[], source: string,
): KnowledgeDraft {
  return {
    knowledgeId: id, scope: 'plugin', pluginId: CONTROL_PLUGIN_ID, kind: 'scenario_method', title,
    problemSignal: '控制面运行停在队列、被拒绝或恢复后对不上账时，操作者缺少统一的判定口径',
    cause: '把"服务在线"当成"运行在推进"，或把拒绝码当成偶发故障而绕过治理重试',
    method, scenarios: ['platform'], edc: [], topics,
    preconditions, notApplicable, counterexamples,
    sources: [source, '平台文档记录的行为契约；本次部署的实测证据须另行留档。'],
  };
}

export const controlSeeds: KnowledgeDraft[] = [
  seed('platform-control.run.lifecycle', '运行停在 QUEUED 的判定顺序',
    '按固定顺序取证：先跑 doctor 看环境失败项（warn 不算失败），再看 GET /api/ops/panel 的 outbox 深度与运行计数，'
    + '最后导出审计链留证据。运行创建即报 EXECUTOR_NOT_CONFIGURED 表示部署未配置 worker，运行保持持久，配置好后重试即可，'
    + '不需要重建运行；QUEUED 长期不动通常意味着 scheduler 未启用或控制面进程退出，重启控制面并用 reconcileOnStartup 清理上个进程遗留。'
    + 'RUN_CATALOG_RUNTIME_MISMATCH / MODEL_CATALOG_UNAVAILABLE 表示模型目录与 runtime bundle 不一致，应重新登记目录，不要手改库。',
    ['dispatch', 'recover'],
    ['能读到控制面端口与 store 路径', '操作者有权重启控制面进程'],
    ['控制面未启动时不要先改库', '不接受"重启后运行消失"的处置'],
    ['直接把 QUEUED 改成终态', '手工改库绕过目录登记'],
    'docs/PLATFORM-FAULT-RUNBOOK.md §1'),
  seed('platform-control.model.governance', '模型拒绝码的处置边界',
    'MODEL_SELECTION_REQUIRED 表示部署有可用模型但本次未选，由员工显式选择，平台不静默替选；'
    + 'MODEL_PREFERENCE_UNAVAILABLE 表示保存的偏好已停用，改选即可，偏好不会自动迁移；'
    + 'MODEL_APPROVAL_REQUIRED / MODEL_APPROVAL_EXPIRED 由审批人按具体 selection 审批或撤回，'
    + 'MODEL_APPROVAL_SELECTION_UNKNOWN 时先登记目录再审批——不存在"先批后补"通道；'
    + 'MODEL_HEALTH_UNAVAILABLE 在探测恢复后自动放行，不能清表"修"它。',
    ['publish', 'identity'],
    ['部署已配置模型目录与审批策略'],
    ['未开启 requireModelApproval / requireModelHealth 时这些码不会出现'],
    ['用改配置重启来绕过审批', '把健康探测失败当数据损坏'],
    'docs/PLATFORM-FAULT-RUNBOOK.md §2'),
  seed('platform-control.quota.boundaries', '配额拒绝的口径与恢复',
    'RUN_QUOTA_CONCURRENCY_EXCEEDED 表示项目内进行中运行数达到上限，取消或终结部分运行后自然释放；'
    + 'RUN_QUOTA_DAILY_EXCEEDED 按 UTC 自然日计，**失败与取消同样消耗当日额度**，次日零时自动恢复。'
    + '计数只统计绑定 Work 的运行，这是口径声明而不是覆盖承诺。平台不会为绕开配额而静默切换模型、区域或项目。',
    ['dispatch', 'publish'],
    ['部署配置了 quotas'],
    ['未配置 quotas 的部署不会产生 429 配额码'],
    ['改系统时钟骗过日配额', '把失败运行移出统计以"腾出"额度'],
    'docs/PLATFORM-FAULT-RUNBOOK.md §3'),
  seed('platform-control.storage.recovery', '存储故障时的备份恢复纪律',
    '库打不开或 quick_check 报错时不要 VACUUM、不要手改：用最近的**已校验**备份恢复到新路径，'
    + '核对 digest 与运行计数后再切换入口，旧库原样保留。恢复目标永远不会因备份未过校验而被覆盖。'
    + '备份不覆盖知识库（knowledge.sqlite）与原生 DSH 会话目录，恢复后这两处须按各自流程单独核对。'
    + '新部署上线前后各演练一次，备份策略变更后重演并留证。',
    ['recover'],
    ['存在已通过校验的备份文件'],
    ['无备份可用时应停止写入并保留现场，而不是尝试修补损坏页'],
    ['用备份覆盖仍在服务的库', '把一次成功恢复当作后续免演练的依据'],
    'docs/PLATFORM-FAULT-RUNBOOK.md §4；docs/BACKUP-DRILL-2026-11-18.md'),
  seed('platform-control.delivery.package', '交付包状态机与冲突处置',
    '封存（SEALED）、交付（DELIVERED）、接收（RECEIVED）是三个不同事实，**下载不等于接收**。'
    + 'DELIVERY_PACKAGE_REVISION_STALE 表示修改冲突，应刷新取最新 revision 重发，不覆盖他人状态；'
    + '撤回（WITHDRAWN）与被替代（SUPERSEDED）是终态。旧包的审核快照不会迁移到新包，新包必须重新走自己的复核——'
    + '发现"新包自动带了旧审批"才是缺陷，需要上报。',
    ['publish', 'recover'],
    ['交付包由平台生成并带 revision'],
    ['一次性导出但没有交付对象的场景不适用状态机'],
    ['把下载记录当接收证据', '手工把旧审批复制到新包'],
    'docs/PLATFORM-FAULT-RUNBOOK.md §5'),
  seed('platform-control.upgrade.migration', '升级迁移的必做核对',
    '控制面库迁移只做加列建表（CREATE TABLE IF NOT EXISTS + PRAGMA user_version），旧库首次以新代码打开时自动补表；'
    + 'workbench.sqlite 已被 control.sqlite 统一取代且没有自动数据迁移，需要旧数据时手工移动文件。'
    + '升级后必做三件事：doctor 全绿、运营面板 outbox 无积压、抽一条审计链核对 prevDigest 连续。'
    + '控制面库与知识库、会话目录是不同存储，迁移其中一处不代表另一处也被迁移。',
    ['recover', 'knowledge'],
    ['可在升级前备份控制面库'],
    ['跨大版本的破坏性重命名不在自动迁移范围内，需要单独评审'],
    ['跳过 doctor 直接放行', '假定 workbench.sqlite 会被自动迁移'],
    'docs/PLATFORM-FAULT-RUNBOOK.md §8'),
];

export const controlKnowledgeContribution = {
  pluginId: CONTROL_PLUGIN_ID,
  scenarioAliases: {} as Record<string, string[]>,
};

export const CONTROL_TOPICS = TOPICS;