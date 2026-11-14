import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Plugin from '../src/cordis.ts';
import { draft } from './helpers.js';
import { AuthorizationError, type Principal } from '../src/policy.js';
import { validateConfig } from '../src/config.js';

test('the control bundle mounts its tools and service without a worker executor', async () => {
  const ctx = new Context();
  const root = await mkdtemp(join(tmpdir(), 'platform-control-mount-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    await ctx.plugin(Prompt);
    await ctx.plugin(Tools);
    const fiber = ctx.plugin(Plugin);
    await fiber;
    assert(ctx.platformControl);
    for (const name of [
      'platform_control_status',
      'platform_app_register',
      'platform_run_create',
      'platform_run_cancel',
      'platform_run_artifacts',
      'platform_work_create',
      'platform_work_list',
      'platform_work_get',
      'platform_work_archive',
      'platform_work_runs',
      'platform_work_run_create',
      'platform_workbench_snapshot',
      'platform_model_catalog',
      'platform_model_catalog_register',
      'platform_model_preference_set',
      'platform_audit_events',
    ]) {
      assert(ctx.tools.get(name), name);
    }
    assert.throws(
      () => ctx.platformControl.createRun('missing', '1.0.0', {}, { actorId: 'session:test', kind: 'operator' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'APP_NOT_FOUND',
    );
    await fiber.dispose();
    assert.equal(ctx.tools.get('platform_control_status'), undefined);
  } finally {
    await ctx.fiber.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('bundle config is validated and allowedApps restricts the local operator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-control-config-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const principal: Principal = { actorId: 'session:test', kind: 'operator' };
  try {
    assert.throws(
      () => validateConfig({ unknownKey: true }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PLATFORM_CONFIG_INVALID',
    );
    const ctx = new Context();
    await ctx.plugin(Prompt);
    await ctx.plugin(Tools);
    const fiber = ctx.plugin(Plugin, { allowedApps: ['listing'] });
    await fiber;
    assert.equal(ctx.platformControl.registerApp(draft('listing'), principal).appId, 'listing');
    assert.throws(
      () => ctx.platformControl.registerApp(draft('other'), principal),
      (error: unknown) => error instanceof AuthorizationError && error.code === 'PLATFORM_APP_ACCESS_DENIED',
    );
    await fiber.dispose();
    await ctx.fiber.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
