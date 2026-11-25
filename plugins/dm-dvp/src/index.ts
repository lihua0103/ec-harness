/** dm-dvp 插件入口：公司 DVP 工作簿 → 规则 IR → 校验 → 用例候选。
 *  生成物一律 CANDIDATE；数据边界见 parse.ts 头注与 docs/DVP-TEMPLATE-SCHEMA.md §8。
 *  不限制 Harness 的通用工具或模型能力；本插件只提供领域工具与方法知识。 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-skill';
import { readFileSync } from 'node:fs';
import { WorkbookError } from '../../../packages/platform-workbook/src/index.js';
import { boundaryNotices, DvpError, overviewDvpWorkbook, parseDvpWorkbook, type DvpSection } from './parse.js';
import { dataBoundaryMode, fullAccess } from './data-boundary.js';
import { RulesInputError, parseRulesJson, withLogicParse } from './rules.js';
import { suggestCases } from './cases.js';
import { readInputWorkbook, scanInputs } from './inputs.js';
import { writeDvpWorkbook } from './write.js';
import { renderChecks, RENDER_TARGETS } from './render.js';
import { readProtocol } from './protocol.js';
import {
  dvpSeeds,
  dvpKnowledgeContribution,
  DVP_PLUGIN_ID,
  DVP_SEED_VERSION,
  METHOD_TOPICS,
  resolveMethodTopic,
} from './knowledge-seeds.js';
import { dvpMethodSuite } from './knowledge-validators.js';
import { captureHygiene, resolveCaptureScope, summarizeKnowledgeItems } from './knowledge-hygiene.js';
import type { KnowledgeDraft } from '../../../packages/platform-knowledge/src/schema.js';
import type {} from '../../../packages/platform-knowledge/src/cordis.js';

export const name = 'ec-clinical-dm-dvp';
export const inject = ['tools', 'skills', 'clinicalKnowledge'];

/** 随包 package.json 的版本：dm_dvp_status 如实上报，不再手写一份会过期的版本号。 */
export const DVP_PLUGIN_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** 数据安全开关（data-boundary.ts，用户手动维护，与模型无关）。下面这些片段在插件注册时按开关选定：
 *  full = 开关关闭（.runtime/data-boundary.json 的 dataSecurity=false）；redacted = 开关开启（默认）。 */
const FULL = fullAccess();
const COVER_NOTE = FULL ? 'Cover / Approval 在本部署全量可读' : '含 Cover，标记不读取';
const REVIEW_NOTE = FULL ? '含 TEST CASE 受试者号与 DM/DBD 评审意见原值；Cover / Approval 原值附在 stats.sheets[].content' : '受试者号/评审意见只计数';
const READ_SCOPE_HEAD = FULL ? '任意工作簿（含 DVP 模板）' : '非 DVP 模板工作簿';
const READ_SCOPE_NOTE = FULL
  ? '本部署已关闭数据安全开关：DVP 模板工作簿与 Cover / Approval / 未识别 sheet 均可直接读取。'
  : 'DVP 模板工作簿一律拒绝（请用 dm_dvp_overview / dm_dvp_parse_workbook，它们保证 Cover/Approval/TEST CASE 边界）；名为 Cover/Approval 的 sheet 不读。';
const SKILL_BOUNDARY_READ = FULL
  ? '本部署为全量模式：DVP 模板工作簿也可以用该工具直接读取任意 sheet（含 Cover / Approval / 未识别 sheet）。'
  : [
    'DVP 模板工作簿不能用该工具——Cover 永不读、Approval 不读、TEST CASE 只计数，',
    '  这些只由 dm_dvp_overview / dm_dvp_parse_workbook 保证；任何工作簿里名为 Cover / Approval 的 sheet 都不读。',
  ].join('\n');
const SKILL_BOUNDARY_SECTION = (FULL
  ? [
    '## 数据边界（随部署模式）',
    '- 本部署为全量模式（.runtime/data-boundary.json 的 dataSecurity=false，由用户自行开关）：工作簿内容（含 Cover / Approval / TEST CASE / DM/DBD 评审意见）全量可读、原值返回。',
    '- 全部生成物为候选（CANDIDATE），不是已验证 DVP；不伪报验证结果。',
  ]
  : [
    '## 数据边界（不可协商）',
    '- Cover sheet 内容永不读取；Approval 签署内容不读取。',
    '- Manual Review for Programming 的 TEST CASE 受试者号与 DM/DBD 评审意见只计数、不回传。',
    '- 未识别 sheet 只记录存在，不读取内容。',
    '- 全部生成物为候选（CANDIDATE），不是已验证 DVP；不伪报验证结果。',
  ]
).join('\n');

const SKILL_CONTENT = `# dm-dvp 方法（DVP 内容生成）

## 输入与可用能力
- 工作目录内容：dm_dvp_scan 列出方案 PDF 与工作簿（含 ALS 导出）的存在、大小与修改时间，不读内容；
  其他类型按扩展名计数。目录里有哪些文件不确定时用它查看。
- 方案 PDF（语言随项目）：dm_dvp_read_protocol 读取文本层（window 控制页区间）。只返回文本层——表格、图表与版式不在其中；
  扫描件返回 NEEDS_OCR（不做 OCR、不凭图猜内容）；加密 PDF 拒绝；缺 ToUnicode 字体以 U+FFFD 占位并计数（ENCODING_FIDELITY）；
  解析 ObjStm 压缩页对象；页树声明页数与实际解析页数不一致时明确告警，不能当作方案完整。
- 公司 DVP 模板 workbook（12 sheet 四层结构：治理/规则/人工/系统功能）：dm_dvp_overview 返回 sheet 角色；
  dm_dvp_parse_workbook 返回规则 IR（跨字段规则/字段级规格/人工评审/动态/版本历史 + 逐条诊断），
  可按 section + paging.nextOffset 继续读取；dm_dvp_validate_rules 复核完整性；dm_dvp_suggest_cases 生成
  正例/反例/恰边界候选；dm_dvp_render_checks 给出目标 EDC 配置参考；dm_dvp_write_workbook 写出草稿工作簿。
- ALS / 数据库结构等非 DVP 模板工作簿：dm_dvp_read_workbook 读取任意 sheet（先省略 sheetId 取清单；大表用
  startRow/endRow 分窗口）。${SKILL_BOUNDARY_READ}
  旧版 .xls（二进制）不能直接读取，需另存为 .xlsx。
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
沉淀范围纪律：项目专属的观察/裁定带 projectId 走 project scope（仅该项目可见）；跨项目通用的方法才省略 projectId（plugin scope），正文必须去项目化——不写本机路径、联系方式、证件号、项目代号。新沉淀的候选不会当场激活：随包验证器只绑定了种子条目。

## 行内变更控制
Add/Delete/Update 列形如 Add/V2.0 = 动作/版本。逐版本追溯差异属后续版本（KnowledgeService 生命周期）。

${SKILL_BOUNDARY_SECTION}
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
        '检索 DVP 方法知识（种子与已沉淀候选）：template/firewhen/protocol/uat/cases（topic 可填主题名，也可用自然语言描述）。种子为 CANDIDATE，未复现验证不称 ACTIVE；知识是方法参考不是授权，不替代当前项目文档。',
      parameters: {
        topic: {
          ...string_type,
          // 不设 enum/必填：真实会话里模型 15 次把自然语言描述传进来被 INVALID_ARGS 挡回（2026-11-24）。
          // 参数校验不该替模型做归类——执行时按关键词归入最接近的主题，归不进去就检索全部主题。
          description:
            '要检索的方法主题。可写主题名：template（模板结构/列语义）、firewhen（fire-when 方言）、protocol（方案 PDF 抽取）、uat（用例与 UAT 边界）、cases（用例设计）；也可以直接用自然语言描述想查什么，会按关键词归入最接近的主题，归不进去或省略时检索全部主题。没有 directory 参数——知识库检索不需要目录。',
        },
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
          const resolved = resolveMethodTopic(args.topic);
          const options = {
            states: ['ACTIVE', 'CANDIDATE'] as Array<'ACTIVE' | 'CANDIDATE'>,
            topics: resolved.topics,
            limit: 100,
          };
          // 如实告诉模型主题是怎么归类的；归不进去时给出可选的精确主题名，下一轮自然收窄
          const topicInfo = {
            requestedTopic: args.topic ?? null,
            resolvedTopic: resolved.topic,
            topicMatch: resolved.matched,
            validTopics: [...METHOD_TOPICS],
            ...(resolved.topic === null ? { topicNotice: '主题未指定或无法归入既定主题，已检索全部主题；下一次可从 validTopics 里选一个主题名以收窄结果。' } : {}),
          };
          if (args.snapshotJson) {
            if (args.snapshotJson.length > 2_000_000) throw new DvpError('KNOWLEDGE_SNAPSHOT_INVALID', 'snapshot JSON 过大');
            const found = knowledge.searchPinned(context, JSON.parse(args.snapshotJson), options);
            return {
              source: 'platform-knowledge',
              retrieval: 'PINNED_SNAPSHOT',
              // 快照 JSON 由调用方回传：固定集合的出处是调用方自述，平台只校验摘要、范围与逐条可见性。
              snapshotSource: 'caller_supplied',
              seedVersion: DVP_SEED_VERSION,
              ...topicInfo,
              ...found,
              ...summarizeKnowledgeItems(found.items, found.total),
              notice: '快照内固定修订；撤回/撤权条目在 evidence.excluded 中显式列出。',
            };
          }
          const found = knowledge.search(context, options);
          return {
            source: 'platform-knowledge',
            retrieval: 'LIVE_UNBOUND',
            seedVersion: DVP_SEED_VERSION,
            ...topicInfo,
            ...found,
            ...summarizeKnowledgeItems(found.items, found.total),
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
        '把当前任务中已核实的 DVP 纠错方法沉淀为知识，始终先落 CANDIDATE：未通过已安装验证器不会 ACTIVE，也不进入 Run 的知识快照；dm_dvp_methods 检索会把候选与 ACTIVE 一并返回并逐条标注 state——候选不是已验证方法。范围纪律：项目专属的观察/裁定带 projectId（project scope，仅该项目可见）；省略 projectId 即 plugin scope（跨项目可见），正文必须去项目化。前提/反例/来源必填，不接受自报通过。claimsCsv 只写可由已安装验证器复现的具体断言；没有 claims 的方法永远保持 CANDIDATE。',
      parameters: {
        knowledgeId: { ...string_type, required: true, description: '新知识 ID；同 ID 重复 capture 会版本冲突。' },
        title: { ...string_type, required: true },
        method: { ...string_type, required: true, description: '方法正文，≤20000 字符。' },
        problemSignal: { ...string_type, required: true },
        cause: { ...string_type, required: true },
        preconditionsCsv: { ...string_type, required: true, description: '适用前提，逗号分隔。' },
        counterexamplesCsv: { ...string_type, required: true, description: '不适用情形/反例，逗号分隔。' },
        sourcesCsv: { ...string_type, required: true, description: '证据来源，逗号分隔。' },
        projectId: {
          ...string_type,
          description:
            '可选。给出时按 project scope 沉淀（仅该项目可见）——项目专属的观察、裁定、带项目代号的来源应走这里；省略时按 plugin scope 沉淀为跨项目通用方法。',
        },
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
          // 命名空间、范围与卫生体检由代码裁决，不取决于模型选了什么 ID / scope 用词。
          if (!args.knowledgeId.startsWith(`${DVP_PLUGIN_ID}.`) || args.knowledgeId.length <= DVP_PLUGIN_ID.length + 1)
            throw new DvpError('KNOWLEDGE_ID_NAMESPACE', `knowledgeId 必须以 ${DVP_PLUGIN_ID}. 开头并带条目名`);
          const target = resolveCaptureScope(args.projectId);
          const hygiene = captureHygiene({
            knowledgeId: args.knowledgeId,
            scope: target.scope,
            text: [
              args.title, args.problemSignal, args.cause, args.method, args.preconditionsCsv,
              args.counterexamplesCsv, args.sourcesCsv, args.topicsCsv, args.notApplicableCsv, args.claimsCsv,
            ].join('\n'),
          });
          if (hygiene.rejected) throw new DvpError('KNOWLEDGE_SENSITIVE_CONTENT', hygiene.reason ?? '候选含不该进入知识库的内容');
          const draft: KnowledgeDraft = {
            knowledgeId: args.knowledgeId,
            scope: target.scope,
            pluginId: DVP_PLUGIN_ID,
            ...(target.scope === 'project' ? { projectId: target.projectId } : {}),
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
          const record = knowledge.capture(
            { pluginId: DVP_PLUGIN_ID, ...(target.scope === 'project' ? { projectId: target.projectId } : {}) },
            draft,
          );
          // 卫生体检结果随回执返回（开关关闭时命中不拦截，但如实计数）。
          return { ...record, hygiene: { mode: hygiene.mode, hits: hygiene.hits } };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_knowledge_validate',
      description:
        '对 CANDIDATE 方法运行已安装业务验证器（固定正/反/边界用例）。转 ACTIVE 须同时满足：候选内容摘要与套件预先安装的覆盖绑定逐字一致、声明的全部 claims 被覆盖、测试全部通过。随包套件只绑定了种子条目，所以新沉淀的候选会得到 VALIDATION_SCOPE_INSUFFICIENT（reason=CONTENT_BINDING_MISMATCH）并保持 CANDIDATE——这是预期结果，不必重试；激活需要随插件发布安装新的覆盖绑定。无 claims、部分覆盖或测试失败同样保持 CANDIDATE 并记事件；不接受模型自报。',
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
          version: DVP_PLUGIN_VERSION,
          templateSchema: 'docs/DVP-TEMPLATE-SCHEMA.md',
          research: 'docs/DVP-GENERATION-RESEARCH.md',
          boundaries: boundaryNotices(),
          dataBoundary: dataBoundaryMode(),
          knowledge: { pluginId: DVP_PLUGIN_ID, seedVersion: seedState.version, topics: [...METHOD_TOPICS], seedState },
          discipline: '全部生成物为候选（CANDIDATE）；不伪报验证结果；UAT 用例由项目团队在行内留档执行。',
          harness: '本插件不限制 Harness 通用工具或模型能力；通用工具（文件、搜索、Shell、代码等）照常可用。以下仅列本插件提供的领域工具。',
          tools: [
            'dm_dvp_scan',
            'dm_dvp_read_protocol',
            'dm_dvp_read_workbook',
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
        `列出 DVP workbook 全部 sheet 及角色分类（${COVER_NOTE}）。不读取任何单元格内容；按任务需要决定是否继续读取某个 sheet。`,
      parameters: {
        directory: {
          ...string_type,
          required: true,
          description:
            '工作目录的绝对路径（例如 D:\\project\\company\\epro\\Project\\DXP-DSH）。必须是已存在的目录本身，不要填到文件；路径未知时先用 dm_dvp_scan 定位。',
        },
        workbookPath: {
          ...string_type,
          required: true,
          description:
            'DVP 模板工作簿的路径：可写相对 directory 的文件名（例如 "DVP_v2.xlsx"），也可写绝对路径，但必须落在 directory 内。不是方案 PDF，也不是 ALS 等其他工作簿。',
        },
      },
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
        `解析公司 DVP workbook 为规则 IR：跨字段规则（含 fire-when 结构化解析与诊断）、字段级规格、人工评审（${REVIEW_NOTE}）、动态规格与版本历史。未识别 sheet 只记录存在。limit 为每区每页条数（默认 200，最大 1000）；超过一页时按返回的 paging.nextOffset 与同一 section 继续读取，offset 必须配 section。aggregate total 覆盖全量。`,
      parameters: {
        directory: {
          ...string_type,
          required: true,
          description:
            '工作目录的绝对路径（例如 D:\\project\\company\\epro\\Project\\DXP-DSH）。必须是已存在的目录本身；路径未知时先用 dm_dvp_scan 定位。',
        },
        workbookPath: {
          ...string_type,
          required: true,
          description:
            'DVP 模板工作簿的路径：可写相对 directory 的文件名（例如 "DVP_v2.xlsx"）或绝对路径，但必须落在 directory 内。不是方案 PDF，也不是 ALS 等其他工作簿（那些用 dm_dvp_read_workbook）。',
        },
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
      name: 'dm_dvp_scan',
      description:
        '列出工作目录内的输入文件（只看存在与属性，不读内容）：方案 PDF（protocol）、可读工作簿 .xlsx/.xlsm（workbook）、旧版或二进制工作簿 .xls/.xlsb 等（unsupportedWorkbook，需另存为 .xlsx 才能读取）；其他类型按扩展名计数。不跟随符号链接，跳过点开头的目录与 node_modules。recursive=false 或 maxDepth=0 只看顶层；相关文件超过 500 个时截断并在 notices 标明。',
      parameters: {
        directory: {
          ...string_type,
          required: true,
          description:
            '工作目录的绝对路径（例如 D:\\project\\company\\epro\\Project\\DXP-DSH）。必须是已存在的目录本身；路径未知时先用 dm_dvp_scan 定位。本工具不接受 workbookPath 或 topic。',
        },
        recursive: { type: 'boolean', description: '默认 true。' },
        maxDepth: { type: 'number', description: '递归深度上限，默认 8，最大 32；0 = 只看顶层。' },
      },
      output,
      async execute(args) {
        return run(() => scanInputs(args.directory, {
          ...(args.recursive !== undefined ? { recursive: args.recursive } : {}),
          ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
        }));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_read_workbook',
      description:
        `读取目录内${READ_SCOPE_HEAD}（ALS / 数据库结构等）的 sheet。不给 sheetId：返回 sheet 清单（角色与可读性）。给 sheetId：返回整表，或 startRow/endRow 行窗口内的单元格（坐标、值、类型；公式只给表达式不给缓存值）、合并区、隐藏行列与警告。${READ_SCOPE_NOTE}大表请分窗口读（建议每窗 ≤ 1000 行）。仅支持 .xlsx/.xlsm。`,
      parameters: {
        directory: { ...string_type, required: true },
        workbookPath: { ...string_type, required: true, description: '工作簿路径（相对 directory 或绝对，但必须落在 directory 内）。' },
        sheetId: { ...string_type, description: '清单返回的 sheet id；省略时返回清单。' },
        startRow: { type: 'number', description: '行窗口起始（1-based，含）；须与 endRow 同时给出。' },
        endRow: { type: 'number', description: '行窗口结束（含）；须与 startRow 同时给出。' },
      },
      output,
      async execute(args) {
        return run(() => {
          if (args.startRow === undefined && args.endRow === undefined) {
            return readInputWorkbook(args.directory, args.workbookPath, args.sheetId);
          }
          if (args.startRow === undefined || args.endRow === undefined) {
            throw new DvpError('WINDOW_INCOMPLETE', 'startRow 与 endRow 须同时给出');
          }
          return readInputWorkbook(args.directory, args.workbookPath, args.sheetId, {
            startRow: args.startRow,
            endRow: args.endRow,
          });
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_dvp_write_workbook',
      description:
        '把规则 IR 写出为公司模板结构的 DVP 草稿工作簿（默认 8 sheet：Cover/Approval 脚手架 + Version History + Edit Checks + Field Level + Manual Review×2 + Dynamic；template 可按实物差量配置 sheet 集与列）。各内容区可为内联数组或文件引用（NDJSON/JSON 数组，路径相对 directory 且不得越界）——千级规则的全量物化走 bulk 引用，模型只产映射不逐条内联。生成物为候选（CANDIDATE）；TEST CASE/DM/DBD Comments 永远留空；辅助 sheet 不生成。outputPath 必须在 directory 内，默认拒绝覆盖。',
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
            '工作簿内容 JSON，区键：{project?, template?, crossField?, fieldLevel?, manualReview?, manualReviewProgramming?, dynamic?, versionHistory?, subjectStatus?, matrix?}。',
            '区值两类写法：① 内联数组；② 文件引用字符串（相对 directory 的 NDJSON——每行一个 JSON 对象、空行跳过——或 JSON 数组文件，≤8MB，必须落在 directory 内，越界/缺文件/坏行按 BULK_REF_OUTSIDE_DIRECTORY/BULK_FILE_NOT_FOUND/BULK_FILE_BAD_LINE:<行号> 拒绝；成功后在结果 notices 回报 BULK_SOURCE:<区>=<相对路径>(<n> rows)）。千级规则一律走 ②。',
            'template（可选，模板差量配置）：{governanceOrder?: "cover-first"|"approval-first"（默认 cover-first；实物 V6.0 为 approval-first）, editChecksQueryType?: boolean（默认 true；V6.0 实物无 Query Type 列设 false）, fieldLevelSheetName?: string（默认 "Edit Checks(Field Level)"；V6.0 实物为 "Edit Checks Rave"，≤31 字符且不含 []:*?/\\）, dynamicSheetName?: string（默认 "Dynamic"；个别实物为 "Dynamics"，限制同上）, includeProgramming?: boolean（默认 true；V6.0 无 Programming 页设 false）, includeSubjectStatus?: boolean, includeMatrix?: boolean（默认 false；对应区有行时自动生成该页）}。旋钮中性只约束工具不替调用方判断：调用方（模型）须在汇报中逐项说明各旋钮最终取值与依据（识别到的实物形态，或「未识别，用默认」），不得静默套默认。',
            'crossField 行：{id, formName, targetField, relatedFields?, queryType, discrepancyText, logic, visits?, changeMark?}；',
            'fieldLevel 行：{formOid, formName, fieldOid, preText?, controlType?, dataFormat?, isLog, isRequired, queryFutureDate, queryNonConformance, changeMark?}（布尔接受 true/false）；',
            'manualReview / manualReviewProgramming 行：{id, formName, reportDescription, discrepancyText?, logic?, visits?, relatedFields?, programming?:{assign?, columnHeading?}}（TEST CASE/DM/DBD 三列恒空）；',
            'dynamic 行：{id, formName, fieldName, type, visits?, discrepancyText?, condition?}，type 限 8 枚举 Dynamic Field/Dynamic Search list/Dynamic Page/Derivation/Dynamic Visit/Participant Status/Dynamic Option/Add Event，越枚举记 DYNAMIC_TYPE_UNRECOGNIZED 诊断；',
            'versionHistory 行：{version, date, modifiedBy?, comments?}；',
            'subjectStatus 行：{status, condition}（受试者状态定义，条件用【表单.字段】记法）；matrix 行：{id, folder?, oid?, forms?: string[]}（访视→表单矩阵，folder 亦接受实物拼写 folrder，forms 可为分号/换行分隔文本）；',
            'project：{studyCode?, studyTitle?, protocolNumber?, sponsor?, dvpVersion?, dvpDate?, createdBy?}。零编造纪律：versionHistory 只写有输入证据的行（协议版本/日期 + 本次生成行），实物惯例是历史版本行由人类维护、日期列留空。',
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
