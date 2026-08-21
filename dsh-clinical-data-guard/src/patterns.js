import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(readFileSync(join(here, '..', 'security', 'node_patterns.json'), 'utf8'));

export const dlpPatterns = source.map(({ source: pattern, flags = '', label }) => ({
  label,
  regex: new RegExp(pattern, flags),
}));

const safePatterns = [
  /^Day\s*\d+$/i,
  /^Week\s*\d+$/i,
  /^Cycle\s*\d+$/i,
  /^Visit\s*\d+$/i,
  /^Baseline$/i,
  /^Screening$/i,
];

// 真实缺陷修复：'标识+YYYYMMDD' 文档版本号（DVP20260610、SPEC20260610）不是
// 受试者编号。与 Python 两侧 is_document_version_number 同一纯格式判据（无关键词
// 豁免——关键词豁免是 ST-D-5 已知泄露通道）：尾部 8 位数字构成合法 YYYYMMDD
// （年 1900-2099、月 01-12、日 01-31）即认定为日期。
// 受试者编号不受影响：A1234567 只有 7 位数字，S0001234 的"0012"月份非法。
const YYYYMMDD_RE = /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

function isDocumentVersionNumber(matchedText) {
  const digits = String(matchedText ?? '').trim().replace(/^[A-Za-z]+/, '');
  return digits.length === 8 && YYYYMMDD_RE.test(digits);
}

// 操作性标识（文件路径/文件名）区间——agent 必须原样回传给工具的参数形态。
// 真实缺陷（2026-08-20 工作台实测）：read_file 参数里的路径含模式形态被拦/
// 被 token 化，模型拿假路径读文件直接 not found。用户规则：路径/文件名是
// 辅助读取的操作数据，三车道一律原样放行。与 Python patterns.py 同口径。
const OPERATIONAL_PATH_RES = [
  /[A-Za-z]:[\\/]+(?:[^\\/:*?"<>|\r\n\\/]+[\\/]+)*[^\\/:*?"<>|\r\n\\/]*/g,
  /(?:\\\\|\/\/)[^\\/:*?"<>|\r\n\\/]+(?:[\\/]+[^\\/:*?"<>|\r\n\\/]+)+/g,
  /(?<![\w.])(?:\/[\w.\-]+)+\/?/g,
  // 相对多段路径，必须以带扩展名文件名收尾（meta.paths 真实形态；
  // 收尾约束排除 "A1234567\\n" 类转义序列被误当路径造成数据值逃逸）
  /[\w\-. ]{1,64}(?:[\\\/][\w\-. ]{1,64}){1,}[\\\/]?[\w\-.]{1,120}\.[A-Za-z]\w{0,7}\b/g,
  /[\w\-. ]{1,64}[\\\/][\w\-.]{1,120}\.[A-Za-z]\w{0,7}\b/g,
];
const FILENAME_TOKEN_RE = /[\w\-. ]{0,118}[\w\-]\.[A-Za-z]\w{0,7}\b/g;

function operationalSpans(value) {
  const spans = [];
  for (const re of [...OPERATIONAL_PATH_RES, FILENAME_TOKEN_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(value)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  return spans;
}

export function scanDlp(text) {
  const value = String(text ?? '');
  const opSpans = operationalSpans(value);
  for (const { regex, label } of dlpPatterns) {
    const match = regex.exec(value);
    if (!match) continue;
    // ST-P1-6: 安全词豁免必须整体等于命中串，不能因命中串"包含"安全词子串就放行
    // （否则 USUBJID=SCREENING-01-123456 因含 Screening 被整体豁免泄露）。
    if (safePatterns.some((safe) => safe.test(match[0].trim()))) continue;
    // ALPHA_SUBJECT_ID 的文档版本号形态排除，与 Python 车道口径一致。
    if (label === 'ALPHA_SUBJECT_ID' && isDocumentVersionNumber(match[0])) continue;
    // 操作性标识（路径/文件名）区间内的命中不是临床数据
    const start = match.index;
    const end = start + match[0].length;
    if (opSpans.some(([a, b]) => a <= start && end <= b)) continue;
    return label;
  }
  return null;
}

export function redactSensitiveText(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    // FIX-3 (AR-2.9): 本地路径（Windows 盘符 / UNC / Unix 绝对路径）→ [PATH]
    .replace(/[A-Za-z]:\\[^\s"']*/g, '[PATH]')
    .replace(/\\\\[^\s"']+/g, '[PATH]')
    .replace(/(^|[\s"'(=])((?:\/[\w.-]+){2,})/g, '$1[PATH]')
    .replace(/\b[A-Za-z]{1,4}\d{6,8}\b/g, '[SUBJ]')
    .replace(/\b\d{3,4}-\d{3,6}\b/g, '[SUBJ]')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?\b/g, '[DATE]')
    .slice(0, 120);
}
