/**
 * 中央总览模块编译器：把提取到的卡片规格编译成 ECharts graphic 选项。
 *
 * 设计稿中央区是 HTML；RBQM 展示页的自定义图表槽位渲染的是 ECharts。
 * 用 graphic 图元逐块重绘（矩形/圆角/文字/下划线），几何取自提取结果，
 * 字体与配色按设计稿 CSS 固定。纯函数，无浏览器依赖。
 */
import type { CentralSpec, CentralThemeCard, CentralKpiCard, Rect } from './central.js';
import { estimateTextWidth } from '../../../packages/platform-viz/src/index.js';

type Json = Record<string, unknown>;

const INK = '#173c48';
const MUTED = '#536d78';
const LINE = '#dce5e8';
const PAGE_BG = '#f4f7f7';
const LINK = '#1f5fa8';

const TONE = {
  high: { bar: '#a93641', bg: '#f9e9eb', fg: '#9f303a', border: '#edcbd0' },
  warning: { bar: '#c9932c', bg: '#fcf2df', fg: '#805718', border: '#efddb7' },
  unknown: { bar: '#8a99a3', bg: '#edf0f3', fg: '#5f6b78', border: '#dbe1e7' },
} as const;

const font = (size: number, weight = 400): string => `${weight} ${size}px "Segoe UI", Arial, sans-serif`;

function textEl(left: number, top: number, text: string, options: Json = {}): Json {
  const size = typeof options.size === 'number' ? options.size : 12;
  const weight = typeof options.weight === 'number' ? options.weight : 400;
  const style: Json = {
    text,
    font: font(size, weight),
    fill: options.color ?? INK,
    lineHeight: options.lineHeight ?? Math.round(size * 1.3),
    verticalAlign: 'top',
  };
  if (options.align) style.align = options.align;
  if (options.width) {
    style.width = options.width;
    style.overflow = 'break';
  }
  return { type: 'text', left, top, silent: true, style };
}

function rectEl(rect: Rect, style: Json): Json {
  return {
    type: 'rect',
    left: rect.x,
    top: rect.y,
    silent: true,
    shape: { width: rect.w, height: rect.h, r: style.r ?? 0 },
    style: { fill: style.fill ?? 'none', stroke: style.stroke ?? 'none', lineWidth: style.lineWidth ?? 0 },
  };
}

function pill(card: Rect, offsetX: number, offsetY: number, text: string, size: number, tones: { bg: string; fg: string; border: string }, paddingX = 5): Json[] {
  const width = estimateTextWidth(text, size, 600) + paddingX * 2 + 2;
  const height = Math.round(size * 1.87);
  return [
    rectEl({ x: card.x + offsetX, y: card.y + offsetY, w: width, h: height }, { fill: tones.bg, stroke: tones.border, lineWidth: 1, r: 3 }),
    textEl(card.x + offsetX + paddingX + 1, card.y + offsetY + Math.round((height - size * 1.4) / 2), text, {
      size,
      weight: 600,
      color: tones.fg,
    }),
  ];
}

function themeCard(card: CentralThemeCard): Json[] {
  const tones = TONE[card.tone];
  const out: Json[] = [
    rectEl(card.rect, { fill: '#ffffff', stroke: LINE, lineWidth: 1, r: 5 }),
    rectEl({ x: card.rect.x, y: card.rect.y, w: 3, h: card.rect.h }, { fill: tones.bar, r: 2 }),
  ];
  const badge = card.badge ? pill(card.rect, 15, 12, card.badge, 9, tones) : [];
  out.push(...badge);
  const titleX = card.rect.x + 15 + (card.badge ? estimateTextWidth(card.badge, 9, 600) + 12 + 7 : 0);
  out.push(textEl(titleX, card.rect.y + 13, card.title, { size: 12.5, weight: 600, color: INK }));
  out.push(textEl(card.rect.x + 15, card.rect.y + 34, card.meta, { size: 11, color: MUTED }));
  if (card.up || card.down) {
    let x = card.rect.x + 15;
    if (card.up) {
      out.push(textEl(x, card.rect.y + 53, card.up, { size: 10.5, weight: 600, color: TONE.high.bar }));
      x += estimateTextWidth(card.up, 10.5, 600) + 10;
    }
    if (card.down) {
      out.push(textEl(x, card.rect.y + 53, card.down, { size: 10.5, weight: 600, color: '#1b7a4f' }));
    }
  }
  card.links.forEach((link, index) => {
    const top = card.rect.y + 68 + index * 16;
    out.push(textEl(card.rect.x + 15, top, link, { size: 10, color: LINK }));
    out.push(rectEl({ x: card.rect.x + 15, y: top + 13, w: estimateTextWidth(link, 10), h: 1 }, { fill: LINK }));
  });
  return out;
}

function kpiCard(card: CentralKpiCard): Json[] {
  const out: Json[] = [rectEl(card.rect, { fill: '#ffffff', stroke: LINE, lineWidth: 1, r: 5 })];
  const hasDot = !!card.dot;
  if (hasDot) out.push(rectEl({ x: card.rect.x + 14, y: card.rect.y + 18, w: 9, h: 9 }, { fill: card.dot, r: 4.5 }));
  out.push(textEl(card.rect.x + 14 + (hasDot ? 16 : 0), card.rect.y + 14, card.title, { size: 12, weight: 500, color: MUTED }));
  out.push(textEl(card.rect.x + 14, card.rect.y + 39, card.value, {
    size: 26,
    weight: 650,
    color: INK,
    lineHeight: 29,
    width: card.rect.w - 28,
  }));
  out.push(textEl(card.rect.x + 14, card.rect.y + 101, card.caption, { size: 11, color: MUTED }));
  return out;
}

export interface CentralOptionInput {
  spec: CentralSpec;
  /** 画布宽度；设计稿按 1479 排版，其它宽度按比例缩放横向坐标。 */
  width?: number;
  /** 是否铺设计稿页面底色（让卡片间隙呈灰色，而不是整块白）。 */
  background?: boolean;
}

export function buildCentralOption({ spec, width, background = true }: CentralOptionInput): Json {
  const base = spec.width > 0 ? spec.width : 1479;
  const canvasWidth = width && width > 0 ? width : base;
  const scale = canvasWidth / base;
  const scaled = (value: number): number => Math.round(value * scale * 100) / 100;
  const rect = (r: Rect): Rect => ({ x: scaled(r.x), y: r.y, w: scaled(r.w), h: r.h });
  // 页头文字保持设计稿坐标（左对齐短文本，缩放反而会挤压字距）；
  // 只缩放卡片几何，让 6 张 KPI/3 列主题卡适配窄画布。
  const scaledSpec: CentralSpec = {
    ...spec,
    themes: spec.themes.map((item) => ({ ...item, rect: rect(item.rect) })),
    kpis: spec.kpis.map((item) => ({ ...item, rect: rect(item.rect) })),
  };

  const graphic: Json[] = [];
  const canvasHeight = Math.max(
    ...scaledSpec.kpis.map((kpi) => kpi.rect.y + kpi.rect.h),
    ...scaledSpec.themes.map((theme) => theme.rect.y + theme.rect.h),
    511,
  );
  if (background) {
    graphic.push(rectEl({ x: 0, y: 0, w: canvasWidth, h: canvasHeight }, { fill: PAGE_BG }));
  }

  graphic.push(textEl(scaledSpec.titleRect.x, scaledSpec.titleRect.y, spec.title, { size: 25, weight: 650, color: INK, lineHeight: 30 }));
  for (const meta of scaledSpec.metas) {
    if (meta.demo) {
      graphic.push(rectEl(meta.rect, { fill: '#ffffff', stroke: LINE, lineWidth: 1, r: 3 }));
      graphic.push(textEl(meta.rect.x + 8, meta.rect.y + 3, meta.text, { size: 11, color: MUTED, lineHeight: 15 }));
    } else {
      graphic.push(textEl(meta.rect.x, meta.rect.y, meta.text, { size: 12, color: MUTED, lineHeight: 17 }));
    }
  }
  if (spec.viewLabel) {
    // 右对齐：按文字实际宽度贴右边缘，窄画布下不会被裁掉最后一个词。
    const labelWidth = Math.max(spec.viewLabelRect.w, estimateTextWidth(spec.viewLabel, 11.5) + 18);
    const labelX = canvasWidth - labelWidth;
    graphic.push(rectEl({ x: labelX, y: spec.viewLabelRect.y, w: labelWidth, h: spec.viewLabelRect.h }, { fill: '#ffffff', stroke: LINE, lineWidth: 1, r: 3 }));
    graphic.push(textEl(labelX + 8, spec.viewLabelRect.y + 4, spec.viewLabel, { size: 11.5, color: MUTED, lineHeight: 16 }));
  }
  graphic.push(textEl(scaledSpec.scopeRect.x, scaledSpec.scopeRect.y, spec.scope, { size: 12, color: MUTED, lineHeight: 17 }));
  graphic.push(textEl(scaledSpec.themesHeadRect.x, scaledSpec.themesHeadRect.y, spec.themesHeading, { size: 14, weight: 600, color: INK, lineHeight: 19 }));
  if (spec.themesSub) {
    const subWidth = estimateTextWidth(spec.themesSub, 11);
    graphic.push(textEl(canvasWidth - subWidth, scaledSpec.themesHeadRect.y + 2, spec.themesSub, { size: 11, color: MUTED, lineHeight: 15 }));
  }
  for (const theme of scaledSpec.themes) graphic.push(...themeCard(theme));
  for (const kpi of scaledSpec.kpis) graphic.push(...kpiCard(kpi));

  return { _bypassBuilder: true, animation: false, graphic };
}
