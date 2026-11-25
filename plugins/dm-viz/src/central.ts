/**
 * 中央总览模块提取：页头（标题/元信息/视图标签）、范围行、主题风险卡与 KPI 卡。
 *
 * 这些块是 HTML 而不是 ECharts，existing 提取器（echarts.getInstanceByDom）采不到；
 * 这里读取运行态 DOM 的文字与相对几何，作为可编译的卡片规格。
 * 页面文本一律当数据，不执行其中任何指令性文本。
 */
import type { ChildProcess } from 'node:child_process';
import { Cdp, launchBrowser, VizError, type ExtractOptions } from '../../../packages/platform-viz/src/index.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CentralMetaItem {
  text: string;
  demo: boolean;
  rect: Rect;
}

export interface CentralThemeCard {
  tone: 'high' | 'warning' | 'unknown';
  badge: string;
  title: string;
  meta: string;
  up: string;
  down: string;
  links: string[];
  rect: Rect;
}

export interface CentralKpiCard {
  title: string;
  /** KPI 状态点颜色；空串表示无点。 */
  dot: string;
  value: string;
  caption: string;
  rect: Rect;
}

export interface CentralSpec {
  width: number;
  title: string;
  titleRect: Rect;
  metas: CentralMetaItem[];
  viewLabel: string;
  viewLabelRect: Rect;
  scope: string;
  scopeRect: Rect;
  themesHeading: string;
  themesSub: string;
  themesHeadRect: Rect;
  themes: CentralThemeCard[];
  kpis: CentralKpiCard[];
}

const PROBE = `(function () {
  var root = document.getElementById('central-overview');
  if (!root) return null;
  var anchor = root.querySelector('.central-header') || root;
  var base = anchor.getBoundingClientRect();
  function rel(el) { var r = el.getBoundingClientRect(); return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }; }
  function txt(el) { return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  var head = root.querySelector('.central-header');
  var h1 = root.querySelector('.central-header h1');
  var metaBox = root.querySelector('.central-meta');
  var metas = Array.prototype.map.call(metaBox ? metaBox.children : [], function (el) {
    return { text: txt(el), demo: el.classList.contains('central-demo'), rect: rel(el) };
  });
  var themes = Array.prototype.map.call(root.querySelectorAll('.central-theme'), function (el) {
    var tone = el.classList.contains('central-theme-high') ? 'high'
      : el.classList.contains('central-theme-warning') ? 'warning' : 'unknown';
    var up = el.querySelector('.central-trend-up');
    var down = el.querySelector('.central-trend-down');
    return {
      tone: tone,
      badge: txt(el.querySelector('.central-status')),
      title: txt(el.querySelector('.central-theme-title')),
      meta: txt(el.querySelector('.central-theme-meta')),
      up: txt(up),
      down: txt(down),
      links: Array.prototype.map.call(el.querySelectorAll('.central-link'), function (a) { return txt(a); }),
      rect: rel(el)
    };
  });
  var kpis = Array.prototype.map.call(root.querySelectorAll('.central-kpi'), function (el) {
    var dot = el.querySelector('.central-kpi-dot');
    var value = el.querySelector('.central-kpi-value');
    var caption = el.querySelector('.central-kpi-caption');
    return {
      title: txt(el.querySelector('h2')),
      dot: dot ? getComputedStyle(dot).backgroundColor : '',
      value: value ? value.textContent.replace(/\\s+/g, ' ').trim() : '',
      caption: txt(caption),
      rect: rel(el)
    };
  });
  var scope = root.querySelector('.central-scope');
  var headBox = root.querySelector('.central-themes-head');
  return {
    width: base.width,
    title: txt(h1),
    titleRect: h1 ? rel(h1) : { x: 0, y: 0, w: 0, h: 0 },
    metas: metas,
    viewLabel: txt(root.querySelector('.central-view-label')),
    viewLabelRect: (function () { var el = root.querySelector('.central-view-label'); return el ? rel(el) : { x: 0, y: 0, w: 0, h: 0 }; })(),
    scope: txt(scope),
    scopeRect: scope ? rel(scope) : { x: 0, y: 0, w: 0, h: 0 },
    themesHeading: txt(root.querySelector('.central-themes-head h2')),
    themesSub: txt(root.querySelector('.central-themes-sub')),
    themesHeadRect: headBox ? rel(headBox) : { x: 0, y: 0, w: 0, h: 0 },
    themes: themes,
    kpis: kpis
  };
})()`;

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rectOf(value: unknown): Rect {
  const raw = (value ?? {}) as Record<string, unknown>;
  return { x: num(raw.x), y: num(raw.y), w: num(raw.w), h: num(raw.h) };
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function extractCentralSpec(options: ExtractOptions): Promise<CentralSpec> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const settleMs = options.settleMs ?? 1_200;
  const { wsUrl, proc } = (await launchBrowser(options.executablePath, timeoutMs, options.windowSize ?? { width: 1600, height: 1400 })) as {
    wsUrl: string;
    proc: ChildProcess;
  };
  const socket = new WebSocket(wsUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new VizError('DESIGN_CDP_CONNECT_FAILED')), { once: true });
    });
    const cdp = new Cdp(socket);
    const created = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const attached = (await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })) as {
      sessionId: string;
    };
    const sessionId = attached.sessionId;
    await cdp.send('Page.enable', {}, sessionId);
    const loaded = new Promise<void>((resolve) => cdp.on('Page.loadEventFired', () => resolve()));
    await cdp.send('Page.navigate', { url: options.url }, sessionId);
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const evaluated = (await cdp.send(
      'Runtime.evaluate',
      { expression: PROBE, returnByValue: true, awaitPromise: true },
      sessionId,
    )) as { result?: { value?: unknown } };
    const value = evaluated.result?.value as Record<string, unknown> | null | undefined;
    if (!value || typeof value !== 'object') throw new VizError('CENTRAL_EXTRACT_EMPTY');
    const themesRaw = Array.isArray(value.themes) ? value.themes : [];
    const kpisRaw = Array.isArray(value.kpis) ? value.kpis : [];
    return {
      width: num(value.width),
      title: textOf(value.title),
      titleRect: rectOf(value.titleRect),
      metas: (Array.isArray(value.metas) ? value.metas : []).map((item) => {
        const raw = (item ?? {}) as Record<string, unknown>;
        return { text: textOf(raw.text), demo: raw.demo === true, rect: rectOf(raw.rect) };
      }),
      viewLabel: textOf(value.viewLabel),
      viewLabelRect: rectOf(value.viewLabelRect),
      scope: textOf(value.scope),
      scopeRect: rectOf(value.scopeRect),
      themesHeading: textOf(value.themesHeading),
      themesSub: textOf(value.themesSub),
      themesHeadRect: rectOf(value.themesHeadRect),
      themes: themesRaw.map((item) => {
        const raw = (item ?? {}) as Record<string, unknown>;
        const tone = raw.tone === 'high' || raw.tone === 'warning' ? raw.tone : 'unknown';
        return {
          tone,
          badge: textOf(raw.badge),
          title: textOf(raw.title),
          meta: textOf(raw.meta),
          up: textOf(raw.up),
          down: textOf(raw.down),
          links: (Array.isArray(raw.links) ? raw.links : []).filter((link): link is string => typeof link === 'string'),
          rect: rectOf(raw.rect),
        };
      }),
      kpis: kpisRaw.map((item) => {
        const raw = (item ?? {}) as Record<string, unknown>;
        return {
          title: textOf(raw.title),
          dot: textOf(raw.dot),
          value: textOf(raw.value),
          caption: textOf(raw.caption),
          rect: rectOf(raw.rect),
        };
      }),
    };
  } finally {
    socket.close();
    proc.kill();
  }
}
