/** 数据安全开关的 HTTP 接口（平台设置页用）：GET /api/data-boundary 读取，PUT /api/data-boundary 写入。
 *  与模型无关；文件与 .runtime/data-boundary.cjs、dm-dvp 插件共用。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:data-boundary', kind: 'operator' };

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-data-boundary-'));
  const file = join(root, 'nested', 'data-boundary.json');
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  const api: RunningWorkbenchServer = await startWorkbenchServer({ service, authenticate: () => operator, dataBoundaryFile: file });
  return { root, file, service, api };
};
type RunningWorkbenchServer = RunningWorkbenchApi;

const call = async (api: RunningWorkbenchApi, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

test('数据安全开关：缺省开启 → 关闭 → 开启，文件与 CLI 格式一致；非法请求被拒', async (t) => {
  const { root, file, service, api } = await setup();
  t.after(async () => { await api.close(); service.close(); await rm(root, { recursive: true, force: true }); });

  const initial = await call(api, 'GET', '/api/data-boundary');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.dataSecurity, true, '没有开关文件 = 数据安全开启');
  assert.equal(initial.body.exists, false);
  assert.equal(initial.body.restartRequired, true, '如实提示改后需重启');

  const off = await call(api, 'PUT', '/api/data-boundary', { dataSecurity: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.dataSecurity, false);
  assert.equal(off.body.exists, true);
  const written = JSON.parse(await readFile(file, 'utf8')) as { dataSecurity: boolean; _comment?: string };
  assert.equal(written.dataSecurity, false, '文件内容与 .runtime/data-boundary.cjs / dm-dvp 插件读取的格式一致');
  assert.ok(typeof written._comment === 'string' && written._comment.length > 10, '带说明，便于手动维护');

  const on = await call(api, 'PUT', '/api/data-boundary', { dataSecurity: true });
  assert.equal(on.body.dataSecurity, true);

  const bad = await call(api, 'PUT', '/api/data-boundary', { dataSecurity: 'false' });
  assert.ok(bad.status >= 400 && bad.status < 500, `非布尔值被拒: ${bad.status}`);
  assert.equal((await call(api, 'GET', '/api/data-boundary')).body.dataSecurity, true, '被拒的请求不改动开关');

  await writeFile(file, '{ broken json');
  assert.equal((await call(api, 'GET', '/api/data-boundary')).body.dataSecurity, true, '文件损坏按开启处理');

  const restore = await call(api, 'PUT', '/api/data-boundary', { dataSecurity: false });
  assert.equal(restore.body.dataSecurity, false, '文件损坏后仍可重新写入');
});

test('写入保留文件里的其他键', async (t) => {
  const { root, file, service, api } = await setup();
  t.after(async () => { await api.close(); service.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ _comment: 'old', dataSecurity: true, custom: 'keep-me' }));
  const result = await call(api, 'PUT', '/api/data-boundary', { dataSecurity: false });
  assert.equal(result.status, 200);
  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.custom, 'keep-me');
  assert.equal(saved.dataSecurity, false);
});
