/**
 * 设计稿运行态提取：用无头 Chrome 打开自包含 HTML，逐图调用
 * echarts.getInstanceByDom(el).getOption()，拿到最终渲染形态。
 *
 * 不依赖 Playwright：直接用 Node 内置 WebSocket 走 CDP。
 * 页面内容一律当作数据，不执行其中任何指令性文本。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { VizError } from './errors.js';
import type { PairResult } from './accept.js';
import type { RenderModel } from './render.js';

type Json = Record<string, unknown>;

export interface DesignLabelTexts {
  series: number;
  key: string;
  texts: string[];
}

export interface DesignChart {
  order: number;
  id: string;
  card: string;
  title: string;
  option: Json;
  /** 设计稿里由函数生成的标签文字：JSON 会丢函数，这里在页面内先求值保存。 */
  labelTexts?: DesignLabelTexts[];
}

export interface ExtractOptions {
  url: string;
  executablePath: string;
  timeoutMs?: number;
  settleMs?: number;
  /** 无头浏览器窗口尺寸；几何提取必须与验收视口一致。 */
  windowSize?: { width: number; height: number };
  /** 需要在目标 origin 预先写入的 sessionStorage（例如已登录系统的令牌）。 */
  storage?: Record<string, string>;
}

const PROBE = `(function () {
  var ec = window.echarts;
  if (!ec || typeof ec.getInstanceByDom !== 'function') return [];
  var out = [];
  var seen = new Set();
  var index = 0;
  var nodes = document.querySelectorAll('div,canvas');
  for (var n = 0; n < nodes.length; n++) {
    var el = nodes[n];
    var inst = null;
    try { inst = ec.getInstanceByDom(el); } catch (e) { inst = null; }
    if (!inst || seen.has(inst)) continue;
    seen.add(inst);
    var raw = null;
    try { raw = inst.getOption(); } catch (e) { raw = null; }
    var labelTexts = [];
    if (raw) {
      (raw.series || []).forEach(function (s, si) {
        ['label', 'endLabel'].forEach(function (key) {
          var cfg = s && s[key];
          if (cfg && typeof cfg.formatter === 'function') {
            var texts = (s.data || []).map(function (d, i) {
              try {
                var value = d && typeof d === 'object' && d.value !== undefined ? d.value : d;
                if (s.stack) value = (raw.series || []).map(function (x) { var v = (x.data || [])[i]; return v && typeof v === 'object' && v.value !== undefined ? v.value : v; });
                return String(cfg.formatter({ value: value, name: (d && d.name) || '', dataIndex: i, seriesName: s.name || '', data: s.data }));
              } catch (e) { return ''; }
            });
            labelTexts.push({ series: si, key: key, texts: texts });
          }
        });
      });
    }
    var opt = null;
    try { opt = JSON.parse(JSON.stringify(raw)); } catch (e) { opt = null; }
    if (!opt) continue;
    var card = el.closest ? el.closest('[data-chart-card]') : null;
    var titleEl = card ? card.querySelector('.card-title') : null;
    out.push({
      order: index++,
      id: el.getAttribute('data-chart-id') || el.id || '',
      card: card ? (card.getAttribute('data-chart-card') || '') : '',
      title: titleEl ? String(titleEl.textContent || '').trim() : '',
      option: opt,
      labelTexts: labelTexts
    });
  }
  return out;
})()`;

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: unknown;
}

export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly handlers = new Map<string, Array<(params: unknown) => void>>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (typeof message.id === 'number') {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new VizError('DESIGN_CDP_ERROR', message.error.message ?? 'unknown'));
        else entry.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
      }
    });
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const payload: Json = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  on(method: string, handler: (params: unknown) => void): void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchBrowser(
  executablePath: string,
  timeoutMs: number,
  windowSize: { width: number; height: number } = { width: 1680, height: 2000 },
): Promise<{ wsUrl: string; proc: ChildProcess }> {
  const proc = spawn(
    executablePath,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--remote-debugging-port=0',
      `--window-size=${windowSize.width},${windowSize.height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new VizError('DESIGN_BROWSER_TIMEOUT')), timeoutMs);
    proc.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(new VizError('DESIGN_BROWSER_FAILED', error.message));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new VizError('DESIGN_BROWSER_EXITED', String(code)));
    });
  });
  return { wsUrl, proc };
}

export async function extractDesignCharts(options: ExtractOptions): Promise<DesignChart[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const settleMs = options.settleMs ?? 1_200;
  const { wsUrl, proc } = await launchBrowser(options.executablePath, timeoutMs);
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
    const navigate = async (target: string): Promise<void> => {
      const loaded = new Promise<void>((resolve) => cdp.on('Page.loadEventFired', () => resolve()));
      await cdp.send('Page.navigate', { url: target }, sessionId);
      await Promise.race([loaded, delay(timeoutMs)]);
    };
    if (options.storage && Object.keys(options.storage).length) {
      // 先到同源页面建立 document，再写入会话存储；随后带缓存参数重新加载，
      // 让单页应用在启动时读到刚写入的令牌（只改 hash 不会触发重新启动）。
      await navigate(new URL(options.url).origin);
      const assignments = Object.entries(options.storage)
        .map(([key, value]) => `sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
        .join('');
      await cdp.send('Runtime.evaluate', { expression: assignments, returnByValue: true }, sessionId);
      const fresh = new URL(options.url);
      fresh.searchParams.set('_r', String(Date.now()));
      await navigate(fresh.toString());
    } else {
      await navigate(options.url);
    }
    await delay(settleMs);
    const evaluated = (await cdp.send(
      'Runtime.evaluate',
      { expression: PROBE, returnByValue: true, awaitPromise: true },
      sessionId,
    )) as { result?: { value?: unknown } };
    const value = evaluated.result?.value;
    if (!Array.isArray(value)) throw new VizError('DESIGN_EXTRACT_EMPTY');
    return value
      .filter((item): item is Json => !!item && typeof item === 'object')
      .map((item, index) => ({
        order: typeof item.order === 'number' ? item.order : index,
        id: typeof item.id === 'string' ? item.id : '',
        card: typeof item.card === 'string' ? item.card : '',
        title: typeof item.title === 'string' ? item.title : '',
        option: (item.option ?? {}) as Json,
        labelTexts: Array.isArray(item.labelTexts) ? (item.labelTexts as DesignLabelTexts[]) : [],
      }))
      .sort((a, b) => a.order - b.order);
  } finally {
    socket.close();
    proc.kill();
  }
}

// ---------------------------------------------------------------------------
// 选项比对：只比较语义字段（系列、类型、数据、类目、朝向、颜色），忽略布局细节。

export interface OptionDiff {
  field: string;
  design: unknown;
  generated: unknown;
}

function seriesOf(option: Json): Json[] {
  return Array.isArray(option.series) ? (option.series as Json[]) : [];
}

function categoryAxis(option: Json): { key: 'xAxis' | 'yAxis'; data: unknown[] } | null {
  for (const key of ['xAxis', 'yAxis'] as const) {
    const raw = option[key];
    const axis = Array.isArray(raw) ? (raw[0] as Json | undefined) : (raw as Json | undefined);
    if (axis && axis.type === 'category' && Array.isArray(axis.data)) {
      return { key, data: axis.data as unknown[] };
    }
  }
  return null;
}

function normalizeData(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in (value as Json)) {
      return (value as Json).value;
    }
    return value;
  });
}

function namesOf(data: unknown): string[] | null {
  if (!Array.isArray(data)) return null;
  const names = data.map((value) =>
    value && typeof value === 'object' && !Array.isArray(value) && 'name' in (value as Json)
      ? String((value as Json).name)
      : '',
  );
  return names.some((name) => name) ? names : null;
}

function sameNumber(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) <= 1e-6;
}

/** ECharts 5 默认主题色：设计稿没有显式配色时 getOption 仍会带出这组值，不应据此判差异。 */
const ECHARTS_DEFAULT_COLOR = [
  '#5470c6',
  '#91cc75',
  '#fac858',
  '#ee6666',
  '#73c0de',
  '#3ba272',
  '#fc8452',
  '#9a60b4',
  '#ea7ccc',
];

function deepEqualValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return sameNumber(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqualValue(value, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Json;
    const right = b as Json;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (!deepEqualValue(left[key], right[key])) return false;
    return true;
  }
  return a === b;
}

export function compareOptions(design: Json, generated: Json): OptionDiff[] {
  const diffs: OptionDiff[] = [];
  const designSeries = seriesOf(design);
  const generatedSeries = seriesOf(generated);
  if (designSeries.length !== generatedSeries.length) {
    diffs.push({ field: 'seriesCount', design: designSeries.length, generated: generatedSeries.length });
  }
  const count = Math.min(designSeries.length, generatedSeries.length);
  for (let index = 0; index < count; index++) {
    const left = designSeries[index]!;
    const right = generatedSeries[index]!;
    if (left.type !== right.type) diffs.push({ field: `series[${index}].type`, design: left.type, generated: right.type });
    if (left.name !== undefined && right.name !== undefined && left.name !== right.name) {
      diffs.push({ field: `series[${index}].name`, design: left.name, generated: right.name });
    }
    const leftNames = namesOf(left.data);
    const rightNames = namesOf(right.data);
    if (leftNames || rightNames) {
      if (!deepEqualValue(leftNames ?? [], rightNames ?? [])) {
        diffs.push({ field: `series[${index}].names`, design: leftNames, generated: rightNames });
      }
    }
    const leftData = normalizeData(left.data);
    const rightData = normalizeData(right.data);
    if (!deepEqualValue(leftData, rightData)) {
      diffs.push({ field: `series[${index}].data`, design: leftData, generated: rightData });
    }
    if (Array.isArray(left.links) && Array.isArray(right.links) && !deepEqualValue(left.links, right.links)) {
      diffs.push({ field: `series[${index}].links`, design: left.links, generated: right.links });
    }
    if (Array.isArray(left.nodes) && Array.isArray(right.nodes) && !deepEqualValue(left.nodes, right.nodes)) {
      diffs.push({ field: `series[${index}].nodes`, design: left.nodes, generated: right.nodes });
    }
  }
  const designAxis = categoryAxis(design);
  const generatedAxis = categoryAxis(generated);
  if (designAxis || generatedAxis) {
    if (!designAxis || !generatedAxis) {
      diffs.push({ field: 'categoryAxis', design: designAxis?.key ?? null, generated: generatedAxis?.key ?? null });
    } else {
      if (designAxis.key !== generatedAxis.key) {
        diffs.push({ field: 'categoryAxis', design: designAxis.key, generated: generatedAxis.key });
      }
      if (!deepEqualValue(designAxis.data, generatedAxis.data)) {
        diffs.push({ field: 'categoryValues', design: designAxis.data, generated: generatedAxis.data });
      }
    }
  }
  if (Array.isArray(design.color) && Array.isArray(generated.color) && !deepEqualValue(design.color, generated.color)) {
    if (!deepEqualValue(design.color, ECHARTS_DEFAULT_COLOR)) {
      diffs.push({ field: 'color', design: design.color, generated: generated.color });
    }
  }
  return diffs;
}

export interface DesignPairDetail {
  order: number;
  designRef: string;
  renderRef: string;
  specId: string;
  diffs: OptionDiff[];
}

export interface PairDesignResult {
  pairs: PairResult[];
  details: DesignPairDetail[];
}

/** 按设计稿顺序与渲染页里的图表项一一配对；数量不齐时缺的一方记为 pending。 */
export function pairDesignCharts(design: DesignChart[], model: RenderModel): PairDesignResult {
  const rendered = model.items.filter((item) => item.kind === 'chart');
  const pairs: PairResult[] = [];
  const details: DesignPairDetail[] = [];
  const count = Math.max(design.length, rendered.length);
  for (let index = 0; index < count; index++) {
    const chart = design[index];
    const item = rendered[index];
    const designRef = chart ? chart.card || chart.id || `order:${chart.order}` : '';
    if (!chart || !item) {
      pairs.push({
        specId: item?.specId ?? chart?.id ?? '',
        designRef: designRef || `order:${index}`,
        renderRef: item?.i ?? '',
        verdict: 'pending',
        knownDiffs: [chart ? 'RENDER_ITEM_MISSING' : 'DESIGN_CHART_MISSING'],
      });
      continue;
    }
    const diffs = compareOptions(chart.option, item.option ?? {});
    pairs.push({
      specId: item.specId ?? '',
      designRef,
      renderRef: item.i,
      verdict: diffs.length === 0 ? 'match' : 'diff',
      knownDiffs: diffs.map((diff) => diff.field),
    });
    details.push({ order: index, designRef, renderRef: item.i, specId: item.specId ?? '', diffs });
  }
  return { pairs, details };
}
