// 验收第二步：在已登录会话里切到目标研究/环境（UI 自身契约 saveStudyEnvironment），再打开 PP 页。
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire('D:/package/Nvm/nvm/node_global/node_modules/@playwright/mcp/package.json');
const { chromium } = require('playwright');

const OUT = 'D:/project/company/ec-clinical-dsh/plugins/dm-participants/.runtime/pp-page';
const ENV_ID = process.env.PP_ENV_ID ?? '215';
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
const apiHits = [];
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
});
page.on('response', (response) => {
  const url = response.url();
  if (/getPatientProfile|getChartLayoutInfo|getCsmChartPreviewData|executeDiagramsSql|getPatientProfileList/.test(url)) {
    apiHits.push({ status: response.status(), url: url.replace('http://localhost:3333', '').split('&_')[0] });
  }
});

await page.goto('http://localhost:3333/#/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
if (page.url().includes('/login')) {
  await page.locator('input[placeholder="请输入账号"]').fill(user);
  await page.locator('input[placeholder="请输入密码"]').fill(pass);
  const agreements = page.locator('.lp-agreement-check');
  const count = await agreements.count();
  for (let i = 0; i < count; i++) await agreements.nth(i).click({ force: true });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /登录|Sign in|Login/ }).click({ timeout: 15000 });
  await page.waitForTimeout(7000);
}

const afterLogin = { url: page.url() };
if (page.url().includes('/login')) {
  afterLogin.loginError = (await page.locator('.el-message, .el-form-item__error').allInnerTexts()).join(' | ').slice(0, 300);
}

// 用页面自己的会话切环境（与 UI 切换器同一个端点）。token 在 sessionStorage['user-info']（SW-08）。
const switchResult = await page.evaluate(async (envId) => {
  let token = '';
  try {
    token = JSON.parse(sessionStorage.getItem('user-info') ?? '{}').accessToken ?? '';
  } catch {
    token = '';
  }
  if (!token) return { error: 'token not found', sessionKeys: Object.keys(sessionStorage) };
  const response = await fetch('/api/v1/study/saveStudyEnvironment?id=' + encodeURIComponent(envId), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'RBQM-language': 'en' },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, code: body.code ?? null };
}, ENV_ID);

await page.goto('http://localhost:3333/#/patientProfile/patienChartView/index?routerId=-1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12000);
// PP_PATIENT：切换到指定参与者（默认页可能停在首个可用参与者）。逐图验证时用来覆盖
// 「该参与者没有 AE/异常化验 → 空态」的情况，验证图形态本身。
const PATIENT = process.env.PP_PATIENT ?? '';
let selectedPatient = null;
if (PATIENT) {
  const select = page.locator('input[placeholder="请选择可用参与者后预览"]').first();
  if (await select.count()) {
    await select.click();
    await page.waitForTimeout(900);
    const option = page.locator('.el-select-dropdown__item', { hasText: PATIENT }).first();
    if (await option.count()) {
      await option.click();
      await page.waitForTimeout(12000);
      selectedPatient = PATIENT;
    } else {
      selectedPatient = 'option not found';
    }
  } else {
    selectedPatient = 'select not found';
  }
}
await page.screenshot({ path: resolve(OUT, 'pp-page-env' + ENV_ID + '.png'), fullPage: true });

const text = (await page.locator('body').innerText()).replace(/\s+\n/g, '\n').slice(0, 1200);
const canvases = await page.locator('canvas').count();
const emptyStates = await page.getByText('暂无数据').count();
// 追加落位的 4 张图在页面末尾：滚动到第一张再拍一张视口截图，便于肉眼验收。
const ownCard = page.getByText('VIZ-PT labs', { exact: false }).first();
if (await ownCard.count()) {
  await ownCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: resolve(OUT, 'pp-own-charts-env' + ENV_ID + '.png') });
}
// 逐图截图：每张 VIZ-PT 图的卡片（标题 + canvas/空态）单独存证，供与设计稿逐图对照。
// 空态卡片没有 canvas，向上找「包含 canvas 或 暂无数据 的最小祖先」，高度上限防抓到整页容器。
const CHART_KEYS = ['triage', 'signals', 'labs', 'toxshift', 'labsig', 'aeburden', 'aetl', 'consent', 'elig', 'visits', 'assess', 'labmatrix', 'queries', 'epro', 'egfr', 'adherence', 'dose', 'pills'];
const perChart = {};
for (const key of CHART_KEYS) {
  try {
    const title = page.getByText('VIZ-PT ' + key, { exact: true }).first();
    const handle = await title.elementHandle({ timeout: 5000 });
    if (!handle) {
      perChart[key] = 'title not found';
      continue;
    }
    const cardHandle = await page.evaluateHandle((el) => {
      let node = el.parentElement;
      while (node && node !== document.body) {
        const box = node.getBoundingClientRect();
        const hit = node.querySelector('canvas') || (node.textContent ?? '').includes('暂无数据');
        if (hit && box.height > 60 && box.height < 800) break;
        node = node.parentElement;
      }
      return node;
    }, handle);
    const card = cardHandle.asElement();
    if (!card) {
      perChart[key] = 'card not found';
      continue;
    }
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    const canvasInCard = (await card.$('canvas')) ? 1 : 0;
    const file = `chart-${key}-env${ENV_ID}${PATIENT ? '-' + PATIENT : ''}.png`;
    await card.screenshot({ path: resolve(OUT, file) });
    perChart[key] = { canvas: canvasInCard, file };
  } catch (err) {
    perChart[key] = String(err).slice(0, 120);
  }
}
await writeFile(
  resolve(OUT, 'evidence-env' + ENV_ID + (PATIENT ? '-' + PATIENT : '') + '.json'),
  JSON.stringify({ envId: ENV_ID, patient: selectedPatient ?? null, switchResult, finalUrl: page.url(), apiHits, consoleErrors, canvases, emptyStates, perChart, text }, null, 2),
  'utf8',
);
console.log('afterLogin:', JSON.stringify(afterLogin));
console.log('switch:', JSON.stringify(switchResult));
console.log('api hits:', apiHits.length, apiHits.slice(0, 14).map((h) => `${h.status} ${h.url.split('?')[0]}`).join(' | '));
console.log('canvas:', canvases, '| empty states:', emptyStates, '| console errors:', consoleErrors.length);
console.log('body:', text.slice(0, 700).replace(/\n/g, ' / '));
await browser.close();