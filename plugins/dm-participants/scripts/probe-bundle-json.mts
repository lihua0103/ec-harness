/** 设计稿 18 图 → 平台 JSON 配置：看序列化后是否含函数（函数无法进配置）。 */
import { buildPtBundle } from '../src/participant-page.js';
const bundle = buildPtBundle();
for (const spec of bundle.specs) {
  const text = JSON.stringify(spec.option);
  const hasFn = /function|=>/.test(text);
  console.log(`${spec.id}: bytes=${text.length} type=${spec.type} hasFunction=${hasFn} note=${spec.note.slice(0, 40)}`);
}
