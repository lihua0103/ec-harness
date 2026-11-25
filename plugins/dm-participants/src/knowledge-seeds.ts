/** dm-participants 方法知识种子（schemaVersion 1 起步）。一律 CANDIDATE：正文提炼自
 *  RBQM 参与者档案页实战与设计文档；本平台的可复现窄声明与验证器尚未建立，
 *  激活前仅作参考，不冒充已验证规则。内容单一来源：本文件；manifest 只登记索引。 */
import type { KnowledgeDraft } from '../../../packages/platform-knowledge/src/schema.js';

export const PT_PLUGIN_ID = 'ec-clinical-dm-participants';
export const PT_SEED_VERSION = '2026.11.17.2';

export const PT_TOPICS = ['channel', 'page', 'pairing', 'rbqm-ops'] as const;
export type PtTopic = (typeof PT_TOPICS)[number];
export const PT_TOPIC_MAP: Record<PtTopic, string[]> = {
  channel: ['channel'],
  page: ['page'],
  pairing: ['pairing'],
  'rbqm-ops': ['rbqm-ops'],
};

function seed(
  id: string, title: string, method: string, topics: string[],
  preconditions: string[], notApplicable: string[], counterexamples: string[], source: string,
): KnowledgeDraft {
  return {
    knowledgeId: id, scope: 'plugin', pluginId: PT_PLUGIN_ID, kind: 'scenario_method', title,
    problemSignal: '参与者档案图表页交付中反复出现的数据通道与配对偏差',
    cause: '跳过统一数据通道直接改渲染，或把夹具数据当生产数据',
    method, scenarios: ['participants'], edc: [], topics,
    preconditions, notApplicable, counterexamples,
    sources: [source, 'Historical source extracted; behavior reproduction in this platform is pending.'],
  };
}

export const ptSeeds: KnowledgeDraft[] = [
  seed('dm-participants.channel.pipeline', 'EDC rawdata→Excel→数据集→builder 渲染通道',
    '数据通道固定为：各 EDC rawdata → 统一清洗 → Excel（原始数据留档不覆盖）→ 数据集导入 → builder 渲染。'
    + '原始数据保留不覆盖：清洗产物写新文件，不写回原始 rawdata；同一批次重复导入按源文件 digest 判定是否变化。'
    + '导入以列类型（number/text/date）为准；把清洗后的展示列当数值列是首要错因。',
    ['channel'],
    ['已获准读取的 rawdata/Excel 且列语义明确'], ['未获准数据不入通道'],
    ['直接改渲染输出代替重新清洗导入', '覆盖原始数据文件'],
    'docs/DM-PARTICIPANTS-PLUGIN-DESIGN.md 数据通道节'),
  seed('dm-participants.page.assembly', '参与者档案页 18 图 5 角色分区装配',
    '参与者档案页为 18 张固定图、按 5 个临床角色分区组织；由 PT_DATA 注入逐受试者数据，'
    + '图配置参数化（策展参数）而非逐受试者复制配置。夹具 18 图配对 digest 稳定：'
    + '同输入同 digest，重渲染不漂移。分区与图集以 participants 档案合同为准，不按项目增删图。',
    ['page'],
    ['使用平台参与者档案页合同'], ['项目要求自定义图集时不沿用 18 图清单'],
    ['逐受试者硬编码数据', '把演示夹具数据当生产数据回显'],
    'docs/DM-PARTICIPANTS-PLUGIN-DESIGN.md；plugins/dm-participants/src/participant-page.ts'),
  seed('dm-participants.pairing.acceptance', '设计稿配对与逐图验收纪律',
    '设计稿（自包含 HTML）经提取与逐图配对后渲染系统图表页并并排对比验收；配对以图表语义（标题/角色分区）'
    + '为单位，不以 DOM 位置。验收证据绑定页面 digest 与设计稿 digest；未配对成功的图明确列出并人工处置，'
    + '不静默丢弃。imported 数据（如 28 人导入）做零泄漏核对后才可参与渲染。',
    ['pairing'],
    ['设计稿为自包含 HTML 且图表块可提取'], ['纯位图稿不自动配对'],
    ['配对失败即跳过该图不报告', '验收只看渲染不报错'],
    'docs/DM-PARTICIPANTS-PLUGIN-DESIGN.md；docs/DM-VIZ-PLUGIN-DESIGN.md §6.3'),
  seed('dm-participants.rbqm-ops.sql-endpoints',
    'RBQM 两个 SQL 端点必须分清：预览不落库，保存才落库',
    'RBQM 的 SQL 能力有两个端点，行为完全不同：① `POST /sqlScript/executeDiagramsSql` 是**预览**——'
    + '物化临时表、执行 SQL、把结果集返回前端，**一行都不写真实表**；② `POST /sqlScript/saveDiagramsData` 才**落库**——'
    + '取回临时表、按目标列序映射、数值列校验、BulkCopy 进目标表。'
    + '只用预览端点时 SQL 会返回 Operation Successful 且接口带回真实数据行，但目标表行数前后完全不变——'
    + '这是"写不进去"最常见的假象。判定方法：对比调用前后 `COUNT(*)` 与 `IDENT_CURRENT()`，没变就是没落库。',
    ['rbqm-ops'],
    ['目标为 RBQM 系统图表/患者登记等需要持久化的写入'],
    ['只做数据核对时用预览端点即可，不必落库'],
    ['用 executeDiagramsSql 做写入并据其返回判定成功', '只看 message=Operation Successful 就认为已落库'],
    'RBQM SqlScriptService.ExecuteDiagramsSqlAsync / SaveDiagramsDataAsync（只读核对，未改其代码）'),

  seed('dm-participants.rbqm-ops.temp-table-write',
    'RBQM 落库走临时表：改 #临时表 才会被写回，改真实表会被权限拒绝',
    'saveDiagramsData 的执行链是「`SELECT * INTO #<TemporaryTableName> FROM <真实表>` → 执行用户 SQL → BulkCopy 临时表回真实表」。'
    + '因此：① 在 `#PatientProfile` 这类临时表上做 DELETE/UPDATE，结果会经 BulkCopy **真正写回**真实表；'
    + '② 直接对真实表 `PATIENT_PROFILE` 做 DELETE 会被拒——SQL 执行账号 `rbqmExec` 是 RBQM 刻意设计的低权限账号'
    + '（工作台/KRI/系统图表共用），实测对 PATIENT_PROFILE 只有 SELECT，数据库角色为空。'
    + '应用层账号即使是 Administrator 也不改变这一点，因为 SQL 一律落在 rbqmExec 上。'
    + '去重/清理类操作的正确写法是在临时表上用 `ROW_NUMBER() OVER (PARTITION BY <键> ...)` 标记后删除多余行，'
    + '让 BulkCopy 把干净结果写回。',
    ['rbqm-ops'],
    ['需要清理或改写系统表（如 PATIENT_PROFILE）中的既有行'],
    ['新建数据（INSERT 进临时表）不需要先删真实表'],
    ['直接 DELETE 真实表并误判为"权限 bug"', '认为 UI 账号是管理员就能改任意表',
     '用 DELETE 真实表代替临时表去重，导致重复行累积'],
    'RBQM SqlScriptService.SaveDiagramsDataAsync + DbProvider.ExecuteSql(rbqmExec)（只读核对）'),

  seed('dm-participants.rbqm-ops.registry-replace',
    '患者登记重复的根因与正确去重方式',
    'saveDiagramsData 写患者登记时的"替换语义"依赖服务端尾部 `DELETE FROM PATIENT_PROFILE WHERE ID<=maxId AND STUDY_ID=…`，'
    + '而该 DELETE 同样走 rbqmExec、同样被权限拒绝且**静默失效**——所以重复保存会累积重复参与者'
    + '（实测 env215 出现 28 人 × 2 = 56 行）。重复行会让前端 `validPatientOptions`（要求 label 唯一）判定整页异常，'
    + '表现为「参与者图表加载失败」。正确处置：在临时表 `#PatientProfile` 上按 PATIENT 去重后保存一次；'
    + '或由 DBA 给 rbqmExec 授 DELETE 以恢复系统自带的替换语义。'
    + '长期建议：每次落位前先核对 `COUNT(*)` 与 `COUNT(DISTINCT PATIENT)` 是否相等。',
    ['rbqm-ops'],
    ['目标环境的 PATIENT_PROFILE 已有该研究的登记行'],
    ['首次写入空表时不会重复，无需去重'],
    ['反复重跑登记而不核对行数', '把重复行当成图表配置问题去排查'],
    'RBQM SqlScriptService.SaveDiagramsDataAsync 尾部 DELETE + 前端 patientCharts.ts validPatientOptions（只读核对）'),

  seed('dm-participants.rbqm-ops.shared-scope',
    'RBQM 当前研究是账号级共享状态：多会话并行会互相踢线并落错研究',
    'RBQM 的「当前研究/环境」保存在服务端账号状态（CurrentUser.CurrStudyId），且同账号单会话——'
    + '新登录会踢掉旧会话（syscode 10001）。多个会话/程序用同一账号并行操作时会发生两件事：'
    + '① 互相踢线导致请求失败；② 上传与写入落到**别的**研究里（实测 PT_PATIENTS.xlsx 落进了另一个研究的队列）。'
    + '因此：登录后必须显式 `POST /study/saveStudyEnvironment?id=<envId>` 申明目标环境；'
    + '重登（被踢）后要**重新申明**；上传后按导入队列核验「本研究是否出现新行且 fileStatus=4」，'
    + '没有新行就是落错研究，不是摄取故障。多会话并行前必须先协调账号占用。',
    ['rbqm-ops'],
    ['多个会话或程序共用同一个 RBQM 账号'],
    ['单会话独占账号时风险低，但仍建议每次显式申明环境'],
    ['重登后不重新申明环境就上传', '把"队列无新行"直接判为摄取停摆'],
    'RBQM CurrentUser.CurrStudyId / FileService.UploadFile / 实测落错研究（只读核对）'),

  seed('dm-participants.rbqm-ops.import-queue',
    'RBQM 上传是异步导入：fileStatus 语义与两种"不建表"要分开判',
    '上传接口只负责写文件并插队列行，真正建表由独立进程 `RBQM.BackendService.File` 每 10 秒轮询完成。'
    + '队列状态：1 待处理 / 2 上传失败 / 3 处理中 / 4 处理成功 / 5 处理失败。'
    + '两种"上传了但没表"必须分开判：① 队列里**没有本研究的新行** = 落错研究（账号当前环境被改写）；'
    + '② 有新行但长时间停在 `st=1` = 解析 worker 没在跑（WebApi 正常不代表它正常）；'
    + '③ 新行变 `st=5` = 解析真失败，看 `failureFileList` 的 failReason（remark 常是泛化的 AnalysisFail，无区分度）。'
    + '另：同名文件在队列处理中时上传返回 10013，worker 未运行时该状态不会自解。',
    ['rbqm-ops'],
    ['通过 /api/file/uplaod 上传建表'],
    ['直接向已有表追加数据不经队列时不适用'],
    ['把 st=1 长时间不动当成上传失败', '只看 upload 返回 200 就认为表已建好'],
    'RBQM FileAnalysisService / BackendService.File 轮询循环 + 队列实测（只读核对）'),

  seed('dm-participants.rbqm-ops.dataset-schema-reuse',
    'RBQM 数据集按表名复用：表头变了必须换表名重传',
    'RBQM 的 ensureDataset 语义是「按表名查找，存在即复用」，**不会**因为上传内容或表头变化而重建表。'
    + '因此改图表数据集 schema（例如给热力图矩阵补 X_IDX/Y_IDX 数值列）后若沿用旧表名，'
    + '服务端返回的是旧表元数据，新列一律 missing，配置校验报 `RBQM_NUMBER_COLUMN_NOT_NUMERIC:<表>.<列>=missing`。'
    + '正确做法：上传前按「表头 + 全量数据行」digest 派生版本化表名（如 `_S<8位>`）重传；'
    + '同输入幂等复用，表头或内容一变就自然落到新表。只按表头做 digest 不够——实测 consent 表头没变、'
    + '行内容变了，仍渲染旧里程碑文案。旧表不删除（历史快照）。',
    ['rbqm-ops'],
    ['通过 /dynamicData 上传建表并使用 getDynamicDataColumn 元数据'],
    ['只改数值不改表头时可直接复用旧表'],
    ['改表头后沿用旧表名并误判为列没建出来', '反复重传同一文件名等待 schema 生效'],
    'RBQM getDynamicDataColumn 元数据 + env215 实测（PT_S1_TRIAGE 缺 X_IDX，改版本化表名后通过）'),

  seed('dm-participants.rbqm-ops.source-rows-complete',
    '图表数据源行必须带全所有被消费字段，缺一个字段会整表被滤空',
    '从参与者模型生成图表源行时（rowsFromParticipants），每个域只推必要的列；'
    + '但各图 buildRows 会按字段过滤（aetl 过滤 grade、visits 过滤 state），'
    + '缺字段的行会被静默滤掉，表现为整张表 0 行并在落位时报 `table PT_S1_<X> has no usable rows`。'
    + '实测两例：aes 记录漏了 grade（只剩 participantId/week/term）；visits 记录漏了 state，'
    + '且漏访没有 dev 时整行被丢弃。新增或修改图表时先核对 source 行字段与该图 buildRows 的过滤条件一一对应。',
    ['rbqm-ops'],
    ['图表数据集由模型派生的源行生成'],
    ['直接读参与者模型对象而非 source 行时不适用'],
    ['把空表当成导入失败去查 worker', '只补字段不回归 buildRows 的过滤条件'],
    'env215 落位实测（PT_S1_AETL/PT_S1_VISITS 0 行 → 补 grade/state 后 19/100 行）'),
];

export const ptKnowledgeContribution = {
  pluginId: PT_PLUGIN_ID,
  scenarioAliases: {} as Record<string, string[]>,
};
