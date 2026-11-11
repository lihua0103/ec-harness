/** 方案 PDF 文本层抽取（语言随项目，CN/EN 同路）。
 *  本地无 PDF 库：结构扫描 + fflate inflate 手写实现。范围声明：
 *  - 只读文本层（Tj/TJ/'/" 与 Td/TD/T*、ET 换行；TJ 数组内大负 kern 记词间空格）；表格、图表、布局信息不在返回内，需人工看原件。
 *  - 扫描件（无文本层）→ NEEDS_OCR，本工具不做 OCR，不猜内容。
 *  - 加密 PDF 拒绝（ENCRYPTED_PDF_UNSUPPORTED），不尝试绕过。
 *  - 缺 ToUnicode 的字体：ASCII 兜底，其余 U+FFFD 占位并计数（ENCODING_FIDELITY）。 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inflateSync, unzlibSync } from 'fflate';
import { DvpError } from './parse.js';
import { decodeCodes, makeFont, parseCMap, type FontEncoding } from './pdf-fonts.js';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 2000;
const MAX_PAGE_CHARS = 80_000;
const MAX_TOTAL_CHARS = 600_000;
const NAME_DELIMS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const SKIP = new Set([' ', '\t', '\r', '\n', '\f', '\0']);

interface PdfObj { dict: string; stream: Uint8Array | null; }

export interface ExtractStats {
  pages: number; extractedPages: number; textChars: number;
  fontsWithoutToUnicode: string[]; inflateFailures: number; unmappedGlyphs: number; truncatedPages: number;
  /** Compressed object streams found in the file and objects successfully unpacked from them. */
  objectStreams: number; objectStreamObjects: number; objectStreamFailures: number;
  /** Page-tree count declared in the PDF vs. pages actually reachable through the tree. */
  declaredPages: number | null;
  /** Pages whose /Contents references are absent or not parseable. */
  pagesWithoutContent: number; pagesWithMissingContent: number;
}

export interface ProtocolPage { page: number; chars: number; text: string; }
export interface ProtocolResult {
  file: string; sha256: string;
  pages: ProtocolPage[]; skippedPages: number;
  stats: ExtractStats; diagnostics: string[]; notices: string[];
}

const NOTICES = [
  'TEXT_LAYER_ONLY：仅返回文本层；方案中的表格、图表与版式信息不在其中，涉及视觉内容请人工查看原件复核。',
  'CANDIDATE：抽取文本仅供 DM 分析参考，不是已验证的方案结构化数据。',
];

function locate(directory: string, protocolPath: string): string {
  let base: string;
  try { base = realpathSync(directory); } catch { throw new DvpError('PROTOCOL_DIRECTORY_NOT_FOUND', directory); }
  const target = path.resolve(base, protocolPath);
  if (target !== base && !target.startsWith(base + path.sep)) throw new DvpError('PROTOCOL_OUTSIDE_DIRECTORY', target);
  if (!/\.pdf$/i.test(target)) throw new DvpError('PROTOCOL_NOT_PDF', target);
  let stat;
  try { stat = statSync(target); } catch { throw new DvpError('PROTOCOL_NOT_FOUND', target); }
  if (stat.size > MAX_FILE_BYTES) throw new DvpError('PROTOCOL_TOO_LARGE', `${stat.size} > ${MAX_FILE_BYTES}`);
  return target;
}

function objectBoundary(text: string, start: number): { kind: 'stream' | 'endobj'; start: number; end: number } | null {
  let i = start;
  while (i < text.length) {
    if (SKIP.has(text[i])) { i++; continue; }
    if (text[i] === '%') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (text[i] === '(') {
      let depth = 1;
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      }
      continue;
    }
    if (text[i] === '<' && text[i + 1] !== '<') {
      const end = text.indexOf('>', i + 1);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (text[i] === '/') {
      i++;
      while (i < text.length && !SKIP.has(text[i]) && !NAME_DELIMS.has(text[i])) i++;
      continue;
    }
    if (NAME_DELIMS.has(text[i])) { i++; continue; }
    const tokenStart = i;
    while (i < text.length && !SKIP.has(text[i]) && !NAME_DELIMS.has(text[i])) i++;
    const word = text.slice(tokenStart, i);
    if (word === 'endobj') return { kind: 'endobj', start: tokenStart, end: i };
    if (word === 'stream') {
      const eol = /^(?:\r\n|\n|\r)/.exec(text.slice(i));
      if (eol) return { kind: 'stream', start: tokenStart, end: i + eol[0].length };
    }
  }
  return null;
}

function scanObjects(text: string): { objects: Map<number, PdfObj>; count: number; failures: number } {
  const objects = new Map<number, PdfObj>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let failures = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1]);
    if (objects.has(num)) continue;
    const bodyStart = m.index + m[0].length;
    const boundary = objectBoundary(text, bodyStart);
    if (!boundary) { failures++; break; }
    if (boundary.kind === 'endobj') {
      objects.set(num, { dict: text.slice(bodyStart, boundary.start), stream: null });
      re.lastIndex = boundary.end;
      continue;
    }

    const streamMarker = boundary.start;
    const dict = text.slice(bodyStart, streamMarker);
    const lengthMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)\b/);
    if (!lengthMatch) {
      // Without a direct /Length, binary stream terminators are ambiguous (their text
      // can occur in payload bytes). Stop rather than treating payload as PDF syntax.
      failures++;
      break;
    }
    const length = Number(lengthMatch[1]);
    const payloadStart = boundary.end;
    const payloadEnd = payloadStart + length;
    if (!Number.isSafeInteger(length) || payloadEnd > text.length) { failures++; break; }
    let afterPayload = payloadEnd;
    if (text[afterPayload] === '\r' && text[afterPayload + 1] === '\n') afterPayload += 2;
    else if (text[afterPayload] === '\n' || text[afterPayload] === '\r') afterPayload++;
    const endstream = /^endstream\b/.exec(text.slice(afterPayload));
    if (!endstream) { failures++; break; }
    const endobjBoundary = objectBoundary(text, afterPayload + endstream[0].length);
    if (!endobjBoundary || endobjBoundary.kind !== 'endobj') { failures++; break; }
    const raw = Buffer.from(text.slice(payloadStart, payloadEnd), 'latin1');
    objects.set(num, { dict, stream: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) });
    re.lastIndex = endobjBoundary.end;
  }
  return { objects, count: objects.size, failures };
}

function inflateObj(obj: PdfObj, stats: ExtractStats): Uint8Array | null {
  if (!obj.stream) return null;
  if (!/FlateDecode/.test(obj.dict)) return obj.stream;
  // PDF 的 FlateDecode 是 zlib 包裹（0x78 头）；少数生产者写裸 deflate，兜底回退。
  try { return unzlibSync(obj.stream); } catch { /* fall through to raw deflate */ }
  try { return inflateSync(obj.stream); } catch { stats.inflateFailures++; return obj.stream; }
}

/** 展开 ObjStm（对象流）：真实 PDF 常把页/字体对象装进压缩对象流。
 *  每个 /N 对是「对象号 偏移」，不是「偏移 偏移」——早期实现把偏移误当对象号，
 *  展开后的页对象全部不可达，生产形态 PDF 会静默丢页。 */
function expandObjectStreams(objects: Map<number, PdfObj>, stats: ExtractStats): void {
  for (const [, obj] of [...objects]) {
    if (!/\/Type\s*\/ObjStm\b/.test(obj.dict)) continue;
    stats.objectStreams++;
    const data = inflateObj(obj, stats);
    if (!data) { stats.objectStreamFailures++; continue; }
    const head = Buffer.from(obj.dict, 'latin1');
    const nMatch = obj.dict.match(/\/N\s+(\d+)/);
    const firstMatch = obj.dict.match(/\/First\s+(\d+)/);
    if (!nMatch || !firstMatch) { stats.objectStreamFailures++; continue; }
    const count = Number(nMatch[1]);
    const first = Number(firstMatch[1]);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(first) || first < 0) {
      stats.objectStreamFailures++;
      continue;
    }
    const text = Buffer.concat([head, Buffer.from(data)]).toString('latin1');
    const bodyStart = head.length;
    if (bodyStart + first > text.length) { stats.objectStreamFailures++; continue; }
    const header = text.slice(bodyStart, bodyStart + first);
    const pairs = [...header.matchAll(/(\d+)\s+(\d+)/g)].slice(0, count);
    if (pairs.length !== count) stats.objectStreamFailures++;
    const base = bodyStart + first;
    pairs.forEach((pair, i) => {
      const objNum = Number(pair[1]);
      const start = base + Number(pair[2]);
      const stop = i + 1 < pairs.length ? base + Number(pairs[i + 1][2]) : text.length;
      if (!Number.isSafeInteger(objNum) || objNum < 1 || start < base || start > stop || stop > text.length) {
        stats.objectStreamFailures++;
        return;
      }
      if (!objects.has(objNum)) {
        objects.set(objNum, { dict: text.slice(start, stop), stream: null });
        stats.objectStreamObjects++;
      }
    });
  }
}

function refsIn(fragment: string): number[] {
  return [...fragment.matchAll(/(\d+)\s+\d+\s+R/g)].map((r) => Number(r[1]));
}

function balancedDict(text: string, openIdx: number): string {
  const start = text.indexOf('<<', openIdx);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i + 1 < text.length; i++) {
    if (text[i] === '<' && text[i + 1] === '<') { depth++; i++; }
    else if (text[i] === '>' && text[i + 1] === '>') { depth--; i++; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

function pageOrder(objects: Map<number, PdfObj>): { order: number[]; missing: number[] } {
  const catalog = [...objects.entries()].find(([, o]) => /\/Type\s*\/Catalog\b/.test(o.dict));
  if (!catalog) return { order: [], missing: [] };
  const pagesRef = catalog[1].dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
  if (!pagesRef) return { order: [], missing: [] };
  const order: number[] = [];
  const missing: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth: number): void => {
    if (seen.has(num) || depth > 64) return;
    seen.add(num);
    const obj = objects.get(num);
    if (!obj) { missing.push(num); return; }
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      const kids = obj.dict.match(/\/Kids\s*\[([^\]]*)\]/);
      if (kids) refsIn(kids[1]).forEach((kid) => walk(kid, depth + 1));
    } else if (/\/Type\s*\/Page\b/.test(obj.dict)) order.push(num);
  };
  walk(Number(pagesRef[1]), 0);
  return { order, missing };
}

/** 页树根节点声明的总页数；用于发现“只解析出部分页”的静默缺失。 */
function declaredPageCount(objects: Map<number, PdfObj>): number | null {
  const catalog = [...objects.entries()].find(([, o]) => /\/Type\s*\/Catalog\b/.test(o.dict));
  if (!catalog) return null;
  const pagesRef = catalog[1].dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
  if (!pagesRef) return null;
  const root = objects.get(Number(pagesRef[1]));
  const count = root?.dict.match(/\/Count\s+(\d+)/);
  return count ? Number(count[1]) : null;
}

/** 页面 /Contents 引用；返回为空或部分对象缺失时，文本抽取结果可能静默为空。 */
function contentRefs(pageNum: number, objects: Map<number, PdfObj>): number[] {
  const obj = objects.get(pageNum);
  if (!obj) return [];
  const arr = obj.dict.match(/\/Contents\s*\[([^\]]*)\]/);
  if (arr) return refsIn(arr[1]);
  const single = obj.dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
  return single ? [Number(single[1])] : [];
}

function resourcesFor(pageNum: number, objects: Map<number, PdfObj>): string {
  let num: number | undefined = pageNum;
  for (let depth = 0; num !== undefined && depth < 32; depth++) {
    const obj = objects.get(num);
    if (!obj) return '';
    const resRef = obj.dict.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
    if (resRef) {
      const resObj = objects.get(Number(resRef[1]));
      return resObj ? balancedDict(resObj.dict, 0) : '';
    }
    if (/\/Resources\s*<</.test(obj.dict)) return balancedDict(obj.dict, obj.dict.indexOf('/Resources'));
    const parent = obj.dict.match(/\/Parent\s+(\d+)\s+\d+\s+R/);
    num = parent ? Number(parent[1]) : undefined;
  }
  return '';
}

function buildFonts(objects: Map<number, PdfObj>, stats: ExtractStats): Map<number, FontEncoding> {
  const fonts = new Map<number, FontEncoding>();
  for (const [num, obj] of objects) {
    if (!/\/Type\s*\/Font\b|\/Subtype\s*\/(Type0|TrueType|Type1|Type3)\b/.test(obj.dict)) continue;
    if (/\/Subtype\s*\/CIDFont/.test(obj.dict)) continue; // DescendantFonts 成员不独立计数
    let encoding = obj.dict.match(/\/Encoding\s*\/([A-Za-z0-9-]+)/)?.[1];
    const encRef = obj.dict.match(/\/Encoding\s+(\d+)\s+\d+\s+R/);
    if (!encoding && encRef) encoding = objects.get(Number(encRef[1]))?.dict.match(/\/BaseEncoding\s*\/([A-Za-z0-9-]+)/)?.[1];
    const uniRef = obj.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    let toUnicode: Map<number, string> | null = null;
    if (uniRef) {
      const uniObj = objects.get(Number(uniRef[1]));
      if (uniObj) {
        const data = inflateObj(uniObj, stats);
        if (data) toUnicode = parseCMap(Buffer.from(data).toString('utf8'));
      }
    }
    if (!toUnicode) stats.fontsWithoutToUnicode.push(`obj${num}`);
    fonts.set(num, makeFont(encoding ?? 'Standard', toUnicode));
  }
  return fonts;
}

function pageFontMap(pageNum: number, objects: Map<number, PdfObj>, fonts: Map<number, FontEncoding>): Map<string, FontEncoding | null> {
  const map = new Map<string, FontEncoding | null>();
  const resDict = resourcesFor(pageNum, objects);
  const fontRef = resDict.match(/\/Font\s+(\d+)\s+\d+\s+R/);
  let fontDict = '';
  if (fontRef) {
    const fo = objects.get(Number(fontRef[1]));
    if (fo) fontDict = balancedDict(fo.dict, 0);
  } else if (/\/Font\s*<</.test(resDict)) {
    fontDict = balancedDict(resDict, resDict.indexOf('/Font'));
  }
  for (const m of fontDict.matchAll(/\/([A-Za-z0-9.#_+-]+)\s+(\d+)\s+\d+\s+R/g)) {
    map.set(m[1], fonts.get(Number(m[2])) ?? null);
  }
  return map;
}

function contentTexts(pageNum: number, objects: Map<number, PdfObj>, stats: ExtractStats): string[] {
  const nums = contentRefs(pageNum, objects);
  if (nums.length === 0) { stats.pagesWithoutContent++; return []; }
  if (nums.some((num) => !objects.get(num))) stats.pagesWithMissingContent++;
  const out: string[] = [];
  for (const num of nums) {
    const cObj = objects.get(num);
    if (!cObj) continue;
    const data = inflateObj(cObj, stats);
    if (data) out.push(Buffer.from(data).toString('latin1'));
  }
  return out;
}

const ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };

/** TJ 数组内大负 kern 阈值（千分之一 em 单位）：位移 ≤ 此值记一个词间空格。
 *  多数生产者省略空格字形、用 kern 位移表达词距；更小的位移是正常字偶距，不触发。 */
const KERN_SPACE = -120;

/** 内容流 → 页面文本。字符串按段累积（kern 词距处切段），到 show 算子统一按当前字体解码。 */
function extractPageText(content: string, pageFonts: Map<string, FontEncoding | null>, stats: ExtractStats): string {
  let font: FontEncoding | null = null;
  let lastName = '';
  let parts: { spaceBefore: boolean; bytes: number[] }[] = [];
  let arrayDepth = 0;
  let out = '';
  const pushByte = (b: number): void => {
    if (parts.length === 0) parts.push({ spaceBefore: false, bytes: [] });
    parts[parts.length - 1].bytes.push(b);
  };
  const queueSpace = (): void => {
    const last = parts[parts.length - 1];
    if (last && last.spaceBefore && last.bytes.length === 0) return;
    parts.push({ spaceBefore: true, bytes: [] });
  };
  const flush = (prefix: string): void => {
    let text = '';
    for (const part of parts) {
      if (part.bytes.length === 0) continue;
      const decoded = decodeCodes(font, Uint8Array.from(part.bytes));
      if (part.spaceBefore && text.length > 0) text += ' ';
      text += decoded.text;
      stats.unmappedGlyphs += decoded.unmapped;
    }
    parts = [];
    out += prefix + text;
  };
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (SKIP.has(ch)) { i++; continue; }
    if (ch === '(') {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const c = content[i];
        if (c === '\\') {
          const next = content[i + 1];
          if (next === undefined) break;
          if (next >= '0' && next <= '7') {
            let oct = '';
            let j = i + 1;
            while (j < n && oct.length < 3 && content[j] >= '0' && content[j] <= '7') { oct += content[j]; j++; }
            pushByte(parseInt(oct, 8) & 0xff);
            i = j;
            continue;
          }
          if (next === '\n') { i += 2; continue; }
          if (next === '\r') { i += 2; if (content[i] === '\n') i++; continue; }
          pushByte(ESCAPES[next] ?? (next.charCodeAt(0) & 0xff));
          i += 2;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
        pushByte(content.charCodeAt(i) & 0xff);
        i++;
      }
      continue;
    }
    if (ch === '<') {
      if (content[i + 1] === '<') {
        const end = content.indexOf('>>', i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      const end = content.indexOf('>', i + 1);
      if (end === -1) break;
      let hex = content.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
      if (hex.length % 2 === 1) hex += '0';
      for (let k = 0; k + 1 < hex.length + 1; k += 2) {
        if (k + 2 > hex.length) break;
        pushByte(parseInt(hex.slice(k, k + 2), 16));
      }
      i = end + 1;
      continue;
    }
    if (ch === '[') { arrayDepth++; i++; continue; }
    if (ch === ']') { if (arrayDepth > 0) arrayDepth--; i++; continue; }
    if (ch === '/') {
      i++;
      let name = '';
      while (i < n && !SKIP.has(content[i]) && !NAME_DELIMS.has(content[i])) { name += content[i]; i++; }
      lastName = name;
      continue;
    }
    let word = '';
    while (i < n && !SKIP.has(content[i]) && !NAME_DELIMS.has(content[i])) { word += content[i]; i++; }
    if (!word) { i++; continue; }
    if (word === 'Tj' || word === 'TJ') flush('');
    else if (word === "'" || word === '"') flush('\n');
    else if (word === 'Td' || word === 'TD' || word === 'T*' || word === 'ET') {
      out += '\n';
      const last = parts[parts.length - 1];
      if (last && last.spaceBefore && last.bytes.length === 0) parts.pop(); // 换行作废排队空格
    }
    else if (word === 'Tf') font = pageFonts.get(lastName) ?? null;
    else if (arrayDepth > 0 && /^-?\d+(\.\d+)?$/.test(word) && parseFloat(word) <= KERN_SPACE) queueSpace();
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** 工具入口：读取方案 PDF 文本层。window = 1-based 闭区间 [startPage, endPage]。 */
export function readProtocol(directory: string, protocolPath: string, window?: { startPage?: number; endPage?: number }): ProtocolResult {
  const target = locate(directory, protocolPath);
  const buf = readFileSync(target);
  if (!buf.subarray(0, 1024).includes('%PDF-')) throw new DvpError('PROTOCOL_NOT_PDF', target);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const text = buf.toString('latin1');
  if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(text)) throw new DvpError('ENCRYPTED_PDF_UNSUPPORTED', target);

  const stats: ExtractStats = {
    pages: 0, extractedPages: 0, textChars: 0,
    fontsWithoutToUnicode: [], inflateFailures: 0, unmappedGlyphs: 0, truncatedPages: 0,
    objectStreams: 0, objectStreamObjects: 0, objectStreamFailures: 0,
    declaredPages: null, pagesWithoutContent: 0, pagesWithMissingContent: 0,
  };
  const { objects, count, failures: objectScanFailures } = scanObjects(text);
  if (count === 0 && objectScanFailures > 0) throw new DvpError('PDF_STRUCTURE_UNREADABLE', 'stream boundary could not be verified from /Length');
  if (count === 0) throw new DvpError('PDF_STRUCTURE_UNREADABLE', 'no indirect objects found');
  expandObjectStreams(objects, stats);

  const diagnostics: string[] = [];
  const tree = pageOrder(objects);
  let order = tree.order;
  const usedTree = order.length > 0;
  if (!usedTree) {
    order = [...objects.entries()].filter(([, o]) => /\/Type\s*\/Page\b/.test(o.dict)).map(([n]) => n);
    diagnostics.push('PAGE_TREE_FALLBACK:未找到 Catalog/Pages 页树，按对象出现顺序取页');
  }
  if (order.length === 0) throw new DvpError('PDF_STRUCTURE_UNREADABLE', 'no page objects found');
  stats.declaredPages = declaredPageCount(objects);
  if (tree.missing.length) {
    diagnostics.push(`PAGE_OBJECT_MISSING:${tree.missing.slice(0, 50).join(',')}${tree.missing.length > 50 ? `(+${tree.missing.length - 50})` : ''}`);
  }
  if (stats.declaredPages !== null && stats.declaredPages !== order.length) {
    diagnostics.push(`PAGE_TREE_INCOMPLETE:declared_${stats.declaredPages}_parsed_${order.length}`);
  }
  if (objectScanFailures > 0) {
    diagnostics.push(`OBJECT_SCAN_INCOMPLETE:${objectScanFailures}`);
  }
  if (order.length > MAX_PAGES) { diagnostics.push(`PAGE_CAP_EXCEEDED:${order.length}>${MAX_PAGES}`); order = order.slice(0, MAX_PAGES); }
  stats.pages = order.length;

  const fonts = buildFonts(objects, stats);
  let startPage = 1;
  let endPage = order.length;
  if (window?.startPage !== undefined || window?.endPage !== undefined) {
    startPage = window.startPage ?? 1;
    endPage = window.endPage ?? order.length;
    if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage || endPage > order.length) {
      throw new DvpError('PAGE_WINDOW_INVALID', `pages=1..${order.length}`);
    }
  }

  const pages: ProtocolPage[] = [];
  let skipped = 0;
  for (let idx = startPage - 1; idx < endPage; idx++) {
    if (stats.textChars >= MAX_TOTAL_CHARS) { skipped = endPage - idx; break; }
    const num = order[idx];
    const pageFonts = pageFontMap(num, objects, fonts);
    const content = contentTexts(num, objects, stats).join('');
    let body = extractPageText(content, pageFonts, stats);
    if (body.length > MAX_PAGE_CHARS) { body = body.slice(0, MAX_PAGE_CHARS); stats.truncatedPages++; }
    stats.extractedPages++;
    stats.textChars += body.length;
    pages.push({ page: idx + 1, chars: body.length, text: body });
  }

  if (stats.fontsWithoutToUnicode.length) diagnostics.push(`FONT_WITHOUT_TOUNICODE:${stats.fontsWithoutToUnicode.join(',')}`);
  if (stats.inflateFailures > 0) diagnostics.push(`INFLATE_FAILED:${stats.inflateFailures}`);
  if (stats.truncatedPages > 0) diagnostics.push(`PAGE_TEXT_TRUNCATED:${stats.truncatedPages}`);
  if (stats.pagesWithoutContent > 0) diagnostics.push(`PAGE_CONTENT_MISSING:${stats.pagesWithoutContent}`);
  if (stats.pagesWithMissingContent > 0) diagnostics.push(`PAGE_CONTENT_UNRESOLVED:${stats.pagesWithMissingContent}`);
  if (skipped > 0) diagnostics.push(`TOTAL_TEXT_TRUNCATED:${skipped}_pages_skipped`);
  const hasText = pages.some((p) => p.text.length > 0);
  if (!hasText) diagnostics.push('NO_TEXT_LAYER');
  const notices = [...NOTICES];
  if (!hasText) notices.push('NEEDS_OCR：未检出文本层，疑似扫描件。本工具不做 OCR——请走公司认可的 OCR 流程或人工录入，不得凭页面图像猜测内容。');
  if (stats.declaredPages !== null && stats.declaredPages !== order.length) {
    notices.push(`PAGE_COVERAGE_INCOMPLETE：页树声明 ${stats.declaredPages} 页，实际解析出 ${order.length} 页（对象缺失或对象流不完整）。抽取文本可能不完整，必须核对原件页数与目录，不能把缺失页当作“方案没有该内容”。`);
  }
  if (stats.objectStreamFailures > 0) {
    notices.push('OBJECT_STREAM_INCOMPLETE：压缩对象流未能完整展开，部分页或字体可能缺失；关键页请人工核对原件。');
  }
  if (stats.fontsWithoutToUnicode.length > 0 || stats.inflateFailures > 0) {
    notices.push('ENCODING_FIDELITY：存在缺 ToUnicode 字体或流解压失败，相应字符以 U+FFFD 占位并计数，文本可能不完整，关键段落请人工核对原件。');
  }
  return { file: path.basename(target), sha256, pages, skippedPages: skipped, stats, diagnostics, notices };
}
