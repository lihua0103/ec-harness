/** 测试用最小合法 PDF 构造器：裸流/FlateDecode 内容、Type0 Identity-H + ToUnicode（bfchar/bfrange）、
 *  WinAnsi 字面串、加密桩。产出带 xref 的字节流，供 protocol.ts 抽取器验收。 */
import { deflateSync, zlibSync } from 'fflate';

export interface FixtureFont {
  name: string;
  /** Identity-H 字体：码→字符映射（经 ToUnicode bfchar 发出）。 */
  identity?: Record<number, string>;
  /** 1 字节字体配 bfrange：<lo> <hi> <dst> 单条范围映射。 */
  bfrange?: { lo: number; hi: number; dst: number };
  /** 故意不带 ToUnicode（测诚实降级）。 */
  noToUnicode?: boolean;
}

export interface FixtureItem {
  font?: string;
  text?: string;
  hexCodes?: number[];
  arrayTj?: boolean;
  newline?: boolean;
  /** TJ 数组中的 kerning 偏移。有 text2 时插在两段文本之间（测 kern→空格启发式），否则附在末尾。 */
  kern?: number;
  /** TJ 数组第二段文本（与 kern 搭配构成 [ (text) kern (text2) ]）。 */
  text2?: string;
}

export interface FixturePage { items: FixtureItem[]; }

export interface FixtureSpec {
  pages: FixturePage[];
  /** Arbitrary strings included in a content stream to guard binary marker handling. */
  streamLiterals?: string[];
  fonts?: FixtureFont[];
  flate?: boolean;
  /** flate 为 true 时改产裸 deflate（无 zlib 包裹），测解压兜底回退。 */
  rawFlate?: boolean;
  encrypt?: boolean;
  /** /Resources 放在 Pages 节点（测 parent 继承）。 */
  resourcesOnPages?: boolean;
  /** 把 Page 字典装进 /Type /ObjStm 压缩对象流（真实生产 PDF 的常见形态）。 */
  objectStream?: boolean;
  /** 故意让页树 /Count 与 /Kids 数量不一致，测完整性告警。 */
  pageCountOverride?: number;
}

const escapeLiteral = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function dstHex(char: string): string {
  let out = '';
  for (const unit of char) out += unit.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
  return out;
}

function cmapStream(font: FixtureFont): string {
  const lines = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CMapName /Test-UCS def', '/CMapType 2 def', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
  ];
  if (font.identity) {
    const entries = Object.entries(font.identity);
    lines.push(`${entries.length} beginbfchar`);
    for (const [code, char] of entries) lines.push(`<${Number(code).toString(16).padStart(4, '0')}> <${dstHex(char)}>`);
    lines.push('endbfchar');
  }
  if (font.bfrange) {
    const { lo, hi, dst } = font.bfrange;
    lines.push('1 beginbfrange', `<${lo.toString(16).padStart(4, '0')}> <${hi.toString(16).padStart(4, '0')}> <${dst.toString(16).padStart(4, '0')}>`, 'endbfrange');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}

function contentStream(page: FixturePage, fonts: FixtureFont[]): string {
  const lines: string[] = ['BT'];
  const firstFont = page.items[0]?.font ?? fonts[0]?.name;
  if (firstFont) lines.push(`/${firstFont} 12 Tf`);
  let currentFont = firstFont;
  for (const item of page.items) {
    const fname = item.font ?? currentFont;
    if (fname !== currentFont) { lines.push(`/${fname} 12 Tf`); currentFont = fname; }
    const isIdentity = fonts.some((f) => f.name === fname && f.identity);
    const width = isIdentity ? 4 : 2;
    const hex = (codes: number[]): string => `<${codes.map((c) => c.toString(16).padStart(width, '0')).join('')}>`;
    if (item.newline) lines.push('0 -18 Td');
    if (item.arrayTj) {
      const pieces: string[] = [];
      if (item.hexCodes) pieces.push(hex(item.hexCodes));
      if (item.text) pieces.push(`(${escapeLiteral(item.text)})`);
      if (item.text2 !== undefined) {
        if (item.kern !== undefined) pieces.push(String(item.kern));
        pieces.push(`(${escapeLiteral(item.text2)})`);
      } else if (item.kern !== undefined) pieces.push(String(item.kern));
      lines.push(`[${pieces.join(' ')}] TJ`);
    } else if (item.hexCodes) {
      lines.push(`${hex(item.hexCodes)} Tj`);
    } else {
      lines.push(`(${escapeLiteral(item.text ?? '')}) Tj`);
    }
  }
  lines.push('ET');
  return lines.join('\n');
}

/** 拼装完整 PDF 字节流（含 xref 偏移表与 trailer）。 */
export function makePdf(spec: FixtureSpec): Buffer {
  const fonts = spec.fonts ?? [];
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (buf: Buffer): void => { chunks.push(buf); pos += buf.length; };
  const emitObj = (num: number, dict: string, stream?: Uint8Array): void => {
    offsets[num] = pos;
    push(Buffer.from(`${num} 0 obj\n${dict}\n`, 'latin1'));
    if (stream) {
      push(Buffer.from('stream\n', 'latin1'));
      push(Buffer.from(stream));
      push(Buffer.from('\nendstream\n', 'latin1'));
    }
    push(Buffer.from('endobj\n', 'latin1'));
  };
  const streamBytes = (text: string): Uint8Array => spec.flate ? (spec.rawFlate ? deflateSync(new TextEncoder().encode(text)) : zlibSync(new TextEncoder().encode(text))) : new TextEncoder().encode(text);
  const streamDict = (len: number): string => `<< /Length ${len}${spec.flate ? ' /Filter /FlateDecode' : ''} >>`;

  push(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'));

  const pageNums = spec.pages.map((_, i) => 3 + i * 2);
  emitObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const fontEntries = fonts.map((f, i) => `/${f.name} ${100 + i * 2} 0 R`).join(' ');
  const resources = `<< /Font << ${fontEntries} >> >>`;
  const declaredPages = spec.pageCountOverride ?? spec.pages.length;
  emitObj(2, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${declaredPages}`
    + (spec.resourcesOnPages ? ` /Resources ${resources}` : '') + ' >>');
  const pageDicts = spec.pages.map((_, i) => {
    const num = pageNums[i];
    return `<< /Type /Page /Parent 2 0 R /Contents ${num + 1} 0 R`
      + (spec.resourcesOnPages ? '' : ` /Resources ${resources}`) + ' /MediaBox [0 0 612 792] >>';
  });
  if (spec.objectStream) {
    // 对象流：头是「对象号 字节偏移」对，偏移相对正文起点；/First 指向正文起点。
    let header = '';
    let running = 0;
    pageNums.forEach((num, i) => {
      header += `${num} ${running} `;
      running += Buffer.byteLength(pageDicts[i] + '\n', 'latin1');
    });
    header += ' ';
    const raw = Buffer.from(header + pageDicts.map((d) => d + '\n').join(''), 'latin1');
    const payload = spec.flate ? (spec.rawFlate ? deflateSync(new Uint8Array(raw)) : zlibSync(new Uint8Array(raw))) : new Uint8Array(raw);
    emitObj(900, `<< /Type /ObjStm /N ${pageNums.length} /First ${Buffer.byteLength(header, 'latin1')}`
      + (spec.flate ? ' /Filter /FlateDecode' : '') + ` /Length ${payload.length} >>`, payload);
  }
  spec.pages.forEach((page, i) => {
    const num = pageNums[i];
    if (!spec.objectStream) emitObj(num, pageDicts[i]);
    const content = contentStream(page, fonts) + (spec.streamLiterals?.length ? `\n(${escapeLiteral(spec.streamLiterals.join(' '))}) Tj` : '');
    const bytes = streamBytes(content);
    emitObj(num + 1, streamDict(bytes.length), bytes);
  });
  fonts.forEach((f, i) => {
    const fnum = 100 + i * 2;
    const cmapLen = (text: string): number => new TextEncoder().encode(text).length;
    if (f.identity) {
      const cmapNum = fnum + 1;
      emitObj(fnum, `<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H /DescendantFonts [${fnum + 2} 0 R] /ToUnicode ${cmapNum} 0 R >>`);
      emitObj(fnum + 2, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>');
      const cmap = cmapStream(f);
      emitObj(cmapNum, `<< /Length ${cmapLen(cmap)} >>`, new TextEncoder().encode(cmap));
    } else if (f.bfrange) {
      const cmapNum = fnum + 1;
      emitObj(fnum, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode ${cmapNum} 0 R >>`);
      const cmap = cmapStream(f);
      emitObj(cmapNum, `<< /Length ${cmapLen(cmap)} >>`, new TextEncoder().encode(cmap));
    } else {
      emitObj(fnum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    }
  });
  if (spec.encrypt) {
    emitObj(500, '<< /Filter /Standard /V 1 /R 2 /O <0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF> /U <FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210> /P -3904 >>');
  }
  const size = Math.max(...Object.keys(offsets).map(Number)) + 1;
  push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n`, 'latin1'));
  for (let i = 1; i < size; i++) push(Buffer.from(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`, 'latin1'));
  const encRef = spec.encrypt ? ' /Encrypt 500 0 R' : '';
  push(Buffer.from(`trailer\n<< /Size ${size} /Root 1 0 R${encRef} >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}
