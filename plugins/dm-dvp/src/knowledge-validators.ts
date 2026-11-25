/** 已安装业务验证器：用固定正/反/边界用例复现 DVP 种子的关键声明。
 *  用例是固定代码；模型 JSON 只能选择运行哪个已注册验证器，不能提供用例本身。 */
import { coerceChangeMark, coerceRuleInput } from './rules.js';
import { coerceManualReview } from './input.js';
import { parseLogic } from './firewhen.js';
import { renderChecks } from './render.js';
import { dvpSeeds } from './knowledge-seeds.js';
import { digest, normalizeDraft } from '../../../packages/platform-knowledge/src/schema.js';
import type { ValidationSuite, KnowledgeRecord, MethodCase } from '../../../packages/platform-knowledge/src/schema.js';

type CaseInput =
  | { op: 'change-mark'; value: string }
  | { op: 'firewhen-status'; logic: string }
  | { op: 'null-operator'; logic: string }
  | { op: 'grouping-flag'; logic: string }
  | { op: 'programming-empty' };

const ruleFor = (logic: string) => coerceRuleInput({
  id: 'VAL', queryType: 'Custom', formName: 'Form', targetField: 'A', discrepancyText: 'd', logic,
});

const changeMarkSeed = dvpSeeds.find((seed) => seed.knowledgeId === 'dm-dvp.changemark.format');
if (!changeMarkSeed) throw new Error('DVP_CHANGEMARK_SEED_MISSING');
const fireWhenSeed = dvpSeeds.find((seed) => seed.knowledgeId === 'dm-dvp.firewhen.dialect');
if (!fireWhenSeed) throw new Error('DVP_FIREWHEN_SEED_MISSING');
const uatSeed = dvpSeeds.find((seed) => seed.knowledgeId === 'dm-dvp.uat.boundaries');
if (!uatSeed) throw new Error('DVP_UAT_SEED_MISSING');
/** 窄声明：仅由下列固定用例逐条复现；宽方法正文不在验证范围。 */
const FIREWHEN_CLAIMS = [
  'fire-when structured vs freeform detection',
  'narrative logic degrades to freeform',
  'is missing renders IsMissing operator',
  'is not missing renders IsPopulated operator',
  'mixed and/or grouping flagged NEEDS_MANUAL_GROUPING',
];
const UAT_CLAIMS = ['test case subject count forced to zero'];

export const dvpMethodSuite: ValidationSuite = {
  id: 'dm-dvp.methods-suite',
  version: '1.1.0',
  knowledgeIds: dvpSeeds.map((s) => s.knowledgeId),
  // 仅窄声明可被本套件逐条复现；template/protocol/cases 种子的宽正文保持 CANDIDATE（仅参考）。
  coverage: [
    {
      knowledgeId: 'dm-dvp.changemark.format',
      candidateDigest: digest(normalizeDraft(changeMarkSeed)),
      claims: ['change-mark action/version', 'change-mark unknown action'],
      evidence: [{ suiteId: 'dm-dvp.methods-suite', suiteVersion: '1.1.0', caseIds: ['change-mark-add', 'change-mark-delete', 'change-mark-unknown-action'] }],
    },
    {
      knowledgeId: 'dm-dvp.firewhen.dialect',
      candidateDigest: digest(normalizeDraft(fireWhenSeed)),
      claims: FIREWHEN_CLAIMS,
      evidence: [{ suiteId: 'dm-dvp.methods-suite', suiteVersion: '1.1.0', caseIds: ['firewhen-structured', 'firewhen-freeform', 'null-missing-operator', 'null-populated-operator', 'mixed-logic-grouping-flag'] }],
    },
    {
      knowledgeId: 'dm-dvp.uat.boundaries',
      candidateDigest: digest(normalizeDraft(uatSeed)),
      claims: UAT_CLAIMS,
      evidence: [{ suiteId: 'dm-dvp.methods-suite', suiteVersion: '1.1.0', caseIds: ['programming-counts-forced-zero'] }],
    },
  ],
  cases: [
    { id: 'change-mark-add', group: 'positive',
      input: { op: 'change-mark', value: 'Add/V2.0' } as CaseInput,
      expected: { action: 'Add', version: 'V2.0' } },
    { id: 'change-mark-delete', group: 'boundary',
      input: { op: 'change-mark', value: 'Delete/V3.1' } as CaseInput,
      expected: { action: 'Delete', version: 'V3.1' } },
    { id: 'change-mark-unknown-action', group: 'negative',
      input: { op: 'change-mark', value: 'Bogus/V1' } as CaseInput,
      expected: null },
    { id: 'firewhen-structured', group: 'positive',
      input: { op: 'firewhen-status', logic: 'fire when A > 1' } as CaseInput,
      expected: 'structured' },
    { id: 'firewhen-freeform', group: 'negative',
      input: { op: 'firewhen-status', logic: 'review per manual process' } as CaseInput,
      expected: 'freeform' },
    { id: 'null-missing-operator', group: 'positive',
      input: { op: 'null-operator', logic: 'fire when DMSTDTC is missing' } as CaseInput,
      expected: 'IsMissing' },
    { id: 'null-populated-operator', group: 'boundary',
      input: { op: 'null-operator', logic: 'fire when AETERM is not missing' } as CaseInput,
      expected: 'IsPopulated' },
    { id: 'mixed-logic-grouping-flag', group: 'negative',
      input: { op: 'grouping-flag', logic: 'fire when (A > 1 OR B < 2) AND C = 3' } as CaseInput,
      expected: true },
    { id: 'programming-counts-forced-zero', group: 'positive',
      input: { op: 'programming-empty' } as CaseInput,
      expected: 0 },
  ],
  async execute(_record: Readonly<KnowledgeRecord>, testCase: Readonly<MethodCase>): Promise<unknown> {
    const input = testCase.input as CaseInput;
    switch (input.op) {
      case 'change-mark':
        return coerceChangeMark(input.value);
      case 'firewhen-status':
        return parseLogic(input.logic).status;
      case 'null-operator': {
        const result = renderChecks([ruleFor(input.logic)], 'rave-steps');
        return result.rules[0].steps[0]?.operator ?? null;
      }
      case 'grouping-flag': {
        const result = renderChecks([ruleFor(input.logic)], 'rave-steps');
        return result.rules[0].warnings.includes('NEEDS_MANUAL_GROUPING');
      }
      case 'programming-empty': {
        const manual = coerceManualReview({
          id: 'MP-1', formName: 'Form', reportDescription: 'desc',
          programming: { assign: 'DMG', columnHeading: 'Listing' },
        });
        return manual.programming?.testCaseSubjectCount ?? -1;
      }
      default:
        throw new Error('UNSUPPORTED_VALIDATION_OP');
    }
  },
};
