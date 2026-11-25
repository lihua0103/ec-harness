/** Transitional single-source seed bodies; future content packaging must not duplicate these texts. */
import type {KnowledgeDraft} from '../../../packages/platform-knowledge/src/schema.js';
import {manualMethods} from './manual-methods.js';
import {pkCommonMethods,pkBeMethods,pkSadMadMethods} from './pk-methods.js';
import {intakeMethods} from './intake-methods.js';
import {batchComparisonMethods} from './comparison-methods.js';
export const LISTING_PLUGIN_ID='dm-listing';
export const LISTING_SEED_VERSION='2026.11.24.1';
function seed(id:string,title:string,method:string,scenarios:string[],topics:string[],preconditions:string[],notApplicable:string[],counterexamples:string[],source:string,claims?:string[]):KnowledgeDraft {
  return {knowledgeId:id,scope:'plugin',pluginId:LISTING_PLUGIN_ID,kind:'scenario_method',title,
    problemSignal:'历史交付中反复出现的需求理解、映射或执行错误',cause:'将不同语义/数据形态混用或把旧项目惯例当默认',
    method,scenarios,edc:[],topics,preconditions,notApplicable,counterexamples,
    ...(claims?.length?{claims}:{}),
    sources:[source,'Historical source extracted; behavior reproduction in this platform is pending.']};
}
export const listingSeeds:KnowledgeDraft[]=[
  seed('dm-listing.review.methods','Manual/Medical逐列解释及纠错',manualMethods,['review'],['manual','medical','row-logic','output-qc'],
    ['当前任务为review类Listing；按实际spec逐行解释'],['非review场景不可机械套列职责'],['flag=duplicated误为只输出重复行','人工说明误编自动异常阈值'],
    'legacy-ec-harness/knowledge-v2/manual'),
  seed('dm-listing.intake.methods','资料、ALS/SAS与运行纠错',intakeMethods,[],['intake','als','sas','runtime'],
    ['先核对当前文件版本与真实格式'],['旧EDC结构不能无证据推广到新系统'],['按目录叫csv就调用CSV解析','缺列误判为spec没有该列'],
    'legacy-ec-harness/knowledge-v2/manual/intake-and-pitfalls',
    // 由 dm-listing.intake-suite 固定用例复现的窄声明；宽方法正文仍为参考，验证范围以回执为准。
    ['token candidates preserve delivered order',
     'explicit password precedes derived candidates',
     'password candidate list ends with empty fallback']),
  seed('dm-listing.pk.common','PK共同编号/时间/精度与交付',pkCommonMethods,['pk-common'],['pk','output-qc'],
    ['当前spec定义PK映射及来源关系'],['不得将共同方法当固定周期/给药规则'],['录入时间代替采样时间','BQL数值化或尾零丢失'],
    'legacy-ec-harness/knowledge-v2/pk-mapping'),
  seed('dm-listing.pk.be','BE周期与参照专项',pkBeMethods,['be'],['pk-be'],
    ['spec及投递形态确认为BE'],['不直接适用SAD/MAD多剂规则'],['受试者首次给药套所有周期','按周期奇偶猜治疗'],
    'legacy-ec-harness/knowledge-v2/pk-mapping/be'),
  seed('dm-listing.pk.sad-mad','SAD/MAD队列/名义日小时与基质',pkSadMadMethods,['sad-mad'],['pk-sad-mad'],
    ['spec及投递形态确认为SAD/MAD'],['不自动使用BE周期或旧项目隐藏策略'],['所有基质混用一条给药参照','未映射时点默认截0'],
    'legacy-ec-harness/knowledge-v2/pk-mapping/sad-mad'),
  seed('dm-listing.batch-comparison.methods','批次新旧比对自包含交付',batchComparisonMethods,['review'],['manual','medical','output-qc','row-logic'],
    ['批次交付合同包含New/Modified/Old比对件','主程序可自包含集成比对段','数据侧可发现旧批次基线RDS'],['首发无基线可跳过比对','独立比对脚本与静态键配置不得作为部署形态'],['FLAG列全New宣称为已完成比对','静态键配置跨批沿用','跨环境基线当同库基线','空表引用键列崩溃','内部命名直接喂比对引擎','近似脚本代替实装验证','静默失效的校验当已校验'],
    'hxn6005-manual-listing-incident-2026-11-23',
    ['common candidate keys form the max subset of both sides columns',
     'the comparison sequence is grouped per key starting at 1',
     'rows sharing a duplicate full comparison key abort the comparison',
     'an empty table yields an empty sequence instead of a crash',
     'a missing baseline or engine skips the comparison without affecting the main listing']),
];
export const listingKnowledgeContribution={pluginId:LISTING_PLUGIN_ID,scenarioAliases:{
  manual:['review'],medical:['review'],pk:['pk-common'],be:['pk-common'],'sad-mad':['pk-common'],
}};
