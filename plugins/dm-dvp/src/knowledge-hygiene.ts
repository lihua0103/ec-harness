/** 知识沉淀卫生闸与范围纪律（裁决归代码：命中只回报类别计数，绝不回显命中值）。
 *
 *  范围纪律：项目专属的观察/裁定落 project scope（仅该项目可见）；跨项目通用方法才落 plugin scope。
 *  plugin scope 的记录对该插件的所有项目可见——项目代号写进去，就等于跨项目可见。
 *  敏感内容：本机路径 / UNC / 邮箱 / 手机号 / 证件号在任何 scope 都不是方法知识；项目代号只允许 project scope。
 *  数据安全开关（data-boundary.ts）：开启（redacted，默认）时命中即拒绝写入；关闭（full）时不拦截，
 *  但照常回报命中计数——放不放行由用户的开关决定，代码只负责如实体检。
 *  检测是启发式的（计数用于提示与拦截，不是审计结论）；没有命中的正文仍须由沉淀者保证已去项目化。 */
import { dataBoundaryMode } from './data-boundary.js';

export type CaptureScope = { scope: 'plugin' } | { scope: 'project'; projectId: string };

export const SENSITIVE_CATEGORIES = ['LOCAL_PATH', 'UNC_PATH', 'EMAIL', 'PHONE', 'ID_NUMBER', 'PROJECT_CODE'] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];
export type SensitiveHits = Partial<Record<SensitiveCategory, number>>;

const NOT_IN_PATH = '\\s"\'<>|，。；';
const PATTERNS: Record<SensitiveCategory, RegExp> = {
  // 盘符绝对路径与类 Unix 家目录；冒号前是字母的不算（排除 http:// 这类 URL）。
  LOCAL_PATH: new RegExp(`(?<![A-Za-z])[A-Za-z]:[\\\\/][^${NOT_IN_PATH}]{3,}|(?<![\\w/.-])/(?:home|Users|mnt|media|srv|opt)/[^${NOT_IN_PATH}]{3,}`, 'g'),
  UNC_PATH: /\\\\[A-Za-z0-9._-]+\\[^\s"'<>|，。；]{2,}/g,
  EMAIL: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  // 中国大陆手机号 / 18 位证件号；前后不紧邻字母数字，避免命中十六进制摘要里的数字片段。
  PHONE: /(?<![0-9A-Za-z-])1[3-9]\d{9}(?![0-9A-Za-z-])/g,
  ID_NUMBER: /(?<![0-9A-Za-z-])\d{17}[0-9Xx](?![0-9A-Za-z-])/g,
  // 项目代号形态：大写字母 + 连字符 + 数字。两位数字须再接分段（排除 ICD-10 这类标准词），三位以上直接命中。
  PROJECT_CODE: /(?<![A-Za-z0-9_-])[A-Z]{2,8}-\d{3,}(?:-[A-Z0-9]{1,8})*|(?<![A-Za-z0-9_-])[A-Z]{2,8}-\d{2}(?:-[A-Z0-9]{1,8})+(?![A-Za-z0-9_-])/g,
};
/** 知识 ID 分段里的「字母紧跟数字」形态（项目代号常被写进 ID，如 <代号><年份>）。 */
const ID_CODE_SEGMENT = /(^|\.)[a-z]{2,6}\d{2,4}(?=\.|$)/gi;

/** 任何 scope 都不该出现的类别；PROJECT_CODE 只在跨项目可见的 plugin scope 才拦截。 */
const FATAL_ANY_SCOPE: ReadonlySet<SensitiveCategory> = new Set<SensitiveCategory>(['LOCAL_PATH', 'UNC_PATH', 'EMAIL', 'PHONE', 'ID_NUMBER']);

/** 体检：返回各类别命中次数（不含命中值本身）。 */
export function scanSensitive(text: string, knowledgeId: string): SensitiveHits {
  const hits: SensitiveHits = {};
  const add = (category: SensitiveCategory, count: number): void => {
    if (count > 0) hits[category] = (hits[category] ?? 0) + count;
  };
  for (const category of SENSITIVE_CATEGORIES) add(category, (text.match(PATTERNS[category]) ?? []).length);
  add('PROJECT_CODE', (knowledgeId.match(ID_CODE_SEGMENT) ?? []).length);
  return hits;
}

/** 范围由是否给出 projectId 决定：给出=project scope（仅该项目可见），空白=plugin scope（跨项目）。 */
export function resolveCaptureScope(projectId: string | undefined): CaptureScope {
  const trimmed = (projectId ?? '').trim();
  return trimmed ? { scope: 'project', projectId: trimmed } : { scope: 'plugin' };
}

export interface HygieneDecision {
  mode: 'redacted' | 'full';
  hits: SensitiveHits;
  /** 仅数据安全开启且命中拦截类别时为 true；调用方据此拒绝写入。 */
  rejected: boolean;
  reason?: string;
}

/** 沉淀前体检：开关开启→命中即拒；开关关闭→只回报。 */
export function captureHygiene(input: { knowledgeId: string; text: string; scope: 'plugin' | 'project' }): HygieneDecision {
  const hits = scanSensitive(input.text, input.knowledgeId);
  if (dataBoundaryMode() === 'full') return { mode: 'full', hits, rejected: false };
  const fatal = SENSITIVE_CATEGORIES.filter(
    (category) => (hits[category] ?? 0) > 0 && (FATAL_ANY_SCOPE.has(category) || (input.scope === 'plugin' && category === 'PROJECT_CODE')),
  );
  if (!fatal.length) return { mode: 'redacted', hits, rejected: false };
  const counts = fatal.map((category) => `${category}=${hits[category] ?? 0}`).join(' ');
  return {
    mode: 'redacted',
    hits,
    rejected: true,
    reason: `候选含不该进入知识库的内容，未写入（命中类别计数：${counts}）。本机路径/联系方式/证件号请删除；`
      + '项目代号或项目专属内容请带 projectId 按 project scope 沉淀，或改写为去项目化的通用描述后重试。',
  };
}

/** 检索结果的诚实标注：候选与 ACTIVE 一并返回时逐条可辨，不让未验证内容混充已验证方法。 */
export function summarizeKnowledgeItems(items: ReadonlyArray<{ state?: string }>, matched: number): {
  summary: { matched: number; returned: number; active: number; candidate: number };
  stateNotice?: string;
} {
  const candidate = items.filter((item) => item.state === 'CANDIDATE').length;
  const returned = items.length;
  return {
    summary: { matched, returned, active: returned - candidate, candidate },
    ...(candidate
      ? { stateNotice: `返回的 ${returned} 条中有 ${candidate} 条为 CANDIDATE：未通过已安装验证器的候选，仅供参考，不是已验证方法。` }
      : {}),
  };
}
