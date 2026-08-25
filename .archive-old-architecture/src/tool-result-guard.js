import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, extname, resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitiveText } from './patterns.js';
import { planeOf } from './planes.js';

const CLINICAL_LISTING_TOOLS = new Set([
  'clinical_listing_inspect',
  'clinical_listing_run_code',
]);
const ALL_CLINICAL_LISTING_TOOLS = new Set([
  ...CLINICAL_LISTING_TOOLS,
  'clinical_listing_publish',
]);

const TRUSTED_LISTING_MARKERS = new Set([
  'CLINICAL_LISTING_INSPECTION',
  'CLINICAL_LISTING_PLAN_RECEIPT',
  'CLINICAL_LISTING_CODE_RECEIPT',
]);

const DATA_QUERY_TOOL_RE = /^(?:fetch|query|read|export)_(?:database|dataset|records?|rows?)$/i;
const LOCAL_OUTPUT_TOOL_RE = /^(?:bash|pwsh|powershell|shell|command|exec|read|read_file|job_output)$/i;
const SOURCE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|]+\.(?:sas7bdat|xpt|sas7bcat|xlsx|xlsm|xls|xlsb)\b/gi;

const EXTRACTOR_TIMEOUT_DEFAULT_MS = 10_000;
const EXTRACTOR_TIMEOUT_MAX_MS = 30_000;
const EXTRACTOR_GRACE_MS = 2_000;

// EDC 字段映射
const EDC_FIELD_MAPPINGS = {
  medidata: {
    SubjectID: 'USUBJID', SiteID: 'SITEID', Subject: 'SUBJID',
    VisitName: 'VISIT', FormName: 'FORM', RecordID: 'RECKEY',
    InstanceName: 'INSTANCE', Status: 'DATASTATUS',
    CreatedDate: 'CRTDTC', UpdatedDate: 'UPDTC',
  },
  oracle: {
    PATIENT_ID: 'USUBJID', SITE_ID: 'SITEID', SUBJECT_NUM: 'SUBJID',
    VISIT_NAME: 'VISIT', FORM_NAME: 'FORM', EVENT_ID: 'RECKEY',
  },
  veeva: {
    Subject: 'USUBJID', Site: 'SITEID', Visit: 'VISIT',
    Form: 'FORM', RecordID: 'RECKEY',
  },
};

// Output 模板规范
const OUTPUT_TEMPLATE_SPECS = {
  listing: {
    required_columns: ['USUBJID', 'VISIT', 'FORM', 'DATA_PAGE', 'COMMENT'],
    optional_columns: ['SITEID', 'STUDYID', 'VISITNUM', 'SEQ'],
  },
  qc: {
    required_columns: ['FIELD', 'VALUE', 'QUERY_TEXT', 'RESPONSE'],
    optional_columns: ['QUERY_ID', 'DISCREPANCY_TYPE', 'STATUS'],
  },
};

function containsTrustedListingReceipt(value) {
  if (Array.isArray(value)) return value.some(containsTrustedListingReceipt);
  if (!value || typeof value !== 'object') return false;
  if (isTrustedListingReceipt(value)) return true;
  if (value.type === 'text' && typeof value.text === 'string') {
    try {
      if (containsTrustedListingReceipt(JSON.parse(value.text))) return true;
    } catch { /* 普通文本不是收据 */ }
  }
  return Object.values(value).some(containsTrustedListingReceipt);
}

function isTrustedListingReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value.clinicalGuard ?? value.clinical_guard;
  if (!TRUSTED_LISTING_MARKERS.has(marker) || value.dataClass !== 'METADATA_ONLY') return false;
  const fingerprint = value.schemaFingerprint ?? value.schema_fingerprint;
  if (typeof fingerprint !== 'string' || !fingerprint) return false;
  return true;
}

const here = dirname(fileURLToPath(import.meta.url));
const extractor = join(here, '..', 'excel_header_extractor.py');

function extractorTimeoutMs(config) {
  const raw = Number(config?.extractorTimeoutMs);
  if (!Number.isFinite(raw) || raw <= 0) return EXTRACTOR_TIMEOUT_DEFAULT_MS;
  return Math.min(raw, EXTRACTOR_TIMEOUT_MAX_MS);
}

function resolveExtractorPython() {
  if (process.env.PLUGIN_PYTHON) return process.env.PLUGIN_PYTHON;
  if (process.env.PYTHON) return process.env.PYTHON;
  const packageRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const repoRoot = resolve(packageRoot, '..');
  const candidate = process.platform === 'win32'
    ? resolve(repoRoot, '.venv', 'Scripts', 'python.exe')
    : resolve(repoRoot, '.venv', 'bin', 'python');
  if (existsSync(candidate)) return candidate;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function systemTmpDir() {
  try {
    const packageRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
    const repoTmp = resolve(packageRoot, '..', '.cache', 'tmp');
    mkdirSync(repoTmp, { recursive: true });
    return repoTmp;
  } catch { return null; }
}

function runExtractor(path, maxRows, timeoutMs) {
  const repoTmp = systemTmpDir();
  return new Promise((resolve, reject) => {
    const args = [extractor, path, '--max-scan-rows', String(maxRows)];
    const child = spawn(resolveExtractorPython(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: (() => {
        const e = {};
        for (const k of ['PATH','SystemRoot','USERPROFILE','HOME','TEMP','TMP','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH','LD_LIBRARY_PATH','DYLD_LIBRARY_PATH']) {
          if (process.env[k] !== undefined) e[k] = process.env[k];
        }
        if (repoTmp) { e.TEMP = repoTmp; e.TMP = repoTmp; e.TMPDIR = repoTmp; e.EMERALD_TMP_ROOT = repoTmp; }
        e.PYTHONIOENCODING = 'utf-8';
        e.PYTHONUTF8 = '1';
        if (process.env.EMERALD_AUDIT_ROOT) e.EMERALD_AUDIT_ROOT = process.env.EMERALD_AUDIT_ROOT;
        return e;
      })()
    });
    let out = '', err = '';
    let killTimer;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), EXTRACTOR_GRACE_MS);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (code !== 0) {
        reject(new Error(redactSensitiveText(err.trim()) || 'excel extractor exited with ' + code));
        return;
      }
      try { resolve(JSON.parse(out)); }
      catch (error) { reject(new Error(redactSensitiveText('invalid excel extractor response: ' + error.message))); }
    });
  });
}

function extractPath(args = {}) {
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file', 'project', 'projectPath', 'specPath', 'sasPath']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export function isCredentialPath(filePath, credentialsDir) {
  if (!credentialsDir || typeof filePath !== 'string' || !filePath.trim()) return false;
  const base = resolve(credentialsDir);
  const target = resolve(filePath);
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function credentialPlaceholder(path) {
  return {
    clinicalGuard: 'CREDENTIAL_LOCAL_ONLY',
    credentialRef: basename(path),
    message: '本地凭据文件：原值仅供本地工具使用，已阻止进入模型上下文。',
  };
}

function existingContent(result) {
  return Array.isArray(result?.content) ? result.content : [];
}

function contentOnly(result, text, protectedDataSource, protectedDataToken) {
  const block = { type: 'text', text };
  if (protectedDataSource && protectedDataToken) {
    block.clinicalGuard = 'PROTECTED_DATA_SOURCE';
    block.protectedDataSource = protectedDataSource;
    block.protectedDataToken = protectedDataToken;
  }
  return { content: [block] };
}

function markListingReceipt(value, token) {
  if (!containsTrustedListingReceipt(value)) return value;
  if (Array.isArray(value)) return value.map((item) => markListingReceipt(item, token));
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'text' && typeof value.text === 'string') {
    let parsed;
    try { parsed = JSON.parse(value.text); } catch { return value; }
    if (!containsTrustedListingReceipt(parsed)) return value;
    return { ...value, clinicalGuard: 'TRUSTED_LISTING_RECEIPT', trustedListingToken: token };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, markListingReceipt(item, token)]));
}

async function scrubUntrustedListingContent(value, runtime, timeoutMs) {
  if (Array.isArray(value)) return Promise.all(value.map((item) => scrubUntrustedListingContent(item, runtime, timeoutMs)));
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'text' && typeof value.text === 'string') {
    let checked;
    try {
      checked = await runtime.request(
        { operation: 'scrub_text', text: value.text, profile: 'strict' },
        Number(timeoutMs) > 0 ? { timeoutMs: Number(timeoutMs) } : {},
      );
    } catch (error) {
      // 2026-08-25：worker 不可用/超时时保留可行动诊断。此前统一回
      // "Listing 结果安全检查失败"，把 worker 侧真因（UNKNOWN_OPERATION、
      // 超时、依赖缺失）全部掩盖，模型只能反复重试同一调用。
      return { ...value, text: JSON.stringify({
        clinicalGuard: 'CHECK_FAILED',
        reason: 'Listing 结果安全检查未完成',
        detail: redactSensitiveText(error?.message ?? 'security worker unavailable'),
      }) };
    }
    if (!checked.ok || typeof checked.text !== 'string') {
      return { ...value, text: JSON.stringify({
        clinicalGuard: 'CHECK_FAILED',
        reason: 'Listing 结果安全检查失败',
        code: typeof checked?.code === 'string' ? checked.code : undefined,
        detail: typeof checked?.reason === 'string'
          ? redactSensitiveText(checked.reason) : undefined,
      }) };
    }
    return { ...value, text: checked.text };
  }
  const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await scrubUntrustedListingContent(item, runtime, timeoutMs)]));
  return Object.fromEntries(entries);
}

function projectExecuteReceipt(receipt) {
  const projected = { clinicalGuard: 'CLINICAL_LISTING_RECEIPT', dataClass: 'METADATA_ONLY' };
  for (const key of ['status', 'stage', 'project', 'scenario', 'code', 'path', 'message']) {
    if (typeof receipt[key] === 'string') projected[key] = receipt[key];
  }
  const fingerprint = receipt.schemaFingerprint ?? receipt.schema_fingerprint;
  if (typeof fingerprint === 'string' && fingerprint) projected.schemaFingerprint = fingerprint;
  projected.note = '执行收据已投影为控制面元数据；产物内容未读取，未随收据出域。';
  return projected;
}

function projectExecuteContent(value) {
  if (Array.isArray(value)) {
    const items = value.map(projectExecuteContent);
    return items.some((item) => item === null) ? null : items;
  }
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'text' && typeof value.text === 'string') {
    let parsed;
    try { parsed = JSON.parse(value.text); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const nested = (parsed.receipt && typeof parsed.receipt === 'object' && !Array.isArray(parsed.receipt)) ? parsed.receipt : null;
    const markerSource = (parsed.clinicalGuard ?? parsed.clinical_guard) ? parsed : nested;
    const marker = markerSource ? (markerSource.clinicalGuard ?? markerSource.clinical_guard) : undefined;
    if (marker !== 'CLINICAL_LISTING_RECEIPT') return null;
    return { type: 'text', text: JSON.stringify(nested ? { ok: parsed.ok === true, action: typeof parsed.action === 'string' ? parsed.action : undefined, receipt: projectExecuteReceipt(nested) } : projectExecuteReceipt(parsed)) };
  }
  const entries = Object.entries(value).map(([key, item]) => [key, projectExecuteContent(item)]);
  if (entries.some(([, item]) => item === null)) return null;
  return Object.fromEntries(entries);
}

function protectedSourceFromExec(exec, config) {
  const values = Object.values(exec?.arguments ?? {}).filter((value) => typeof value === 'string');
  const candidates = values.flatMap((value) => value.match(SOURCE_PATH_RE) ?? []);
  for (const candidate of candidates) {
    const plane = planeOf(candidate, config);
    const ext = extname(candidate).toLowerCase();
    if (plane !== 'data') continue;
    if (['.sas7bdat', '.xpt', '.sas7bcat'].includes(ext)) return 'sas';
    if (['.xlsx', '.xlsm', '.xls', '.xlsb'].includes(ext)) return 'external_excel';
  }
  return undefined;
}

function dataOnlyPlaceholder(path, kind) {
  return {
    clinicalGuard: 'DATA_BLOCKED',
    kind,
    file: redactSensitiveText(basename(path)),
    message: '临床数据内容已屏蔽；仅允许获批的本地工作流处理，禁止发送给模型。',
    allowedRead: 'STRUCTURE_ONLY',
  };
}

function basename(path) { return path.split(/[/\\]/).pop() ?? path; }

// ============================================================
// 智能功能（始终生效）
// ============================================================

/**
 * 检测 EDC 系统
 */
function detectEDCSystem(headers) {
  const headerNames = headers.sheets?.[0]?.headers ?? [];
  const normalized = headerNames.map(h => h.toLowerCase().replace(/[_\s]/g, ''));
  let bestMatch = { system: null, score: 0 };
  for (const [system, mapping] of Object.entries(EDC_FIELD_MAPPINGS)) {
    let matches = 0;
    for (const field of Object.keys(mapping)) {
      if (normalized.includes(field.toLowerCase().replace(/[_\s]/g, ''))) matches++;
    }
    if (matches > bestMatch.score && matches >= 3) bestMatch = { system, score: matches };
  }
  return bestMatch.system ? { system: bestMatch.system, confidence: bestMatch.score / Object.keys(EDC_FIELD_MAPPINGS[bestMatch.system]).length } : { system: null, confidence: 0 };
}

/**
 * 映射到标准字段
 */
function mapToStandardFields(headers, edcSystem) {
  if (!edcSystem) return { mapped: [], unmapped: headers };
  const mapping = EDC_FIELD_MAPPINGS[edcSystem] ?? {};
  const normalized = {};
  headers.forEach(h => { normalized[h.toLowerCase().replace(/[_\s]/g, '')] = h; });
  const mapped = [], unmapped = [];
  for (const [edcField, standardField] of Object.entries(mapping)) {
    const norm = edcField.toLowerCase().replace(/[_\s]/g, '');
    if (normalized[norm]) mapped.push({ original: normalized[norm], standard: standardField, edcSystem });
  }
  const mappedOriginals = new Set(mapped.map(m => m.original));
  headers.forEach(h => { if (!mappedOriginals.has(h)) unmapped.push(h); });
  return { mapped, unmapped };
}

/**
 * 验证 Output 模板规范
 */
function validateOutputTemplate(headers, templateType = 'listing') {
  const spec = OUTPUT_TEMPLATE_SPECS[templateType];
  if (!spec) return { valid: true, templateType, missing: [] };
  const headerNames = headers.sheets?.[0]?.headers ?? [];
  const headerLower = headerNames.map(h => h.toLowerCase());
  const missing = spec.required_columns.filter(col => !headerLower.includes(col.toLowerCase()));
  return {
    valid: missing.length === 0,
    templateType,
    requiredColumns: spec.required_columns,
    missingColumns: missing,
    complianceScore: spec.required_columns.length > 0 ? (spec.required_columns.length - missing.length) / spec.required_columns.length : 1.0,
  };
}

/**
 * 2026-08-25 重构 v2：
 * - interceptData 参数控制数据拦截
 * - 智能功能（表头提取、EDC识别、模板验证）始终生效
 */
export async function safeToolResult(exec, result, runtime, config, trustedToken, options = {}) {
  // 2026-08-25 P0：开关状态必须取自调用方传入的 options.interceptData（由
  // policy.isEnabled() 实时求值），不能读 config.dataInterceptionEnabled——
  // 后者是启动期快照，运行时切换开关后它仍是旧值，导致关闭开关后照样拦截。
  // 仅当调用方未传 interceptData 时才回退到 config 快照。
  const interceptData = typeof options.interceptData === 'boolean'
    ? options.interceptData
    : (config?.dataInterceptionEnabled ?? true);

  // 开关关闭 = 零限制：任何工具结果原样返回，不扫描、不投影、不占位，
  // 完全交给 harness 自主理解。
  if (!interceptData) {
    return { content: existingContent(result) };
  }
  const execName = String(exec?.name ?? '');

  // 1. Listing 工具（流程引导，始终生效）
  if (ALL_CLINICAL_LISTING_TOOLS.has(execName)) {
    if (CLINICAL_LISTING_TOOLS.has(execName)) {
      if (!containsTrustedListingReceipt(existingContent(result))) {
        return { content: await scrubUntrustedListingContent(existingContent(result), runtime, config?.hookTimeoutMs) };
      }
      return { content: markListingReceipt(existingContent(result), trustedToken) };
    }
    const projected = projectExecuteContent(existingContent(result));
    if (projected) return { content: projected };
    return { content: await scrubUntrustedListingContent(existingContent(result), runtime, config?.hookTimeoutMs) };
  }

  const path = extractPath(exec.arguments ?? {});
  const localPath = path && !isAbsolute(path) && config.workspaceRoot ? resolve(config.workspaceRoot, path) : path;
  const plane = planeOf(path, config);
  const ext = extname(path).toLowerCase();

  // 2. 凭据文件（始终阻断）
  if (isCredentialPath(path, config.credentialsDir)) {
    return contentOnly(result, JSON.stringify(credentialPlaceholder(path)));
  }

  // 3. 路径元数据（控制面信息）
  if (result?.meta?.shape === 'paths' && Array.isArray(result.meta.paths)) {
    return contentOnly(result, JSON.stringify({
      clinicalGuard: 'CONTROL_PATHS',
      trustedControlToken: trustedToken,
      paths: result.meta.paths.filter((p) => typeof p === 'string'),
      truncated: Boolean(result.meta.truncated),
      total: Number.isFinite(result.meta.total) ? result.meta.total : result.meta.paths.length,
      note: '仅返回路径控制信息；未读取或返回任何文件内容。',
    }));
  }

  // 4. 命令串中的数据来源
  const commandSource = !path && LOCAL_OUTPUT_TOOL_RE.test(execName) ? protectedSourceFromExec(exec, config) : undefined;
  if (commandSource) {
    return contentOnly(result, JSON.stringify(dataOnlyPlaceholder('', commandSource.toUpperCase() + '_OUTPUT')));
  }

  // 5. 数据查询工具
  if (DATA_QUERY_TOOL_RE.test(execName)) {
    return contentOnly(result, JSON.stringify(dataOnlyPlaceholder('', 'DATA_QUERY')));
  }

  // 6. 普通错误放行
  if (result?.isError) return { content: existingContent(result) };

  // 7. 文档/spec 域（始终放行）
  if (plane === 'spec' || plane === 'document') {
    return { content: existingContent(result).map((block) => block?.type === 'text' ? { ...block, clinicalGuard: 'TRUSTED_DOCUMENT_CONTENT', trustedDocumentToken: trustedToken } : block) };
  }

  // 8. 产物域（表格输出样式规范，始终生效）
  if (plane === 'output') {
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      if (!existsSync(localPath)) return contentOnly(result, JSON.stringify({ clinicalGuard: 'CHECK_FAILED', reason: '目标文件不存在' }));
      try {
        const headers = await runExtractor(localPath, config.maxScanRows ?? 20, extractorTimeoutMs(config));
        const templateValidation = validateOutputTemplate(headers);
        const edcRecognition = detectEDCSystem(headers);
        const fieldMapping = mapToStandardFields(headers.sheets?.[0]?.headers ?? [], edcRecognition.system);
        if (interceptData) {
          return contentOnly(result, JSON.stringify({ clinicalGuard: 'OUTPUT_STRUCTURE_VALIDATED', ...headers, templateValidation, edcRecognition, fieldMapping, note: '交付物结构已验证，数据内容已屏蔽' }));
        } else {
          return contentOnly(result, JSON.stringify({ clinicalGuard: 'OUTPUT_STRUCTURE', ...headers, templateValidation, edcRecognition, fieldMapping, note: '交付物结构信息' }));
        }
      } catch (error) {
        return contentOnly(result, JSON.stringify({ clinicalGuard: 'CHECK_FAILED', reason: '表头提取失败', detail: redactSensitiveText(error.message) }));
      }
    }
  }

  // 9. 数据域
  if (plane === 'data') {
    // SAS 数据
    if (['.sas7bdat', '.xpt', '.sas7bcat'].includes(ext)) {
      return interceptData
        ? contentOnly(result, JSON.stringify(dataOnlyPlaceholder(path, 'SAS_DATA')))
        : { content: existingContent(result) };  // 关闭：不拦截
    }

    // Excel/CSV
    if (['.xlsx', '.xlsm', '.xls', '.xlsb', '.csv'].includes(ext)) {
      if (!existsSync(localPath)) return contentOnly(result, JSON.stringify({ clinicalGuard: 'CHECK_FAILED', reason: '目标文件不存在' }));
      try {
        const headers = await runExtractor(localPath, config.maxScanRows ?? 20, extractorTimeoutMs(config));
        const edcRecognition = detectEDCSystem(headers);
        const fieldMapping = mapToStandardFields(headers.sheets?.[0]?.headers ?? [], edcRecognition.system);
        if (interceptData) {
          return contentOnly(result, JSON.stringify({ clinicalGuard: 'DATA_BLOCKED_STRUCTURED', file: basename(path), sheets: headers.sheets, edcRecognition, fieldMapping, note: '数据内容已屏蔽，表头和 EDC 字段已提取' }));
        } else {
          return contentOnly(result, JSON.stringify({ clinicalGuard: 'DATA_WITH_SMART_INFO', file: basename(path), sheets: headers.sheets, edcRecognition, fieldMapping, note: '数据内容和智能识别信息' }));
        }
      } catch (error) {
        return contentOnly(result, JSON.stringify({ clinicalGuard: 'CHECK_FAILED', reason: '表头提取失败', detail: redactSensitiveText(error.message) }));
      }
    }
  }

  // 10. zip 归档
  if (ext === '.zip') {
    return contentOnly(result, JSON.stringify(dataOnlyPlaceholder(path, 'ZIP_ARCHIVE')));
  }

  // 11. 其他原样放行
  return { content: existingContent(result) };
}

export function shouldReplaceResult() { return true; }
