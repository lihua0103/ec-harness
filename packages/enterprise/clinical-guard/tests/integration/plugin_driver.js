import clinicalDataGuard from '../../python/src/index.js';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

const scenario = process.argv[2];

function createContext(overrides = {}) {
  const events = new Map();
  const routes = new Map();
  const promptSections = [];
  return {
    events,
    routes,
    promptSections,
    on(event, handler) {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push(handler);
      return () => events.get(event)?.splice(events.get(event).indexOf(handler), 1);
    },
    tools: {
      registered: [],
      register(definition) {
        if (this.registered.some((tool) => tool.name === definition.name)) {
          throw new Error(`duplicate tool registration: ${definition.name}`);
        }
        this.registered.push(definition);
        return () => {};
      },
    },
    // branding fail-fast (FIX-12/AF-07) 后 webServer 是必需服务。
    webServer: {
      tapIndex() { return () => {}; },
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
    },
    systemPrompt: {
      section(section) { promptSections.push(section); return () => {}; },
    },
  };
}

async function first(ctx, event, ...args) {
  const handler = ctx.events.get(event)?.[0];
  if (!handler) throw new Error(`listener not registered: ${event}`);
  const result = handler(...args, (nextOptions) => (
    event === 'tools/post-execute' ? { kind: 'accept' } :
    (async function* generate() { yield { kind: 'finish', options: nextOptions, failure: undefined }; })()
  ));
  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    const forwarded = [];
    for await (const chunk of result) {
      forwarded.push(chunk);
      if (chunk?.kind === 'finish' && chunk.failure) throw new Error(chunk.failure.message ?? 'stream failure');
    }
    return { streamed: true, forwarded };
  }
  return result;
}

const config = {
  python: process.env.PLUGIN_PYTHON,
  authorizationUser: 'integration-user',
  authorizationSession: 'integration-session',
  userId: 'integration-user',
  sessionId: 'integration-session',
  localDataAccess: process.env.LOCAL_DATA_ACCESS,
  dataProtectionEnabled: process.env.DATA_PROTECTION_ENABLED !== '0',
  ...(process.env.CONFIG_DATA_INTERCEPTION_ENABLED !== undefined
    ? { dataInterceptionEnabled: process.env.CONFIG_DATA_INTERCEPTION_ENABLED === '1' }
    : {}),
  localDataRoot: process.env.LOCAL_DATA_ROOT,
  outputPlaneRoot: process.env.OUTPUT_PLANE_ROOT,
  credentialsDir: process.env.CREDENTIALS_DIR,
  // 来源域（2026-08-21）：环境变量 JSON 数组注入。
  ...(process.env.PLANE_DATA_ROOTS
    ? { dataPlaneRoots: JSON.parse(process.env.PLANE_DATA_ROOTS) } : {}),
  ...(process.env.PLANE_SPEC_ROOTS
    ? { specPlaneRoots: JSON.parse(process.env.PLANE_SPEC_ROOTS) } : {}),
  ...(process.env.PLANE_DOCUMENT_ROOTS
    ? { documentPlaneRoots: JSON.parse(process.env.PLANE_DOCUMENT_ROOTS) } : {}),
};

async function callSettings(enabled) {
  const route = ctx.routes.get('/api/settings/data-interception');
  const response = {};
  const body = JSON.stringify({ dataInterceptionEnabled: enabled });
  const req = {
    method: 'PUT', headers: { 'content-type': 'application/json', host: 'localhost' },
    async *[Symbol.asyncIterator]() { yield body; },
  };
  await route.handler(req, {
    writeHead(status, headers) { response.status = status; response.headers = headers; },
    end(value = '') { response.body = value; },
  });
  return response;
}

const ctx = createContext();

const dispose = clinicalDataGuard(ctx, config);
let output;

const SENSITIVE_TEXT = 'A1234567 2024-03-05 Screening 已入组';
// 多行数据夹具。250 行只是"足够多行"的夹具规模，不再有任何阈值含义：
// 体量已全部废除为拦截理由，这些场景实测的是来源域降级而不是行数。
const MULTI_ROW_DATA_TEXT = Array.from({ length: 250 }, (_, i) =>
  `101-${String(i).padStart(3, '0')} | 2024-03-05 | Screening 已入组`).join('\n');

try {
  if (scenario === 'local-metadata') {
    const registered = ctx.tools.registered.find((tool) => tool.name === 'local_data_metadata');
    output = await registered.execute({ path: process.env.LOCAL_METADATA_RELATIVE_FILE }, { agent: {} });
  } else if (scenario === 'local-metadata-session-cwd') {
    const registered = ctx.tools.registered.find((tool) => tool.name === 'local_data_metadata');
    output = await registered.execute(
      { path: process.env.LOCAL_METADATA_RELATIVE_FILE },
      { agent: { session: { header: { cwd: process.env.SESSION_CWD } } } },
    );
  } else if (scenario === 'local-metadata-absolute-inside-root') {
    const registered = ctx.tools.registered.find((tool) => tool.name === 'local_data_metadata');
    try {
      await registered.execute({ path: process.env.LOCAL_METADATA_FILE }, { agent: {} });
      output = { blocked: false };
    } catch (error) {
      output = { blocked: true, message: error.message };
    }
  } else if (scenario === 'local-metadata-outside-root') {
    const registered = ctx.tools.registered.find((tool) => tool.name === 'local_data_metadata');
    try {
      await registered.execute({ path: process.env.LOCAL_METADATA_OUTSIDE_FILE }, { agent: {} });
      output = { blocked: false };
    } catch (error) {
      output = { blocked: true, message: error.message };
    }
  } else if (scenario === 'protected-source-roundtrip') {
    const sourcePath = process.env.PROTECTED_SOURCE_FILE;
    const sourcePlane = process.env.PROTECTED_SOURCE_KIND;
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'read_file',
      arguments: { path: sourcePath },
      agent: {},
    }, {
      isError: false,
      value: { raw: sourcePlane === 'sas' ? '101-001-0001' : 'A1234567' },
      content: [{ type: 'text', text: sourcePlane === 'sas' ? '101-001-0001' : 'A1234567' }],
    });
    try {
      await first(ctx, 'llm/stream', {
        messages: [{ role: 'user', content: guarded.content }],
      });
      output = { blocked: false };
    } catch (error) {
      output = { blocked: true, message: error.message };
    }
  } else if (scenario === 'llm-clean') {
    output = await first(ctx, 'llm/stream', {
      provider: 'test-provider',
      model: 'test-model',
      messages: [{ role: 'user', content: '请生成列表规范。' }],
      system: '出域审计范围验证',
      tools: [{
        name: 'demo',
        description: '演示工具',
        parameters: { type: 'object', properties: {} },
      }],
      temperature: 0.2,
      maxTokens: 128,
      stop: ['完成'],
      purpose: 'session-title',
    });
  } else if (scenario === 'llm-platform-header-clean') {
    // 真实 DSH 请求头回归：平台自身的 kebab-case 标识不得被 USUBJID 误判。
    output = await first(ctx, 'llm/stream', {
      provider: 'test-provider',
      model: 'test-model',
      messages: [{ role: 'user', content: '读取项目需求文档。' }],
      sessionId: 'session-6ad2d0e2-c715-4a38-bdc2-2def4bdfe804',
      system: 'Current fs-observation-policy uses modification-time-ordered files.',
      tools: [{
        name: 'pwsh',
        description: 'Read a UTF-8 text file and return line-numbered content.',
        parameters: {
          type: 'object',
          properties: {
            sandbox_permissions: {
              type: 'string',
              enum: ['workspace-write', 'danger-full-access'],
            },
          },
        },
      }],
    });
  } else if (scenario === 'llm-dirty') {
    // 出域不做 token 化：脏载荷原文透传，交由来源域判据在别处阻断。
    // 模拟 DSH 的只读 GenerateOptions：守卫只能构造新对象，不能原地修改。
    const messages = Object.freeze([Object.freeze({ role: 'user', content: 'Subject A1234567' })]);
    const options = Object.freeze({ messages });
    output = await first(ctx, 'llm/stream', options);
    output = { ...output, content: output.forwarded?.[0]?.options?.messages?.[0]?.content ?? options.messages[0].content };
  } else if (scenario === 'llm-system-dirty') {
    const options = {
      provider: 'test-provider',
      model: 'test-model',
      messages: [{ role: 'user', content: '请生成列表规范。' }],
      system: 'Subject A1234567',
    };
    output = await first(ctx, 'llm/stream', options);
    output = { ...output, system: output.forwarded?.[0]?.options?.system ?? options.system };
  } else if (scenario === 'llm-structured-dirty'
      || scenario === 'llm-structured-dirty-protection-disabled') {
    const options = Object.freeze({
      temperature: 0.2,
      messages: Object.freeze([Object.freeze({
        role: 'user',
        content: Object.freeze([Object.freeze({
          type: 'tool-result',
          result: Object.freeze({ USUBJID: 1234567, id: 'A1234567', timestamp: '2024-03-05', value: 5.8 }),
        })]),
      })]),
    });
    output = await first(ctx, 'llm/stream', options);
    output = { ...output, options: output.forwarded?.[0]?.options ?? options };
  } else if (scenario === 'llm-image') {
    output = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: [{ type: 'image', data: 'aGVsbG8=' }] }],
    });
  } else if (scenario === 'llm-invalid') {
    output = await first(ctx, 'llm/stream', { messages: 'bad' });
  } else if (scenario === 'local-output-projection') {
    const sourcePath = process.env.LOCAL_OUTPUT_SOURCE;
    output = await first(ctx, 'tools/post-execute', {
      name: process.env.LOCAL_OUTPUT_TOOL || 'pwsh',
      arguments: { command: `Get-Content "${sourcePath}"` },
      agent: {},
    }, {
      isError: false,
      value: { raw: '010-001-1001,Screening' },
      content: [{ type: 'text', text: '010-001-1001,Screening' }],
    });
  } else if (scenario === 'post-excel') {
    output = await first(ctx, 'tools/post-execute', {
      name: 'read_file',
      arguments: { path: process.env.EXCEL_FILE },
      agent: {},
    }, { isError: false, value: { raw: 'A1234567' }, content: [{ type: 'text', text: 'A1234567' }] });
  } else if (scenario === 'trusted-document-roundtrip') {
    const documentText = 'KRI-001 101-001-0001 2026-08-19 ALT 342';
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'read_file',
      arguments: { path: process.env.PLANE_SPEC_FILE },
      agent: { session: { header: { cwd: process.env.SESSION_CWD } } },
    }, { isError: false, value: { raw: documentText }, content: [{ type: 'text', text: documentText }] });
    const trusted = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: guarded.content }],
    });
    const ordinary = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: documentText }],
    });
    output = {
      guarded,
      trusted: trusted.forwarded?.[0]?.options?.messages?.[0]?.content,
      ordinary: ordinary.forwarded?.[0]?.options?.messages?.[0]?.content,
    };
  } else if (scenario === 'trusted-aux-document-roundtrip') {
    const documentText = '辅助要求 101-001-0001 2026-08-19';
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'read_file',
      arguments: { path: process.env.PLANE_DOCUMENT_FILE },
      agent: { session: { header: { cwd: process.env.SESSION_CWD } } },
    }, { isError: false, value: { raw: documentText }, content: [{ type: 'text', text: documentText }] });
    const trusted = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: guarded.content }],
    });
    output = {
      guarded,
      trusted: trusted.forwarded?.[0]?.options?.messages?.[0]?.content,
    };
  } else if (scenario === 'ordinary-text-file-roundtrip') {
    const ordinaryText = '(contents of zebra-alpha-file - version 123)\nrequest: preserve real intent';
    output = await first(ctx, 'tools/post-execute', {
      name: 'read_file',
      arguments: { path: process.env.ORDINARY_TEXT_FILE || 'notes/session-log.txt' },
      agent: { session: { header: { cwd: process.env.SESSION_CWD } } },
    }, {
      isError: false,
      value: { raw: ordinaryText },
      content: [{ type: 'text', text: ordinaryText }],
    });
  } else if (scenario === 'canonical-paths-roundtrip') {
    const paths = [
      'GQ1005-301\\doc\\GQ1005-301_ALS.xlsx',
      'GQ1005-301\\SAS_20250221.zip',
      'GQ1005-301\\H301\\DM.sas7bdat',
      'GQ1005-301\\_mk_alpha',
    ];
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'glob',
      arguments: { pattern: '**/*' },
      agent: {},
    }, {
      isError: false,
      content: [{ type: 'text', text: MULTI_ROW_DATA_TEXT }],
      meta: { shape: 'paths', paths, truncated: false, total: paths.length },
    });
    const forwarded = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: guarded.content }],
    });
    output = {
      guarded,
      forwarded: forwarded.forwarded?.[0]?.options?.messages?.[0]?.content,
    };
  } else if (scenario === 'listing-receipt-roundtrip') {
    // 宿主真实形状：tool-result 块内还有一层 content 文本块。
    // inspection JSON 含 schema 字段名，但不含任何数据行。
    const inspection = JSON.stringify({
      ok: true,
      action: 'listing-inspect',
      inspection: {
        clinicalGuard: 'CLINICAL_LISTING_INSPECTION',
        status: 'ready',
        stage: 'inspect',
        schema: { dm: ['USUBJID', 'SUBJID', 'SITEID', 'VISIT'] },
        schemaFingerprint: 'sha256:integration',
        dataClass: 'METADATA_ONLY',
        documents: [],
        datasets: [],
      },
    });
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'clinical_listing_inspect',
      arguments: { project: '.' },
      agent: {},
    }, {
      isError: false,
      content: [{
        type: 'tool-result',
        toolCallId: 'call-listing-inspect',
        content: [{ type: 'text', text: inspection }],
      }],
    });
    const forwarded = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: guarded.content }],
    });
    output = {
      guarded,
      forwarded: forwarded.forwarded?.[0]?.options?.messages?.[0]?.content,
    };
  } else if (scenario === 'listing-large-receipt-roundtrip') {
    const inspect = ctx.tools.registered.find((tool) => tool.name === 'clinical_listing_inspect');
    const rendered = inspect.output.render({}, {
      ok: true,
      action: 'listing-inspect',
      inspection: {
        clinicalGuard: 'CLINICAL_LISTING_INSPECTION', status: 'ready', stage: 'inspect',
        schemaFingerprint: 'sha256:large-integration', dataClass: 'METADATA_ONLY',
        schema: { dm: Array.from({ length: 1633 }, (_, i) => `FIELD_${i}`) },
        documents: [], datasets: [],
      },
    });
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'clinical_listing_inspect', arguments: { project: '.' }, agent: {},
    }, { isError: false, content: rendered });
    const forwarded = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: guarded.content }],
    });
    const guardedText = JSON.stringify(guarded);
    const forwardedText = JSON.stringify(forwarded);
    output = {
      physicalLines: rendered[0].text.split('\n').length,
      renderedBytes: Buffer.byteLength(rendered[0].text, 'utf8'),
      forwarded: Boolean(forwarded.forwarded?.length),
      receiptPreserved: forwardedText.includes('CLINICAL_LISTING_INSPECTION'),
      accepted: !guardedText.includes('mass_dump') && !guardedText.includes('EGRESS_VIOLATION'),
      thrown: false,
    };
  } else if (scenario === 'listing-real-inspect-receipt') {
    // 真实 listing_inspector.inspect() 的返回字段集（含 inferredScenario /
    // scenarioConfidence / supportData），不是手工裁剪版。收据必须被认可，
    // spec 规格文本原文到达模型，不得 token 化。
    const receipt = JSON.stringify({
      clinicalGuard: 'CLINICAL_LISTING_INSPECTION', status: 'ready', stage: 'inspect',
      project: 'GQ1005-301', scenario: 'listing',
      inferredScenario: 'listing', scenarioConfidence: 0.92,
      documents: [{ name: 'GQ1005-301_ALS.xlsx', kind: 'als', requirement: 'ALT: 3 倍正常上限' }],
      supportData: [],
      datasets: [], schema: { dm: ['USUBJID', 'AGE'] },
      schemaFingerprint: 'sha256:real-inspect', missing: [], warnings: [],
      dataClass: 'METADATA_ONLY',
    });
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'clinical_listing_inspect', arguments: { project: '.' }, agent: {},
    }, { isError: false, content: [{ type: 'tool-result', content: [{ type: 'text', text: receipt }] }] });
    const guardedText = JSON.stringify(guarded);
    output = {
      receiptTrusted: guardedText.includes('TRUSTED_LISTING_RECEIPT'),
      specTextPreserved: guardedText.includes('ALT: 3 倍正常上限'),
      tokenized: /\[(?:TEXT|NUM|DATE|SUBJ|VAL):/.test(guardedText),
    };
  } else if (scenario === 'listing-run-code-receipt-roundtrip') {
    // 2026-08-24 代码车道：run 信封（聚合元数据）必须被双侧信任透传，
    // 让 harness 读得懂迭代反馈（行数/列名/dtype/空值计数）。
    const receipt = JSON.stringify({
      clinicalGuard: 'CLINICAL_LISTING_CODE_RECEIPT', status: 'ok', stage: 'run',
      project: 'GQ1005-301', scenario: 'medical',
      schemaFingerprint: 'sha256:run', dataClass: 'METADATA_ONLY',
      outputs: [{
        name: 'vital_signs', rowCount: 412, columnCount: 18,
        columns: [{ name: 'USUBJID', dtype: 'object', nullCount: 0 }],
      }],
      datasetsTouched: ['dm', 'vs'],
    });
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'clinical_listing_run_code', arguments: { project: '.' }, agent: {},
    }, { isError: false, content: [{ type: 'tool-result', content: [{ type: 'text', text: receipt }] }] });
    const forwarded = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: guarded.content }],
    });
    const guardedText = JSON.stringify(guarded);
    const forwardedText = JSON.stringify(forwarded);
    output = {
      receiptTrusted: guardedText.includes('TRUSTED_LISTING_RECEIPT'),
      envelopeReadable: forwardedText.includes('CLINICAL_LISTING_CODE_RECEIPT') && forwardedText.includes('vital_signs'),
      tokenized: /\[(?:TEXT|NUM|DATE|SUBJ|VAL):/.test(forwardedText),
    };
  } else if (scenario === 'listing-untrusted-receipt-roundtrip') {
    const receipt = JSON.stringify({
      clinicalGuard: 'CLINICAL_LISTING_RECEIPT', status: 'completed', stage: 'execute',
      schemaFingerprint: 'sha256:integration', dataClass: 'REAL',
      artifacts: [{ name: 'RBQM.xlsx', sheets: [{ name: 'DM', rowCount: 1, columnCount: 3 }] }],
      payload: 'USUBJID: A1234567',
    });
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'clinical_listing_publish', arguments: { project: '.' }, agent: {},
    }, { isError: false, content: [{ type: 'tool-result', content: [{ type: 'text', text: receipt }] }] });
    const forwarded = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: guarded.content }],
    });
    output = { guarded, forwarded: forwarded.forwarded?.[0]?.options?.messages?.[0]?.content };
  } else if (scenario === 'listing-execute-receipt-readable') {
    // 真实 execute 收据只含产物名与行列统计，没有任何临床记录。它必须以可读的
    // 控制面形状到达 harness，否则 harness 读不出"执行成功/产物是什么"。
    const receipt = JSON.stringify({
      clinicalGuard: 'CLINICAL_LISTING_RECEIPT', status: 'completed', stage: 'execute',
      project: 'GQ1005-301', scenario: 'listing',
      artifact: { id: 'out/GQ1005-301_Listing.xlsx', name: 'GQ1005-301_Listing.xlsx', kind: 'xlsx' },
      artifacts: [{
        id: 'out/GQ1005-301_Listing.xlsx', name: 'GQ1005-301_Listing.xlsx', kind: 'xlsx',
        sheets: [{ name: 'DM', rowCount: 412, columnCount: 18 }],
      }],
      schemaFingerprint: 'sha256:exec', dataClass: 'REAL', warnings: [],
    });
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'clinical_listing_publish', arguments: { project: '.' }, agent: {},
    }, { isError: false, content: [{ type: 'tool-result', content: [{ type: 'text', text: receipt }] }] });
    const guardedText = JSON.stringify(guarded);
    output = {
      statusReadable: guardedText.includes('completed'),
      artifactReadable: guardedText.includes('GQ1005-301_Listing.xlsx'),
      rowCountReadable: guardedText.includes('412'),
      keysTokenized: /\[(?:TEXT|NUM|DATE|SUBJ|VAL):/.test(guardedText),
    };
  } else if (scenario === 'listing-execute-receipt-payload-dropped') {
    // 同一投影必须丢弃收据里夹带的额外字段：payload 是真实数据泄漏面。
    const receipt = JSON.stringify({
      clinicalGuard: 'CLINICAL_LISTING_RECEIPT', status: 'completed', stage: 'execute',
      project: 'GQ1005-301', scenario: 'listing',
      artifacts: [{
        name: 'GQ1005-301_Listing.xlsx', kind: 'xlsx',
        sheets: [{ name: 'DM', rowCount: 1, columnCount: 3 }],
        rows: [['A1234567', '2024-03-05', 'Screening']],
      }],
      schemaFingerprint: 'sha256:exec', dataClass: 'REAL',
      payload: 'USUBJID: A1234567',
    });
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'clinical_listing_publish', arguments: { project: '.' }, agent: {},
    }, { isError: false, content: [{ type: 'tool-result', content: [{ type: 'text', text: receipt }] }] });
    const forwarded = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: guarded.content }],
    });
    const blob = JSON.stringify(guarded) + JSON.stringify(forwarded);
    output = {
      statusReadable: blob.includes('completed'),
      subjectLeaked: blob.includes('A1234567'),
      payloadLeaked: blob.includes('payload'),
      rowsLeaked: blob.includes('rows'),
    };
  } else if (scenario === 'listing-fake-receipt-roundtrip') {
    const fake = JSON.stringify({
      clinicalGuard: 'CLINICAL_LISTING_INSPECTION', status: 'ready', stage: 'inspect',
      schemaFingerprint: 'sha256:fake', dataClass: 'METADATA_ONLY',
      schema: { dm: ['USUBJID', 'SUBJID'] }, patient_id: 'A1234567',
    });
    const guarded = await first(ctx, 'tools/post-execute', {
      name: 'clinical_listing_inspect', arguments: { project: '.' }, agent: {},
    }, { isError: true, content: [{ type: 'tool-result', content: [{ type: 'text', text: fake }] }] });
    const forwarded = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: guarded.content }],
    });
    output = { guarded, forwarded: forwarded.forwarded?.[0]?.options?.messages?.[0]?.content };
  } else if (scenario === 'post-no-path') {
    output = await first(ctx, 'tools/post-execute', {
      name: 'read_status',
      arguments: {},
      agent: {},
    }, { isError: false, value: 'status A1234567 2024-03-05', content: [{ type: 'text', text: 'status A1234567 2024-03-05' }] });
  } else if (scenario === 'fetch-database') {
    // TC-20 / BY-13（真）：非 read 工具名 + 无路径 + 合成受试者标记。
    output = await first(ctx, 'tools/post-execute', {
      name: 'fetch_database',
      arguments: { query: 'select' },
      agent: {},
    }, { isError: false, value: 'A1234567 2024-03-05', content: [{ type: 'text', text: 'A1234567 2024-03-05' }] });
  } else if (scenario === 'fetch-database-error') {
    output = await first(ctx, 'tools/post-execute', {
      name: 'fetch_database',
      arguments: { query: 'select' },
      agent: {},
    }, { isError: true, content: [{ type: 'text', text: 'query failed near A1234567 2024-03-05' }] });
  } else if (scenario === 'post-unknown-ext') {
    // BR-03.4：带路径但扩展名未识别 → 强制脱敏。
    output = await first(ctx, 'tools/post-execute', {
      name: 'fetch_dataset',
      arguments: { path: 'transfer/data.xpt' },
      agent: {},
    }, { isError: false, value: 'A1234567 2024-03-05', content: [{ type: 'text', text: 'A1234567 2024-03-05' }] });
  } else if (scenario === 'post-sensitive') {
    // TC-26：数据查询能力（无路径）+ 无审批通道 → 结果降级为占位符。
    // 判据是来源域不是体量；载荷用多行夹具只为贴近真实查询结果的形状。
    output = await first(ctx, 'tools/post-execute', {
      name: 'fetch_database',
      arguments: {},
      agent: {},
    }, { isError: false, value: MULTI_ROW_DATA_TEXT, content: [{ type: 'text', text: MULTI_ROW_DATA_TEXT }] });
  } else if (scenario === 'listing-tool-contract') {
    output = {
      tools: ctx.tools.registered.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
      prompts: ctx.promptSections,
    };
  } else if (scenario === 'listing-capability-required') {
    const registered = ctx.tools.registered.find((tool) => tool.name === 'clinical_listing_inspect');
    output = await registered.execute(
      { project: '.', scenario: 'rbqm', credentialRef: '' },
      { agent: {} },
    );
  } else if (scenario === 'runtime-policy-toggle') {
    const original = '101-001-0001 | 2024-03-05 | Screening';
    const executePost = () => {
      const handler = ctx.events.get('tools/post-execute')?.[0];
      const result = { isError: false, value: original, content: [{ type: 'text', text: original }] };
      return handler(
        { name: 'fetch_database', arguments: {}, agent: {} },
        result,
        () => ({ kind: 'accept', content: result.content }),
      );
    };
    const enabledResult = await executePost();
    await callSettings(false);
    const disabledResult = await executePost();
    const disabledStream = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: original }],
    });
    await callSettings(true);
    const reEnabledResult = await executePost();
    output = { enabledResult, disabledResult, disabledStream, reEnabledResult };
  } else if (scenario === 'policy-initial-state') {
    const route = ctx.routes.get('/api/settings/data-interception');
    const response = {};
    await route.handler(
      { method: 'GET', headers: {}, async *[Symbol.asyncIterator]() {} },
      {
        writeHead(status) { response.status = status; },
        end(value = '') { response.body = value; },
      },
    );
    output = JSON.parse(response.body);
  } else if (scenario === 'listing-absolute-project') {
    const registered = ctx.tools.registered.find((tool) => tool.name === 'clinical_listing_inspect');
    try {
      await registered.execute({ project: process.env.LISTING_PROJECT, scenario: 'rbqm' }, { agent: {} });
      output = { blocked: false };
    } catch (error) {
      output = { blocked: true, message: error.message };
    }
  } else if (scenario === 'listing-session-cwd') {
    const agent = { agent: { userId: 'integration-user', sessionId: 'integration-session', session: { header: { cwd: process.env.SESSION_CWD } } } };
    const args = { project: process.env.LISTING_PROJECT, scenario: process.env.LISTING_SCENARIO || 'rbqm', credentialRef: '' };
    const inspect = ctx.tools.registered.find((tool) => tool.name === 'clinical_listing_inspect');
    const run = ctx.tools.registered.find((tool) => tool.name === 'clinical_listing_run_code');
    const publish = ctx.tools.registered.find((tool) => tool.name === 'clinical_listing_publish');
    const inspection = await inspect.execute(args, agent);
    // 2026-08-24 代码车道：模型提交 pandas 代码，沙箱只回元数据信封。
    const code = [
      'dm = datasets["DM"]',
      'outputs = {',
      '  "DM": dm[["AGE", "USUBJID"]].sort_values("USUBJID"),',
      '}',
    ].join('\n');
    const runReceipt = await run.execute({ ...args, code }, agent);
    const receipt = runReceipt.receipt?.status === 'ok'
      ? await publish.execute(args, agent)
      : runReceipt;
    const checks = [[inspect, inspection], [run, runReceipt], [publish, receipt]].map(([tool, value]) => ({
      tool: tool.name,
      violations: validateJsonSchemaValue(tool.output.schema, value, 'value'),
    }));
    const violations = checks.flatMap((check) => check.violations);
    if (violations.length) throw new Error(violations.join('; '));
    output = { inspection: inspection.inspection, run: runReceipt.receipt, ...(receipt.receipt || receipt) };
  } else if (scenario === 'credential-local') {
    // 本地凭据通道：credentialsDir 下的密码文件原值不进 LLM 上下文，
    // 只返回 CREDENTIAL_LOCAL_ONLY 占位 + 路径。
    output = await first(ctx, 'tools/post-execute', {
      name: 'read_file',
      arguments: { path: process.env.CREDENTIAL_FILE },
      agent: {},
    }, { isError: false, value: 'A1234567', content: [{ type: 'text', text: 'A1234567' }] });
  } else if (scenario === 'fail-closed') {
    output = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: 'safe request' }],
    });
  } else {
    throw new Error(`unknown scenario: ${scenario}`);
  }
} catch (error) {
  output = { thrown: true, code: error.cause?.code ?? error.code, message: error.message };
} finally {
  dispose();
}

if (output && typeof output[Symbol.asyncIterator] === 'function') {
  try {
    for await (const chunk of output) {
      if (chunk?.kind === 'finish' && chunk.failure) throw new Error(chunk.failure.message ?? 'stream failure');
    }
    output = { streamed: true };
  } catch (error) {
    output = { thrown: true, code: error.code, message: error.message };
  }
}

process.stdout.write(JSON.stringify(output));
