/** DVP 方法种子（过渡期单一来源）；种子一律 CANDIDATE，激活需已安装验证器，检索不构成授权。
 *  分层决策（2026-11-21，训练路线第三阶段知识沉淀）：惯例种子先写 EDC 无关核心、Rave 实物作注脚，
 *  暂留 dm-dvp 插件种子内（公共规则标准库独立承载留待第四阶段多 EDC 迭代再上移），供公共层复用。 */
import type { KnowledgeDraft } from '../../../packages/platform-knowledge/src/schema.js';

export const DVP_PLUGIN_ID = 'dm-dvp';
export const DVP_SEED_VERSION = '2026.11.21.2';

export const METHOD_TOPICS = ['template', 'firewhen', 'protocol', 'uat', 'cases'] as const;
export type MethodTopic = typeof METHOD_TOPICS[number];
export const METHOD_TOPIC_MAP: Record<MethodTopic, string[]> = {
  template: ['template', 'writer'],
  firewhen: ['firewhen', 'render'],
  protocol: ['protocol', 'extraction'],
  uat: ['uat', 'boundary'],
  cases: ['cases', 'design'],
};

/** 全部方法主题对应的知识主题（去重）。 */
export const ALL_METHOD_TOPICS: string[] = [...new Set(Object.values(METHOD_TOPIC_MAP).flat())];

/** 主题名的常见别名（小写、可包含匹配）：模型常用自然语言或连字符写法。 */
const METHOD_TOPIC_ALIASES: ReadonlyArray<readonly [string, MethodTopic]> = [
  ['fire-when', 'firewhen'], ['fire when', 'firewhen'], ['fire_when', 'firewhen'], ['firewhen', 'firewhen'],
  ['模板', 'template'], ['列语义', 'template'], ['工作簿结构', 'template'], ['sheet', 'template'], ['template', 'template'],
  ['方案', 'protocol'], ['pdf', 'protocol'], ['抽取', 'protocol'], ['提取', 'protocol'], ['protocol', 'protocol'],
  ['用例设计', 'cases'], ['用例集', 'cases'], ['测试用例设计', 'cases'],
  ['案例', 'cases'], ['case', 'cases'], ['设计', 'cases'], ['候选', 'cases'],
  ['用例', 'uat'], ['边界', 'uat'], ['测试', 'uat'], ['核查', 'uat'], ['uat', 'uat'],
];

export type MethodTopicMatch = 'exact' | 'alias' | 'all';

/** 把模型给的 topic（枚举值、别名或自然语言）归入方法主题。
 *  规则：精确值 → 主题名或别名作为子串出现 → 归不进去或没给 = null（检索全部主题）。
 *  这是归类不是校验：不抛错，结果里如实报告 matched，让模型下一轮自己收窄。 */
export function resolveMethodTopic(raw: unknown): { topic: MethodTopic | null; matched: MethodTopicMatch; topics: string[] } {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return { topic: null, matched: 'all', topics: ALL_METHOD_TOPICS };
  const exact = METHOD_TOPICS.find((topic) => topic === text);
  if (exact) return { topic: exact, matched: 'exact', topics: METHOD_TOPIC_MAP[exact] };
  const nested = METHOD_TOPICS.find((topic) => text.includes(topic));
  if (nested) return { topic: nested, matched: 'alias', topics: METHOD_TOPIC_MAP[nested] };
  // 多个别名同时出现时取最长的（"用例设计" → cases，不被较短的"用例" → uat 抢先）
  const alias = METHOD_TOPIC_ALIASES
    .filter(([key]) => text.includes(key))
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (alias) return { topic: alias[1], matched: 'alias', topics: METHOD_TOPIC_MAP[alias[1]] };
  return { topic: null, matched: 'all', topics: ALL_METHOD_TOPICS };
}

function seed(
  id: string, title: string, method: string, scenarios: string[], topics: string[],
  preconditions: string[], notApplicable: string[], counterexamples: string[], source: string,
  claims?: string[], overrides?: { problemSignal?: string; cause?: string },
): KnowledgeDraft {
  return {
    knowledgeId: id, scope: 'plugin', pluginId: DVP_PLUGIN_ID, kind: 'scenario_method', title,
    problemSignal: overrides?.problemSignal ?? '历史交付中反复出现的模板结构误用、方言误解析或边界越线',
    cause: overrides?.cause ?? '把旧项目惯例当默认结构，或把配置参考当已验证配置',
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
    'docs/DVP-TEMPLATE-SCHEMA.md §7.2',
    ['fire-when structured vs freeform detection',
     'narrative logic degrades to freeform',
     'is missing renders IsMissing operator',
     'is not missing renders IsPopulated operator',
     'mixed and/or grouping flagged NEEDS_MANUAL_GROUPING']),
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
    'docs/DVP-TEMPLATE-SCHEMA.md §8',
    ['test case subject count forced to zero']),
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
  seed('dm-dvp.bulkwrite.scale', '千级规则 bulk 写入（插件只供能力，识别推理在模型侧）',
    '全量清单纪律：真实 DVP 是全量枚举（公开对照实测 866 跨字段/709 字段级/92 人工审阅/216 动态条目），'
    + '单轮内联 JSON 受吞吐限制。dm_dvp_write_workbook 各内容区值可给文件引用：相对 directory 的 NDJSON'
    + '（每行一个规则对象、空行跳过）或 JSON 数组文件（≤8MB，directory 内），工具机械展开并在 notices 回报'
    + ' BULK_SOURCE:<区>=<路径>(<n> rows)；越界/缺文件/坏行按 BULK_* 错误码拒绝。'
    + '实测证据（2026-11-21）：8 个 NDJSON（crossField 849/fieldLevel 709/dynamic 715/matrix 130/'
    + 'manualReview 16/subjectStatus 4/versionHistory 6）经文件引用传入，5 次 write 的 documentJson 仅 0.8–0.9KB'
    + '——上下文只产映射不逐条抄写；两次误传非清单参数 templateDirectory 后模型自行修正，不影响写簿；'
    + 'manualReviewProgramming 区识别标准无此页后未写入（规则留存源文件未丢弃）。'
    + '方案/ALS 的解读（访视名、表单结构、规则归类、文案范式）一律是模型推理职责；'
    + '模板形态选择纪律见 dm-dvp.template.knobs，惯例素材见 docs/DVP-TEMPLATE-SCHEMA.md §9。'
    + '零编造纪律：无输入证据的日期/版本/签署人留空。',
    ['dvp'], ['template', 'writer'],
    ['规则清单来自 ALS 元数据或模板结构机械全量物化', '目标形态为真实公司 DVP 实物'], ['手工精选子集冒充全量', '在插件代码内固化单项目惯例'],
    ['把抽样清单当全量 DVP 交付', '用 bulk 引用指向 directory 外', '替模型预设项目类型判断'],
    'docs/DVP-TEMPLATE-SCHEMA.md §9',
    ['section value as file reference expands NDJSON or JSON array in-directory',
     'BULK_SOURCE notice reports expanded source per section',
     'template options default to the generic template shape']),
  seed('dm-dvp.conventions.evidence', '公司 DVP 文案与结构惯例：已实证清单（v1.1 对标）',
    'EDC 无关核心惯例（2026-11-21 v1.1 复跑对标公司实物，状态升级为已实证）：'
    + '① 差异文案三型模板——缺失型「X已提供，但Y未提供。」、一致性型「X不等于Y。」、时序型「X应早于/晚于Y」，'
    + '句尾统一「请核实」。② 核查 ID 主体=表单缩写_序号，Listing 同构。'
    + '③ 变更标记列（Add/Delete/Update）基线版全空，不做占位；零编造——无输入证据的日期/版本/签署人留空，'
    + 'Version History 只写有证据行。④ 访视列用 ALL 与方案真实访视名，不用「所有访视」。'
    + '⑤ 全量清单纪律：元数据机械全量物化，抽样精选即不合格。'
    + '实例注脚（Rave）：字段级表=Edit Checks Rave，与系统原生三旗标（IsRequired/Query Future Date/'
    + 'Query Non-Conformance）分列两 sheet，勿混。'
    + '对标证据：请核实句尾 853/849 行≈100%（标准 97%）；缺失型「已提供，但」144 vs 138；'
    + '时序「晚于」18=18、「早于」34≈33；Edit Checks Rave 709=709 且枚举分布逐项相同；'
    + 'Add/Delete/Update 双方 0% 填充；ALL×638、「所有访视」×0；Edit Checks 849/866=98% 且逐表单计数精确命中。'
    + '状态：已实证；逐项数值基线见 docs/DVP-TEMPLATE-SCHEMA.md §9.4。'
    + '残留差距（记法密度/注释/变体）见 dm-dvp.text.density，矩阵后缀见 dm-dvp.id.matrix-suffix。',
    ['dvp'], ['template'],
    ['生成目标为公司形态 DVP 工作簿', '对标基准为真实实物而非模板说明书'], ['非公司模板不机械套用', '数值是单实例基线，其他实例允许差量'],
    ['把候选工作簿当已验证 DVP 交付', '编造 Version History 日期或签署人', '用抽样清单冒充全量'],
    'docs/DVP-TEMPLATE-SCHEMA.md §9.1/§9.4',
    undefined,
    { problemSignal: '文案与结构惯例在 v1.0 复跑中被验证与实物系统性错位，需以对标数值固化已实证项', cause: '惯例只凭模板说明书推断，未经实物全量对标即当作已验证' }),
  seed('dm-dvp.classification.visit-matrix', '访视-表单条目的跨页归类口径（主要残留差距）',
    'EDC 无关归类三问：① 条目是「逐访视对逐表单的显示控制」→ 归访视-表单矩阵区（跨页口径：矩阵区承载访视展开，'
    + '动态区只留少量全局条件）；② 「少数条件表单在特定人群/时点的显示」→ 归动态/条件区；'
    + '③ 「跨周期访视触发的核查」→ 归规则区，ID 带周期坐标后缀（见 dm-dvp.id.matrix-suffix）。'
    + '矩阵区的追加 form 放条件数据表单，而非逐访视表单。'
    + '跨页归类是模型侧识别决策：读方案访视设计 + 数据库结构逐条判断，插件不代劳、不写死归类逻辑。'
    + '实例注脚（Rave V6.0）：矩阵区仅 44 行、ID 用 DYN_VISIT_ 前缀；动态区 Dynamic Visit 仅 4 条。'
    + 'v1.1 复跑的归类错误（本种子要纠的差距）：253 条 Dynamic Visit 塞进动态区（标准 4 条），'
    + '矩阵区 130 行几乎全是访视表单（标准 44 行、放条件表单）。',
    ['dvp'], ['template', 'design'],
    ['方案已给出访视设计与矩阵/条件表单定义', '数据库结构（ALS）可区分访视表单与条件数据表单'],
    ['无访视矩阵定义的模板不套用此口径'],
    ['替模型写死「哪种条目进哪个页」的归类逻辑', '把全部访视相关条目都当 Dynamic Visit'],
    'docs/DVP-TEMPLATE-SCHEMA.md §9.2/§9.4',
    undefined,
    { problemSignal: 'v1.1 复跑把访视展开误归动态区、把访视表单塞满矩阵区，跨页归类口径与实物相反', cause: '把「访视相关」一律当 Dynamic Visit，未按「逐访视显示控制 vs 条件显示」拆分归类' }),
  seed('dm-dvp.id.matrix-suffix', '跨周期访视规则的矩阵后缀 ID（开放问题）',
    'EDC 无关：当核查只在「某访视 × 某周期」的矩阵单元触发时，ID 在表单缩写_序号主体外追加周期坐标后缀'
    + '（实例形态：主体_序号_C3_C80，Rave 实物 49 条 SV_ 系）；主体规则（所有周期共用）不带后缀。'
    + '生成纪律：能从输入证据（访视矩阵定义/规则条件）推导出周期坐标才写后缀；'
    + '推导不出就留待人工标注，不猜坐标。'
    + '状态：开放问题（2026-11-21）——v1.1 实测跨周期后缀仅命中 10/49（约 39 条跨周期规则未进规则区），'
    + '且 EX 前缀多 23 条（前缀口径漂移）。ID 主体已实证，见 dm-dvp.conventions.evidence。',
    ['dvp'], ['template'],
    ['访视矩阵定义可推导周期坐标', '规则条件含跨周期访视限定'],
    ['无矩阵定义时不猜后缀'],
    ['凭空编造周期坐标', '给所有规则统一加后缀'],
    'docs/DVP-TEMPLATE-SCHEMA.md §9.1/§9.4',
    undefined,
    { problemSignal: '跨周期访视规则的 ID 漏加矩阵后缀，v1.1 仅 10/49 命中，EX 前缀多 23 条', cause: '把周期坐标当可选修饰，未从访视矩阵定义逐条推导后缀；前缀口径未对齐实物' }),
  seed('dm-dvp.text.density', 'Logic 注释、跨表引用记法密度与句尾变体（文案差距）',
    'EDC 无关文案密度口径：① 跨表引用才用【表单.字段】记法；同表内字段裸写，不做全局包裹——'
    + '记法密度应随「真跨表」比例走，全局包裹即漂移。② Logic 允许「注：」行内注释补充业务口径，是惯例不是噪音。'
    + '③ 句尾「请核实」为主，「请核查」是合法变体，不必强行归一。'
    + '实例注脚（Rave V6.0 对照 v1.1）：【】记法 75 vs 2009（全局包裹漂移）、'
    + '「注：」69 vs 0（缺注释习惯）、「请核查」23 vs 0（变体被归一）。'
    + '状态：差距未收敛（2026-11-21）；句尾主形态已实证，见 dm-dvp.conventions.evidence。',
    ['dvp'], ['template'],
    ['Logic 文本进入公司形态 DVP 工作簿'],
    ['非公司模板的记法约定未确认时不套用'],
    ['为对齐密度统计人为删改业务语义', '把「请核查」当错别字全量替换'],
    'docs/DVP-TEMPLATE-SCHEMA.md §9.1/§9.4',
    undefined,
    { problemSignal: '【表单.字段】记法全局包裹（2009 vs 75）、Logic 无「注：」注释（69 vs 0）、「请核查」变体被归一（23 vs 0）', cause: '把跨表引用记法当统一转义，未区分同表/跨表；注释与变体被规整化清洗' }),
  seed('dm-dvp.template.knobs', '模板差量旋钮的决策范式（模型按实物形态自选）',
    'template 六旋钮（governanceOrder/editChecksQueryType/fieldLevelSheetName/includeProgramming/'
    + 'includeSubjectStatus/includeMatrix）是插件提供的中性能力面：默认值保持通用模板形态，'
    + '插件不预设、不硬编码任何项目惯例；选哪种形态由模型按当前项目输入证据（实物列数、sheet 清单、页序）逐项决策。'
    + '决策范式：先识别实物形态，再定旋钮取值——实证：识别到实物无 Query Type 列（8 列形态）后自选'
    + ' editChecksQueryType=false，与实物一致；识别实物无 Programming 页后不写入该区（8 条规则留存源文件未丢）。'
    + '无法识别的旋钮用默认并如实标注「未识别，用默认」。'
    + '汇报义务：交付汇报必须逐旋钮写明最终取值与依据；静默套用默认而不提，视为缺陷。',
    ['dvp'], ['template', 'writer'],
    ['目标为公司形态 DVP 实物', '输入含可识别的模板/实物形态证据'],
    ['非公司模板形态未确认时用默认并标注'],
    ['在插件代码内预设旋钮取值', '静默套用默认不汇报', '把旋钮默认值当项目惯例证据'],
    'docs/DVP-TEMPLATE-SCHEMA.md §9.3/§9.4',
    undefined,
    { problemSignal: '旋钮被静默套默认，交付汇报不写取值与依据，模板形态与实物错位', cause: '把中性旋钮当无需决策的配置，跳过实物识别直接生成' }),
];

export const dvpKnowledgeContribution = { pluginId: DVP_PLUGIN_ID, scenarioAliases: {} };
