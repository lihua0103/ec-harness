/** DVP 任务的输入发现与通用工作簿读取（2026-11-24）。
 *
 *  背景：真实会话里模型不知道工作目录里有什么，连续调用了并不存在的 dm_dvp_read_als /
 *  dm_dvp_list_files / dm_dvp_scan（全部 UNKNOWN_TOOL），最后停下向操作者要路径。本模块补上
 *  "先看见输入"的能力；工具只给能力与诚实信息，不编排调用步骤：
 *  - scanInputs：列出目录内的方案 PDF 与工作簿文件——只看存在、扩展名、大小、修改时间，不读内容；
 *  - readInputWorkbook：读取非 DVP 模板工作簿（ALS / 数据库结构等）的任意 sheet。
 *
 *  数据边界（parse.ts 头注、docs/DVP-TEMPLATE-SCHEMA.md §8，不可协商）在这里同样成立：
 *  - 识别为 DVP 模板的工作簿一律拒绝通用读取——Cover 永不读、Approval 不读、TEST CASE 受试者号与
 *    DM/DBD 评审意见只计数，这些只由 dm_dvp_overview / dm_dvp_parse_workbook 专用工具保证；
 *  - 任何工作簿里名为 Cover / Approval 的 sheet 都不读（与 classifySheet 同一条名称规则）。 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { Workbook, WorkbookError, type AlsSheetCell, type AlsSheetContent } from '../../../packages/platform-workbook/src/index.js';
import { classifySheet, DvpError, locateInsideDirectory } from './parse.js';
import { DATA_BOUNDARY_FULL_NOTICE, fullAccess } from './data-boundary.js';

// ── 输入发现 ──────────────────────────────────────────────────────────────────

export type InputKind = 'protocol' | 'workbook' | 'unsupportedWorkbook';

export interface ScannedInput {
  /** 相对 directory 的路径，统一用 / 分隔。 */
  path: string;
  /** protocol = 方案 PDF；workbook = 可读的 .xlsx/.xlsm；unsupportedWorkbook = 旧版/二进制工作簿（只列存在）。 */
  kind: InputKind;
  extension: string;
  bytes: number;
  /** 文件系统修改时间（ISO 8601）。 */
  modifiedAt: string;
}

export interface ScanOptions {
  /** 是否递归子目录；默认 true。 */
  recursive?: boolean;
  /** 递归深度上限（0 = 只看顶层）；默认 8，最大 32。 */
  maxDepth?: number;
}

export interface ScanResult {
  /** 解析后的真实目录。 */
  directory: string;
  /** 方案与工作簿文件，按路径排序。 */
  files: ScannedInput[];
  summary: { protocol: number; workbook: number; unsupportedWorkbook: number };
  /** 其他类型文件按扩展名计数（无扩展名记为 "(none)"），不逐个列出。 */
  other: Record<string, number>;
  scanned: { files: number; directories: number; truncated: boolean };
  /** 读取限制与跳过说明；为空表示完整扫描。 */
  notices: string[];
}

const LIST_LIMIT = 500;
const WALK_LIMIT = 20_000;
const DEFAULT_DEPTH = 8;
const MAX_DEPTH = 32;
const SKIPPED_DIRECTORIES = new Set(['node_modules']);

const kindOf = (extension: string): InputKind | null =>
  extension === 'pdf' ? 'protocol'
    : extension === 'xlsx' || extension === 'xlsm' ? 'workbook'
      : ['xls', 'xlsb', 'xltx', 'xltm', 'xlt'].includes(extension) ? 'unsupportedWorkbook'
        : null;

export function scanInputs(directory: string, options: ScanOptions = {}): ScanResult {
  const recursive = options.recursive ?? true;
  const maxDepthRaw = options.maxDepth ?? DEFAULT_DEPTH;
  if (!Number.isSafeInteger(maxDepthRaw) || maxDepthRaw < 0) throw new DvpError('SCAN_DEPTH_INVALID', String(maxDepthRaw));
  const maxDepth = Math.min(maxDepthRaw, MAX_DEPTH);
  let base: string;
  try { base = realpathSync(resolve(directory)); } catch { throw new DvpError('DIRECTORY_NOT_FOUND'); }
  if (!statSync(base).isDirectory()) throw new DvpError('NOT_A_DIRECTORY', base);

  const files: ScannedInput[] = [];
  const other: Record<string, number> = {};
  const notices: string[] = [];
  const summary = { protocol: 0, workbook: 0, unsupportedWorkbook: 0 };
  const scanned = { files: 0, directories: 0, truncated: false };
  const tooDeep = new Set<number>();
  const unreadable: string[] = [];
  const toRelative = (full: string): string => relative(base, full).split(sep).join('/');

  const walk = (current: string, depth: number): void => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { unreadable.push(toRelative(current)); return; }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      // Point-prefixed entries are tooling state (.git, .platform); symbolic links are never followed so the
      // scan reports the tree under the given directory and nothing it points at.
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (depth >= maxDepth) { tooDeep.add(depth); continue; }
        scanned.directories += 1;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned.files += 1;
      if (scanned.files > WALK_LIMIT) { scanned.truncated = true; return; }
      const extension = extname(entry.name).slice(1).toLowerCase();
      const kind = kindOf(extension);
      if (kind === null) {
        const key = extension || '(none)';
        other[key] = (other[key] ?? 0) + 1;
        continue;
      }
      summary[kind] += 1;
      if (files.length >= LIST_LIMIT) { scanned.truncated = true; continue; }
      const stat = statSync(full, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      files.push({ path: toRelative(full), kind, extension, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  };
  walk(base, 0);

  files.sort((left, right) => left.path.localeCompare(right.path));
  // Key order follows the extension, not the walk: the same directory always serialises the same way.
  const otherCounts = Object.fromEntries(Object.entries(other).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  if (summary.unsupportedWorkbook > 0) {
    notices.push('LEGACY_WORKBOOK_NOT_READABLE：.xls / .xlsb 等旧版或二进制工作簿不能直接读取，需另存为 .xlsx。');
  }
  if (tooDeep.size > 0) notices.push(`DEPTH_REACHED：深度 ${maxDepth} 以内的目录已扫描，更深的子目录未扫描（可调大 maxDepth）。`);
  for (const path of unreadable) notices.push(`DIRECTORY_NOT_READABLE：${path}（无权限，已跳过）`);
  if (scanned.truncated) notices.push(`SCAN_TRUNCATED：结果超过上限（列出 ${LIST_LIMIT} 个方案/工作簿文件、遍历 ${WALK_LIMIT} 项），未列全。`);
  return { directory: base, files, summary, other: otherCounts, scanned, notices };
}

// ── 通用工作簿读取 ────────────────────────────────────────────────────────────

export interface InputSheetSummary {
  sheetId: string;
  name: string;
  visibility: string;
  /** classifySheet 的角色；这里的工作簿不会含 DVP 规则 sheet。 */
  role: string;
  /** false 仅因名称边界（Cover / Approval）。 */
  readable: boolean;
  note?: string;
}

/** 不带 sheetId 时的返回：sheet 清单，供调用方选择要读的 sheet。 */
export interface InputWorkbookInventory {
  kind: 'inventory';
  workbookPath: string;
  sha256: string;
  sheets: InputSheetSummary[];
  boundaryNotice: string[];
}

export interface InputSheetRead {
  kind: 'sheet';
  workbookPath: string;
  sha256: string;
  sheet: { sheetId: string; name: string; visibility: string };
  /** 实际读取的行窗口；整表读取时为 null。 */
  window: { startRow: number; endRow: number } | null;
  /** 按行列排序的单元格；公式单元格 value 为空、formula.text 为表达式（不给缓存值）。 */
  cells: AlsSheetCell[];
  mergedRanges: string[];
  hiddenRows: number[];
  hiddenColumns: Array<{ min: number; max: number }>;
  rowCount: number;
  warnings: string[];
  boundaryNotice: string[];
}

/** 出现任一即视为 DVP 模板工作簿的 sheet 角色（规则表）。dynamic / versionHistory 单独出现不构成模板。 */
const DVP_TEMPLATE_ROLES: ReadonlySet<string> = new Set(['crossField', 'fieldLevel', 'manualReview', 'manualReviewProgramming']);
/** 名称边界：这些 sheet 在任何工作簿里都不读。 */
const NEVER_READ_ROLES: ReadonlySet<string> = new Set(['cover', 'approval']);

const INPUT_BOUNDARY_NOTICES = [
  'DVP_TEMPLATE_USE_DEDICATED_TOOLS：DVP 模板工作簿不能经本工具读取，请用 dm_dvp_overview / dm_dvp_parse_workbook。',
  'COVER_AND_APPROVAL_NOT_READ：名为 Cover / Approval 的 sheet 内容不读取。',
];

/** 当前部署模式的边界声明（全量模式见 data-boundary.ts）。 */
function inputBoundaryNotices(): string[] {
  return fullAccess() ? [DATA_BOUNDARY_FULL_NOTICE] : INPUT_BOUNDARY_NOTICES;
}

export async function readInputWorkbook(
  directory: string,
  workbookPath: string,
  sheetId?: string,
  window?: { startRow: number; endRow: number },
): Promise<InputWorkbookInventory | InputSheetRead> {
  if (window !== undefined) {
    const { startRow, endRow } = window;
    if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(endRow) || startRow < 1 || endRow < startRow) {
      throw new DvpError('WINDOW_INVALID', 'startRow / endRow 须为 ≥1 的整数且 endRow ≥ startRow');
    }
  }
  const full = fullAccess();
  const real = locateInsideDirectory(directory, workbookPath);
  const buffer = readFileSync(real);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const workbook = await Workbook.open(buffer);
  try {
    const sheets = await workbook.listSheets();
    // The template check precedes every content read: a DVP template must never be read around its boundaries
    // (redacted mode only; a full-access deployment — all catalog models are company-internal — reads everything).
    const templateRoles = [...new Set(sheets.map((sheet) => classifySheet(sheet.name).role)
      .filter((role) => DVP_TEMPLATE_ROLES.has(role)))];
    if (templateRoles.length > 0 && !full) {
      throw new DvpError('DVP_TEMPLATE_USE_DEDICATED_TOOLS',
        `该工作簿含 DVP 规则 sheet（${templateRoles.join(' / ')}）：Cover 永不读、Approval 不读、TEST CASE 只计数，只能经 dm_dvp_overview / dm_dvp_parse_workbook 读取`);
    }
    if (sheetId === undefined) {
      return {
        kind: 'inventory',
        workbookPath: real,
        sha256,
        sheets: sheets.map((sheet) => {
          const classified = classifySheet(sheet.name);
          return {
            sheetId: sheet.id, name: sheet.name, visibility: sheet.visibility, role: classified.role,
            readable: full || !NEVER_READ_ROLES.has(classified.role),
            ...(classified.note ? { note: classified.note } : {}),
          };
        }),
        boundaryNotice: inputBoundaryNotices(),
      };
    }
    const sheet = sheets.find((candidate) => candidate.id === sheetId);
    if (!sheet) {
      throw new DvpError('UNKNOWN_SHEET', `sheetId ${sheetId} 不存在；可用：${sheets.map((candidate) => `${candidate.id}=${candidate.name}`).join(', ')}`);
    }
    const classified = classifySheet(sheet.name);
    if (!full && NEVER_READ_ROLES.has(classified.role)) {
      throw new DvpError('SHEET_CONTENT_NOT_READ', `${classified.note ?? '该 sheet 内容不读取'}（既定数据边界）`);
    }
    let content: AlsSheetContent;
    try {
      content = await workbook.readWorksheet(sheetId, window);
    } catch (error) {
      if (error instanceof WorkbookError && error.code === 'TOO_MANY_CELLS') {
        throw new DvpError('SHEET_TOO_LARGE_USE_WINDOW', '该 sheet 单次读取过大；请用 startRow / endRow 分窗口读取（建议每窗 ≤ 1000 行）');
      }
      throw error;
    }
    const rows = new Set<number>();
    for (const cell of content.cells) rows.add(Number(/[1-9][0-9]*$/.exec(cell.ref)?.[0]));
    return {
      kind: 'sheet',
      workbookPath: real,
      sha256,
      sheet: { sheetId: sheet.id, name: sheet.name, visibility: sheet.visibility },
      window: window ?? null,
      cells: content.cells,
      mergedRanges: content.mergedRanges,
      hiddenRows: content.hiddenRows,
      hiddenColumns: content.hiddenColumns,
      rowCount: rows.size,
      warnings: content.warnings,
      boundaryNotice: inputBoundaryNotices(),
    };
  } finally {
    workbook.close();
  }
}
