/** dm-dvp 插件入口：公司 DVP 工作簿 → 规则 IR → 校验 → 用例候选。
 *  生成物一律 CANDIDATE；数据边界见 parse.ts 头注与 docs/DVP-TEMPLATE-SCHEMA.md §8。
 *  不限制 Harness 的通用工具或模型能力；本插件只提供领域工具与方法知识。 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-skill';
import { readFileSync } from 'node:fs';
import { WorkbookError } from '../../../packages/platform-workbook/src/index.js';
import { BOUNDARY_NOTICES, DvpError, overviewDvpWorkbook, parseDvpWorkbook, type DvpSection } from './parse.js';
import { RulesInputError, parseRulesJson, withLogicParse } from './rules.js';
import { suggestCases } from './cases.js';
import { writeDvpWorkbook } from './write.js';
import { renderChecks, RENDER_TARGETS } from './render.js';
import { readProtocol } from './protocol.js';
import {
  dvpSeeds,
  dvpKnowledgeContribution,
  DVP_PLUGIN_ID,
  DVP_SEED_VERSION,
  METHOD_TOPICS,
  METHOD_TOPIC_MAP,
} from './knowledge-seeds.js';
import { dvpMethodSuite } from './knowledge-validators.js';
import type { KnowledgeDraft } from '../../../packages/platform-knowledge/src/schema.js';
import type {} from '../../../packages/platform-knowledge/src/cordis.js';

export const name = 'ec-clinical-dm-dvp';
export const inject = ['tools', 'skills', 'clinicalKnowledge'];

const SKILL_CONTENT = `# dm-dvp 方法（DVP 内容生成）

## 输入与可用能力
- 方案 PDF（语言随项目）：dm_dvp_read_protocol 读取文本层（window 控制页区间）。只返回文本层——表格、图表与版式不在其中；
  扫描件返回 NEEDS_OCR（不做 OCR、不凭图猜内容）；加密 PDF 拒绝；缺 ToUnicode 字体以 U+FFFD 占位并计数（ENCODING_FIDELITY）；
  解析 ObjStm 压缩页对象；页树声明页数与实际解析页数不一致时明确告警，不能当作方案完整。
- 公司 DVP 模板 workbook（12 sheet 四层结构：治理/规则/人工/系统功能）：dm_dvp_overview 返回 sheet 角色；
  dm_dvp_parse_workbook 返回规则 IR（跨字段规则/字段级规格/人工评审/动态/版本历史 + 逐条诊断），
  可按 section + paging.nextOffset 继续读取；dm_dvp_validate_rules 复核完整性；dm_dvp_suggest_cases 生成
  正例/反例/恰边界候选；dm_dvp_render_checks 给出目标 EDC 配置参考；dm_dvp_write_workbook 写出草稿工作簿。
- 方法知识：dm_dvp_methods 检索 template/firewhen/protocol/uat/cases；dm_dvp_knowledge_capture/validate/events
  沉淀、复核和查看学习事件。

按当前任务自行选择能力与顺序；没有必须遵循的工具调用流水线。

## fire-when 方言（EDC 无关中间层）
Logic 列以 fire when 开头的英文谓词伪代码：< > = 比较（含 >= <= != <>）、AND/OR/NOT（大小写混用）、
is (not) missing、NULL 缺失语义、双引号/单引号字符串、字段名可含空格（如多词域名）。
解析失败降级 freeform 并给出诊断码，绝不硬拒；结构化逻辑可经 dm_dvp_render_checks 渲染为
Rave 风格检查步骤（variable/operator/value/joiner）或通用表达式，渲染结果是配置参考（RENDER_REFERENCE_ONLY），
AND/OR 混合嵌套与复合 NOT 显式标记人工确认项，不代做语义改写。

## Query Type 四枚举
Date | Custom | Missing | Range——超出枚举记 QUERY_TYPE_UNRECOGNIZED 诊断，不猜。

## Dynamic Type 8 枚举
Dynamic Field | Dynamic Search list | Dynamic Page | Derivation | Dynamic Visit | Participant Status | Dynamic Option | Add Event——超出枚举记 DYNAMIC_TYPE_UNRECOGNIZED 诊断，不猜。此表是系统既有配置的登记，生成时按目标系统实际配置核对，不假定其他系统同构。

## 方法知识（KnowledgeService）
dm_dvp_methods 检索 DVP 方法种子（template/firewhen/protocol/uat/cases）；历史种子为 CANDIDATE，未复现验证不称 ACTIVE。
已核实的纠错方法经 dm_dvp_knowledge_capture 沉淀（前提/反例/来源必填，claims 只写可复现断言），dm_dvp_knowledge_validate 跑已安装验证器；
只有全部 claims 被套件覆盖且通过才 ACTIVE，工具回归通过不等于方法正文已验证。dm_dvp_knowledge_events 读学习/验证事件。知识是方法参考，不是授权，也不替代当前项目文档。

## 行内变更控制
Add/Delete/Update 列形如 Add/V2.0 = 动作/版本。逐版本追溯差异属后续版本（KnowledgeService 生命周期）。

## 数据边界（不可协商）
- Cover sheet 内容永不读取；Approval 签署内容不读取。
- Manual Review for Programming 的 TEST CASE 受试者号与 DM/DBD 评审意见只计数、不回传。
- 未识别 sheet 只记录存在，不读取内容。
- 全部生成物为候选（CANDIDATE），不是已验证 DVP；不伪报验证结果。
- UAT 用例留档遵循公司流程：用例落在 Manual Review for Programming 行内 TEST CASE 区，由项目团队执行归档。

## 字段级规格的 EDC 语义
Form OID / Field OID / Control Type / Data Format 是 Rave 风格系统功能层；
跨 EDC 复用需按目标系统映射，不假定其他系统同构。`;

export function apply(ctx: Context): void {
  const knowledge = ctx.clinicalKnowledge;
  const unregisterContribution = knowledge.registerContribution(dvpKnowledgeContribution);
  ctx.effect(() => unregisterContribution);
  const unregisterValidator = knowledge.registerValidator(DVP_PLUGIN_ID, dvpMethodSuite);
  ctx.effect(() => unregisterValidator);
  // M2-01：注册本插件的知识智能体定义（随包发布锁定版本；卸载撤销注册并保留历史）。
  ctx.effect(() =>
    knowledge.registerAgentManifest(
      JSON.parse(readFileSync(new URL('../knowledge/manifest.json', import.meta.url), 'utf8')),
    ),
  );
  // 种子问题只降级知识检索能力，不阻断插件装配；dm_dvp_status 如实上报。
  let seedState: { version: string; result: unknown } | { version: string; error: string };
  try {
    seedState = { version: DVP_SEED_VERSION, result: knowledge.importSeeds(DVP_PLUGIN_ID, DVP_SEED_VERSION, dvpSeeds) };
  } catch (error) {
    seedState = { version: DVP_SEED_VERSION, error: error instanceof Error ? error.message : 'UNKNOWN' };
  }
  ctx.skills.register({
    name: 'dm-dvp',
    description: '临床 DVP 生成方法：公司模板解析、fire-when 方言、用例候选与数据边界。',
    content: SKILL_CONTENT,
    source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true },
  });
  const string_type = { type: 'string' as const };
  const output = {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  };
  const run = async (action: () => unknown | Promise<unknown>): Promise<string> => {
    try {
      const value = JSON.stringify(await action());
      if (value.length > 900_000)
        throw new DvpError(
          'RESPONSE_TOO_LARGE',
          `返回 ${value.length} 字符超出 900000 上限；请用更小 limit 或分批请求。`,
        );
      return value;
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'ASK_ABORTED')))
        return JSON.stringify({ ok: false, code: 'CANCELLED' });
      if (error instanceof DvpError || error instanceof RulesInputError || error instanceof WorkbookError) {
        return JSON.stringify({ ok: false, code: error.code, detail: error.message });
      }
      return JSON.stringify({
        ok: false,
        code: 'DVP_OPERATION_FAILED',
        notice: '未知错误正文未直接返回；请在本地查看运行日志。',
      });
    }
  };
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_methods',
      description:
        '检索 DVP 方法知识（种子与已沉淀候选）：template/firewhen/protocol/uat/cases。种子为 CANDIDATE，未复现验证不称 ACTIVE；知识是方法参考不是授权，不替代当前项目文档。',
      parameters: {
        topic: { ...string_type, required: true, enum: [...METHOD_TOPICS] },
        projectId: { ...string_type, description: '当前项目 ID（与快照绑定的项目一致时用于固定集合检索）。' },
        snapshotJson: {
          ...string_type,
          description:
            '可选：Run 创建时绑定的知识快照 JSON。提供时在固定修订集合内检索；缺省时结果标注 retrieval=LIVE_UNBOUND（活库、未绑定），不冒称固定集合。',
        },
      },
      output,
      async execute(args) {
        return run(() => {
          const context: { pluginId: string; projectId?: string } = {
            pluginId: DVP_PLUGIN_ID,
            ...(args.projectId ? { projectId: args.projectId } : {}),
          };
          const options = {
            states: ['ACTIVE', 'CANDIDATE'] as Array<'ACTIVE' | 'CANDIDATE'>,
            topics: METHOD_TOPIC_MAP[args.topic as keyof typeof METHOD_TOPIC_MAP],
            limit: 100,
          };
          if (args.snapshotJson) {
            if (args.snapshotJson.length > 2_000_000) throw new DvpError('KNOWLEDGE_SNAPSHOT_INVALID', 'snapshot JSON 过大');
            return {
              source: 'platform-knowledge',
              retrieval: 'PINNED_SNAPSHOT',
              seedVersion: DVP_SEED_VERSION,
              ...knowledge.searchPinned(context, JSON.parse(args.snapshotJson), options),
              notice: '快照内固定修订；撤回/撤权条目在 evidence.excluded 中显式列出。',
            };
          }
          return {
            source: 'platform-knowledge',
            retrieval: 'LIVE_UNBOUND',
            seedVersion: DVP_SEED_VERSION,
            ...knowledge.search(context, options),
            notice: '历史种子当前为候选；未绑定 Run 快照，结果为活库检索（不冒充固定集合）。',
          };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_knowledge_capture',
      description:
        '把当前任务中已核实的 DVP 纠错方法沉淀为 CANDIDATE 知识；未复现验证不会激活也不进入默认检索。前提/反例/来源必填（激活的必要证据），不接受自报通过。claimsCsv 只写可由已安装验证器复现的具体断言；没有 claims 的方法永远保持 CANDIDATE。',
      parameters: {
        knowledgeId: { ...string_type, required: true, description: '新知识 ID；同 ID 重复 capture 会版本冲突。' },
        title: { ...string_type, required: true },
        method: { ...string_type, required: true, description: '方法正文，≤20000 字符。' },
        problemSignal: { ...string_type, required: true },
        cause: { ...string_type, required: true },
        preconditionsCsv: { ...string_type, required: true, description: '适用前提，逗号分隔。' },
        counterexamplesCsv: { ...string_type, required: true, description: '不适用情形/反例，逗号分隔。' },
        sourcesCsv: { ...string_type, required: true, description: '证据来源，逗号分隔。' },
        topicsCsv: { type: 'string' },
        notApplicableCsv: { type: 'string' },
        claimsCsv: {
          ...string_type,
          description: '可由已安装验证器复现的具体断言，逗号分隔。没有 claims 的方法不会激活。',
        },
      },
      output,
      async execute(args) {
        return run(() => {
          const csv = (v?: string) =>
            (v ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
          if (args.method.length > 20000) throw new DvpError('KNOWLEDGE_TEXT_INVALID', 'method exceeds 20000 chars');
          const draft: KnowledgeDraft = {
            knowledgeId: args.knowledgeId,
            scope: 'plugin',
            pluginId: DVP_PLUGIN_ID,
            kind: 'scenario_method',
            title: args.title,
            problemSignal: args.problemSignal,
            cause: args.cause,
            method: args.method,
            scenarios: ['dvp'],
            edc: [],
            topics: csv(args.topicsCsv),
            preconditions: csv(args.preconditionsCsv),
            notApplicable: csv(args.notApplicableCsv),
            counterexamples: csv(args.counterexamplesCsv),
            sources: csv(args.sourcesCsv),
            ...(csv(args.claimsCsv).length ? { claims: csv(args.claimsCsv) } : {}),
          };
          return knowledge.capture({ pluginId: DVP_PLUGIN_ID }, draft);
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_knowledge_validate',
      description:
        '对 CANDIDATE 方法运行已安装业务验证器（固定正/反/边界用例）；只有候选声明的全部 claims 都被该套件覆盖且测试通过，才转 ACTIVE 并写回执。无 claims、部分覆盖或测试失败均保持 CANDIDATE 并记事件；不接受模型自报。',
      parameters: {
        knowledgeId: { ...string_type, required: true },
        revision: { type: 'number', required: true },
        validatorId: { ...string_type, required: true },
      },
      output,
      async execute(args) {
        return run(() =>
          knowledge.validate({ pluginId: DVP_PLUGIN_ID }, args.knowledgeId, args.revision, args.validatorId),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_knowledge_events',
      description: '读取指定 DVP 知识的最近学习/验证事件（捕获、种子冲突、验证失败、激活等），最新在前。',
      parameters: { knowledgeId: { ...string_type, required: true }, limit: { type: 'number' } },
      output,
      async execute(args) {
        return run(() =>
          knowledge.events({ pluginId: DVP_PLUGIN_ID }, args.knowledgeId, 0, Math.min(args.limit ?? 50, 100)),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_status',
      description: 'dm-dvp 插件状态：版本、模板 schema 依据、数据边界与候选纪律。',
      parameters: {},
      output,
      async execute() {
        return run(() => ({
          version: '0.3.0',
          templateSchema: 'docs/DVP-TEMPLATE-SCHEMA.md',
          research: 'docs/DVP-GENERATION-RESEARCH.md',
          boundaries: BOUNDARY_NOTICES,
          knowledge: { pluginId: DVP_PLUGIN_ID, seedVersion: seedState.version, topics: [...METHOD_TOPICS], seedState },
          discipline: '全部生成物为候选（CANDIDATE）；不伪报验证结果；UAT 用例由项目团队在行内留档执行。',
          tools: [
            'dm_dvp_read_protocol',
            'dm_dvp_overview',
            'dm_dvp_parse_workbook',
            'dm_dvp_validate_rules',
            'dm_dvp_suggest_cases',
            'dm_dvp_render_checks',
            'dm_dvp_write_workbook',
            'dm_dvp_methods',
            'dm_dvp_knowledge_capture',
            'dm_dvp_knowledge_validate',
            'dm_dvp_knowledge_events',
          ],
        }));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_overview',
      description:
        '列出 DVP workbook 全部 sheet 及角色分类（含 Cover，标记不读取）。不读取任何单元格内容；按任务需要决定是否继续读取某个 sheet。',
      parameters: { directory: { ...string_type, required: true }, workbookPath: { ...string_type, required: true } },
      output,
      async execute(args) {
        return run(() => overviewDvpWorkbook(args.directory, args.workbookPath));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_parse_workbook',
      description:
        '解析公司 DVP workbook 为规则 IR：跨字段规则（含 fire-when 结构化解析与诊断）、字段级规格、人工评审（受试者号/评审意见只计数）、动态规格与版本历史。未识别 sheet 只记录存在。limit 为每区每页条数（默认 200，最大 1000）；超过一页时按返回的 paging.nextOffset 与同一 section 继续读取，offset 必须配 section。aggregate total 覆盖全量。',
      parameters: {
        directory: { ...string_type, required: true },
        workbookPath: { ...string_type, required: true },
        limit: { type: 'number', description: '每区每页条数上限；默认 200，最大 1000。' },
        section: {
          ...string_type,
          enum: ['crossField', 'fieldLevel', 'manualReview', 'dynamic', 'versionHistory'],
          description: '翻页时指定要读取的业务区；指定后只返回该区，manualReview 合并两个人工评审 sheet。',
        },
        offset: {
          type: 'number',
          description: '该 section 的起始偏移，取上一页 paging.nextOffset；必须同时指定 section。',
        },
      },
      output,
      async execute(args) {
        return run(() =>
          parseDvpWorkbook(args.directory, args.workbookPath, {
            limit: args.limit,
            offset: args.offset,
            section: args.section as DvpSection | undefined,
          }),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_validate_rules',
      description:
        '校验规则数组（dm_dvp_parse_workbook 输出的 crossField 或其子集，JSON 字符串）：完整性诊断 + fire-when 结构化解析。只报诊断，不改语义，不伪报通过。',
      parameters: {
        rulesJson: { ...string_type, required: true, description: '规则数组或 {crossField:[...]} 的 JSON 字符串。' },
      },
      output,
      async execute(args) {
        return run(() => {
          const rules = parseRulesJson(args.rulesJson);
          const enriched = rules.map(withLogicParse);
          return {
            summary: {
              rules: enriched.length,
              withIssues: enriched.filter((r) => r.issues.length || (r.logicParse?.diagnostics.length ?? 0)).length,
              structuredLogic: enriched.filter((r) => r.logicParse?.status === 'structured').length,
              freeformLogic: enriched.filter((r) => r.logicParse?.status === 'freeform').length,
            },
            rules: enriched.map((r) => ({
              id: r.id || '(no id)',
              queryType: r.queryType,
              issues: r.issues,
              logic: r.logicParse
                ? { status: r.logicParse.status, fields: r.logicParse.fields, diagnostics: r.logicParse.diagnostics }
                : null,
            })),
          };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_suggest_cases',
      description:
        '为规则数组生成测试用例候选：正例（应触发）/反例（不应触发）/恰边界（结构化推导）与 unresolved（需人工设计）。候选从未在任何 EDC/UAT 执行，不构成验证证据。',
      parameters: {
        rulesJson: { ...string_type, required: true, description: '规则数组或 {crossField:[...]} 的 JSON 字符串。' },
      },
      output,
      async execute(args) {
        return run(() => suggestCases(parseRulesJson(args.rulesJson)));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_render_checks',
      description:
        '把规则数组渲染为目标 EDC 配置参考：rave-steps（Rave 风格检查步骤 variable/operator/value/joiner）或 generic-expression（归一化 fire-when）。AND/OR 混合嵌套标记 NEEDS_MANUAL_GROUPING、复合 NOT 标记 NEEDS_MANUAL_REWRITE，freeform 不渲染。结果仅供参考，不写入生产 EDC 配置。',
      parameters: {
        rulesJson: { ...string_type, required: true, description: '规则数组或 {crossField:[...]} 的 JSON 字符串。' },
        target: { ...string_type, required: true, enum: [...RENDER_TARGETS] },
      },
      output,
      async execute(args) {
        return run(() => renderChecks(parseRulesJson(args.rulesJson), args.target as (typeof RENDER_TARGETS)[number]));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_read_protocol',
      description:
        '读取方案 PDF 的文本层（语言随项目）。window 可选页区间（1-based 闭区间）。只返回文本层：表格、图表与版式信息不在其中；无文本层（扫描件）时明确 NEEDS_OCR，不做 OCR、不猜测内容；加密 PDF 拒绝（ENCRYPTED_PDF_UNSUPPORTED）；缺 ToUnicode 的字体以 U+FFFD 占位并计数。返回 sha256 与逐页文本。',
      parameters: {
        directory: { ...string_type, required: true },
        protocolPath: {
          ...string_type,
          required: true,
          description: 'PDF 路径（相对 directory 或绝对，但必须落在 directory 内）。',
        },
        startPage: { type: 'number', description: '起始页（1-based，可选）。' },
        endPage: { type: 'number', description: '结束页（含，可选）。' },
      },
      output,
      async execute(args) {
        return run(() =>
          readProtocol(args.directory, args.protocolPath, {
            ...(args.startPage !== undefined ? { startPage: args.startPage } : {}),
            ...(args.endPage !== undefined ? { endPage: args.endPage } : {}),
          }),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_write_workbook',
      description:
        '把规则 IR 写出为公司模板结构的 DVP 草稿工作簿（8 sheet：Cover/Approval 脚手架 + Version History + Edit Checks + Field Level + Manual Review×2 + Dynamic）。生成物为候选（CANDIDATE）；TEST CASE/DM/DBD Comments 永远留空；辅助 sheet 不生成。outputPath 必须在 directory 内，默认拒绝覆盖。',
      parameters: {
        directory: { ...string_type, required: true },
        outputPath: {
          ...string_type,
          required: true,
          description: '目标 xlsx 路径（相对或绝对，但必须落在 directory 内）。',
        },
        documentJson: {
          ...string_type,
          required: true,
          description: [
            '工作簿内容 JSON，区键：{project?, crossField?, fieldLevel?, manualReview?, manualReviewProgramming?, dynamic?, versionHistory?}。',
            'crossField 行：{id, formName, targetField, relatedFields?, queryType, discrepancyText, logic, visits?, changeMark?}；',
            'fieldLevel 行：{formOid, formName, fieldOid, preText?, controlType?, dataFormat?, isLog, isRequired, queryFutureDate, queryNonConformance, changeMark?}（布尔接受 true/false）；',
            'manualReview / manualReviewProgramming 行：{id, formName, reportDescription, discrepancyText?, logic?, visits?, relatedFields?, programming?:{assign?, columnHeading?}}（TEST CASE/DM/DBD 三列恒空）；',
            'dynamic 行：{id, formName, fieldName, type, visits?, discrepancyText?, condition?}，type 限 8 枚举 Dynamic Field/Dynamic Search list/Dynamic Page/Derivation/Dynamic Visit/Participant Status/Dynamic Option/Add Event，越枚举记 DYNAMIC_TYPE_UNRECOGNIZED 诊断；',
            'versionHistory 行：{version, date, modifiedBy?, comments?}；',
            'project：{studyCode?, studyTitle?, protocolNumber?, sponsor?, dvpVersion?, dvpDate?, createdBy?}。',
            '宽容别名：form→formName、fields→targetField(首)+relatedFields(余)、message→discrepancyText、targetedField→targetField、crfPageDomain→formName（dynamic）、author/by→modifiedBy、change/description→comments、code→studyCode、name/title→studyTitle、protocolNo/registry→protocolNumber、version→dvpVersion、date→dvpDate。',
            '未识别键照常写出能识别的部分，并在结果 notices 逐条列出未识别键（UNKNOWN_KEYS_IGNORED）供核对；issues 是带诊断的行数统计，覆盖已存在文件需显式 overwrite:true。',
          ].join(''),
        },
        overwrite: { type: 'boolean', description: '默认 false；显式 true 才允许覆盖已存在文件。' },
      },
      output,
      async execute(args) {
        return run(() =>
          writeDvpWorkbook(args.directory, args.outputPath, args.documentJson, { overwrite: args.overwrite }),
        );
      },
    }),
  );
}

// KA15 黄金集需要的自持知识导出（平台种子单一来源仍是 knowledge-seeds.ts）。
export { dvpSeeds, dvpKnowledgeContribution, DVP_PLUGIN_ID, DVP_SEED_VERSION } from './knowledge-seeds.js';
