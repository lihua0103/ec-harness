/**
 * 选型与缺口诊断：只回答"这份规格在平台上能否表达、缺什么"，不替模型读设计稿。
 */
import { catalogOf } from './catalog.js';
import { buildOption } from './option.js';
import { validateSpec, type Bundle, type ChartSpec } from './spec.js';

export interface PlanSpecResult {
  id: string;
  title: string;
  type: string;
  preset?: string;
  mode: string;
  shape?: string;
  points?: number;
  ok: boolean;
  issues: string[];
}

export interface PlanResult {
  ok: boolean;
  specs: PlanSpecResult[];
  gaps: string[];
}

function issueText(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    const message = error instanceof Error ? error.message : code;
    return message.startsWith(code) ? message : `${code}: ${message}`;
  }
  return error instanceof Error ? error.message : 'UNKNOWN';
}

export function planSpecs(bundle: Bundle): PlanResult {
  const results: PlanSpecResult[] = [];
  const gaps = new Set<string>();
  for (const spec of bundle.specs) {
    const issues: string[] = [];
    let shape: string | undefined;
    let points: number | undefined;
    try {
      shape = catalogOf(spec.type).shape;
      validateSpec(spec, bundle.datasets);
      const built = buildOption(bundle, spec);
      points = built.points;
      if (points <= 0) issues.push('RENDER_WOULD_BE_BLANK');
    } catch (error) {
      const text = issueText(error);
      issues.push(text);
      const code = text.split(':')[0] ?? text;
      gaps.add(code);
    }
    results.push({
      id: spec.id,
      title: spec.title,
      type: spec.type,
      preset: spec.preset,
      mode: spec.mode,
      shape,
      points,
      ok: issues.length === 0,
      issues,
    });
  }
  return { ok: results.every((result) => result.ok), specs: results, gaps: [...gaps].sort() };
}

export function planOne(spec: ChartSpec, bundle: Bundle): PlanSpecResult {
  return planSpecs({ ...bundle, specs: [spec] }).specs[0]!;
}
