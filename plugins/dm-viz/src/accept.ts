/**
 * 验收：以单个图表项为粒度。P1 只做配置级检查（能否产出可渲染数据）；
 * DOM 级空白/画布计数需要浏览器，另行执行，不能由这里替代。
 */
import { buildItem, type RenderItem } from './render.js';
import { orderedItems, pageDigest, rectsOverlap, type Bundle, type LayoutItem } from './spec.js';

export type Verdict = 'match' | 'diff' | 'pending';

export interface PairResult {
  specId: string;
  designRef: string;
  renderRef: string;
  verdict: Verdict;
  knownDiffs: string[];
}

export interface AcceptanceRecord {
  pageId: string;
  level: 'config';
  specDigest: string;
  structure: {
    items: number;
    rendered: number;
    blank: number;
    canvases: number;
    tables: number;
    cards: number;
    dividers: number;
    overlaps: number;
    orphans: number;
    errors: string[];
    blankItems: string[];
  };
  pairs: PairResult[];
  result: 'pass' | 'fail';
  note: string;
}

function issueText(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    const message = error instanceof Error ? error.message : code;
    return message.startsWith(code) ? message : `${code}: ${message}`;
  }
  return error instanceof Error ? error.message : 'UNKNOWN';
}

function overlapCount(items: LayoutItem[]): number {
  let count = 0;
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      if (rectsOverlap(items[a]!, items[b]!)) count++;
    }
  }
  return count;
}

export function acceptPage(bundle: Bundle, pairs: PairResult[] = []): AcceptanceRecord {
  const items = orderedItems(bundle.layout);
  const specIds = new Set(bundle.specs.map((spec) => spec.id));
  const errors: string[] = [];
  const blankItems: string[] = [];
  let rendered = 0;
  let canvases = 0;
  let tables = 0;
  let cards = 0;
  let dividers = 0;
  let orphans = 0;

  for (const item of items) {
    if (item.kind === 'divider') {
      dividers++;
      rendered++;
      continue;
    }
    if (!specIds.has(item.specId)) {
      orphans++;
      errors.push(`LAYOUT_ORPHAN_SPEC@${item.i}:${item.specId}`);
      continue;
    }
    let built: RenderItem;
    try {
      built = buildItem(bundle, item);
    } catch (error) {
      errors.push(`BUILD_FAILED@${item.i}:${issueText(error)}`);
      continue;
    }
    rendered++;
    if (built.kind === 'chart') canvases++;
    else if (built.kind === 'table') tables++;
    else if (built.kind === 'cards') cards++;
    if (built.points <= 0) blankItems.push(item.i);
  }

  const pendingPairs = pairs.filter((pair) => pair.verdict === 'pending').length;
  const result =
    blankItems.length === 0 &&
    errors.length === 0 &&
    orphans === 0 &&
    overlapCount(items) === 0 &&
    rendered === items.length &&
    pendingPairs === 0
      ? 'pass'
      : 'fail';

  return {
    pageId: bundle.layout.pageId,
    level: 'config',
    specDigest: pageDigest(bundle),
    structure: {
      items: items.length,
      rendered,
      blank: blankItems.length,
      canvases,
      tables,
      cards,
      dividers,
      overlaps: overlapCount(items),
      orphans,
      errors,
      blankItems,
    },
    pairs,
    result,
    note: '配置级验收：只证明每项能由配置产出可渲染数据；DOM 空白、画布数量与设计稿像素比对需浏览器执行，另行记录。',
  };
}
