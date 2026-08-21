import clinicalDataGuard from '../../src/index.js';

const scenario = process.argv[2];

function createContext(overrides = {}) {
  const events = new Map();
  return {
    events,
    on(event, handler) {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push(handler);
      return () => events.get(event)?.splice(events.get(event).indexOf(handler), 1);
    },
    tools: { guard() { return () => {}; }, registered: [], register(definition) { this.registered.push(definition); return () => {}; } },
    approval: overrides.approval,
    // branding fail-fast (FIX-12/AF-07) 后 webServer 是必需服务。
    webServer: {
      tapIndex() { return () => {}; },
      register() { return () => {}; },
    },
  };
}

async function first(ctx, event, ...args) {
  const handler = ctx.events.get(event)?.[0];
  if (!handler) throw new Error(`listener not registered: ${event}`);
  const result = handler(...args, () => (
    event === 'tools/pre-execute' ? { kind: 'allow' } :
    event === 'tools/post-execute' ? { kind: 'accept' } :
    (async function* generate() { yield { kind: 'finish', failure: undefined }; })()
  ));
  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    for await (const chunk of result) {
      if (chunk?.kind === 'finish' && chunk.failure) throw new Error(chunk.failure.message ?? 'stream failure');
    }
    return { streamed: true };
  }
  return result;
}

const config = {
  mode: process.env.PLUGIN_MODE ?? 'enforce',
  python: process.env.PLUGIN_PYTHON,
  authorizationRoot: process.env.AUTHZ_ROOT,
  authorizationUser: 'integration-user',
  authorizationSession: 'integration-session',
  userId: 'integration-user',
  sessionId: 'integration-session',
  approvedBy: 'integration-operator',
  localDataAccess: process.env.LOCAL_DATA_ACCESS,
  localDataRoot: process.env.LOCAL_DATA_ROOT,
  credentialsDir: process.env.CREDENTIALS_DIR,
};

function approvalFor(scenario) {
  if (scenario === 'sensitive-allowed') {
    return { async request() { return 'allowed-once'; } };
  }
  if (scenario === 'post-sensitive-denied') {
    return { async request() { return 'denied'; } };
  }
  if (scenario === 'post-sensitive-redacted') {
    return { async request() { return { outcome: 'allowed-once', choice: 'redacted-continue' }; } };
  }
  if (scenario === 'post-sensitive-audited' || scenario === 'l3-consume-flow') {
    return { async request() { return { outcome: 'allowed-once', choice: 'allow-audited' }; } };
  }
  return undefined;
}

const ctx = createContext({ approval: approvalFor(scenario) });

const dispose = clinicalDataGuard(ctx, config);
let output;

const SENSITIVE_TEXT = 'A1234567 2024-03-05 Screening 已入组';
// smart_guard 接线后，L3 用户决策只保留给整表转储硬红线（data_lines≥200）。
const MASS_DUMP_TEXT = Array.from({ length: 250 }, (_, i) =>
  `101-${String(i).padStart(3, '0')} | 2024-03-05 | Screening 已入组`).join('\n');

try {
  if (scenario === 'pre-generic-source') {
    output = await first(ctx, 'tools/pre-execute', {
      name: 'read_file',
      arguments: { path: process.env.LOCAL_METADATA_FILE },
      agent: {},
    });
  } else if (scenario === 'local-metadata') {
    output = await first(ctx, 'tools/pre-execute', {
      name: 'local_data_metadata',
      arguments: { path: process.env.LOCAL_METADATA_FILE },
      agent: {},
    });
    const registered = ctx.tools.registered.find((tool) => tool.name === 'local_data_metadata');
    const value = await registered.execute({ path: process.env.LOCAL_METADATA_FILE }, { agent: {} });
    output = { gate: output, value };
  } else if (scenario === 'local-metadata-outside-root') {
    const registered = ctx.tools.registered.find((tool) => tool.name === 'local_data_metadata');
    try {
      await registered.execute({ path: process.env.LOCAL_METADATA_OUTSIDE_FILE }, { agent: {} });
      output = { blocked: false };
    } catch (error) {
      output = { blocked: true, message: error.message };
    }
  } else if (scenario === 'pre-sas') {
    output = await first(ctx, 'tools/pre-execute', {
      name: 'read_file',
      arguments: { path: 'clinical.sas7bdat' },
      agent: {},
    });
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
    // smart_guard 自愈：脏载荷不再抛异常，token 化后继续流式。
    // options 被就地替换，流结束后可断言脱敏结果。
    const options = { messages: [{ role: 'user', content: 'Subject A1234567' }] };
    output = await first(ctx, 'llm/stream', options);
    output = { ...output, content: options.messages[0].content };
  } else if (scenario === 'llm-system-dirty') {
    const options = {
      provider: 'test-provider',
      model: 'test-model',
      messages: [{ role: 'user', content: '请生成列表规范。' }],
      system: 'Subject A1234567',
    };
    output = await first(ctx, 'llm/stream', options);
    output = { ...output, system: options.system };
  } else if (scenario === 'llm-image') {
    output = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: [{ type: 'image', data: 'aGVsbG8=' }] }],
    });
  } else if (scenario === 'llm-invalid') {
    output = await first(ctx, 'llm/stream', { messages: 'bad' });
  } else if (scenario === 'post-excel') {
    output = await first(ctx, 'tools/post-execute', {
      name: 'read_file',
      arguments: { path: process.env.EXCEL_FILE },
      agent: {},
    }, { isError: false, value: { raw: 'A1234567' }, content: [{ type: 'text', text: 'A1234567' }] });
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
  } else if (scenario === 'post-unknown-ext') {
    // BR-03.4：带路径但扩展名未识别 → 强制脱敏。
    output = await first(ctx, 'tools/post-execute', {
      name: 'fetch_dataset',
      arguments: { path: 'transfer/data.xpt' },
      agent: {},
    }, { isError: false, value: 'A1234567 2024-03-05', content: [{ type: 'text', text: 'A1234567 2024-03-05' }] });
  } else if (scenario === 'post-sensitive') {
    // TC-26：整表转储（唯一 L3 硬红线）+ 无审批通道 → BLOCKED，三选项不进入模型上下文。
    output = await first(ctx, 'tools/post-execute', {
      name: 'fetch_database',
      arguments: {},
      agent: {},
    }, { isError: false, value: MASS_DUMP_TEXT, content: [{ type: 'text', text: MASS_DUMP_TEXT }] });
  } else if (scenario === 'post-sensitive-denied'
      || scenario === 'post-sensitive-redacted'
      || scenario === 'post-sensitive-audited') {
    output = await first(ctx, 'tools/post-execute', {
      name: 'fetch_database',
      arguments: {},
      agent: {},
    }, { isError: false, value: MASS_DUMP_TEXT, content: [{ type: 'text', text: MASS_DUMP_TEXT }] });
  } else if (scenario === 'l3-consume-flow') {
    // TC-28：L3_ALLOW_AUDITED 一次性消费。smart_guard 接线后小脏载荷走 token 化
    // 自愈（不消费授权）；授权消费只对整表转储硬红线触发——首个转储请求消费
    // 授权后原样放行，第二个转储请求授权已消费 → 阻断。
    const granted = await first(ctx, 'tools/post-execute', {
      name: 'fetch_database',
      arguments: {},
      agent: {},
    }, { isError: false, value: MASS_DUMP_TEXT, content: [{ type: 'text', text: MASS_DUMP_TEXT }] });
    const firstDirty = await first(ctx, 'llm/stream', {
      messages: [{ role: 'user', content: MASS_DUMP_TEXT }],
    });
    let secondDirty;
    try {
      await first(ctx, 'llm/stream', {
        messages: [{ role: 'user', content: MASS_DUMP_TEXT }],
      });
      secondDirty = { blocked: false };
    } catch (error) {
      secondDirty = { blocked: true };
    }
    output = { grantedKind: granted?.kind, grantedValue: granted?.value, firstDirty, secondDirty };
  } else if (scenario === 'sensitive-allowed') {
    output = await first(ctx, 'tools/pre-execute', {
      name: 'read_file',
      arguments: { path: process.env.EXCEL_FILE },
      agent: { id: 'agent-1', userId: 'integration-user', sessionId: 'integration-session' },
      callId: 'call-1',
    });
  } else if (scenario === 'credential-local') {
    // 本地凭据通道：credentialsDir 下的密码文件原值不进 LLM 上下文，
    // 只返回 CREDENTIAL_LOCAL_ONLY 占位 + 路径。
    output = await first(ctx, 'tools/post-execute', {
      name: 'read_file',
      arguments: { path: process.env.CREDENTIAL_FILE },
      agent: {},
    }, { isError: false, value: 'A1234567', content: [{ type: 'text', text: 'A1234567' }] });
  } else if (scenario === 'fail-closed') {
    output = await first(ctx, 'tools/pre-execute', {
      name: 'read_file',
      arguments: { path: 'safe.txt' },
      agent: {},
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
