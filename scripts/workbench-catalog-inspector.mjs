// Deployment-owned inspection plugin. Runs inside the locked DSH composition, not the control API.
// Only public provider/model metadata is exported. No provider config or credentials are serialized.
import { writeFile } from 'node:fs/promises';
export const name = 'platform-model-catalog-inspector';
export const inject = ['llm'];
export function apply(ctx) {
  const output = process.env.PLATFORM_CATALOG_OUTPUT;
  if (!output) throw new Error('PLATFORM_CATALOG_OUTPUT_REQUIRED');
  let active = true;
  ctx.effect(() => () => { active = false; });
  ctx.on('ready', async () => {
    const providers = [];
    for (const provider of ctx.llm.listProviders()) {
      const id = provider.id ?? provider.name;
      if (typeof id !== 'string') throw new Error('PROVIDER_ID_MISSING');
      const models = await ctx.llm.listModels(id);
      providers.push({ id, models: models.map((model) => ({
        id: model.id, name: model.name, contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })) });
    }
    if (active) await writeFile(output, JSON.stringify({ providers }, null, 2), { flag: 'wx' });
  });
}
