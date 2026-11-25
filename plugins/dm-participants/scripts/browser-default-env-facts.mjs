// 只读：登录后不切环境，报告 UI 默认落到的研究/环境，以及该环境的登记与 PP 图表现状。
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
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
await page.goto('http://localhost:3333/#/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
if (page.url().includes('/login')) {
  await page.locator('input[placeholder="请输入账号"]').fill(user);
  await page.locator('input[placeholder="请输入密码"]').fill(pass);
  const boxes = page.locator('.lp-agreement-check');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).click({ force: true });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /登录/ }).click({ timeout: 15000 });
  await page.waitForTimeout(7000);
}

const facts = await page.evaluate(async () => {
  const token = JSON.parse(sessionStorage.getItem('user-info') ?? '{}').accessToken ?? '';
  const headers = { Authorization: 'Bearer ' + token, 'RBQM-language': 'en', 'content-type': 'application/json' };
  const get = async (path, init) => (await fetch('/api/v1' + path, { headers, ...init }).then((r) => r.json()).catch(() => ({})));
  const studies = await get('/study/getUserStudyList', { method: 'POST', body: JSON.stringify({ pageNo: 1, pageSize: 50 }) });
  const registry = await get('/patientProfile/getPatientProfile');
  const layout = await get('/csm/getChartLayoutInfo?type=2&pageType=1');
  const configs = await get('/csm/getChartConfigList', { method: 'POST', body: JSON.stringify({ pageNo: 1, pageSize: 50, chartName: '', type: 2 }) });
  const rows = (body) => (Array.isArray(body?.data) ? body.data : body?.data?.data ?? []);
  return {
    studies: rows(studies).map((s) => ({ id: s.id, name: s.studyName, envs: (s.studyEnvironment ?? []).map((e) => `${e.label}=${e.value}`) })),
    registryCount: rows(registry).length,
    registryFirst: rows(registry).slice(0, 2).map((r) => ({ label: r.label, site: r.site, country: r.country })),
    ppLayoutCount: rows(layout).length,
    ppLayoutNames: rows(layout).slice(0, 6).map((i) => i.chartName ?? i.i),
    ppConfigCount: rows(configs).length,
  };
});
const headerText = (await page.locator('body').innerText()).slice(0, 400).replace(/\n/g, ' / ');
await page.goto('http://localhost:3333/#/patientProfile/patienChartView/index?routerId=-1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
await page.screenshot({ path: resolve(OUT, 'pp-page-default-env.png'), fullPage: true });
const ppText = (await page.locator('body').innerText()).slice(0, 600).replace(/\n/g, ' / ');
await writeFile(resolve(OUT, 'default-env-facts.json'), JSON.stringify({ headerText, ppText, ...facts }, null, 2), 'utf8');
console.log('url:', page.url());
console.log('registry:', facts.registryCount, JSON.stringify(facts.registryFirst));
console.log('PP layout:', facts.ppLayoutCount, JSON.stringify(facts.ppLayoutNames), '| PP configs:', facts.ppConfigCount);
console.log('studies:', facts.studies.map((s) => `${s.name}[${s.envs.join(',')}]`).join(' | '));
console.log('pp page text:', ppText.slice(0, 300));
await browser.close();