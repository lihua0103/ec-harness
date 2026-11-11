/** PDF 字体层：ToUnicode CMap 解析与字符码→Unicode 映射。
 *  能力声明（诚实降级）：支持 bfchar/bfrange（3 元素与数组形式）；Identity-H/UCS2 按 2 字节码；
 *  无 ToUnicode 的字体：ASCII 直映射兜底，其余字节替换 U+FFFD 并计数——不猜 CJK 映射。 */

export interface FontEncoding { codeBytes: 1 | 2; toUnicode: Map<number, string>; hasToUnicode: boolean; }
export interface GlyphDecode { text: string; unmapped: number; }

function fromHexUtf16(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i + 4 <= clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  return out;
}

/** 解析 ToUnicode CMap 正文。异常大范围（>65535 项）防御性跳过。 */
export function parseCMap(body: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of body.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), fromHexUtf16(m[2]));
    }
  }
  for (const block of body.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1], 16);
      const dsts = [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((d) => fromHexUtf16(d[1]));
      dsts.forEach((dst, i) => map.set(lo + i, dst));
    }
    const rest = block[1].replace(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g, ' ');
    for (const m of rest.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), start = parseInt(m[3], 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(start + (c - lo)));
    }
  }
  return map;
}

export function codeBytesFor(encoding: string): 1 | 2 {
  return /Identity-H|UCS2|UTF16/i.test(encoding) ? 2 : 1;
}

export function makeFont(encoding: string, toUnicode: Map<number, string> | null): FontEncoding {
  return { codeBytes: codeBytesFor(encoding), toUnicode: toUnicode ?? new Map(), hasToUnicode: !!toUnicode };
}

const CONTROL_AS_SPACE = new Set([0x09, 0x0a, 0x0d]);

/** 字节码序列 → 文本。无字体信息时按 ASCII 兜底。 */
export function decodeCodes(font: FontEncoding | null, codes: Uint8Array): GlyphDecode {
  let text = '';
  let unmapped = 0;
  if (!font) {
    for (const b of codes) {
      if (b >= 32 && b < 127) text += String.fromCharCode(b);
      else if (CONTROL_AS_SPACE.has(b)) text += ' ';
      else unmapped++;
    }
    return { text, unmapped };
  }
  if (font.codeBytes === 2) {
    for (let i = 0; i + 1 < codes.length; i += 2) {
      const mapped = font.toUnicode.get((codes[i] << 8) | codes[i + 1]);
      if (mapped !== undefined) text += mapped;
      else { text += '�'; unmapped++; }
    }
    if (codes.length % 2 === 1) unmapped++;
    return { text, unmapped };
  }
  for (const b of codes) {
    const mapped = font.toUnicode.get(b);
    if (mapped !== undefined) text += mapped;
    else if (b >= 32 && b < 127) text += String.fromCharCode(b);
    else if (CONTROL_AS_SPACE.has(b)) text += ' ';
    else { text += '�'; unmapped++; }
  }
  return { text, unmapped };
}
