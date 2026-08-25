import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';

/**
 * 来源域（Plane）判定 — 来源域架构的主判据（2026-08-21 设计）。
 *
 * 判据是"这个路径来自哪个域"，不是"这段内容像不像临床数据"：
 * 路径包含是判定性的（无误报），内容形态识别是不可判定的（补丁竞赛）。
 *
 * 优先级（安全侧优先）：
 *   data（数据域）> spec（规格档）> document（辅助档）> output（产物域）
 *
 *   data     : dataPlaneRoots 内的任何文件 + 全局数据类扩展名兜底
 *              （.sas7bdat 放在哪都属数据域——即便在 spec 根内）。
 *   spec     : specPlaneRoots 内（用户显式声明的规格文档子目录）→ 全文可读且不脱敏；
 *              未配置时自动检测：doc/spec/, doc/ALS/, doc/template/ 等常见目录。
 *   document : documentPlaneRoots 内但不在 spec 子目录 → 全文可读且不脱敏。
 *              未配置时自动检测：doc/ 下的非 spec 子目录。
 *   output   : outputPlaneRoot 内或项目内 .clinical-listing/output → 交付物，模型只见收据/表头。
 *
 * 全部返回 null 时保持既有行为（脱敏车道），完全向后兼容。
 */

export const DATA_PLANE_EXTS = ['.sas7bdat', '.xpt', '.sas7bcat'];

// 2026-08-21: 常见的 spec/document 目录名称（自动检测）
const SPEC_DIR_NAMES = ['spec', 'als', 'template', 'templates', 'requirements', '需求', '规格', '方案'];
const DOCUMENT_DIR_NAMES = ['doc', 'docs', 'document', 'documents', '辅助', '文档', '参考'];
const DATA_DIR_NAMES = ['data', 'dataset', 'datasets', 'raw', 'source', 'clinical', '受试者', '数据'];
const OUTPUT_DIR_NAMES = ['output', 'outputs', '交付物', '结果', 'report', 'reports'];
const EXCEL_DATA_EXTS = ['.xlsx', '.xlsm', '.xls', '.xlsb'];

// 常见的 spec/document 文件扩展名
const SPEC_EXT_NAMES = ['.md', '.txt', '.docx', '.doc', '.pdf', '.xlsx', '.xls'];
const DOCUMENT_EXT_NAMES = ['.xlsx', '.xls', '.csv'];

function inside(root, target) {
  if (!root || typeof target !== 'string' || !target.trim()) return false;
  const base = resolve(root);
  const path = resolve(target);
  const rel = relative(base, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function anyInside(roots, target) {
  return (roots ?? []).some((root) => inside(root, target));
}

function workspacePath(path, workspaceRoot) {
  if (!workspaceRoot || isAbsolute(path)) return path;
  return resolve(workspaceRoot, path);
}

/**
 * 2026-08-21: 自动检测平面目录。
 *
 * 未显式配置时，只检查工作区内约定的顶层目录，不递归枚举项目。
 *
 * @param {object} config - 包含 workspaceRoot, specPlaneRoots, documentPlaneRoots 的配置对象
 * @returns {object} - { specRoots: string[], documentRoots: string[] }
 */
export function autoDetectPlanes(config = {}) {
  const workspaceRoot = config.workspaceRoot || process.cwd();
  const specRoots = [...(config.specPlaneRoots || [])];
  const documentRoots = [...(config.documentPlaneRoots || [])];

  // 如果已有配置，不做自动检测
  if (specRoots.length > 0 || documentRoots.length > 0) {
    return { specRoots, documentRoots };
  }

  const addExisting = (list, path) => {
    if (existsSync(path) && !list.includes(path)) list.push(path);
  };
  for (const name of SPEC_DIR_NAMES) addExisting(specRoots, join(workspaceRoot, name));
  for (const docName of DOCUMENT_DIR_NAMES) {
    const docRoot = join(workspaceRoot, docName);
    addExisting(documentRoots, docRoot);
    for (const specName of SPEC_DIR_NAMES) addExisting(specRoots, join(docRoot, specName));
  }
  return { specRoots, documentRoots };
}

/**
 * 根据路径判断是否是数据文件扩展名
 */
function isDataExt(ext) {
  return ['.xlsx', '.xls', '.csv', '.sas7bdat', '.xpt', '.pkl'].includes(ext.toLowerCase());
}

/**
 * 根据路径判断是否是规格文档扩展名
 */
function isSpecExt(ext) {
  return ['.md', '.txt', '.docx', '.doc', '.pdf', '.xlsx', '.xls'].includes(ext.toLowerCase());
}

export function planeOf(path, config = {}) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const target = workspacePath(path, config.workspaceRoot);

  // 2026-08-21: 自动检测平面配置
  const { specRoots, documentRoots } = autoDetectPlanes(config);

  const extIdx = path.lastIndexOf('.');
  const ext = extIdx === -1 ? '' : path.slice(extIdx).toLowerCase();

  // 扩展名兜底优先于一切根声明：SAS 数据集无论被放进哪个目录都是数据域。
  if (DATA_PLANE_EXTS.includes(ext)) return 'data';

  const workspaceParts = config.workspaceRoot && inside(config.workspaceRoot, target)
    ? relative(resolve(config.workspaceRoot), resolve(target)).split(/[/\\]/)
    : [];
  const documentIndex = workspaceParts.findIndex((part) => (
    DOCUMENT_DIR_NAMES.some((name) => part.toLowerCase() === name.toLowerCase())
  ));
  const inDocumentRoot = anyInside(config.documentPlaneRoots, target)
    || documentRoots.some((root) => inside(root, target))
    || documentIndex >= 0;
  if (inDocumentRoot) {
    const nestedSpec = documentIndex >= 0 && workspaceParts.slice(documentIndex + 1).some((part) => (
      SPEC_DIR_NAMES.some((name) => part.toLowerCase() === name.toLowerCase())
    ));
    const inSpecRoot = anyInside(config.specPlaneRoots, target)
      || anyInside(specRoots, target)
      || nestedSpec;
    return inSpecRoot ? 'spec' : 'document';
  }

  // 2026-08-24: 产物域判定必须先于扩展名兜底。两个确定性判据：
  //   1) 显式配置的 outputPlaneRoot（托管部署的独立产物域）；
  //   2) 项目内 listing 交付目录 .clinical-listing/output——交付物跟随用户
  //      所选项目而非系统 .dsh 目录，未配置 outputPlaneRoot 时由
  //      listing_workflow 回退写入该位置。
  // 若放在 EXCEL_DATA_EXTS 兜底之后，交付 Excel 会被判成数据域，产物域
  // "仅表头"处置（EXCEL_STRUCTURE_ONLY）成为死分支。
  if (config.outputPlaneRoot && inside(config.outputPlaneRoot, target)) return 'output';
  if (workspaceParts.some(
    (part, index) => part === '.clinical-listing' && workspaceParts[index + 1] === 'output',
  )) return 'output';

  if (EXCEL_DATA_EXTS.includes(ext)) return 'data';

  if (anyInside(config.dataPlaneRoots, target)) return 'data';

  const inSpecRoot = anyInside(config.specPlaneRoots, target)
    || anyInside(specRoots, target);
  if (inSpecRoot) return 'spec';

  // 2026-08-21: 增强的自动检测 - 基于文件扩展名和目录结构
  // 如果文件在工作区内的 doc/spec/als/template 等目录下，且是规格文档扩展名
  if (config.workspaceRoot) {
    try {
      const absPath = resolve(target);
      const absRoot = resolve(config.workspaceRoot);
      if (inside(absRoot, absPath)) {
        const rel = relative(absRoot, absPath);
        const parts = rel.split(/[/\\]/);
        for (const part of parts) {
          const partLower = part.toLowerCase();
          if (SPEC_DIR_NAMES.some(n => partLower === n.toLowerCase())) {
            return 'spec';
          }
          if (DOCUMENT_DIR_NAMES.some(n => partLower === n.toLowerCase())) {
            return 'document';
          }
        }
      }
    } catch {
      // 忽略路径解析错误
    }
  }

  return null;
}

/** 环境变量形态：分号分隔（Windows 路径含冒号，不能用冒号分隔）。 */
export function parseRootsEnv(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(';').map((s) => s.trim()).filter(Boolean);
}

/**
 * 根配置校验（fail-fast，在 validateConfig 内调用）。
 * - dataPlaneRoots / documentPlaneRoots / outputPlaneRoot 必须已存在
 *   （打错路径静默失效等于防线虚设）。
 * - specPlaneRoots 允许暂不存在（用户先建目录再放文件是正常顺序），
 *   但不得与数据域互相嵌套。
 * - 数据域与文档/规格域不得互相嵌套——一个目录只能属于一个域。
 */
export function validatePlaneRoots(config = {}) {
  const errors = [];
  const checkExists = (roots, label) => {
    for (const root of roots) {
      if (!existsSync(root)) errors.push(`${label} 不存在: ${root}`);
    }
  };
  checkExists(config.dataPlaneRoots ?? [], 'dataPlaneRoots 条目');
  checkExists(config.documentPlaneRoots ?? [], 'documentPlaneRoots 条目');
  if (config.outputPlaneRoot && !existsSync(config.outputPlaneRoot)) {
    errors.push(`outputPlaneRoot 不存在: ${config.outputPlaneRoot}`);
  }
  const nested = (a, b) => a !== b
    && (inside(a, b) || inside(b, a));
  const pairs = [
    [config.dataPlaneRoots ?? [], config.specPlaneRoots ?? [], 'dataPlaneRoots', 'specPlaneRoots'],
    [config.dataPlaneRoots ?? [], config.documentPlaneRoots ?? [], 'dataPlaneRoots', 'documentPlaneRoots'],
  ];
  for (const [listA, listB, nameA, nameB] of pairs) {
    for (const a of listA) {
      for (const b of listB) {
        if (nested(a, b)) errors.push(`${nameA} 与 ${nameB} 不得互相嵌套: ${a} / ${b}`);
      }
    }
  }
  return errors;
}
