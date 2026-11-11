import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readProtocol } from '../src/protocol.js';
import { DvpError } from '../src/parse.js';
import { makePdf, type FixtureSpec } from './fixtures/make-pdf.js';

function withPdf(name: string, spec: FixtureSpec): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvp-pdf-'));
  writeFileSync(path.join(dir, name), makePdf(spec));
  return dir;
}

const throwsCode = (fn: () => unknown, code: string): void => {
  try { fn(); assert.fail(`expected DvpError ${code}`); }
  catch (e) {
    assert.ok(e instanceof DvpError && e.code === code, `expected ${code}, got: ${(e as Error).message}`);
  }
};

test('latin 字面串两页抽取 + window', () => {
  const dir = withPdf('protocol.pdf', {
    pages: [
      { items: [{ text: 'Informed Consent Form' }, { newline: true, text: 'Visit 1 screening' }] },
      { items: [{ text: 'Adverse Event grading' }] },
    ],
  });
  const full = readProtocol(dir, 'protocol.pdf');
  assert.equal(full.pages.length, 2);
  assert.equal(full.pages[0].text, 'Informed Consent Form\nVisit 1 screening');
  assert.equal(full.pages[1].text, 'Adverse Event grading');
  assert.equal(full.stats.pages, 2);
  assert.match(full.sha256, /^[0-9a-f]{64}$/);

  const windowed = readProtocol(dir, 'protocol.pdf', { startPage: 2, endPage: 2 });
  assert.equal(windowed.pages.length, 1);
  assert.equal(windowed.pages[0].page, 2);
  assert.equal(windowed.pages[0].text, 'Adverse Event grading');
});

test('stream 正文含 endobj/endstream 文本不截断对象或流', () => {
  const dir = withPdf('protocol.pdf', {
    pages: [{ items: [{ text: 'stream-marker regression' }] }],
    streamLiterals: ['literal endobj and endstream stay inside stream data'],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages.length, 1);
  assert.match(result.pages[0].text, /literal endobj and endstream stay inside stream data/);
  assert.equal(result.stats.pagesWithoutContent, 0);
});

test('FlateDecode 内容流解压', () => {
  const dir = withPdf('protocol.pdf', {
    flate: true,
    pages: [{ items: [{ text: 'Randomization strata' }, { newline: true, text: 'age 18-65' }] }],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages[0].text, 'Randomization strata\nage 18-65');
  assert.equal(result.stats.inflateFailures, 0);
});

test('裸 deflate 流兜底回退（少数生产者省略 zlib 包裹）', () => {
  const dir = withPdf('protocol.pdf', {
    flate: true,
    rawFlate: true,
    pages: [{ items: [{ text: 'raw deflate fallback' }] }],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages[0].text, 'raw deflate fallback');
  assert.equal(result.stats.inflateFailures, 0);
});

test('Identity-H + bfchar CJK 十六进制串解码', () => {
  const dir = withPdf('protocol.pdf', {
    fonts: [{ name: 'F1', identity: { 1: '血', 2: '压', 3: '标', 4: '题' } }],
    pages: [{ items: [{ hexCodes: [1, 2, 3, 4] }, { newline: true, hexCodes: [3, 4, 1, 2] }] }],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages[0].text, '血压标题\n标题血压');
  assert.equal(result.stats.unmappedGlyphs, 0);
  assert.equal(result.diagnostics.some((d) => d.startsWith('FONT_WITHOUT_TOUNICODE')), false);
});

test('bfrange 范围映射 + TJ 数组与 kerning', () => {
  const dir = withPdf('protocol.pdf', {
    fonts: [{ name: 'FB', bfrange: { lo: 0x41, hi: 0x5a, dst: 0x0041 } }],
    pages: [{
      items: [
        { hexCodes: [0x41, 0x42, 0x43] },
        { newline: true, arrayTj: true, hexCodes: [0x44, 0x45], kern: -80 },
      ],
    }],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages[0].text, 'ABC\nDE');
});

test('TJ 大负 kern → 词间空格；小 kern 不触发', () => {
  const dir = withPdf('protocol.pdf', {
    pages: [{
      items: [
        { arrayTj: true, text: 'Double-Blind', kern: -250, text2: 'Randomized' },
        { newline: true, arrayTj: true, text: 'small', kern: -80, text2: 'kern' },
        { newline: true, text: 'plain line' },
      ],
    }],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages[0].text, 'Double-Blind Randomized\nsmallkern\nplain line');
});

test('括号转义与嵌套括号字面串', () => {
  const dir = withPdf('protocol.pdf', {
    pages: [{ items: [{ text: 'AE (serious) events' }, { newline: true, text: 'a(b)c' }] }],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages[0].text, 'AE (serious) events\na(b)c');
});

test('加密 PDF 拒绝', () => {
  const dir = withPdf('protocol.pdf', { pages: [{ items: [{ text: 'x' }] }], encrypt: true });
  throwsCode(() => readProtocol(dir, 'protocol.pdf'), 'ENCRYPTED_PDF_UNSUPPORTED');
});

test('无文本层 → NO_TEXT_LAYER + NEEDS_OCR', () => {
  const dir = withPdf('scan.pdf', { pages: [{ items: [] }, { items: [] }] });
  const result = readProtocol(dir, 'scan.pdf');
  assert.equal(result.diagnostics.includes('NO_TEXT_LAYER'), true);
  assert.ok(result.notices.some((n) => n.startsWith('NEEDS_OCR')));
  assert.equal(result.pages.every((p) => p.chars === 0), true);
});

test('缺 ToUnicode 字体：高字节 U+FFFD 占位并计数', () => {
  const dir = withPdf('protocol.pdf', {
    fonts: [{ name: 'F1', noToUnicode: true }],
    pages: [{ items: [{ hexCodes: [0xc4, 0xd6] }, { newline: true, text: 'plain' }] }],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages[0].text.includes('plain'), true);
  assert.equal(result.pages[0].text.includes('�'), true);
  assert.ok(result.stats.fontsWithoutToUnicode.length >= 1);
  assert.ok(result.diagnostics.some((d) => d.startsWith('FONT_WITHOUT_TOUNICODE')));
  assert.ok(result.notices.some((n) => n.startsWith('ENCODING_FIDELITY')));
});

test('resources 在 Pages 节点的继承', () => {
  const dir = withPdf('protocol.pdf', {
    resourcesOnPages: true,
    fonts: [{ name: 'F1', identity: { 1: '访', 2: '视' } }],
    pages: [{ items: [{ hexCodes: [1, 2] }] }],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages[0].text, '访视');
});

test('ObjStm 压缩页对象：对象号/偏移正确展开，不丢页', () => {
  const dir = withPdf('protocol.pdf', {
    objectStream: true,
    flate: true,
    pages: [
      { items: [{ text: 'First section' }] },
      { items: [{ text: 'Second section' }] },
      { items: [{ text: 'Third section' }] },
    ],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages.length, 3);
  assert.deepEqual(result.pages.map((p) => p.text), ['First section', 'Second section', 'Third section']);
  assert.equal(result.stats.objectStreams, 1);
  assert.equal(result.stats.objectStreamObjects, 3);
  assert.equal(result.stats.objectStreamFailures, 0);
  assert.equal(result.stats.declaredPages, 3);
  assert.equal(result.diagnostics.some((d) => d.startsWith('PAGE_TREE_INCOMPLETE')), false);
});

test('页树声明页数与可解析页数不一致：显式告警而非静默丢页', () => {
  const dir = withPdf('protocol.pdf', {
    pageCountOverride: 3,
    pages: [{ items: [{ text: 'only page' }] }],
  });
  const result = readProtocol(dir, 'protocol.pdf');
  assert.equal(result.pages.length, 1);
  assert.equal(result.stats.declaredPages, 3);
  assert.ok(result.diagnostics.some((d) => d.startsWith('PAGE_TREE_INCOMPLETE')));
  assert.ok(result.notices.some((n) => n.startsWith('PAGE_COVERAGE_INCOMPLETE')));
});

test('路径与窗口边界拒绝', () => {
  const dir = withPdf('protocol.pdf', { pages: [{ items: [{ text: 'x' }] }] });
  writeFileSync(path.join(dir, 'garbage.pdf'), Buffer.from('not a pdf at all'));
  throwsCode(() => readProtocol(dir, 'protocol.pdf', { startPage: 5 }), 'PAGE_WINDOW_INVALID');
  throwsCode(() => readProtocol(dir, 'protocol.pdf', { startPage: 2, endPage: 1 }), 'PAGE_WINDOW_INVALID');
  throwsCode(() => readProtocol(dir, 'garbage.pdf'), 'PROTOCOL_NOT_PDF');
  throwsCode(() => readProtocol(dir, 'draft.txt'), 'PROTOCOL_NOT_PDF');
  throwsCode(() => readProtocol(dir, '../escape.pdf'), 'PROTOCOL_OUTSIDE_DIRECTORY');
  throwsCode(() => readProtocol(path.join(dir, 'nope'), 'x.pdf'), 'PROTOCOL_DIRECTORY_NOT_FOUND');
});
