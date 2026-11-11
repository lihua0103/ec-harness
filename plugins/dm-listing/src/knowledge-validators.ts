/** Installed business validator: reproduces the key claims of intake knowledge against the
 *  live archive helpers. Cases and expected values are fixed code; model JSON can choose WHICH
 *  registered validator to run, never supply the tests themselves. */
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {splitTokens,tokenCandidates,passwordCandidates} from './archive.js';
import type {ValidationSuite,KnowledgeRecord,MethodCase} from '../../../packages/platform-knowledge/src/schema.js';

type CaseInput=
  |{op:'tokens';value:string;take?:number}
  |{op:'password-order';explicitPassword?:string;projectName:string;sidecarName?:string;sidecarText?:string;zipName?:string;take?:number}
  |{op:'password-last';explicitPassword?:string;projectName:string;sidecarName?:string;sidecarText?:string;zipName?:string};

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

export const listingMethodSuite:ValidationSuite={
  id:'dm-listing.intake-suite',
  version:'1.0.0',
  knowledgeIds:['dm-listing.intake.methods'],
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
