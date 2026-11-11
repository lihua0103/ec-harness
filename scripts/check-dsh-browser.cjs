// Compare the model menu position in installed browsers without changing app settings.
const { chromium } = require(require.resolve('playwright', {
  paths: [require('node:path').resolve(__dirname, '../upstream/deepseek-harness-git/apps/web')],
}));
(async () => {
  for (const channel of ['chrome', 'msedge']) {
    let browser;
    try {
      browser = await chromium.launch({ channel, headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
      const model = page.getByRole('button', { name: '请选择模型', exact: true });
      await model.waitFor({ state: 'visible', timeout: 60000 });
      const notice = page.getByRole('dialog', { name: '预览版说明' });
      if (await notice.isVisible()) await notice.getByRole('button', { name: '继续', exact: true }).click({ timeout: 30000 });
      await model.click();
      const menu = page.getByRole('group', { name: '模型与推理等级', exact: true });
      await menu.waitFor({ state: 'visible' });
      // Read a stable layout after fonts and two animation frames have settled.
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
      const result = await page.evaluate(() => {
        const trigger = document.querySelector('button[aria-label="请选择模型"]');
        const menu = document.querySelector('[aria-label="模型与推理等级"]');
        const a = trigger.getBoundingClientRect(), b = menu.getBoundingClientRect();
        return { ua: navigator.userAgent, anchorSupported: CSS.supports('anchor-name', '--test'),
          trigger: a.toJSON(), menu: b.toJSON(),
          alignedRight: Math.abs(a.right - b.right) < 3,
          aboveTrigger: b.bottom <= a.top && a.top - b.bottom < 20 };
      });
      console.log(JSON.stringify({ channel, ...result, errors }));
      await page.screenshot({ path: require('node:path').resolve(__dirname, `../dsh-model-menu-${channel}.png`) });
    } catch (error) {
      console.log(JSON.stringify({ channel, error: error.message }));
      process.exitCode = 1;
    } finally { if (browser) await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
