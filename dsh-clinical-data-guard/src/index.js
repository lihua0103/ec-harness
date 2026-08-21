import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerBranding } from './branding.js';
import { scanDlp } from './patterns.js';
import { extractPath, safeToolResult, shouldReplaceResult } from './tool-result-guard.js';

// FIX-6 (R-9): 安全检查请求超时（默认 30s，可配置）。
const REQUEST_TIMEOUT_DEFAULT_MS = 30_000;
// FIX-11 (Claude P2-1): worker 心跳——30s 间隔、5s 超时、3 次失败标记 degraded 并重启。
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const HEARTBEAT_MAX_FAILURES = 3;

export class SecurityRuntime {
  constructor(config) {
    this.config = config;
    this.pending = new Map();
    this.seq = 0;
    this.broken = false;
    this.degraded = false;
    this.heartbeatFailures = 0;
    this.heartbeatTimer = null;
    this.#spawnWorker();
  }

  #spawnWorker() {
    const config = this.config;
    const python = config.python ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    // ST-P2-3: worker 只继承最小 env 白名单，防止不可信 Excel 解析漏洞
    // 导致 LLM API Key 等宿主凭据被收割。所有需要的运行时量显式传递。
    const env = {};
    // PATH/SystemRoot/USERPROFILE/HOME: 让 Python 能找到标准库和 CRT
    for (const key of ['PATH', 'SystemRoot', 'USERPROFILE', 'HOME', 'TEMP', 'TMP',
                       'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH',
                       'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.EMERALD_WORKER_ROOT = cwd;
    // 协议层 UTF-8 兜底（E2E-1 修复）
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.PYTHONPATH = cwd + (process.env.PYTHONPATH ? delimiter + process.env.PYTHONPATH : '');
    // 审计/授权 root 路径（若已配置）
    if (process.env.EMERALD_AUDIT_ROOT) env.EMERALD_AUDIT_ROOT = process.env.EMERALD_AUDIT_ROOT;
    if (process.env.EMERALD_AUTHZ_ROOT) env.EMERALD_AUTHZ_ROOT = process.env.EMERALD_AUTHZ_ROOT;
    const child = spawn(python, ['-m', 'security.worker'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onOutput(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    // 仅当退出的仍是当前 worker 时才判定运行时损坏（避免重启竞态误杀新进程）。
    child.on('error', (error) => {
      if (this.child === child) this.#failAll(error);
    });
    child.on('exit', () => {
      if (this.child === child) this.#failAll(new Error('security worker exited'));
    });
  }

  // FIX-6 (R-9): EPIPE / 进程崩溃 → 标记损坏、kill 并拒绝全部 pending。
  #failAll(error) {
    this.broken = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    try { this.child.kill(); } catch { /* already dead */ }
  }

  #onOutput(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        response = { ok: false, code: 'SECURITY_UNAVAILABLE', reason: 'invalid worker response' };
      }
      const pending = this.pending.get(response.requestId);
      if (pending) {
        this.pending.delete(response.requestId);
        clearTimeout(pending.timer);
        pending.resolve(response);
      }
    }
  }

  request(payload, options = {}) {
    const requestId = `req-${++this.seq}`;
    const configured = Number(this.config?.requestTimeoutMs);
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : (configured > 0 ? configured : REQUEST_TIMEOUT_DEFAULT_MS);
    return new Promise((resolve, reject) => {
      if (this.broken || this.child.exitCode !== null || this.child.killed) {
        reject(new Error('security worker unavailable'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        // FIX-6: 超时视为检查不可用，fail-closed 由调用方拒绝继续。
        reject(new Error(`security worker request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ requestId, ...payload }) + '\n', (error) => {
        if (error) {
          // FIX-6 (R-9): stdin EPIPE → worker 损坏，kill 并拒绝全部 pending。
          this.pending.delete(requestId);
          clearTimeout(timer);
          this.#failAll(error);
          reject(error);
        }
      });
    });
  }

  // FIX-11 (Claude P2-1): ping/pong 心跳，3 次失败标记 degraded 并自动重启 worker。
  // 间隔/超时/阈值可经 config 覆盖（测试注入小值驱动）。
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    const intervalMs = Number(this.config?.heartbeatIntervalMs) > 0
      ? Number(this.config.heartbeatIntervalMs) : HEARTBEAT_INTERVAL_MS;
    const probeTimeoutMs = Number(this.config?.heartbeatTimeoutMs) > 0
      ? Number(this.config.heartbeatTimeoutMs) : HEARTBEAT_TIMEOUT_MS;
    const maxFailures = Number.isInteger(this.config?.heartbeatMaxFailures)
      ? Number(this.config.heartbeatMaxFailures) : HEARTBEAT_MAX_FAILURES;
    const ping = async () => {
      if (this.broken) {
        // worker 已退出/损坏：计入心跳失败，达到阈值自动重启恢复服务。
        this.heartbeatFailures += 1;
        if (this.heartbeatFailures >= maxFailures) {
          this.degraded = true;
          this.#restartWorker();
        }
        return;
      }
      try {
        await this.request({ operation: 'ping' }, { timeoutMs: probeTimeoutMs });
        this.heartbeatFailures = 0;
        this.degraded = false;
      } catch {
        this.heartbeatFailures += 1;
        if (this.heartbeatFailures >= maxFailures) {
          this.degraded = true;
          this.#restartWorker();
        }
      }
    };
    this.heartbeatTimer = setInterval(ping, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  #restartWorker() {
    try { this.child.kill(); } catch { /* already dead */ }
    this.heartbeatFailures = 0;
    this.broken = false;
    this.#spawnWorker();
  }

  dispose() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try { this.child.kill(); } catch { /* already dead */ }
  }
}

function validateConfig(raw = {}) {
  const mode = raw.mode ?? process.env.DATA_PROTECTION_MODE ?? 'enforce';
  if (!['enforce', 'shadow', 'disabled'].includes(mode)) {
    throw new Error(`invalid DATA_PROTECTION_MODE: ${mode}`);
  }
  const approvalId = raw.approvalId ?? process.env.DATA_PROTECTION_APPROVAL_ID;
  const approvedBy = raw.approvedBy ?? process.env.DATA_PROTECTION_APPROVED_BY;
  if (mode === 'disabled' && (!approvalId || !approvedBy)) {
    throw new Error('disabled mode requires approvalId and approvedBy');
  }
  const maxScanRows = Number(raw.maxScanRows ?? process.env.MAX_SCAN_ROWS ?? 20);
  if (!Number.isInteger(maxScanRows) || maxScanRows < 1 || maxScanRows > 200) {
    throw new Error('maxScanRows must be an integer from 1 to 200');
  }
  // 本地凭据通道：credentialsDir 下的文件是本地凭据（如压缩包密码），
  // 原值只在本地工具间流转，绝不进 LLM 上下文。默认关闭。
  const credentialsDir = raw.credentialsDir ?? process.env.EMERALD_CREDENTIALS_DIR;
  // UAT 本地数据处理车道：只允许项目根目录内的本地转换；它不改变
  // llm/stream 与 post-execute 的出域防线，也不放行 expected/网络/数据转储。
  const localDataAccess = raw.localDataAccess ?? process.env.EMERALD_LOCAL_DATA_ACCESS ?? 'disabled';
  if (!['disabled', 'uat-local'].includes(localDataAccess)) {
    throw new Error(`invalid localDataAccess: ${localDataAccess}`);
  }
  const localDataRoot = raw.localDataRoot ?? process.env.EMERALD_LOCAL_DATA_ROOT;
  if (localDataAccess === 'uat-local' && (typeof localDataRoot !== 'string' || !localDataRoot.trim())) {
    throw new Error('uat-local data access requires localDataRoot');
  }
  return {
    ...raw,
    mode,
    approvalId,
    approvedBy,
    maxScanRows,
    credentialsDir,
    localDataAccess,
    localDataRoot,
    authorizationRoot: raw.authorizationRoot ?? process.env.EMERALD_AUTHZ_ROOT,
  };
}

function context(config, exec = {}) {
  return {
    mode: config.mode,
    // FIX-9 (BR-06.5): 身份默认值非空，Python 侧哈希真实生效。
    sessionId: exec.agent?.sessionId ?? config.sessionId ?? config.authorizationSession ?? 'unknown-session',
    userId: exec.agent?.userId ?? config.userId ?? config.authorizationUser ?? 'anonymous',
    workspaceRoot: exec.agent?.session?.header?.cwd ?? config.localDataRoot,
    localDataAccess: config.localDataAccess,
    localDataRoot: config.localDataRoot,
    approvalId: config.approvalId,
    approvedBy: config.approvedBy,
  };
}

function modelRequestPayload(options) {
  const { signal, ...payload } = options;
  return payload;
}

const ALLOWED_CONTENT_BLOCKS = new Set(['text', 'reasoning', 'tool-call', 'tool-result']);

const LOCAL_DATA_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    clinicalGuard: { type: 'string', required: true, const: 'LOCAL_METADATA_ONLY' },
    path: { type: 'string', required: true },
    fileType: { type: 'string', required: true },
    sheets: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          rowCount: { type: 'integer', required: true },
          columns: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
    },
  },
};

function registerLocalMetadataTool(ctx, runtime, config) {
  if (config.localDataAccess !== 'uat-local') return () => {};
  const promptDisposer = ctx.systemPrompt?.section?.({
    name: 'tool:local-data-metadata',
    order: 99,
    text: 'For UAT clinical source files, use local_data_metadata to inspect only schema metadata (file type, sheet names, row counts, and column names). Do not use bash, read_file, pwsh, or scripts to open source data files. The tool never returns data rows or cell values.',
  }) ?? (() => {});
  const toolDisposer = ctx.tools.register(defineTool({
    name: 'local_data_metadata',
    description: 'Inspect a UAT source file locally and return only non-value metadata: file type, sheet names, row counts, and column names. No records, cell values, subject identifiers, dates, or query text are returned.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path under the configured local UAT data root. Supported: xlsx, xls, csv, sas7bdat.',
      },
    },
    output: {
      schema: LOCAL_DATA_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    execute: async (args, exec) => {
      const response = await runtime.request({
        operation: 'inspect_local_data',
        path: args.path,
        context: context(config, exec),
      });
      if (!response.ok) throw new Error(response.reason ?? 'local metadata inspection failed');
      return {
        clinicalGuard: 'LOCAL_METADATA_ONLY',
        ...response.metadata,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Inspect local metadata: ${args.path}`,
      kind: 'read',
      locations: [{ path: args.path }],
    }),
  }));
  return () => {
    toolDisposer?.();
    promptDisposer?.();
  };
}

function validateMessageShape(messages) {
  if (!Array.isArray(messages)) return 'messages 必须是数组';
  for (const message of messages) {
    if (!message || typeof message !== 'object') return '消息必须是对象';
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
      return '消息内容必须是字符串或 typed content 数组';
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== 'object' || !ALLOWED_CONTENT_BLOCKS.has(block.type)) {
          return `不支持的内容块类型: ${block?.type ?? 'unknown'}`;
        }
      }
    }
  }
  return null;
}

export default function clinicalDataGuard(ctx, rawConfig = {}) {
  const config = validateConfig(rawConfig);
  const runtime = new SecurityRuntime(config);
  runtime.startHeartbeat();
  const branding = registerBranding(ctx, config);
  const localMetadataTool = registerLocalMetadataTool(ctx, runtime, config);
  const disposers = [() => runtime.dispose(), branding, localMetadataTool];

  // L3 用户决策（FIX-4 / FR-13）：outcome 为 allowed-once 时按用户选择落授权类别。
  async function requestL3Decision(exec, userPrompt) {
    if (!ctx.approval?.request) return { allowed: false, blockedNoChannel: true };
    let outcome = await ctx.approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      signal: exec.signal,
      reason: `${userPrompt ?? '敏感临床数据需要用户决策。'} 选项：跳过（默认）/ 脱敏后继续 / 允许（需授权）`,
    });
    let choice = 'redacted-continue';
    if (typeof outcome === 'object' && outcome) {
      choice = outcome.choice ?? 'redacted-continue';
      outcome = outcome.outcome;
    }
    if (outcome !== 'allowed-once') return { allowed: false, blockedNoChannel: false };
    const category = choice === 'allow-audited' ? 'L3_ALLOW_AUDITED' : 'L3_REDACTED_CONTINUE';
    const authorization = await runtime.request({
      operation: 'authorize',
      root: config.authorizationRoot,
      user: exec.agent?.userId ?? config.authorizationUser ?? config.userId,
      session: exec.agent?.sessionId ?? config.authorizationSession ?? config.sessionId,
      category,
      operator: config.approvedBy ?? config.authorizationUser,
    });
    if (!authorization.ok) return { allowed: false, blockedNoChannel: false, authzFailed: true };
    return { allowed: true, category };
  }

  const quickGuard = ctx.tools.guard((exec) => {
    // Dedicated UAT metadata inspection has a narrower, independently validated
    // data boundary in the worker. Generic argument DLP must not reject its
    // legitimate local path before that boundary can enforce root containment.
    if (exec.name === 'local_data_metadata' && config.localDataAccess === 'uat-local') {
      return undefined;
    }
    const args = exec.arguments ?? {};
    const serialized = JSON.stringify(args);
    const hit = scanDlp(serialized);
    if (hit) return `[clinical-data-guard] 工具参数包含疑似临床数据（${hit}），已阻断。`;
    return undefined;
  });
  disposers.push(quickGuard);

  const pre = ctx.on('tools/pre-execute', async (exec, next) => {
    let check;
    try {
      check = await runtime.request({
        operation: 'check_tool',
        tool: exec.name,
        args: exec.arguments ?? {},
        context: context(config, exec),
      });
    } catch (error) {
      return { kind: 'deny', reason: `[clinical-data-guard] 安全运行时不可用，已拒绝执行：${error.message}` };
    }
    if (!check.ok) {
      const localLane = check.code === 'LOCAL_DATA_ACCESS_REQUIRED'
        && config.localDataAccess === 'uat-local';
      if (localLane) {
        return { kind: 'deny', reason: `[clinical-data-guard] 本地 UAT 数据处理需要受限本地执行车道：${check.reason}` };
      }
      return { kind: 'deny', reason: `[clinical-data-guard] ${check.reason} (audit:${check.audit_id ?? 'none'})` };
    }
    // FIX-12: pre-execute 路径键与 extractPath 对齐（path/file_path/filePath/filename/file，5 键）。
    const path = extractPath(exec.arguments ?? {});
    // UAT 车道：源文件只允许在安全 worker 的本地元数据车道内读取。
    // 具体的路径边界和格式检查由 worker 的 check_tool 统一执行；这里
    // 不再调用 inspect_file（那是通用 Excel L3 预检，会重复扫描并阻断
    // 已获准的 UAT 本地结构读取）。结果投影在 post-execute 统一处理。
    if (config.localDataAccess === 'uat-local' && typeof path === 'string'
        && /\.(xlsx|xls|csv|sas7bdat)$/i.test(path)) {
      return next();
    }

    return next();
  });
  disposers.push(pre);

  const post = ctx.on('tools/post-execute', async (exec, result, next) => {
    if (config.mode === 'enforce' && shouldReplaceResult(exec)) {
      const decision = await safeToolResult(exec, result, runtime, config);
      if (decision.needsApproval) {
        // FIX-4/FIX-13: user decisions may replace model-facing content, but
        // must never replace canonical value with a generic cross-tool shape.
        // DSH revalidates an accepted `value` against the originating tool's
        // output schema; glob/pwsh/read/get_goal/job_list therefore use content.
        if (!ctx.approval?.request) {
          return {
            kind: 'accept',
            content: [{
              type: 'text',
              text: JSON.stringify({
                clinicalGuard: 'BLOCKED',
                reason: '敏感数据需要用户决策，当前部署无审批通道，结果已 fail-closed。',
              }),
            }],
          };
        }
        const l3 = await requestL3Decision(exec, decision.userPrompt);
        if (!l3.allowed) {
          return {
            kind: 'accept',
            content: [{
              type: 'text',
              text: JSON.stringify({
                clinicalGuard: 'BLOCKED',
                reason: '用户未授权查看敏感数据组合，结果已阻断。',
              }),
            }],
          };
        }
        if (l3.category === 'L3_ALLOW_AUDITED') {
          // 允许并审计：保留工具原有 content；canonical value 不被改写，
          // 仅由用户明确授权决定这一次结果可以继续展示。
          return { kind: 'accept', content: decision.originalContent ?? result.content };
        }
        // 脱敏后继续：只返回 scrubbed content，原始 value 仍留在执行局部。
        return { kind: 'accept', content: decision.scrubbedContent };
      }
      return { kind: 'accept', content: decision.content ?? result.content };
    }
    return next();
  });
  disposers.push(post);

  const stream = ctx.on('llm/stream', async function* streamGuard(options, next) {
    const shapeError = validateMessageShape(options.messages ?? []);
    if (shapeError) throw new Error(`[clinical-data-guard] ${shapeError}`);
    const payload = modelRequestPayload(options);
    const check = await runtime.request({
      operation: 'check_llm',
      payload,
      context: { ...context(config), scanScope: 'full_generate_options' },
    });
    if (!check.ok) {
      if (check.code === 'SECURITY_UNAVAILABLE') throw new Error(check.reason);
      // FIX-4 (FR-13): L3_ALLOW_AUDITED 一次性消费——命中违规时若存在当次有效授权
      // 则消费并放行本请求；同一授权不会被第二次使用。
      if (check.code === 'EGRESS_VIOLATION') {
        const consumed = await runtime.request({
          operation: 'consume_authorization',
          root: config.authorizationRoot,
          user: config.authorizationUser ?? config.userId,
          session: config.authorizationSession ?? config.sessionId,
          category: 'L3_ALLOW_AUDITED',
        });
        if (consumed.ok) {
          yield* next();
          return;
        }
      }
      throw new Error(`[clinical-data-guard] 临床数据出域已阻断 (audit:${check.audit_id ?? 'none'})`);
    }
    // smart_guard 自愈车道：worker 已把命中值统一 token 化（[SUBJ:xx] 等），
    // 用脱敏后的载荷继续本次请求——原值不出域，会话不再被误报钉死。
    // waterfall 的 next() 复用同一 options 对象，字段就地替换即对下游生效；
    // signal 等非载荷字段不在 payload 内，保持原引用。
    if (check.action === 'scrubbed' && check.payload && typeof check.payload === 'object') {
      for (const key of Object.keys(payload)) {
        if (key in check.payload) options[key] = check.payload[key];
      }
    }
    yield* next();
  });
  disposers.push(stream);

  return () => disposers.reverse().forEach((dispose) => dispose());
}

clinicalDataGuard.inject = ['tools', 'llm', 'webServer'];
