import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerBranding } from './branding.js';
import { createDataInterceptionPolicy } from './data-interception-policy.js';
import { planeOf, parseRootsEnv, validatePlaneRoots } from './planes.js';
import { safeToolResult, shouldReplaceResult } from './tool-result-guard.js';
import { registerClinicalListingPlugin } from './clinical-listing-plugin.js';

const REQUEST_TIMEOUT_DEFAULT_MS = 30_000;
const HOOK_TIMEOUT_DEFAULT_MS = 120_000;
const HEAVY_OPERATIONS = new Set(['listing_inspect', 'listing_run_code', 'listing_publish']);
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const HEARTBEAT_MAX_FAILURES = 3;

export class SecurityRuntime {
  constructor(config) {
    this.config = config;
    this.lanes = {
      fast: this.#newLane(),
      heavy: this.#newLane(),
    };
    this.heartbeatTimer = null;
    this.#spawnWorker(this.lanes.fast);
    this.#spawnWorker(this.lanes.heavy);
  }

  get child() { return this.lanes.fast.child; }
  get broken() { return this.lanes.fast.broken; }
  get degraded() { return this.lanes.fast.degraded; }
  get startupNotice() { return this.lanes.fast.startupNotice; }

  #newLane() {
    return {
      child: null, buffer: '', pending: new Map(), seq: 0,
      broken: false, degraded: false, heartbeatFailures: 0, startupNotice: null,
    };
  }

  #laneFor(payload, options) {
    if (options?.lane === 'heavy') return this.lanes.heavy;
    if (options?.lane === 'fast') return this.lanes.fast;
    return HEAVY_OPERATIONS.has(String(payload?.operation ?? ''))
      ? this.lanes.heavy : this.lanes.fast;
  }

  #resolvePython() {
    if (this.config?.python) return this.config.python;
    if (process.env.PLUGIN_PYTHON) return process.env.PLUGIN_PYTHON;
    if (process.env.PYTHON) return process.env.PYTHON;
    const pluginRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
    const candidates = process.platform === 'win32'
      ? [join(pluginRoot, '..', '.venv', 'Scripts', 'python.exe')]
      : [join(pluginRoot, '..', '.venv', 'bin', 'python'),
         join(pluginRoot, '..', '.venv', 'bin', 'python3')];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  #spawnWorker(lane) {
    const config = this.config;
    const python = this.#resolvePython();
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    lane.startupNotice = null;
    const env = {};
    for (const key of ['PATH', 'SystemRoot', 'USERPROFILE', 'HOME', 'TEMP', 'TMP',
                       'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH',
                       'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    let workerTmp = null;
    try {
      const packageRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
      workerTmp = join(packageRoot, '..', '.cache', 'tmp');
      mkdirSync(workerTmp, { recursive: true });
      env.TEMP = workerTmp;
      env.TMP = workerTmp;
      env.TMPDIR = workerTmp;
      env.EMERALD_TMP_ROOT = workerTmp;
    } catch {
      // 目录不可建时保留宿主临时区
    }
    env.EMERALD_WORKER_ROOT = cwd;
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    const pythonPaths = [cwd];
    if (process.env.PYTHONPATH) pythonPaths.push(process.env.PYTHONPATH);
    env.PYTHONPATH = pythonPaths.join(delimiter);
    if (process.env.EMERALD_AUDIT_ROOT) env.EMERALD_AUDIT_ROOT = process.env.EMERALD_AUDIT_ROOT;
    const child = spawn(python, ['-m', 'security.worker'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    lane.child = child;
    lane.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onOutput(lane, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('error', (error) => {
      if (lane.child === child) this.#failAll(lane, error);
    });
    child.on('exit', () => {
      if (lane.child !== child) return;
      const notice = lane.startupNotice;
      this.#failAll(lane, notice
        ? new Error('security worker exited: ' + (notice.code ?? 'UNKNOWN') + ' - ' + (notice.reason ?? 'no reason'))
        : new Error('security worker exited'));
    });
  }

  #failAll(lane, error) {
    lane.broken = true;
    for (const { reject, timer } of lane.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    lane.pending.clear();
    try { lane.child.kill(); } catch { /* already dead */ }
  }

  #onOutput(lane, chunk) {
    lane.buffer += chunk;
    let index;
    while ((index = lane.buffer.indexOf('\n')) >= 0) {
      const line = lane.buffer.slice(0, index).trim();
      lane.buffer = lane.buffer.slice(index + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        response = { ok: false, code: 'SECURITY_UNAVAILABLE', reason: 'invalid worker response' };
      }
      const pending = lane.pending.get(response.requestId);
      if (pending) {
        lane.pending.delete(response.requestId);
        clearTimeout(pending.timer);
        pending.resolve(response);
      } else if (response.code) {
        lane.startupNotice = response;
      }
    }
  }

  request(payload, options = {}) {
    const lane = this.#laneFor(payload, options);
    const requestId = 'req-' + (++lane.seq);
    const configured = Number(this.config?.requestTimeoutMs);
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : (configured > 0 ? configured : REQUEST_TIMEOUT_DEFAULT_MS);
    return new Promise((resolve, reject) => {
      if (lane.broken || lane.child.exitCode !== null || lane.child.killed) {
        const notice = lane.startupNotice;
        reject(new Error(notice
          ? 'security worker unavailable: ' + (notice.code ?? 'UNKNOWN') + ' - ' + (notice.reason ?? 'no reason')
          : 'security worker unavailable'));
        return;
      }
      const timer = setTimeout(() => {
        lane.pending.delete(requestId);
        const timeout = new Error('security worker request timeout after ' + timeoutMs + 'ms');
        reject(timeout);
        if (!options.probe && !this.#hasInFlightRequest(lane)) {
          this.#restartWorker(lane, new Error('security worker restarted after a timed-out request'));
        }
      }, timeoutMs);
      lane.pending.set(requestId, { resolve, reject, timer, probe: options.probe === true });
      lane.child.stdin.write(JSON.stringify({ requestId, ...payload }) + '\n', (error) => {
        if (error) {
          lane.pending.delete(requestId);
          clearTimeout(timer);
          this.#failAll(lane, error);
          reject(error);
        }
      });
    });
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    const intervalMs = Number(this.config?.heartbeatIntervalMs) > 0
      ? Number(this.config.heartbeatIntervalMs) : HEARTBEAT_INTERVAL_MS;
    const probeTimeoutMs = Number(this.config?.heartbeatTimeoutMs) > 0
      ? Number(this.config.heartbeatTimeoutMs) : HEARTBEAT_TIMEOUT_MS;
    const maxFailures = Number.isInteger(this.config?.heartbeatMaxFailures)
      ? Number(this.config.heartbeatMaxFailures) : HEARTBEAT_MAX_FAILURES;
    const ping = async () => {
      const fast = this.lanes.fast;
      if (fast.broken) {
        fast.heartbeatFailures += 1;
        if (fast.heartbeatFailures >= maxFailures) {
          fast.degraded = true;
          this.#restartWorker(fast);
        }
        return;
      }
      if (this.#hasInFlightRequest(fast)) {
        fast.heartbeatFailures = 0;
        return;
      }
      try {
        await this.request({ operation: 'ping' }, { timeoutMs: probeTimeoutMs, probe: true });
        fast.heartbeatFailures = 0;
        fast.degraded = false;
      } catch {
        fast.heartbeatFailures += 1;
        if (fast.heartbeatFailures >= maxFailures) {
          fast.degraded = true;
          this.#restartWorker(fast);
        }
      }
    };
    this.heartbeatTimer = setInterval(ping, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  #hasInFlightRequest(lane) {
    for (const entry of lane.pending.values()) {
      if (!entry.probe) return true;
    }
    return false;
  }

  #restartWorker(lane, reason = new Error('security worker restarted')) {
    const previous = lane.child;
    lane.broken = true;
    for (const { reject, timer } of lane.pending.values()) {
      clearTimeout(timer);
      reject(reason);
    }
    lane.pending.clear();
    try { previous.kill(); } catch { /* already dead */ }
    lane.heartbeatFailures = 0;
    lane.broken = false;
    this.#spawnWorker(lane);
  }

  dispose() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const lane of [this.lanes.fast, this.lanes.heavy]) {
      try { lane.child.kill(); } catch { /* already dead */ }
    }
  }
}

function validateConfig(raw = {}) {
  const environmentEnabled = process.env.DATA_PROTECTION_ENABLED !== '0'
    && process.env.DATA_INTERCEPTION_ENABLED !== '0';
  const dataInterceptionEnabled = raw.dataInterceptionEnabled
    ?? raw.dataProtectionEnabled
    ?? environmentEnabled;
  if (typeof dataInterceptionEnabled !== 'boolean') {
    throw new Error('dataInterceptionEnabled must be a boolean');
  }
  const maxScanRows = Number(raw.maxScanRows ?? process.env.MAX_SCAN_ROWS ?? 20);
  if (!Number.isInteger(maxScanRows) || maxScanRows < 1 || maxScanRows > 200) {
    throw new Error('maxScanRows must be an integer from 1 to 200');
  }
  const credentialsDir = raw.credentialsDir ?? process.env.EMERALD_CREDENTIALS_DIR;
  const localDataAccess = raw.localDataAccess ?? process.env.EMERALD_LOCAL_DATA_ACCESS ?? 'disabled';
  if (!['disabled', 'uat-local'].includes(localDataAccess)) {
    throw new Error('invalid localDataAccess: ' + localDataAccess);
  }
  const localDataRoot = raw.localDataRoot ?? process.env.EMERALD_LOCAL_DATA_ROOT;
  const listingTimeoutMs = raw.listingTimeoutMs
    ?? (process.env.EMERALD_LISTING_TIMEOUT_MS ? Number(process.env.EMERALD_LISTING_TIMEOUT_MS) : undefined);
  if (listingTimeoutMs !== undefined) {
    const values = typeof listingTimeoutMs === 'object' && listingTimeoutMs !== null
      ? Object.values(listingTimeoutMs) : [listingTimeoutMs];
    if (!values.length || values.some((value) => !Number.isFinite(Number(value)) || Number(value) <= 0)) {
      throw new Error('listingTimeoutMs must be a positive number of milliseconds');
    }
  }
  const hookTimeoutMs = raw.hookTimeoutMs
    ?? (process.env.EMERALD_HOOK_TIMEOUT_MS ? Number(process.env.EMERALD_HOOK_TIMEOUT_MS) : undefined);
  if (hookTimeoutMs !== undefined
    && (!Number.isFinite(Number(hookTimeoutMs)) || Number(hookTimeoutMs) <= 0)) {
    throw new Error('hookTimeoutMs must be a positive number of milliseconds');
  }
  const asRootList = (value) => {
    if (Array.isArray(value)) return value.filter((x) => typeof x === 'string' && x.trim());
    if (typeof value === 'string' && value.trim()) return [value];
    return [];
  };
  const config = {
    ...raw,
    dataInterceptionEnabled,
    maxScanRows,
    credentialsDir,
    localDataAccess,
    localDataRoot,
    listingTimeoutMs,
    hookTimeoutMs,
    dataPlaneRoots: asRootList(raw.dataPlaneRoots ?? parseRootsEnv(process.env.EMERALD_DATA_PLANE_ROOTS)),
    specPlaneRoots: asRootList(raw.specPlaneRoots ?? parseRootsEnv(process.env.EMERALD_SPEC_PLANE_ROOTS)),
    documentPlaneRoots: asRootList(raw.documentPlaneRoots ?? parseRootsEnv(process.env.EMERALD_DOCUMENT_PLANE_ROOTS)),
    outputPlaneRoot: raw.outputPlaneRoot ?? process.env.EMERALD_OUTPUT_PLANE_ROOT,
  };
  const planeErrors = validatePlaneRoots(config);
  if (planeErrors.length) {
    throw new Error('invalid plane roots: ' + planeErrors.join('; '));
  }
  return config;
}

function hookTimeoutMs(config) {
  const override = Number(config?.hookTimeoutMs);
  if (Number.isFinite(override) && override > 0) return override;
  return HOOK_TIMEOUT_DEFAULT_MS;
}

function context(config, policy, exec = {}) {
  const workspaceRoot = exec.agent?.session?.header?.cwd ?? config.localDataRoot;
  // 2026-08-25 P0：开关状态实时求值，绝不用启动期快照。worker 侧
  // check_llm / scrub_text / inspect_local_data / listing_* 都据此字段决定
  // 是否执行拦截；传快照会让运行时切换开关后 worker 仍按旧值拦截。
  const enabled = typeof policy?.isEnabled === 'function'
    ? policy.isEnabled()
    : (config.dataInterceptionEnabled ?? true);
  return {
    dataInterceptionEnabled: enabled,
    sessionId: exec.agent?.sessionId ?? config.sessionId ?? 'unknown-session',
    userId: exec.agent?.userId ?? config.userId ?? 'anonymous',
    workspaceRoot,
    localDataAccess: config.localDataAccess,
    localDataRoot: workspaceRoot,
    credentialsDir: config.credentialsDir,
  };
}

function modelRequestPayload(options) {
  const { signal, ...payload } = options;
  return payload;
}

function maskTrustedDocuments(value, token, restored = new Map(), path = []) {
  if (Array.isArray(value)) return value.map(
    (item, index) => maskTrustedDocuments(item, token, restored, [...path, index]),
  );
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'text'
      && value.clinicalGuard === 'PROTECTED_DATA_SOURCE'
      && value.protectedDataToken === token
      && (value.protectedDataSource === 'sas' || value.protectedDataSource === 'external_excel')) {
    const { clinicalGuard, protectedDataSource, protectedDataToken, ...block } = value;
    return { ...block, text: 'protected data source' };
  }
  if (value.type === 'text'
      && value.clinicalGuard === 'TRUSTED_DOCUMENT_CONTENT'
      && value.trustedDocumentToken === token
      && typeof value.text === 'string') {
    restored.set(JSON.stringify([...path, 'text']), value.text);
    const { clinicalGuard, trustedDocumentToken, ...block } = value;
    return { ...block, text: 'trusted document content' };
  }
  if (value.type === 'text'
      && value.clinicalGuard === 'TRUSTED_LISTING_RECEIPT'
      && value.trustedListingToken === token
      && typeof value.text === 'string') {
    restored.set(JSON.stringify([...path, 'text']), value.text);
    const { clinicalGuard, trustedListingToken, ...block } = value;
    return { ...block, text: 'trusted listing receipt' };
  }
  if (value.type === 'text'
      && typeof value.text === 'string'
      && value.text.includes('"clinicalGuard":"CONTROL_PATHS"')
      && value.text.includes('"trustedControlToken":"' + token + '"')) {
    try {
      const projection = JSON.parse(value.text);
      if (projection.clinicalGuard === 'CONTROL_PATHS'
          && projection.trustedControlToken === token
          && Array.isArray(projection.paths)
          && projection.paths.every((item) => typeof item === 'string')) {
        restored.set(JSON.stringify([...path, 'text']), JSON.stringify({
          ...projection,
          trustedControlToken: undefined,
        }));
        return { ...value, text: 'trusted local path control metadata' };
      }
    } catch {
      // 非 canonical JSON 不建立豁免，继续走常规出域检查
    }
  }
  return Object.fromEntries(Object.entries(value).map(
    ([key, item]) => [key, maskTrustedDocuments(item, token, restored, [...path, key])],
  ));
}

function restoreTrustedDocuments(value, restored, path = []) {
  const original = restored.get(JSON.stringify(path));
  if (original !== undefined) return original;
  if (Array.isArray(value)) return value.map(
    (item, index) => restoreTrustedDocuments(item, restored, [...path, index]),
  );
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(
    ([key, item]) => [key, restoreTrustedDocuments(item, restored, [...path, key])],
  ));
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

function registerLocalMetadataTool(ctx, runtime, config, policy) {
  // 工具始终注册；开启状态的访问门禁由 worker 决定，关闭状态不设门禁。
  const promptDisposer = ctx.systemPrompt?.section?.({
    name: 'tool:local-data-metadata',
    order: 99,
    text: 'For UAT clinical source files, use local_data_metadata to inspect only schema metadata.',
  }) ?? (() => {});
  const toolDisposer = ctx.tools.register(defineTool({
    name: 'local_data_metadata',
    description: 'Inspect a UAT source file locally and return only non-value metadata.',
    parameters: {
      path: { type: 'string', required: true, description: 'Relative path under the current Web UI session workspace.' },
    },
    output: {
      schema: LOCAL_DATA_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const response = await runtime.request({
        operation: 'inspect_local_data',
        path: args.path,
        context: context(config, policy, exec),
      }, { timeoutMs: hookTimeoutMs(config) });
      if (!response.ok) throw new Error(response.reason ?? 'local metadata inspection failed');
      return { clinicalGuard: 'LOCAL_METADATA_ONLY', ...response.metadata };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Inspect local metadata: ' + args.path,
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
          return '不支持的内容块类型: ' + (block?.type ?? 'unknown');
        }
      }
    }
  }
  return null;
}

/**
 * 2026-08-25 重构 v2：
 * - 开关只控制数据拦截
 * - 智能功能（流程引导、EDC识别、模板规范）始终生效
 * - 开关切换时触发进程重启
 */
export default function clinicalDataGuard(ctx, rawConfig = {}) {
  const config = validateConfig(rawConfig);

  // 创建策略对象，传入开关切换回调
  const policy = createDataInterceptionPolicy(config.dataInterceptionEnabled, {
    onChange(change) {
      const record = JSON.stringify({
        event: 'data_interception_policy_changed',
        previousEnabled: change.previousEnabled,
        enabled: change.enabled,
        source: change.source ?? 'runtime',
        timestamp: new Date().toISOString(),
      });
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(record);
      else process.stderr.write('[clinical-data-guard] ' + record + '\n');
    },

    // 2026-08-25: 开关切换时触发进程重启
    onSwitch(switchInfo) {
      console.error(
        '[clinical-data-guard] 开关切换: ' + switchInfo.previousEnabled + ' → ' + switchInfo.enabled + '，触发进程重启'
      );
      // 通知 Harness 重启进程
      if (typeof ctx.emit === 'function') {
        ctx.emit('plugin:restart', {
          reason: 'data_interception_switch',
          previousEnabled: switchInfo.previousEnabled,
          enabled: switchInfo.enabled,
          timestamp: switchInfo.timestamp,
        });
      }
    },
  });

  const runtime = new SecurityRuntime(config);
  const trustedToken = randomBytes(32).toString('hex');
  runtime.startHeartbeat();

  const disposers = [];

  // 2026-08-25: 所有组件始终注册，不受开关控制
  // 开关只影响数据拦截，不影响智能功能

  // 1. 品牌与开关 UI（始终注册）
  disposers.push(registerBranding(ctx, config, policy));

  // 2. Listing 插件（流程引导，始终生效）
  disposers.push(registerClinicalListingPlugin(ctx, runtime, config, policy));

  // 3. 本地数据工具（始终注册）
  disposers.push(registerLocalMetadataTool(ctx, runtime, config, policy));

  // 4. post-execute 钩子（数据拦截受开关控制，智能功能始终生效）
  const post = ctx.on('tools/post-execute', async (exec, result, next) => {
    if (shouldReplaceResult(exec)) {
      // 2026-08-25: 根据开关状态决定是否拦截数据
      // 智能功能（表头提取、EDC识别、模板验证）始终生效
      const interceptData = policy.isEnabled();

      const decision = await safeToolResult(exec, result, runtime, {
        ...config,
        workspaceRoot: context(config, policy, exec).workspaceRoot,
        protectedDataToken: trustedToken,
        hookTimeoutMs: hookTimeoutMs(config),
      }, trustedToken, { interceptData });

      return { kind: 'accept', content: decision.content ?? result.content };
    }
    return next();
  });
  disposers.push(post);

  // 5. llm/stream 钩子（出域检查受开关控制）
  const stream = ctx.on('llm/stream', async function* streamGuard(options, next) {
    // 2026-08-25: 根据开关状态决定是否执行出域检查
    if (policy.isEnabled()) {
      const shapeError = validateMessageShape(options.messages ?? []);
      if (shapeError) throw new Error('[clinical-data-guard] ' + shapeError);

      const restoredDocuments = new Map();
      const payload = maskTrustedDocuments(
        modelRequestPayload(options), trustedToken, restoredDocuments,
      );

      const check = await runtime.request({
        operation: 'check_llm',
        payload,
        context: {
          ...context(config, policy),
          scanScope: 'full_generate_options',
        },
      }, { timeoutMs: hookTimeoutMs(config) });

      if (!check.ok) {
        if (check.code === 'SECURITY_UNAVAILABLE') throw new Error(check.reason);
        throw new Error('[clinical-data-guard] 临床数据出域已阻断 (audit:' + (check.audit_id ?? 'none') + ')');
      }

      if (check.payload && typeof check.payload === 'object') {
        const restored = restoreTrustedDocuments(check.payload, restoredDocuments);
        yield* next({ ...options, ...restored });
        return;
      }
    }

    // 开关关闭时：不检查，直接放行
    yield* next();
  });
  disposers.push(stream);

  return () => {
    disposers.reverse().forEach((dispose) => dispose?.());
    runtime.dispose();
  };
}

clinicalDataGuard.inject = ['tools', 'llm', 'webServer', 'systemPrompt'];
