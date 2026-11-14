/** Clinical domain contributions. No global tool restrictions or model-provider overrides. */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-user-questions';
import { resolve } from 'node:path';
const string_type = { type: 'string' as const };
import { ListingService, type Item } from './service.js';
import { probeRuntime, type RuntimeSpec } from './runner.js';
import { clinicalMethods, listingWorkflow, scenario, SCENARIOS, KNOWLEDGE_VERSION, profiles } from './knowledge.js';
import { pkCommonMethods, pkBeMethods, pkSadMadMethods } from './pk-methods.js';
import { scanProject, readProjectWorksheet, readProjectArtifact } from './project.js';
import { resolveRuntime, describeDataset } from './datasets.js';
import { overviewProject, readWorkflowSheet, describeWorkflowDataset } from './workflow.js';
import { ListingError } from './workbook.js';
import { TaskStore } from './storage.js';
import { manualMethods, MANUAL_METHODS_VERSION, suggestManualColumnRoles } from './manual-methods.js';
import { scenarioMethodSkill, METHOD_TOPICS, type MethodTopic } from './scenario-methods.js';
import {
  listingSeeds,
  listingKnowledgeContribution,
  LISTING_PLUGIN_ID,
  LISTING_SEED_VERSION,
} from './knowledge-seeds.js';
import { listingMethodSuite } from './knowledge-validators.js';
import type { KnowledgeDraft } from '../../../packages/platform-knowledge/src/schema.js';
import type {} from '../../../packages/platform-knowledge/src/cordis.js';

export const name = 'ec-clinical-dm-listing';
export const inject = ['tools', 'skills', 'userQuestions', 'clinicalKnowledge'];
/** Platform knowledge is installed independently; Listing does not own/close its service. */
export function apply(ctx: Context): void {
  const knowledge = ctx.clinicalKnowledge;
  const unregister = knowledge.registerContribution(listingKnowledgeContribution);
  ctx.effect(() => unregister);
  // Activation requires this installed suite; model JSON cannot register or replace validators.
  ctx.effect(() => knowledge.registerValidator(LISTING_PLUGIN_ID, listingMethodSuite));
  // A seed problem must degrade one capability, not kill plugin assembly; status reports it either way.
  let seedState: { version: string; result: unknown } | { version: string; error: string };
  try {
    seedState = {
      version: LISTING_SEED_VERSION,
      result: knowledge.importSeeds(LISTING_PLUGIN_ID, LISTING_SEED_VERSION, listingSeeds),
    };
  } catch (error) {
    seedState = { version: LISTING_SEED_VERSION, error: error instanceof Error ? error.message : 'UNKNOWN' };
  }
  const sessions = new Map<object, ListingService>();
  const root = resolve(process.env.DSH_HOME ?? '.runtime/dsh-home', 'dm-listing-synthetic');
  ctx.effect(() => () => {
    for (const instance of sessions.values()) instance.close();
    sessions.clear();
  });
  const service = (exec: ToolExecution): ListingService => {
    if (!exec.agent) throw new ListingError('LIVE_AGENT_REQUIRED');
    const key = exec.agent.session;
    let s = sessions.get(key);
    if (!s) {
      s = new ListingService(root, String(exec.agent.session.header.id));
      sessions.set(key, s);
    }
    return s;
  };
  for (const [skillName, description, content] of [
    ['clinical-dm-methods', '临床 DM 共通知识：需求追溯、关联、日期、合成验证及原始 data 边界。', clinicalMethods],
    ['dm-listing', 'Medical / Manual / Report / PK Listing：自主理解 spec、生成 R、合成测试和交付。', listingWorkflow],
    [
      'dm-listing-manual-methods',
      'Manual/Medical成功纠错：spec逐列职责、范围/行/列/输出、重复标记、连接展开与服务器R交付。',
      manualMethods,
    ],
    [
      'dm-listing-scenario-methods',
      '三项目成功纠错经验：Manual/Medical、PK BE、PK SAD/MAD及spec/ALS/SAS识别和执行修复。',
      scenarioMethodSkill,
    ],
  ])
    ctx.skills.register({
      name: skillName,
      description,
      content,
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    });
  const output = {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  };
  const run = async (action: () => unknown | Promise<unknown>): Promise<string> => {
    try {
      return JSON.stringify(await action());
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'ASK_ABORTED')))
        return JSON.stringify({ ok: false, code: 'CANCELLED' });
      if (error instanceof ListingError) return JSON.stringify({ ok: false, code: error.code, detail: error.message });
      return JSON.stringify({
        ok: false,
        code: 'LISTING_OPERATION_FAILED',
        notice: '未知错误正文未直接返回；请在本地查看运行日志。',
      });
    }
  };
  const id = {
    type: 'string' as const,
    required: true as const,
    description: '当前会话的内置合成工作区 ID，不是文件路径。',
  };
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_manual_methods',
      description:
        '获取Manual/Medical通用成功纠错方法。可选headersJson返回全部原始标题与非强制语义线索；不丢未知列，不执行或替代AI需求理解。',
      parameters: {
        headersJson: { type: 'string', description: '可选标题字符串数组JSON；只提供导航，不设固定schema。' },
      },
      output,
      async execute(args) {
        return run(() => {
          let headers: unknown = [];
          if (args.headersJson) {
            if (args.headersJson.length > 200000) throw new ListingError('HEADERS_TOO_LARGE');
            headers = JSON.parse(args.headersJson);
          }
          if (!Array.isArray(headers) || headers.some((h) => typeof h !== 'string'))
            throw new ListingError('HEADERS_INVALID');
          return {
            version: MANUAL_METHODS_VERSION,
            source: 'platform-knowledge',
            columnHints: suggestManualColumnRoles(headers),
            authoritative: false,
            ...knowledge.search(
              { pluginId: LISTING_PLUGIN_ID, scenario: 'manual' },
              { states: ['ACTIVE', 'CANDIDATE'], topics: ['manual'], limit: 100 },
            ),
          };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_scenario_methods',
      description:
        '按需检索已交付Manual、PK BE、PK SAD/MAD的通用成功纠错方法。Medical复用Manual；方法不替代当前项目需求，不加载旧业务答案。',
      parameters: { topic: { type: 'string', required: true, enum: [...METHOD_TOPICS] } },
      output,
      async execute(args) {
        return run(() => {
          const scenarioName: Record<MethodTopic, string | undefined> = {
            intake: undefined,
            manual: 'manual',
            medical: 'medical',
            pk: 'pk',
            'pk-be': 'be',
            'pk-sad-mad': 'sad-mad',
          };
          const topic = args.topic as MethodTopic;
          const topics =
            topic === 'intake'
              ? ['intake']
              : topic === 'pk-be'
                ? ['pk', 'pk-be']
                : topic === 'pk-sad-mad'
                  ? ['pk', 'pk-sad-mad']
                  : topic === 'pk'
                    ? ['pk']
                    : [topic];
          return {
            source: 'platform-knowledge',
            seedVersion: LISTING_SEED_VERSION,
            ...knowledge.search(
              { pluginId: LISTING_PLUGIN_ID, scenario: scenarioName[topic] },
              { states: ['ACTIVE', 'CANDIDATE'], topics, limit: 100 },
            ),
            notice: '历史种子当前为候选；未复现验证不称ACTIVE。',
          };
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_scan_project',
      description: '扫描本地项目目录：文件清单、摘要、spec/ALS/数据候选证据。只读；分页限制明确返回。',
      parameters: { directory: { ...string_type, required: true } },
      output,
      async execute(args) {
        return run(() => scanProject(args.directory));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_read_workbook',
      description: '读取项目内 Excel/工作簿任意 sheet（含 Cover）整表或行窗口，返回坐标、隐藏/合并/公式表达式与警告。',
      parameters: {
        directory: { ...string_type, required: true },
        workbookPath: { ...string_type, required: true },
        sheetId: { ...string_type, required: true },
        startRow: { type: 'number' },
        endRow: { type: 'number' },
      },
      output,
      async execute(args) {
        return run(() =>
          readProjectWorksheet(
            args.directory,
            args.workbookPath,
            args.sheetId,
            args.startRow !== undefined && args.endRow !== undefined
              ? { startRow: args.startRow, endRow: args.endRow }
              : undefined,
          ),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_read_artifact',
      description: '读取项目内文本/SAS/R对象/压缩文件（受大小限制），文本返回原文，二进制返回base64与摘要。',
      parameters: { directory: { ...string_type, required: true }, path: { ...string_type, required: true } },
      output,
      async execute(args) {
        return run(() => readProjectArtifact(args.directory, args.path));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_describe_dataset',
      description:
        '用本机R读取CSV/RDS/RData/sas7bdat/xpt，或加密zip数据包：按已交付程序的候选顺序自动推导密码（显式→项目目录分词→zip旁sidecar txt→zip文件名分词→文档名→无密码；ZipCrypto进程内解密，AES需本机7z），返回对象名、行列、列类型、样本及列级统计（每列NA计数、字符列空串计数、可数值化列的min/max/mean，均由R对实际数据计算），失败返回真实R诊断。需要操作者R配置。',
      parameters: {
        path: { ...string_type, required: true },
        maxRows: { type: 'number' },
        projectDir: { type: 'string' },
      },
      output,
      async execute(args, exec) {
        return run(async () => {
          const runtime = await resolveRuntime();
          return describeDataset(
            runtime,
            args.path,
            args.maxRows ?? 5,
            exec?.signal,
            args.projectDir ? { projectDir: args.projectDir } : undefined,
          );
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_overview',
      description:
        '扫描目录并列出所有workbook的sheet名称（含Cover），不读取cell内容。可用于发现项目资料；不是任何后续工具的强制前置。',
      parameters: { directory: { ...string_type, required: true } },
      output,
      async execute(args) {
        return run(() => overviewProject(args.directory));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_read_sheet',
      description:
        '读取指定workbook sheet，返回完整单元格内容（含隐藏行列、公式表达式、合并范围）。sheetId可来自overview结果或调用方已知信息，不要求先调用overview。',
      parameters: {
        directory: { ...string_type, required: true },
        workbookPath: { ...string_type, required: true },
        sheetId: { ...string_type, required: true },
        startRow: { type: 'number' },
        endRow: { type: 'number' },
      },
      output,
      async execute(args, exec) {
        return run(() =>
          readWorkflowSheet(
            args.directory,
            args.workbookPath,
            args.sheetId,
            args.startRow !== undefined && args.endRow !== undefined
              ? { startRow: args.startRow, endRow: args.endRow }
              : undefined,
          ),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_knowledge_capture',
      description:
        '把当前任务中已核实的纠错方法沉淀为CANDIDATE知识；未复现验证不会激活也不进入默认检索。kind固定scenario_method；前提/反例/来源必填（激活的必要证据）。claimsCsv只写可由已安装验证器复现的具体断言；没有claims的方法永远保持CANDIDATE。',
      parameters: {
        knowledgeId: { ...string_type, required: true, description: '新知识ID；同ID重复capture会版本冲突。' },
        title: { ...string_type, required: true },
        method: { ...string_type, required: true, description: '方法正文，≤20000字符。' },
        problemSignal: { ...string_type, required: true },
        cause: { ...string_type, required: true },
        preconditionsCsv: { ...string_type, required: true, description: '适用前提，逗号分隔。' },
        counterexamplesCsv: { ...string_type, required: true, description: '不适用情形/反例，逗号分隔。' },
        sourcesCsv: { ...string_type, required: true, description: '证据来源，逗号分隔。' },
        topicsCsv: { type: 'string' },
        notApplicableCsv: { type: 'string' },
        scenariosCsv: { type: 'string' },
        claimsCsv: {
          ...string_type,
          description: '可由已安装验证器复现的具体断言，逗号分隔。没有claims的方法不会激活。',
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
          if (args.method.length > 20000) throw new ListingError('KNOWLEDGE_TEXT_INVALID');
          const draft: KnowledgeDraft = {
            knowledgeId: args.knowledgeId,
            scope: 'plugin',
            pluginId: LISTING_PLUGIN_ID,
            kind: 'scenario_method',
            title: args.title,
            problemSignal: args.problemSignal,
            cause: args.cause,
            method: args.method,
            scenarios: csv(args.scenariosCsv),
            edc: [],
            topics: csv(args.topicsCsv),
            preconditions: csv(args.preconditionsCsv),
            notApplicable: csv(args.notApplicableCsv),
            counterexamples: csv(args.counterexamplesCsv),
            sources: csv(args.sourcesCsv),
            ...(csv(args.claimsCsv).length ? { claims: csv(args.claimsCsv) } : {}),
          };
          return knowledge.capture({ pluginId: LISTING_PLUGIN_ID }, draft);
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_knowledge_validate',
      description:
        '对CANDIDATE方法运行已安装业务验证器（固定正/反/边界用例）；只有候选声明的全部claims都被该套件覆盖且测试通过，才转ACTIVE并写回执。无claims、部分覆盖或测试失败均保持CANDIDATE并记事件；不接受模型自报。',
      parameters: {
        knowledgeId: { ...string_type, required: true },
        revision: { type: 'number', required: true },
        validatorId: { ...string_type, required: true },
      },
      output,
      async execute(args) {
        return run(() =>
          knowledge.validate({ pluginId: LISTING_PLUGIN_ID }, args.knowledgeId, args.revision, args.validatorId),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_knowledge_events',
      description: '读取指定知识的最近学习/验证事件（捕获、种子冲突、验证失败、过期未激活等），最新在前。',
      parameters: {
        knowledgeId: { ...string_type, required: true },
        limit: { type: 'number' },
      },
      output,
      async execute(args) {
        return run(() =>
          knowledge.events({ pluginId: LISTING_PLUGIN_ID }, args.knowledgeId, 0, Math.min(args.limit ?? 50, 100)),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_status',
      description: '列出 Listing 场景知识和可用范围。不限制 Harness 的通用工具或智能能力。',
      parameters: {},
      output,
      async execute() {
        return run(() => ({
          version: '0.2.0',
          knowledgeVersion: KNOWLEDGE_VERSION,
          scenarios: SCENARIOS,
          profiles,
          seedState,
          scope:
            '插件工具接入操作者提供的本地项目（只读）与内置合成示例；DeepSeek 通用能力不受此开关限制。知识激活仅覆盖候选声明的claims，工具回归通过不等于方法正文已验证。',
        }));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_list_tasks',
      description: '恢复当前会话所属的持久合成任务，返回任务ID和版本，不访问其他会话任务或原始临床data。',
      parameters: {},
      output,
      async execute(_args, exec) {
        return run(() => service(exec).list());
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_open_demo',
      description:
        '创建由插件构造的人工合成项目，包含 spec/ALS/schema/CSV。不能用参数指定真实目录或将真实数据标为合成。',
      parameters: {
        scenario: { type: 'string', required: true, enum: [...SCENARIOS] },
        pkType: { type: 'string', enum: ['be', 'sad-mad'] },
        ambiguous: { type: 'boolean', description: '创建需求 sheet 版本冲突以验证向用户询问。' },
      },
      output,
      async execute(args, exec) {
        return run(() =>
          service(exec).open(scenario(args.scenario), args.pkType as 'be' | 'sad-mad' | undefined, args.ambiguous),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_inspect',
      description:
        '列出合成 spec 的 sheet 名称（含 Cover，均标记可读）、任务版本和执行/QC摘要，不读单元格或执行原始日志。',
      parameters: { workspaceId: id },
      output,
      async execute(args, exec) {
        return run(() => service(exec).sheets(args.workspaceId));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_read_requirements',
      description:
        '读取确定的合成需求 sheet；需求 sheet 识别不确定时在读取任何候选 cell 前由可信 UI 列出全部 sheet（含 Cover）询问用户，不按名称拒绝读取。',
      parameters: { workspaceId: id },
      output,
      async execute(args, exec) {
        return run(() =>
          service(exec).readRequirements(
            args.workspaceId,
            async (question) => {
              const result = await ctx.userQuestions.ask({
                questions: [question],
                agent: exec.agent,
                signal: exec.signal,
              });
              const answer = result.answers.find((a) => a.id === question.id);
              if (!answer || answer.custom?.trim()) throw new ListingError('SHEET_SELECTION_REQUIRED');
              return answer.selected;
            },
            exec.signal,
          ),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_save_requirements',
      description:
        '保存需求理解 IR，不替代 Harness 推理。itemsJson 为条目数组：id/meaning/condition/columns(string[])/mapping/validation/unresolved(string[])。',
      parameters: { workspaceId: id, itemsJson: { type: 'string', required: true } },
      output,
      async execute(args, exec) {
        return run(() => {
          if (args.itemsJson.length > 200000) throw new ListingError('IR_TOO_LARGE');
          let v: unknown;
          try {
            v = JSON.parse(args.itemsJson);
          } catch {
            throw new ListingError('INVALID_IR_JSON');
          }
          if (
            !Array.isArray(v) ||
            v.some(
              (x) =>
                !x ||
                typeof x !== 'object' ||
                ['id', 'meaning', 'condition', 'mapping', 'validation'].some((k) => typeof x[k] !== 'string') ||
                ['columns', 'unresolved'].some(
                  (k) => !Array.isArray(x[k]) || x[k].some((s: unknown) => typeof s !== 'string'),
                ),
            )
          )
            throw new ListingError('INVALID_IR_JSON');
          return service(exec).saveRequirements(args.workspaceId, v as Item[]);
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_save_program',
      description: '保存 Harness 自主编写的 R 程序草稿到合成工作区。不自动执行代码、不伪报测试通过。',
      parameters: { workspaceId: id, code: { type: 'string', required: true } },
      output,
      async execute(args, exec) {
        return run(() => service(exec).saveProgram(args.workspaceId, args.code));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_validate_synthetic',
      description:
        '申请用户批准后实际运行已保存的合成 R 版本，并由独立固定检查器验证 output.csv。非隔离执行，不支持真实data；无运行时配置就拒绝。',
      parameters: { workspaceId: id },
      output,
      async execute(args, exec) {
        return run(async () => {
          const executable = process.env.DSH_LISTING_R_EXECUTABLE,
            home = process.env.DSH_LISTING_R_HOME;
          const kind = process.env.DSH_LISTING_R_KIND;
          if (!executable || !home || (kind !== 'Rterm' && kind !== 'Rscript'))
            throw new ListingError('OPERATOR_R_CONFIG_REQUIRED');
          const runtime: RuntimeSpec = { executable, home, kind };
          await probeRuntime(runtime);
          return service(exec).validateSynthetic(
            args.workspaceId,
            runtime,
            async (details) => {
              const label = '批准本次合成代码执行';
              const questionId = `run-${args.workspaceId}-${details.programDigest}`;
              const result = await ctx.userQuestions.ask({
                agent: exec.agent,
                signal: exec.signal,
                questions: [
                  {
                    id: questionId,
                    question: '是否执行此版本的合成 R 代码？',
                    detail: `仅内置合成输入，但这是当前操作者权限下的非隔离任意代码执行，不是安全沙箱。请先审核程序。SHA256: ${details.programDigest}；运行时: ${details.runtime.kind}。不得接入真实data。`,
                    options: [{ label }, { label: '取消' }],
                    multiSelect: false,
                  },
                ],
              });
              const answer = result.answers.find((a) => a.id === questionId);
              return !answer?.custom?.trim() && answer?.selected.length === 1 && answer.selected[0] === label;
            },
            exec.signal,
          );
        });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_recover_interrupted',
      description:
        '恢复异常退出宿主遗留的 RUNNING 合成任务。先检查记录的 R 进程 PID 是否仍在运行，仍活动则直接拒绝；PID 无记录时由可信 UI 要求操作者确认整个旧进程树已停止。不是自动终止或重跑，不采信残留输出。',
      parameters: { workspaceId: id },
      output,
      async execute(args, exec) {
        return run(() =>
          service(exec).recoverInterrupted(
            args.workspaceId,
            async (details) => {
              const label = '已确认旧进程树全部停止，标记中断';
              const questionId = `recover-${args.workspaceId}-${details.runId}`;
              const result = await ctx.userQuestions.ask({
                agent: exec.agent,
                signal: exec.signal,
                questions: [
                  {
                    id: questionId,
                    question: '是否确认旧执行进程树已全部停止并恢复任务？',
                    detail: `PID 证据: ${details.pidEvidence}。运行已异常中断，残留输出不可采信。请先确认旧 R 进程已全部停止，不能确认就取消。不要按旧 PID 盲目终止其他进程。运行 ${details.runId}；程序 SHA256 ${details.programDigest}。确认仅标记 INTERRUPTED、解锁编辑，不会自动执行或把残留结果当作 PASS。`,
                    options: [{ label }, { label: '无法确认，保持阻断' }],
                    multiSelect: false,
                  },
                ],
              });
              const answer = result.answers.find((a) => a.id === questionId);
              return !answer?.custom?.trim() && answer?.selected.length === 1 && answer.selected[0] === label;
            },
            exec.signal,
          ),
        );
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dm_listing_prepare_delivery',
      description: '生成 R 代码草稿交付清单，明确未运行和未验证状态，不等于真实 QC 或发布批准。',
      parameters: { workspaceId: id },
      output,
      async execute(args, exec) {
        return run(() => service(exec).delivery(args.workspaceId));
      },
    }),
  );
}
