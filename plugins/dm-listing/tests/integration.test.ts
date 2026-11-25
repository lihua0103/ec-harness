import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Skills from '@deepseek-ai/dsh-skill';
import Questions from '@deepseek-ai/dsh-user-questions';
import * as Plugin from '../src/index.ts';
import * as PlatformKnowledge from '../../../packages/platform-knowledge/src/cordis.ts';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('real Cordis services mount and dispose tools/knowledge without changing ordinary tools',async()=>{
  const ctx=new Context();
  const root=await mkdtemp(join(tmpdir(),'listing-platform-integration-')),previousHome=process.env.DSH_HOME;
  process.env.DSH_HOME=root;
  try{
    await ctx.plugin(Prompt);await ctx.plugin(Tools);await ctx.plugin(Skills);await ctx.plugin(Questions);
    await ctx.plugin(PlatformKnowledge);
    const fiber=ctx.plugin(Plugin);await fiber;
    assert(ctx.tools.get('dm_listing_open_demo'));
    assert(ctx.tools.get('dm_listing_validate_synthetic'));
    assert(ctx.tools.get('dm_listing_prepare_delivery'));
    assert(ctx.tools.get('dm_listing_recover_interrupted'));
    assert.equal((await ctx.skills.get('dm-listing'))?.name,'dm-listing');
    assert.equal((await ctx.skills.get('dm-listing-manual-methods'))?.name,'dm-listing-manual-methods');
    assert(ctx.tools.get('dm_listing_manual_methods'));
    assert.equal((await ctx.skills.get('dm-listing-scenario-methods'))?.name,'dm-listing-scenario-methods');
    assert(ctx.tools.get('dm_listing_scenario_methods'));
    assert.equal((await ctx.skills.list()).length,4);
    await fiber.dispose();
    assert.equal(ctx.tools.get('dm_listing_open_demo'),undefined);
    assert.equal((await ctx.skills.list()).length,0);
    assert(ctx.tools.get('platform_knowledge_search'),'platform tools survive Listing disposal');
    assert(ctx.clinicalKnowledge);
    assert.equal(ctx.clinicalKnowledge.search({pluginId:'dm-listing'},{states:['CANDIDATE']}).total,6,'seed history survives contribution disposal');
  }finally{
    await ctx.fiber.dispose();
    if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;
    await rm(root,{recursive:true,force:true});
  }
});
test('real question service dispatches trusted answers and rejects cancelled requests',async()=>{
  const ctx=new Context();
  try{
    await ctx.plugin(Questions);
    ctx.on('user-questions/request',async request=>({answers:request.questions.map(q=>({id:q.id,selected:[q.options![0].label]}))}));
    const answer=await ctx.userQuestions.ask({questions:[{id:'select',question:'Which sheet?',options:[{label:'Manual Review'}]}]});
    assert.equal(answer.answers[0].selected[0],'Manual Review');
    const controller=new AbortController();controller.abort();
    await assert.rejects(ctx.userQuestions.ask({questions:[{id:'select',question:'Which sheet?'}],signal:controller.signal}),/aborted/);
  }finally{await ctx.fiber.dispose();}
});
test('reported plugin version follows the shipped package.json instead of a hardcoded copy',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version?:unknown};
  assert.equal(typeof manifest.version,'string');
  assert.equal(Plugin.LISTING_PLUGIN_VERSION,manifest.version);
});
