/**
 * 生成 P1 合成验收页（HTML）与验收记录，供人工查看。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/p1-artifact.ts
 * 只使用合成数据；输出到 .runtime/dm-viz/。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptPage } from '../src/accept.js';
import { buildModel, renderHtml } from '../src/render.js';
import { allDatasets, bundleOf } from '../tests/fixtures.js';
import { p1Layout, p1Specs } from '../tests/p1-fixtures.js';

const specs = p1Specs();
const bundle = bundleOf(specs, p1Layout(specs), allDatasets());
const model = buildModel(bundle);
const record = acceptPage(bundle);
const out = resolve(process.env.DSH_HOME ?? '.runtime/dsh-home', 'dm-viz');
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'p1-page.html'), renderHtml(model), 'utf8');
writeFileSync(resolve(out, 'p1-acceptance.json'), JSON.stringify(record, null, 2), 'utf8');
console.log(
  JSON.stringify(
    {
      html: resolve(out, 'p1-page.html'),
      acceptance: resolve(out, 'p1-acceptance.json'),
      digest: model.digest,
      items: model.items.length,
      result: record.result,
      structure: record.structure,
    },
    null,
    2,
  ),
);
