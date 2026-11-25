// 只读：登录后读 UI 自己记住的 STUDY_ID / 环境选择，认出「这个环境」到底是哪个研究。
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire('D:/package/Nvm/nvm/node_global/node_modules/@playwright/mcp/package.json');
const { chromium } = require('playwright');
const OUT = 'D:/project/company/ec-clinical-dsh/plugins/dm-participants/.runtime/pp-page';
const parse = (t) => Object.fromEntries(t.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^['"]|['"]$/g, '')]));
const envs = parse(await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
for (let attempt = 0; attempt < 2; attempt++) {
  await page.goto('http://localhost:3333/#/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  if (!page.url().includes('/login')) break;
  await page.locator('input[placeholder="请输入账号"]').fill(envs['RBQM_INTRANET_USER']);
  await page.locator('input[placeholder="请输入密码"]').fill(envs['RBQM_INTRANET_PASSWORD']);
  const boxes = page.locator('.lp-agreement-check');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).click({ force: true });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /登录/ }).click({ timeout: 15000 });
  await page.waitForTimeout(8000);
  if (!page.url().includes('/login')) break;
}
const facts = await page.evaluate(async () => {
  const session = Object.fromEntries(Object.entries(sessionStorage).map(([k, v]) => [k, k === 'user-info' ? '(redacted)' : String(v).slice(0, 120)]));
  const token = JSON.parse(sessionStorage.getItem('user-info') ?? '{}').accessToken ?? '';
  const headers = { Authorization: 'Bearer ' + token, 'RBQM-language': 'en', 'content-type': 'application/json' };
  const get = async (p, init) => await fetch('/api/v1' + p, { headers, ...init }).then((r) => r.json()).catch(() => ({}));
  const studies = await get('/study/getUserStudyList', { method: 'POST', body: JSON.stringify({ pageNo: 1, pageSize: 60 }) });
  const rows = studies?.data?.data ?? [];
  const registry = await get('/patientProfile/getPatientProfile');
  const layout = await get('/csm/getChartLayoutInfo?type=2&pageType=1');
  const files = await get('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=1');
  return {
    session,
    studyIdRaw: sessionStorage.getItem('STUDY_ID'),
    studies: rows.map((s) => ({ id: s.id, name: s.studyName, envs: (s.studyEnvironment ?? []).map((e) => `${e.label}=${e.value}`) })),
    registryCount: (registry?.data?.data ?? []).length,
    firstLabel: (registry?.data?.data ?? [])[0]?.label ?? null,
    ppLayout: (layout?.data?.data ?? layout?.data ?? []).length,
    queueTotal: files?.data?.total ?? null,
  };
});
const studyId = String(facts.studyIdRaw ?? '').replace(/"/g, '');
const match = facts.studies.find((s) => String(s.id) === studyId);
await writeFile(resolve(OUT, 'current-study.json'), JSON.stringify({ studyId, match, ...facts }, null, 2), 'utf8');
console.log('url:', page.url());
console.log('STUDY_ID:', studyId, '→', match ? `${match.name} [${match.envs.join(',')}]` : '(not in list)');
console.log('registry:', facts.registryCount, facts.firstLabel, '| PP layout:', facts.ppLayout, '| queue:', facts.queueTotal);
console.log('session keys:', Object.keys(facts.session).join(','));
await browser.close();