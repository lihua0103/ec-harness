/**
 * 设计稿卡片的说明文字（question / caption / note / evidence）。
 *
 * 这些块是卡片内、图表上下的 HTML 文本，不属于 ECharts option。展示页的图表格子
 * 没有文本槽位，因此在图表 canvas 内用 graphic 文本重绘，并为栅格预留对应高度：
 * - 图上文字：grid.top 下移
 * - 图下文字：grid.bottom 上移
 * 几何与字号全部来自设计稿运行态提取，不手写内容。
 */
import type { ChildProcess } from 'node:child_process';
import { Cdp, launchBrowser, type ExtractOptions } from './design.js';
import { estimateTextWidth } from './text.js';
import { VizError } from './errors.js';

type Json = Record<string, any>;

export interface DesignNoteBlock {
  cls: string;
  text: string;
  position: 'above' | 'below' | 'overlap';
  rect: { x: number; y: number; w: number; h: number };
  fontSize: string;
  fontWeight: string;
  color: string;
  lineHeight: string;
}

export interface DesignCardNotes {
  card: string;
  cardRect: { x: number; y: number; w: number; h: number };
  chartRect: { x: number; y: number; w: number; h: number };
  blocks: DesignNoteBlock[];
}

const PROBE = `(function () {
  function r(el) { var b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; }
  var result = [];
  Array.prototype.forEach.call(document.querySelectorAll('article.card[data-chart-card]'), function (card) {
    var chart = card.querySelector('.ec-chart');
    if (!chart) return;
    var cr = r(chart);
    var blocks = [];
    Array.prototype.forEach.call(card.children, function (el) {
      if (el === chart) return;
      var cls = (el.className || '').toString();
      if (!/review-question|review-caption|review-note|review-evidence/.test(cls)) return;
      var s = getComputedStyle(el); var br = r(el);
      var text;
      var details = el.querySelector('details');
      if (details) {
        var clone = el.cloneNode(true);
        var hidden = clone.querySelector('details');
        if (hidden) hidden.remove();
        text = (clone.innerText || clone.textContent || '').trim();
        var summary = details.querySelector('summary');
        if (summary) text += (text ? '\\n' : '') + '▶ ' + (summary.textContent || '').trim();
      } else {
        text = (el.innerText || el.textContent || '').trim();
      }
      var lineHeight = parseFloat(s.lineHeight) || 14;
      var lines = text ? text.split('\\n').filter(function (line) { return line.trim(); }).length : 0;
      blocks.push({
        cls: cls,
        text: text,
        rect: { x: br.x, y: br.y, w: br.w, h: Math.max(lineHeight, Math.round(lines * lineHeight)) },
        position: br.y + br.h <= cr.y + 2 ? 'above' : (br.y >= cr.y + cr.h - 2 ? 'below' : 'overlap'),
        fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, lineHeight: s.lineHeight
      });
    });
    if (blocks.length) result.push({ card: card.getAttribute('data-chart-card'), cardRect: r(card), chartRect: cr, blocks: blocks });
  });
  return result;
})()`;

export async function extractDesignNotes(options: ExtractOptions): Promise<DesignCardNotes[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const settleMs = options.settleMs ?? 1_200;
  const { wsUrl, proc } = (await launchBrowser(
    options.executablePath,
    timeoutMs,
    options.windowSize ?? { width: 1920, height: 1400 },
  )) as { wsUrl: string; proc: ChildProcess };
  const socket = new WebSocket(wsUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new VizError('DESIGN_CDP_CONNECT_FAILED')), { once: true });
    });
    const cdp = new Cdp(socket);
    const created = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const attached = (await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })) as { sessionId: string };
    const sessionId = attached.sessionId;
    await cdp.send('Page.enable', {}, sessionId);
    const loaded = new Promise<void>((resolve) => cdp.on('Page.loadEventFired', () => resolve()));
    await cdp.send('Page.navigate', { url: options.url }, sessionId);
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const evaluated = (await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true }, sessionId)) as {
      result?: { value?: unknown };
    };
    const value = evaluated.result?.value;
    if (!Array.isArray(value)) throw new VizError('DESIGN_NOTES_EMPTY', JSON.stringify(evaluated).slice(0, 400));
    return value as DesignCardNotes[];
  } finally {
    socket.close();
    proc.kill();
  }
}

const GAP = 6;

function blocks(notes: DesignCardNotes, position: 'above' | 'below'): DesignNoteBlock[] {
  return notes.blocks.filter((block) => block.position === position);
}

/** 预估 ECharts 实际换行高度：设计稿行数可能因字体度量不同而少一行。 */
function blockHeight(block: DesignNoteBlock, canvasWidth: number): number {
  const size = Number.parseFloat(block.fontSize) || 11;
  const lineHeight = Number.parseFloat(block.lineHeight) || 14;
  const lines = Math.max(1, Math.ceil(estimateTextWidth(block.text, size) / Math.max(80, canvasWidth - 12)));
  return Math.max(block.rect.h, Math.ceil((lines + (lines > 1 ? 1 : 0)) * lineHeight) + 2);
}

function reserve(notes: DesignCardNotes, position: 'above' | 'below', canvasWidth: number): number {
  const list = blocks(notes, position);
  if (!list.length) return 0;
  return list.reduce((sum, block) => sum + blockHeight(block, canvasWidth) + GAP, 0);
}

/**
 * 把说明文字写入图表 option：调整栅格留白并追加 graphic 文本。
 * 返回新的 option（不修改入参）。
 */
export function applyDesignNotes(option: Json, notes: DesignCardNotes, canvasWidth: number): Json {
  const top = blocks(notes, 'above');
  const bottom = blocks(notes, 'below');
  if (!top.length && !bottom.length) return option;

  const next: Json = JSON.parse(JSON.stringify(option));
  const previous = next._designNotes as { top?: number; bottom?: number } | undefined;
  const gridTarget = Array.isArray(next.grid) ? next.grid[0] : next.grid;
  if (previous && gridTarget && typeof gridTarget === 'object') {
    gridTarget.top = Number(gridTarget.top ?? 0) - Number(previous.top ?? 0);
    gridTarget.bottom = Number(gridTarget.bottom ?? 0) - Number(previous.bottom ?? 0);
  }
  if (Array.isArray(next.graphic)) {
    next.graphic = next.graphic.filter((element: Json) => element?._designNote !== true);
    if (!next.graphic.length) delete next.graphic;
  }
  const topReserve = reserve(notes, 'above', canvasWidth);
  const bottomReserve = reserve(notes, 'below', canvasWidth);
  if (gridTarget && typeof gridTarget === 'object') {
    gridTarget.top = Number(gridTarget.top ?? 0) + topReserve;
    gridTarget.bottom = Number(gridTarget.bottom ?? 0) + bottomReserve;
  }
  // 图例与 visualMap 是画布内绝对定位，必须随文字一起让位，否则会压住说明文字。
  const legendTarget = Array.isArray(next.legend) ? next.legend[0] : next.legend;
  if (legendTarget && typeof legendTarget === 'object') {
    if (topReserve && legendTarget.top !== undefined) legendTarget.top = Number(legendTarget.top) + topReserve;
    if (bottomReserve && legendTarget.bottom !== undefined) legendTarget.bottom = Number(legendTarget.bottom) + bottomReserve;
  }
  const visualTarget = Array.isArray(next.visualMap) ? next.visualMap[0] : next.visualMap;
  if (visualTarget && typeof visualTarget === 'object') {
    if (topReserve && visualTarget.top !== undefined) visualTarget.top = Number(visualTarget.top) + topReserve;
    if (bottomReserve && visualTarget.bottom !== undefined) visualTarget.bottom = Number(visualTarget.bottom) + bottomReserve;
  }

  const graphic: Json[] = Array.isArray(next.graphic) ? next.graphic : [];
  let y = 0;
  for (const block of top) {
    graphic.push(textElement(0, y, block, canvasWidth));
    y += blockHeight(block, canvasWidth) + GAP;
  }
  let fromBottom = bottomReserve;
  for (const block of bottom) {
    fromBottom -= blockHeight(block, canvasWidth) + GAP;
    graphic.push(textElement(0, undefined, block, canvasWidth, fromBottom));
  }
  next.graphic = graphic;
  next._designNotes = { top: topReserve, bottom: bottomReserve };
  next._bypassBuilder = true;
  return next;
}

function textElement(left: number, top: number | undefined, block: DesignNoteBlock, canvasWidth: number, bottom?: number): Json {
  const element: Json = {
    type: 'text',
    _designNote: true,
    left,
    silent: true,
    style: {
      text: block.text,
      font: `${block.fontWeight} ${block.fontSize} "Segoe UI", Arial, sans-serif`,
      fill: block.color,
      lineHeight: Number.parseFloat(block.lineHeight) || 14,
      width: Math.max(120, canvasWidth - 4),
      overflow: 'break',
      verticalAlign: 'top',
    },
  };
  if (bottom === undefined) element.top = top ?? 0;
  else element.bottom = bottom;
  return element;
}
