// Keyless browser smoke: never sends a model request or reads clinical data.
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium}=require(require.resolve('playwright',{paths:[path.resolve(__dirname,'../upstream/deepseek-harness-git/apps/web')]}));
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.argv[2],{waitUntil:'domcontentloaded'});
    const entry=page.getByRole('button',{name:'DM Listing',exact:true});
    await entry.waitFor({timeout:60000});
    await entry.click();
    const dialog=page.getByRole('dialog',{name:'DM Listing',exact:true});
    const select=dialog.getByLabel('Listing 场景');
    assert.deepEqual(await select.locator('option').evaluateAll(es=>es.map(e=>e.value)),['medical','manual','report','pk']);
    await select.selectOption('pk');
    await dialog.getByLabel('PK 子型').selectOption('sad-mad');
    await page.screenshot({path:path.resolve(__dirname,'../dsh-listing-plugin.png')});
    await dialog.getByRole('button',{name:'插入任务',exact:true}).click();
    const draft=await page.locator('[contenteditable="true"]').textContent();
    assert(draft.includes('pk (sad-mad)'));assert(draft.includes('Cover 禁读'));
    await page.getByRole('button',{name:'插件',exact:true}).click();
    const plugin=page.getByText('@ec-clinical/dsh-dm-listing',{exact:true});
    const description=page.getByText('临床 Listing：Medical / Manual / Report / PK，首版仅支持内置合成示例。',{exact:true});
    await plugin.waitFor({state:'visible',timeout:60000});
    const visible=await plugin.isVisible();
    await page.getByRole('button',{name:'查看 @ec-clinical/dsh-dm-listing',exact:true}).click();
    await page.getByText('知识版本 2026.11.08.1：Medical/Manual 共用 review 通道；Report/PK 独立；PK 分 BE 和 SAD/MAD。',{exact:true}).waitFor();
    await page.getByRole('status').filter({hasText:'上线状态：阻断。'}).waitFor();
    await page.getByText('任务恢复：选表、需求与程序修订按会话持久化；重启后可调用 dm_listing_list_tasks 恢复。草稿允许先写，交付必须绑定当前需求版本。',{exact:true}).waitFor();
    await page.screenshot({path:path.resolve(__dirname,'../dsh-listing-installed.png')});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({browser:'Edge',fourScenarios:true,pkSubtype:true,insertTask:true,modelRequestSent:false,pluginRegistryLabelVisible:visible,errors}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
