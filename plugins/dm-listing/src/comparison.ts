/** Generalized batch-comparison contract (2026-11-23 manual-listing incident memo):
 *  the comparison deliverable is produced by the SAME single-file program tail, never by a
 *  separately deployed script or a static key-config file; the embedded key config is derived
 *  from the actual column sets of both sides. Pure functions only — the generated R program
 *  embeds the same contract and re-checks row-level uniqueness at run time. */

export const COMPARISON_CONTRACT_VERSION = 'batch-comparison-v1';
/** Key candidate chain, tried in order: keep the largest subset present in BOTH sides' columns. */
export const DEFAULT_CMP_KEY_CANDIDATES = ['SUBJID', 'RECORDID', 'SUBTRID', 'CSN'] as const;
/** Without any common candidate, fall back to this subject column of the new side alone. */
export const FALLBACK_CMP_KEY = 'SUBJID';
/** Within-group sequence appended to every key so split-listing twin rows stay one-key-one-row. */
export const CMP_SEQ_COLUMN = 'CmpRowSeq';

export type ComparisonRow = Record<string, unknown>;

export interface ComparisonKeyPlan {
  listing: string;
  baseKeys: string[];
  fullKey: string[];
  source: 'common-candidates' | 'fallback-subject' | 'positional';
}

const columnsOf = (columns: readonly string[] | undefined): string[] => (Array.isArray(columns) ? [...columns] : []);

/** Per listing: candidate-ordered max common subset of both sides' columns, subject fallback,
 *  positional pairing as the last resort. The old side without this listing yields no keys. */
export function deriveComparisonKeyPlans(
  newColumns: Readonly<Record<string, readonly string[]>>,
  oldColumns: Readonly<Record<string, readonly string[]>>,
  candidates: readonly string[] = DEFAULT_CMP_KEY_CANDIDATES,
): ComparisonKeyPlan[] {
  const plans: ComparisonKeyPlan[] = [];
  for (const listing of Object.keys(newColumns)) {
    const present = columnsOf(newColumns[listing]);
    const previous = columnsOf(oldColumns[listing]);
    let base = candidates.filter((key) => present.includes(key) && previous.includes(key));
    let source: ComparisonKeyPlan['source'] = 'common-candidates';
    if (!base.length) {
      base = present.includes(FALLBACK_CMP_KEY) ? [FALLBACK_CMP_KEY] : [];
      source = base.length ? 'fallback-subject' : 'positional';
    }
    plans.push({ listing, baseKeys: base, fullKey: [...base, CMP_SEQ_COLUMN], source });
  }
  return plans;
}

/** R-paste-compatible cell stringification: NA text for missing values, TRUE/FALSE booleans. */
const cmpCellValue = (value: unknown): string =>
  value === undefined || value === null
    ? 'NA'
    : typeof value === 'boolean'
      ? value ? 'TRUE' : 'FALSE'
      : String(value);

const rowKey = (row: ComparisonRow, keys: readonly string[]): string =>
  keys.map((key) => cmpCellValue(row[key])).join('\r');

/** Key columns this table actually has; unknown key columns drop out like R intersect(). */
const presentKeys = (rows: readonly ComparisonRow[], keys: readonly string[]): string[] =>
  rows.length ? keys.filter((key) => Object.prototype.hasOwnProperty.call(rows[0], key)) : [];

/** Within-group 1-based sequence over baseKeys groups. Empty tables yield an empty sequence —
 *  the empty-form guard: an empty listing must never surface as a missing-key crash. */
export function assignComparisonSeq(rows: readonly ComparisonRow[], baseKeys: readonly string[]): number[] {
  const usable = presentKeys(rows, baseKeys);
  const counters = new Map<string, number>();
  return rows.map((row) => {
    const group = rowKey(row, usable);
    const next = (counters.get(group) ?? 0) + 1;
    counters.set(group, next);
    return next;
  });
}

/** Duplicated-row count over the full comparison key (sum of R duplicated()); nonzero aborts. */
export function countDuplicateKeys(rows: readonly ComparisonRow[], fullKey: readonly string[]): number {
  const usable = presentKeys(rows, fullKey);
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const key = rowKey(row, usable);
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return duplicates;
}

export interface ComparisonReadiness {
  action: 'PRODUCE' | 'SKIP';
  reason: 'BASELINE_AND_ENGINE_READY' | 'BASELINE_MISSING_FIRST_DELIVERY' | 'ENGINE_UNAVAILABLE';
  mainListingAffected: false;
}

/** Fault tolerance: a missing baseline (first delivery) or engine never blocks the main listing. */
export function comparisonReadiness(baselineRdsPresent: boolean, engineInstalled: boolean): ComparisonReadiness {
  if (!baselineRdsPresent) return { action: 'SKIP', reason: 'BASELINE_MISSING_FIRST_DELIVERY', mainListingAffected: false };
  if (!engineInstalled) return { action: 'SKIP', reason: 'ENGINE_UNAVAILABLE', mainListingAffected: false };
  return { action: 'PRODUCE', reason: 'BASELINE_AND_ENGINE_READY', mainListingAffected: false };
}

/** Run-log checkpoints the operator verifies after execution (日志检查点：三行核对). The process
 *  exit code is never evidence: a skipped or failed comparison still exits 0 with the main listing
 *  delivered. A delivered program may not print the baseline-loaded line (the reference program
 *  only reports a missing baseline); then the absence of every skip/failure line is the evidence. */
export const COMPARISON_CHECKPOINTS = [
  { id: 'baseline-loaded', requirement: '日志出现比对基线加载行（含基线 RDS 路径）；程序不打印该行时，以未出现未找到旧版基线、引擎未安装、比对件生成失败三类提示为准' },
  { id: 'key-uniqueness-passed', requirement: '日志出现比对键唯一性校验通过行（两侧一行一键；重复则中止）' },
  { id: 'comparison-artifact-written', requirement: '日志出现比对件生成行，且 (vs旧批次) 着色件实际存在' },
] as const;
