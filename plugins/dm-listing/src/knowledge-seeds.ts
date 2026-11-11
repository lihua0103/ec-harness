/** Transitional single-source seed bodies; future content packaging must not duplicate these texts. */
import type {KnowledgeDraft} from '../../../packages/platform-knowledge/src/schema.js';
import {manualMethods} from './manual-methods.js';
import {pkCommonMethods,pkBeMethods,pkSadMadMethods} from './pk-methods.js';
import {intakeMethods} from './intake-methods.js';
export const LISTING_PLUGIN_ID='dm-listing';
export const LISTING_SEED_VERSION='2026.11.09.3';
function seed(id:string,title:string,method:string,scenarios:string[],topics:string[],preconditions:string[],notApplicable:string[],counterexamples:string[],source:string):KnowledgeDraft {
  return {knowledgeId:id,scope:'plugin',pluginId:LISTING_PLUGIN_ID,kind:'scenario_method',title,
    problemSignal:'历史交付中反复出现的需求理解、映射或执行错误',cause:'将不同语义/数据形态混用或把旧项目惯例当默认',
    method,scenarios,edc:[],topics,preconditions,notApplicable,counterexamples,
    sources:[source,'Historical source extracted; behavior reproduction in this platform is pending.']};
}
export const listingSeeds:KnowledgeDraft[]=[
  seed('dm-listing.review.methods','Manual/Medical逐列解释及纠错',manualMethods,['review'],['manual','medical','row-logic','output-qc'],
    ['当前任务为review类Listing；按实际spec逐行解释'],['非review场景不可机械套列职责'],['flag=duplicated误为只输出重复行','人工说明误编自动异常阈值'],
    'legacy-ec-harness/knowledge-v2/manual'),
  seed('dm-listing.intake.methods','资料、ALS/SAS与运行纠错',intakeMethods,[],['intake','als','sas','runtime'],
    ['先核对当前文件版本与真实格式'],['旧EDC结构不能无证据推广到新系统'],['按目录叫csv就调用CSV解析','缺列误判为spec没有该列'],
    'legacy-ec-harness/knowledge-v2/manual/intake-and-pitfalls'),
  seed('dm-listing.pk.common','PK共同编号/时间/精度与交付',pkCommonMethods,['pk-common'],['pk','output-qc'],
    ['当前spec定义PK映射及来源关系'],['不得将共同方法当固定周期/给药规则'],['录入时间代替采样时间','BQL数值化或尾零丢失'],
    'legacy-ec-harness/knowledge-v2/pk-mapping'),
  seed('dm-listing.pk.be','BE周期与参照专项',pkBeMethods,['be'],['pk-be'],
    ['spec及投递形态确认为BE'],['不直接适用SAD/MAD多剂规则'],['受试者首次给药套所有周期','按周期奇偶猜治疗'],
    'legacy-ec-harness/knowledge-v2/pk-mapping/be'),
  seed('dm-listing.pk.sad-mad','SAD/MAD队列/名义日小时与基质',pkSadMadMethods,['sad-mad'],['pk-sad-mad'],
    ['spec及投递形态确认为SAD/MAD'],['不自动使用BE周期或旧项目隐藏策略'],['所有基质混用一条给药参照','未映射时点默认截0'],
    'legacy-ec-harness/knowledge-v2/pk-mapping/sad-mad'),
];
export const listingKnowledgeContribution={pluginId:LISTING_PLUGIN_ID,scenarioAliases:{
  manual:['review'],medical:['review'],pk:['pk-common'],be:['pk-common'],'sad-mad':['pk-common'],
}};
