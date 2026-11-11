// Independence: dm-dvp must load with the platform bundle and nothing from dm-listing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Skills from '@deepseek-ai/dsh-skill';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Plugin from '../src/index.ts';
import * as PlatformKnowledge from '../../../packages/platform-knowledge/src/cordis.ts';

test('dm-dvp mounts with the platform knowledge bundle and no dm-listing package', async () => {
  const ctx = new Context();
  const root = await mkdtemp(join(tmpdir(), 'dvp-alone-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    await ctx.plugin(Prompt);
    await ctx.plugin(Tools);
    await ctx.plugin(Skills);
    await ctx.plugin(PlatformKnowledge);
    const fiber = ctx.plugin(Plugin);
    await fiber;
    assert(ctx.tools.get('dm_dvp_status'));
    assert(ctx.tools.get('dm_dvp_parse_workbook'));
    assert(ctx.tools.get('platform_knowledge_search'));
    assert(ctx.clinicalKnowledge);
    assert(ctx.clinicalKnowledge.search({ pluginId: 'dm-dvp' }, { states: ['CANDIDATE'] }).total >= 6);
    await fiber.dispose();
    assert.equal(ctx.tools.get('dm_dvp_status'), undefined);
    assert(ctx.tools.get('platform_knowledge_search'), 'platform tools survive DVP disposal');
  } finally {
    await ctx.fiber.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('dm-dvp source and package metadata contain no dm-listing dependency', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = await readdir(join(root, 'src'), { recursive: true });
  const imports = [];
  for (const file of files.filter((name) => name.endsWith('.ts'))) {
    const text = await readFile(join(root, 'src', file), 'utf8');
    if (/(?:from\s*|import\s*\()\s*['"][^'"]*dm-listing/.test(text)) imports.push(`src/${file}`);
  }
  assert.deepEqual(imports, []);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(JSON.stringify(pkg).includes('dm-listing'), false);
});