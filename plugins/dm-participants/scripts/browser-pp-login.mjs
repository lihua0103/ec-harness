// 真实浏览器登录 + 打开参与者档案（PP）页。凭据在本进程内从 .env.rbqm-envs 解析，
// 只填进页面输入框，不返回、不打印（返回值仅 URL/标题/计数）。
async (page) => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile('D:/project/company/RBQM/.env.rbqm-envs', 'utf8');
  const bag = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) bag[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const user = bag['RBQM_INTRANET_USER'];
  const pass = bag['RBQM_INTRANET_PASSWORD'];
  if (!user || !pass) return { error: 'credentials missing' };
  if (page.url().includes('/login')) {
    await page.locator('input[placeholder="请输入账号"]').fill(user);
    await page.locator('input[placeholder="请输入密码"]').fill(pass);
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForTimeout(6000);
  }
  return { url: page.url(), title: await page.title() };
}