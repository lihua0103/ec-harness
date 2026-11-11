/** DVP 方法种子（过渡期单一来源）；种子一律 CANDIDATE，激活需已安装验证器，检索不构成授权。 */
import type { KnowledgeDraft } from '../../../packages/platform-knowledge/src/schema.js';

export const DVP_PLUGIN_ID = 'dm-dvp';
export const DVP_SEED_VERSION = '2026.11.11.1';

export const METHOD_TOPICS = ['template', 'firewhen', 'protocol', 'uat', 'cases'] as const;
export type MethodTopic = typeof METHOD_TOPICS[number];
export const METHOD_TOPIC_MAP: Record<MethodTopic, string[]> = {
  template: ['template', 'writer'],
  firewhen: ['firewhen', 'render'],
  protocol: ['protocol', 'extraction'],
  uat: ['uat', 'boundary'],
  cases: ['cases', 'design'],
};

function seed(
  id: string, title: string, method: string, scenarios: string[], topics: string[],
  preconditions: string[], notApplicable: string[], counterexamples: string[], source: string,
  claims?: string[],
): KnowledgeDraft {
  return {
    knowledgeId: id, scope: 'plugin', pluginId: DVP_PLUGIN_ID, kind: 'scenario_method', title,
    problemSignal: '历史交付中反复出现的模板结构误用、方言误解析或边界越线',
    cause: '把旧项目惯例当默认结构，或把配置参考当已验证配置',
    method, scenarios, edc: [], topics, preconditions, notApplicable, counterexamples,
    ...(claims?.length ? { claims } : {}),
    sources: [source, 'Historical source extracted; behavior reproduction in this platform is pending.'],
  };
}

export const dvpSeeds: KnowledgeDraft[] = [
  seed('dm-dvp.template.discipline', '公司 DVP 模板四层结构与写出边界',
    '公司 12-sheet 模板四层：治理（Cover/Approval 脚手架）、规则（Edit Checks 9 列、Edit Checks(Field Level) 11 列）、'
    + '人工（Manual Review 8 列、Manual Review for Programming 13 列）、系统功能（Dynamic 8 列）+ Version History 4 列。'
    + '写出经 dm_dvp_write_workbook：TEST CASE/DM Comments/DBD Comments 永远留空，UAT 用例由项目团队在行内留档执行；'
    + 'Sheet2/分配/Sheet10/WpsReserved 等辅助 sheet 不生成；Cover/Approval 只出脚手架。'
    + 'Add/Delete/Update 列 = 动作/版本（如 Add/V2.0）。Query Type 枚举 Date/Custom/Missing/Range，超出记 QUERY_TYPE_UNRECOGNIZED 不猜。',
    ['dvp'], ['template', 'writer'],
    ['使用公司 12-sheet 模板；写出目标为草稿工作簿'], ['非公司模板或外部模板结构不可机械套用'],
    ['把 CANDIDATE 工作簿当已验证 DVP 交付', '替项目团队预填 UAT 执行结果'],
    'docs/DVP-TEMPLATE-SCHEMA.md'),
  seed('dm-dvp.firewhen.dialect', 'fire-when 方言解析与目标 EDC 渲染纪律',
    'fire when 英文谓词伪代码是 EDC 无关中间层。dm_dvp_render_checks 渲染 rave-steps（variable/operator/value/joiner）'
    + '或 generic-expression；结果 RENDER_REFERENCE_ONLY，仅供参考，不直接写入生产 EDC 配置。'
    + 'AND/OR 混合嵌套标 NEEDS_MANUAL_GROUPING（扁平步骤序列不承载分组语义）；'
    + '复合 NOT 标 NEEDS_MANUAL_REWRITE（不自动 De Morgan，防缺失语义漂移）；单比较 NOT 可安全翻转算子并留痕。'
    + 'is (not) missing 映射 IsMissing/IsPopulated。解析失败降级 freeform 并给诊断码，绝不硬拒。',
    ['dvp'], ['firewhen', 'render'],
    ['Logic 列以 fire when 开头且为英文谓词伪代码'], ['freeform 叙述性逻辑不强行结构化'],
    ['把渲染步骤直接当 Rave 已配置检查', '对混合嵌套自动决定分组顺序'],
    'docs/DVP-TEMPLATE-SCHEMA.md §7.2'),
  seed('dm-dvp.protocol.extraction', '方案 PDF 文本层抽取与诚实降级',
    'dm_dvp_read_protocol 只读文本层（语言随项目，window 控制页区间）。表格、图表与版式信息不在返回内，'
    + '涉及视觉内容请人工查看原件复核。无文本层（扫描件）返回 NEEDS_OCR——不做 OCR、不凭页面图像猜内容；'
    + '加密 PDF 拒绝（ENCRYPTED_PDF_UNSUPPORTED），不尝试绕过；缺 ToUnicode 字体以 U+FFFD 占位并计数'
    + '（ENCODING_FIDELITY，关键段落人工核对）。返回 sha256 便于版本追溯。',
    ['dvp'], ['protocol', 'extraction'],
    ['输入为含文本层的 PDF 文件且位于 directory 内'], ['扫描件不走 OCR 流程前不得当结构化输入'],
    ['把抽取文本当方案结构化数据', '对扫描件凭图猜测入排标准'],
    'plugins/dm-dvp/src/protocol.ts'),
  seed('dm-dvp.uat.boundaries', 'UAT 三列留空与 TEST CASE 行内留档纪律',
    'Manual Review for Programming 的 TEST CASE-Subject ID 与 DM Comments/DBD Comments 只计数、不回传；'
    + '写出端这些列永远留空。UAT 用例由项目团队在公司流程内执行并归档，插件不代执行、不代归档。'
    + '全部生成物为候选（CANDIDATE），不伪报验证结果；解析端 Cover sheet 内容永不读取。',
    ['dvp'], ['uat', 'boundary'],
    ['涉及 UAT 留档或评审意见处理'], ['公司另有明确流程时以流程为准'],
    ['替项目团队填写 UAT 执行结果', '在回复中回传受试者号或评审意见原文'],
    'docs/DVP-TEMPLATE-SCHEMA.md §8'),
  seed('dm-dvp.cases.design', '用例候选正反恰边界设计与 unresolved 处理',
    'dm_dvp_suggest_cases 生成正例（应触发）/反例（不应触发）/恰边界（从比较算子与 NULL 语义推导，'
    + '如 >= 边界含等号侧）候选；unresolved 项（freeform/absent 逻辑、混合分组）交 DM 人工设计。'
    + '候选从未在任何 EDC/UAT 执行，不构成验证证据；执行成功、结构正确、独立业务 QC 是不同事实。',
    ['dvp'], ['cases', 'design'],
    ['规则 IR 已含 queryType 与逻辑列'], ['未运行的候选不得报 PASS'],
    ['把候选清单当已执行测试报告', '对 freeform 规则强行造结构化用例'],
    'plugins/dm-dvp/src/cases.ts'),
  seed('dm-dvp.changemark.format', '变更标记动作/版本解析',
    'Add/Delete/Update 列形如「动作/版本」（如 Add/V2.0、Delete/V3.1）；仅 Add、Delete、Update 视为变更动作，'
    + '未知动作不猜测、不当作变更。裸版本号只记版本、动作留空。',
    ['dvp'], ['template', 'change-mark'],
    ['变更列存在动作/版本写法'], ['非公司模板的变更列格式未确认时不套用'],
    ['把任意前缀当作变更动作', '把版本号误当动作'],
    'plugins/dm-dvp/src/rules.ts',
    ['change-mark action/version', 'change-mark unknown action']),
];

export const dvpKnowledgeContribution = { pluginId: DVP_PLUGIN_ID, scenarioAliases: {} };
