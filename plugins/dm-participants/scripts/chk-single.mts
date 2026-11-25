import { SINGLE_CHARTS } from '../src/participant-single.js';
for (const c of SINGLE_CHARTS) {
  const text = JSON.stringify(c.option);
  console.log(`${c.key}: cols=${c.columns.length} nums=${c.scope.numberColumns.length} bytes=${text.length} hasFn=${/function|=>/.test(text)}`);
}
