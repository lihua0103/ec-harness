/** 平台工作台（ec-platform-workbench）技术知识种子。
 *
 *  来源是已实现的工作台行为与改造方案：工作与会话绑定、输入/运行/交付三指针、交付包状态、差异不可比较、
 *  诚实单操作者标注、审计溯源读取。只登记操作与恢复契约，不含业务正文与临床内容。 */
import type { KnowledgeDraft } from '../../platform-knowledge/src/schema.js';

export const WORKBENCH_PLUGIN_ID = 'ec-platform-workbench';
export const WORKBENCH_SEED_VERSION = '2026.11.20.1';

const TOPICS = ['operate', 'recover', 'governance', 'release'] as const;

function seed(
  id: string, title: string, method: string, topics: string[],
  preconditions: string[], notApplicable: string[], counterexamples: string[], source: string,
): KnowledgeDraft {
  return {
    knowledgeId: id, scope: 'plugin', pluginId: WORKBENCH_PLUGIN_ID, kind: 'scenario_method', title,
    problemSignal: '工作台把"最近一次结果"笼统展示，员工容易把旧交付当新结果、把未执行当已完成',
    cause: '混淆输入、运行与交付三个不同事实，或用页面刷新代替可追溯的运行记录',
    method, scenarios: ['workbench'], edc: [], topics,
    preconditions, notApplicable, counterexamples,
    sources: [source, '行为已在工作台代码中实现；真实宿主与员工可用性须另行验收取证。'],
  };
}

export const workbenchSeeds: KnowledgeDraft[] = [
  seed('platform-workbench.session.binding', '打开工作与会话的绑定关系',
    '打开工作时把工作与一个原生 DSH 会话绑定，每个工作只绑定一次，之后从工作进入沿用该会话，'
    + '不另建第二套聊天内核，也不把历史会话重新归属。绑定关系是工作上下文的一部分，切换工作不会串用会话。',
    ['operate'],
    ['工作已创建且原生会话服务可用'],
    ['只读浏览清单不需要绑定会话'],
    ['每次打开都新建会话', '把不同工作的对话混在同一会话里复用'],
    'docs/WORKBENCH-ENTERPRISE-RENOVATION-PLAN-2026-11-17.md §8'),
  seed('platform-workbench.run.pointer', '输入/运行/交付三指针不得统称最新',
    '工作页始终分开展示三个指针：当前输入基线（含 revision）、最近一次运行（状态与时间）、最近一次交付（状态）。'
    + '换批次重跑会生成新输入基线并继承上一批交付作为参照，旧结果的交付编号保持不变；'
    + '"新一轮已开始"不等于"旧交付已失效"，也不等于"已完成"。',
    ['operate', 'governance'],
    ['工作已绑定项目与应用'],
    ['首次运行前没有交付指针，应显示为未交付而不是空结果'],
    ['用一个"最新"字段覆盖三种事实', '刷新页面后丢失指针坐标'],
    'docs/WORKBENCH-ENTERPRISE-RENOVATION-PLAN-2026-11-17.md §8 E1-1/E1-2'),
  seed('platform-workbench.delivery.lifecycle', '交付包状态与接收的证据',
    '封存（SEALED）、交付（DELIVERED）、接收（RECEIVED）分开展示；下载不等于接收，接收需要显式确认并留记录。'
    + '撤回（WITHDRAWN）与被替代（SUPERSEDED）是终态，历史仍可查；旧包的审核快照不迁移到新包。',
    ['governance', 'release'],
    ['工作已产生交付包'],
    ['内部演练交付不需要对外接收方，但仍要区分封存与交付'],
    ['把下载次数当接收证据', '覆盖旧包状态来"修正"历史'],
    'docs/PLATFORM-FAULT-RUNBOOK.md §5'),
  seed('platform-workbench.diff.incomparable', '不可比较时拒绝比较',
    '差异视图按应用贡献的业务键对齐而不是按行号；应用或版本不一致时返回 comparable:false'
    + '（APP_MISMATCH / APP_VERSION_MISMATCH），此时拒绝比较并说明原因，不给出"看起来差不多"的结论。'
    + 'WORKER_FINDINGS_INVALID 表示插件提交的发现格式非法（如重复业务键），应修插件侧生成逻辑，平台不静默裁剪。',
    ['governance', 'recover'],
    ['两次运行绑定同一应用与兼容版本'],
    ['只有一次运行时没有差异视图可看'],
    ['按行号手工对齐两次运行', '把不可比较当成相同'],
    'docs/PLATFORM-FAULT-RUNBOOK.md §6'),
  seed('platform-workbench.identity.honest', '单操作者部署的诚实标注',
    '在真实企业身份接入前，工作台保持"单操作者"诚实标注，不提供登录/权限管理界面，也不把界面上的显隐当授权；'
    + '授权由部署与执行环境负责。真实 SSO/多租户属于待接入项，界面不得暗示已具备。',
    ['governance'],
    ['部署未接入企业 IdP'],
    ['接入真实身份后，标注与权限 UI 按新合同替换'],
    ['用前端隐藏按钮冒充权限控制', '在标注里暗示已有企业级审计身份'],
    'docs/PLATFORM-FAULT-RUNBOOK.md §9'),
  seed('platform-workbench.audit.provenance', '审计与溯源的可查入口',
    '运行记录保留持久事件（含工具调用与时长），可按运行回放定位；审计导出带 SHA-256 链，'
    + '导出文件用于留证而不是替代复核。工作页展示绑定、角色与工件摘要，摘要用于核对而不是内容外显。',
    ['governance', 'recover'],
    ['控制面已开启运行事件记录'],
    ['尚未产生运行的工作没有事件可回放'],
    ['用截图当审计证据', '把导出文件当作已复核'],
    'docs/WORKBENCH-ENTERPRISE-RENOVATION-PLAN-2026-11-17.md §8 E1-6'),
];

export const workbenchKnowledgeContribution = {
  pluginId: WORKBENCH_PLUGIN_ID,
  scenarioAliases: {} as Record<string, string[]>,
};

export const WORKBENCH_TOPICS = TOPICS;