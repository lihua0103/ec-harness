import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDlp, redactSensitiveText } from './patterns.js';

const here = dirname(fileURLToPath(import.meta.url));
const extractor = join(here, '..', 'excel_header_extractor.py');

// FIX-8 (NFR-12): extractor 超时可配置，默认 10s，硬上限 30s；SIGTERM → 2s → SIGKILL。
const EXTRACTOR_TIMEOUT_DEFAULT_MS = 10_000;
const EXTRACTOR_TIMEOUT_MAX_MS = 30_000;
const EXTRACTOR_GRACE_MS = 2_000;

function dirname(path) {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
}

function join(...parts) {
  return parts.join('/').replace(/\\/g, '/');
}

export function extractPath(args = {}) {
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/**
 * 本地凭据通道 (用户需求)：判断 filePath 是否位于配置的 credentialsDir 之内。
 * 用解析后的绝对路径前缀判断（防 ../ 穿越），不靠文件名/内容形态（后者是
 * ST-D-5 泄露通道）。credentialsDir 未配置时恒为 false（凭据通道默认关闭）。
 */
export function isCredentialPath(filePath, credentialsDir) {
  if (!credentialsDir || typeof filePath !== 'string' || !filePath.trim()) return false;
  const base = resolve(credentialsDir);
  const target = resolve(filePath);
  const rel = relative(base, target);
  // rel 不以 .. 开头且非绝对路径 → target 在 base 之内。
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 凭据占位：agent 上下文只得到"这是本地凭据、原值在此路径、只允许交本地工具"，
 * 凭据原值绝不进入 LLM 上下文。本地解压工具用路径自行在本地读取原值。
 */
function credentialPlaceholder(path) {
  return {
    clinicalGuard: 'CREDENTIAL_LOCAL_ONLY',
    credentialPath: path,
    message: '本地凭据文件：原值仅供本地工具（如解压）使用，已阻止其进入模型上下文。',
  };
}

function extractorTimeoutMs(config) {
  const raw = Number(config?.extractorTimeoutMs);
  if (!Number.isFinite(raw) || raw <= 0) return EXTRACTOR_TIMEOUT_DEFAULT_MS;
  return Math.min(raw, EXTRACTOR_TIMEOUT_MAX_MS);
}

function runExtractor(path, maxRows, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [
      extractor,
      path,
      '--max-scan-rows',
      String(maxRows),
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: (() => { const e = {}; for (const k of ['PATH','SystemRoot','USERPROFILE','HOME','TEMP','TMP','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH','LD_LIBRARY_PATH','DYLD_LIBRARY_PATH']) { if (process.env[k] !== undefined) e[k] = process.env[k]; } e.PYTHONIOENCODING = 'utf-8'; e.PYTHONUTF8 = '1'; if (process.env.EMERALD_AUDIT_ROOT) e.EMERALD_AUDIT_ROOT = process.env.EMERALD_AUDIT_ROOT; return e; })() });
    let out = '';
    let err = '';
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
        // FIX-3 (AR-2.9): extractor stderr 已在 Python 侧脱敏，此处再做路径/受试者兜底脱敏。
        reject(new Error(redactSensitiveText(err.trim()) || `excel extractor exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (error) {
        reject(new Error(redactSensitiveText(`invalid excel extractor response: ${error.message}`)));
      }
    });
  });
}

function dataOnlyPlaceholder(path, kind) {
  return {
    clinicalGuard: 'DATA_BLOCKED',
    kind,
    file: redactSensitiveText(basename(path)),
    message: '临床数据行内容已屏蔽；仅允许本地处理，禁止发送给模型。',
  };
}

/**
 * FIX-1 (R-8 / FR-07-02 / BR-03.4 / BY-13 / TC-20):
 * 不再按工具名是否包含 `read` 放行。所有工具结果都必须进入安全处置：
 * 无路径 → scrub_text；危险扩展名 → 占位；Excel 类 → 表头提取；
 * 带路径但扩展名未识别 → 同样强制 scrub_text。
 */
export function shouldReplaceResult() {
  return true;
}

function textContent(text) {
  return [{ type: 'text', text }];
}

function contentOnly(result, text) {
  return { content: textContent(text) };
}

function existingContent(result) {
  return Array.isArray(result?.content) ? result.content : [];
}

/**
 * FIX-13: post-execute 的 `value` 会按工具自身 output.schema 重新校验。
 * 临床守卫无法为 glob/pwsh/read 等任意工具构造同 schema 的通用占位值，
 * 因此安全边界应替换模型可见的 `content`，保留 canonical value 供宿主
 * 完成它自己的 schema/类型契约。这样既不把原始内容交给模型，也不会把
 * 字符串占位错误地塞进对象、数组或 oneOf 输出 schema。
 */
function blockedContent(reason) {
  return contentOnly(null, JSON.stringify({
    clinicalGuard: 'BLOCKED',
    reason,
  }));
}

/**
 * FIX-1/FIX-13: all tool results are inspected, but only the model-facing
 * content projection is replaced. The DSH tool runtime revalidates a replaced
 * `value` against the originating tool schema; a generic string replacement
 * would therefore break object/array/oneOf tools (glob, pwsh, read, get_goal,
 * job_list, etc.).
 */
export async function safeToolResult(exec, result, runtime, config) {
  const path = extractPath(exec.arguments ?? {});
  const ext = extname(path).toLowerCase();

  // A failed result has no canonical value. It may still have model-facing error
  // content, which can be scrubbed safely through the same content-only path.
  // Do not attempt a value replacement: DSH rejects that by contract.
  if (result?.isError) {
    const payload = result?.content ?? result;
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload) ?? String(payload);
    const scrub = await runtime.request({ operation: 'scrub_text', text: serialized });
    if (!scrub.ok) return blockedContent('工具结果安全脱敏失败。');
    if (scrub.needs_user) {
      return {
        needsApproval: true,
        userPrompt: scrub.user_prompt,
        scrubbedContent: textContent(`已自动脱敏 ${scrub.scrubbed_rows} 行疑似数据\n${scrub.text}`),
        originalContent: existingContent(result),
      };
    }
    if (scrub.scrubbed_rows === 0) return { content: existingContent(result) };
    return contentOnly(result, `已自动脱敏 ${scrub.scrubbed_rows} 行疑似数据\n${scrub.text}`);
  }

  // 本地凭据通道：原值绝不进入模型上下文，只展示非敏感占位。
  if (isCredentialPath(path, config.credentialsDir)) {
    return contentOnly(result, JSON.stringify(credentialPlaceholder(path)));
  }

  if (ext === '.sas7bdat') {
    return contentOnly(result, JSON.stringify(dataOnlyPlaceholder(path, 'SAS_DATA')));
  }
  if (ext === '.zip') {
    return contentOnly(result, JSON.stringify(dataOnlyPlaceholder(path, 'ZIP_MAYBE_DATA')));
  }

  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    if (!existsSync(path)) {
      return contentOnly(result, JSON.stringify({
        clinicalGuard: 'CHECK_FAILED',
        reason: '目标文件不存在，无法验证内容。',
      }));
    }
    try {
      const headers = await runExtractor(path, config.maxScanRows, extractorTimeoutMs(config));
      return contentOnly(result, JSON.stringify({ clinicalGuard: 'EXCEL_HEADERS_ONLY', ...headers }));
    } catch (error) {
      return contentOnly(result, JSON.stringify({
        clinicalGuard: 'CHECK_FAILED',
        reason: '表头安全提取失败，结果已 fail-closed。',
        detail: redactSensitiveText(error.message),
      }));
    }
  }

  // 无路径 / 带路径但扩展名未识别：强制检查并只替换 content。
  const payload = result?.value ?? result?.content ?? result;
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload) ?? String(payload);
  const scrub = await runtime.request({ operation: 'scrub_text', text: serialized });
  if (!scrub.ok) return blockedContent('工具结果安全脱敏失败。');
  if (scrub.needs_user) {
    return {
      needsApproval: true,
      userPrompt: scrub.user_prompt,
      scrubbedContent: textContent(`已自动脱敏 ${scrub.scrubbed_rows} 行疑似数据\n${scrub.text}`),
      originalContent: existingContent(result),
    };
  }
  // Keep the tool-owned renderer/UI card when scanning made no change.
  if (scrub.scrubbed_rows === 0) return { content: existingContent(result) };
  return contentOnly(result, `已自动脱敏 ${scrub.scrubbed_rows} 行疑似数据\n${scrub.text}`);
}
