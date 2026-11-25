/** Installed business validators: reproduce the key claims of intake and batch-comparison
 *  knowledge against live helpers. Cases and expected values are fixed code; model JSON can
 *  choose WHICH registered validator to run, never supply the tests themselves. */
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {splitTokens,tokenCandidates,passwordCandidates} from './archive.js';
import {listingSeeds} from './knowledge-seeds.js';
import {
  assignComparisonSeq,countDuplicateKeys,deriveComparisonKeyPlans,comparisonReadiness,
  DEFAULT_CMP_KEY_CANDIDATES,CMP_SEQ_COLUMN,
} from './comparison.js';
import {digest,normalizeDraft} from '../../../packages/platform-knowledge/src/schema.js';
import type {ValidationSuite,KnowledgeRecord,MethodCase} from '../../../packages/platform-knowledge/src/schema.js';

const intakeSeed=listingSeeds.find((s)=>s.knowledgeId==='dm-listing.intake.methods');
if(!intakeSeed)throw new Error('LISTING_INTAKE_SEED_MISSING');
/** 窄声明：仅由下列固定用例逐条复现；宽方法正文不在验证范围。 */
const INTAKE_CLAIMS=[
  'token candidates preserve delivered order',
  'explicit password precedes derived candidates',
  'password candidate list ends with empty fallback',
];

type CaseInput=
  |{op:'tokens';value:string;take?:number}
  |{op:'password-order';explicitPassword?:string;projectName:string;sidecarName?:string;sidecarText?:string;zipName?:string;take?:number}
  |{op:'password-last';explicitPassword?:string;projectName:string;sidecarName?:string;sidecarText?:string;zipName?:string;take?:number};

async function runPasswordCase(input:Extract<CaseInput,{op:'password-order'|'password-last'}>):Promise<unknown> {
  const dir=await mkdtemp(join(tmpdir(),'kmval-'));
  try{
    await mkdir(join(dir,input.projectName),{recursive:true});
    const dataDir=join(dir,input.projectName,'data');
    await mkdir(dataDir,{recursive:true});
    if(input.sidecarName&&input.sidecarText!==undefined)await writeFile(join(dataDir,input.sidecarName),input.sidecarText,'utf8');
    if(input.zipName)await writeFile(join(dataDir,input.zipName),'PK','utf8');
    const candidates=passwordCandidates({explicitPassword:input.explicitPassword,projectDir:join(dir,input.projectName),dataDir});
    return input.op==='password-last'?candidates[candidates.length-1]:candidates.slice(0,input.take??candidates.length);
  }finally{await rm(dir,{recursive:true,force:true});}
}

export const intakeMethodSuite:ValidationSuite={
  id:'dm-listing.intake-suite',
  version:'1.1.0',
  knowledgeIds:['dm-listing.intake.methods'],
  coverage:[{
    knowledgeId:'dm-listing.intake.methods',
    candidateDigest:digest(normalizeDraft(intakeSeed)),
    claims:INTAKE_CLAIMS,
    evidence:[{suiteId:'dm-listing.intake-suite',suiteVersion:'1.1.0',caseIds:['tokens-delivered-order','tokens-empty-input','password-order-delivered','password-list-ends-empty']}],
  }],
  cases:[
    {id:'tokens-delivered-order',group:'positive',
      input:{op:'tokens',value:'HXN6005_A1-201.zip',take:6} as CaseInput,
      expected:['HXN6005_A1-201.zip','HXN6005_A1-201','HXN6005','A1','201','zip']},
    {id:'tokens-empty-input',group:'negative',
      input:{op:'tokens',value:''} as CaseInput,
      expected:[]},
    {id:'tokens-single-short',group:'boundary',
      input:{op:'tokens',value:'a1'} as CaseInput,
      expected:['a1']},
    {id:'password-order-delivered',group:'positive',
      input:{op:'password-order',explicitPassword:'EXPL1',projectName:'PROJ-A',sidecarName:'pw.txt',sidecarText:'SIDE3CRET\n',zipName:'pack.zip',take:5} as CaseInput,
      expected:['EXPL1','PROJ-A','PROJ','PROJA','PROJ_A']},
    {id:'password-list-ends-empty',group:'boundary',
      input:{op:'password-last',projectName:'PROJ-B'} as CaseInput,
      expected:''},
    {id:'password-no-empty-skip-strong',group:'negative',
      input:{op:'password-order',explicitPassword:'',projectName:'PROJ-C',take:1} as CaseInput,
      expected:['PROJ-C']},
  ],
  async execute(_record:Readonly<KnowledgeRecord>,testCase:Readonly<MethodCase>):Promise<unknown> {
    const input=testCase.input as CaseInput;
    if(input.op==='tokens'){
      const value=String(input.value??'');
      const out=testCase.group==='negative'?splitTokens(value):tokenCandidates(value);
      return input.take!==undefined?out.slice(0,input.take):out;
    }
    if(input.op==='password-order'||input.op==='password-last')return runPasswordCase(input);
    throw new Error('UNSUPPORTED_VALIDATION_OP');
  },
};

const comparisonSeed=listingSeeds.find((s)=>s.knowledgeId==='dm-listing.batch-comparison.methods');
if(!comparisonSeed)throw new Error('LISTING_COMPARISON_SEED_MISSING');
/** 窄声明：仅由下列固定用例逐条复现；宽方法正文不在验证范围。 */
const COMPARISON_CLAIMS=[
  'common candidate keys form the max subset of both sides columns',
  'the comparison sequence is grouped per key starting at 1',
  'rows sharing a duplicate full comparison key abort the comparison',
  'an empty table yields an empty sequence instead of a crash',
  'a missing baseline or engine skips the comparison without affecting the main listing',
];

type CmpRow=Record<string,unknown>;
interface CmpCaseInput{
  op:'keys'|'seq'|'dupes'|'readiness';
  listings?:string[];
  newCols?:Record<string,string[]>;
  oldCols?:Record<string,string[]>;
  candidates?:string[];
  rows?:CmpRow[];
  baseKeys?:string[];
  baselineRdsPresent?:boolean;
  engineInstalled?:boolean;
}

function runComparisonCase(input:CmpCaseInput):unknown{
  if(input.op==='keys'){
    const plans=deriveComparisonKeyPlans(input.newCols??{},input.oldCols??{},input.candidates??DEFAULT_CMP_KEY_CANDIDATES);
    return plans.map(p=>({listing:p.listing,baseKeys:p.baseKeys,fullKey:p.fullKey,source:p.source}));
  }
  if(input.op==='seq'){
    const seq=assignComparisonSeq(input.rows??[],input.baseKeys??[]);
    const rows=input.rows??[];
    return rows.map((row,index)=>({...row,[CMP_SEQ_COLUMN]:seq[index]}));
  }
  if(input.op==='dupes')return countDuplicateKeys(input.rows??[],input.baseKeys??[]);
  if(input.op==='readiness')return comparisonReadiness(input.baselineRdsPresent===true,input.engineInstalled===true);
  throw new Error('UNSUPPORTED_VALIDATION_OP');
}

export const comparisonMethodSuite:ValidationSuite={
  id:'dm-listing.comparison-suite',
  version:'1.0.0',
  knowledgeIds:['dm-listing.batch-comparison.methods'],
  coverage:[{
    knowledgeId:'dm-listing.batch-comparison.methods',
    candidateDigest:digest(normalizeDraft(comparisonSeed)),
    claims:COMPARISON_CLAIMS,
    evidence:[{suiteId:'dm-listing.comparison-suite',suiteVersion:'1.0.0',caseIds:[
      'keys-common-subset','keys-fallback-subject','keys-positional','seq-grouped',
      'dupes-none','dupes-abort','empty-table-empty-seq','readiness-first-delivery','readiness-no-engine']}],
  }],
  cases:[
    {id:'keys-common-subset',group:'positive',
      input:{op:'keys',newCols:{AE:['SUBJID','RECORDID','SUBTRID','CSN','TERM']},oldCols:{AE:['SUBJID','RECORDID','SUBTRID','CSN']}} as CmpCaseInput,
      expected:[{listing:'AE',baseKeys:['SUBJID','RECORDID','SUBTRID','CSN'],fullKey:['SUBJID','RECORDID','SUBTRID','CSN',CMP_SEQ_COLUMN],source:'common-candidates'}]},
    {id:'keys-fallback-subject',group:'positive',
      input:{op:'keys',newCols:{SV:['SUBJID','VISIT','DATE']},oldCols:{SV:['VISIT','SITEID','DATE']}} as CmpCaseInput,
      expected:[{listing:'SV',baseKeys:['SUBJID'],fullKey:['SUBJID',CMP_SEQ_COLUMN],source:'fallback-subject'}]},
    {id:'keys-positional',group:'boundary',
      input:{op:'keys',newCols:{X:['A','B']},oldCols:{X:['A','C']}} as CmpCaseInput,
      expected:[{listing:'X',baseKeys:[],fullKey:[CMP_SEQ_COLUMN],source:'positional'}]},
    {id:'seq-grouped',group:'positive',
      input:{op:'seq',baseKeys:['SUBJID','RECORDID'],rows:[
        {SUBJID:'S1',RECORDID:'R1',V:'a'},{SUBJID:'S1',RECORDID:'R1',V:'b'},
        {SUBJID:'S1',RECORDID:'R2',V:'c'},{SUBJID:'S2',RECORDID:'R9',V:'d'}]} as CmpCaseInput,
      expected:[
        {SUBJID:'S1',RECORDID:'R1',V:'a',[CMP_SEQ_COLUMN]:1},{SUBJID:'S1',RECORDID:'R1',V:'b',[CMP_SEQ_COLUMN]:2},
        {SUBJID:'S1',RECORDID:'R2',V:'c',[CMP_SEQ_COLUMN]:1},{SUBJID:'S2',RECORDID:'R9',V:'d',[CMP_SEQ_COLUMN]:1}]},
    {id:'dupes-none',group:'positive',
      input:{op:'dupes',baseKeys:['SUBJID','RECORDID','SUBTRID','CSN',CMP_SEQ_COLUMN],rows:[
        {SUBJID:'S1',RECORDID:'R1',SUBTRID:'T1',CSN:'C1',[CMP_SEQ_COLUMN]:1},
        {SUBJID:'S1',RECORDID:'R1',SUBTRID:'T1',CSN:'C1',[CMP_SEQ_COLUMN]:2},
        {SUBJID:'S2',RECORDID:'R1',SUBTRID:'T1',CSN:'C1',[CMP_SEQ_COLUMN]:1}]} as CmpCaseInput,
      expected:0},
    {id:'dupes-abort',group:'negative',
      input:{op:'dupes',baseKeys:['SUBJID','RECORDID'],rows:[
        {SUBJID:'S1',RECORDID:'R1'},{SUBJID:'S1',RECORDID:'R1'}]} as CmpCaseInput,
      expected:1},
    {id:'empty-table-empty-seq',group:'boundary',
      input:{op:'seq',baseKeys:['SUBJID','RECORDID'],rows:[]} as CmpCaseInput,
      expected:[]},
    {id:'readiness-first-delivery',group:'positive',
      input:{op:'readiness',baselineRdsPresent:false,engineInstalled:true} as CmpCaseInput,
      expected:{action:'SKIP',reason:'BASELINE_MISSING_FIRST_DELIVERY',mainListingAffected:false}},
    {id:'readiness-no-engine',group:'negative',
      input:{op:'readiness',baselineRdsPresent:true,engineInstalled:false} as CmpCaseInput,
      expected:{action:'SKIP',reason:'ENGINE_UNAVAILABLE',mainListingAffected:false}},
  ],
  async execute(_record:Readonly<KnowledgeRecord>,testCase:Readonly<MethodCase>):Promise<unknown> {
    const input=testCase.input as CmpCaseInput;
    if(input.op==='keys'||input.op==='seq'||input.op==='dupes'||input.op==='readiness')return runComparisonCase(input);
    throw new Error('UNSUPPORTED_VALIDATION_OP');
  },
};

/** Listing registers one validator per claim set; the index file picks them by id. */
export const listingMethodSuites:ValidationSuite[]=[intakeMethodSuite,comparisonMethodSuite];
/** Back-compat: callers that treat the listing validator as a single suite use the intake suite. */
export const listingMethodSuite:ValidationSuite=intakeMethodSuite;