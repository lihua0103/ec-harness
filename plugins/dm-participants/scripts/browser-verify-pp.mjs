// 真实浏览器验收（本机 msedge 通道）：登录 RBQM → 打开参与者档案页 → 截图 + 收集证据。
// 凭据仅在本进程内从 .env.rbqm-envs 解析后填入页面，不打印、不落盘。
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire('D:/package/Nvm/nvm/node_global/node_modules/@playwright/mcp/package.json');
const { chromium } = require('playwright');

const OUT = 'D:/project/company/ec-clinical-dsh/plugins/dm-participants/.runtime/pp-page';
const parseDotEnv = (text) => {
  const bag = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) bag[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return bag;
};

const envs = parseDotEnv(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const user = envs['RBQM_INTRANET_USER'];
const pass = envs['RBQM_INTRANET_PASSWORD'];
if (!user || !pass) {
  console.error('credentials missing');
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
const consoleErrors = [];
const apiHits = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
});
page.on('response', (response) => {
  const url = response.url();
  if (/getPatientProfile|getChartLayoutInfo|getCsmChartPreviewData|executeDiagramsSql/.test(url)) {
    apiHits.push({ url: url.replace('http://localhost:3333', ''), status: response.status() });
  }
});

await page.goto('http://localhost:3333/#/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
if (page.url().includes('/login')) {
  await page.locator('input[placeholder="请输入账号"]').fill(user);
  await page.locator('input[placeholder="请输入密码"]').fill(pass);
  // 两项隐私声明都勾选后才允许登录（前端硬性条件）。点复选框本体，避免点到声明里的文档链接。
  const agreements = page.locator('.lp-agreement-check');
  const agreementCount = await agreements.count();
  for (let i = 0; i < agreementCount; i++) await agreements.nth(i).click({ force: true });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /登录|Sign in|Login/ }).click({ timeout: 15000 });
  await page.waitForTimeout(7000);
}
const afterLogin = { url: page.url(), title: await page.title() };

await page.goto('http://localhost:3333/#/patientProfile/patienChartView/index?routerId=-1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
await page.screenshot({ path: resolve(OUT, 'pp-page.png'), fullPage: true });

const text = (await page.locator('body').innerText()).replace(/\s+\n/g, '\n').slice(0, 1500);
const chartCount = await page.locator('canvas, svg').count();
await writeFile(
  resolve(OUT, 'evidence.json'),
  JSON.stringify({ afterLogin, finalUrl: page.url(), apiHits, consoleErrors, chartCount, text }, null, 2),
  'utf8',
);
console.log('afterLogin:', JSON.stringify(afterLogin));
console.log('finalUrl:', page.url());
console.log('api hits:', apiHits.length, apiHits.slice(0, 12).map((h) => `${h.status} ${h.url.split('?')[0]}`).join(' | '));
console.log('chart elements:', chartCount, '| console errors:', consoleErrors.length);
console.log('body text (first 600):', text.slice(0, 600).replace(/\n/g, ' / '));
await browser.close();