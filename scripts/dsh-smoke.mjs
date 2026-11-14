// Diagnostic: drive the same locked DSH profile directly and print the public SDK result shape.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const root = process.cwd();
const sdk = await import(pathToFileURL(path.join(root, 'upstream', 'deepseek-harness-git', 'packages', 'sdk', 'client', 'lib', 'index.js')).href);
const harness = new sdk.DeepSeekHarness({
  profile: 'worker',
  dshHome: path.join(root, '.runtime', 'worker-home'),
  cwd: path.join(root, '.runtime', 'workbench', 'e2e-project'),
  patches: [path.join(root, '.runtime', 'workbench', 'model-route.patch.yml')],
  provider: process.env.SMOKE_PROVIDER ?? 'zai-coding-cn',
  model: process.env.SMOKE_MODEL ?? 'glm-5.3-flash',
  initializeTimeoutMs: 120000,
});
try {
  const result = await harness.run(process.env.SMOKE_PROMPT ?? '用一句话回复：平台连通性测试成功。');
  console.log(JSON.stringify({
    sessionId: result.sessionId,
    finishReason: result.finishReason,
    finalResponse: result.finalResponse,
    eventTypes: (result.events ?? []).map((event) => event.type),
    notifications: (result.notifications ?? []).map((notification) => notification.method).slice(0, 40),
  }, null, 2));
} catch (error) {
  console.error('SDK_ERROR', error?.constructor?.name, error?.code ?? '', String(error?.message ?? error).slice(0, 3000));
  process.exitCode = 1;
} finally {
  await harness.close();
}
