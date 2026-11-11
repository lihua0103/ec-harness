import {manualMethods,MANUAL_METHODS_VERSION} from './manual-methods.js';
import {pkCommonMethods,pkBeMethods,pkSadMadMethods,PK_METHODS_VERSION} from './pk-methods.js';
import {intakeMethods} from './intake-methods.js';
export const METHOD_TOPICS=['intake','manual','medical','pk','pk-be','pk-sad-mad'] as const;
export type MethodTopic=typeof METHOD_TOPICS[number];
/** No project constant/schema decisions: retrieve methods and preserve their applicability limits. */
export function scenarioMethods(topic:MethodTopic){
  const texts:Record<MethodTopic,string>={intake:intakeMethods,manual:manualMethods,medical:manualMethods,
    pk:pkCommonMethods,'pk-be':pkCommonMethods+'\n\n'+pkBeMethods,'pk-sad-mad':pkCommonMethods+'\n\n'+pkSadMadMethods};
  if(!Object.hasOwn(texts,topic))throw new Error('METHOD_TOPIC_UNKNOWN');
  return {topic,version:topic==='manual'||topic==='medical'?MANUAL_METHODS_VERSION:PK_METHODS_VERSION,
    methods:texts[topic],authoritative:false,scope:'通用成功纠错方法；当前spec/ALS/数据事实与明确用户裁定优先，不携带旧项目业务常量。'};
}
export const scenarioMethodSkill=`三项目成功纠错方法入口：Manual、PK BE、PK SAD/MAD；Medical与Manual共用spec识别和处理方法，输出合同以当前项目为准。
调用dm_listing_scenario_methods按需取topic：intake（完整需求/版本/ALS/SAS/容器/执行纠错）、manual或medical（逐列职责、范围/行/列/输出）、pk（共同编号/时间/精度/盲态）、pk-be（周期/序列/多工件）、pk-sad-mad（队列/名义日小时/多剂/基质）。可直接自主编程运行，不要求先按固定顺序读完全部文档。
优先在当前问题上识别适用前提、反例与验证点。方法不是业务答案；不要迁入旧项目列、OID、阈值、特殊裁定或固定样式，不以安全审批或IR完整限制写码。真实项目的未解决含义列证据澄清，技术错误自主修复。`;
