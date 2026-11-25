// Prototype verification for workbench-flow — a static single-file interaction sample
// (index.html, fictional data, no build, no runtime). It cannot carry product acceptance,
// so this check verifies exactly what the artifact claims to be: well-formed HTML with the
// interaction anchors the workbench flow contract requires (session switch with a loading
// state, the honest unavailable-run error, and the new-work entry). Structural checks only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const failures = [];
const check = (ok, label, extra) => {
  if (ok) console.log('PASS', label);
  else { failures.push(label); console.log('FAIL', label, extra ?? ''); }
};

check(html.startsWith('<!doctype html>'), 'index.html starts with a doctype');
check(html.trimEnd().endsWith('</html>'), 'index.html closes its html element');
check((html.match(/<script/g) ?? []).length === (html.match(/<\/script>/g) ?? []).length,
  'script tags are balanced', `${(html.match(/<script/g) ?? []).length} open / ${(html.match(/<\/script>/g) ?? []).length} close`);

// Interaction anchors the flow sample exists to demonstrate. Buttons are built through a
// `btn(key,…)` factory (data-${key}) and dispatched via `'…'in x`, so the anchors are the
// dispatch keys, not literal data- attributes in the source.
check(/'session'in x/.test(html), 'run/session switch dispatch present (session key)');
check(/'work'in x/.test(html), 'work chat dispatch present (work key)');
check(/mode==='loading'/.test(html) || html.includes('正在打开所选对话'), 'session switch has a loading state');
check(html.includes('打不开这段运行对话'), 'honest unavailable-run error copy present');
check(html.includes('新建工作'), 'new-work entry present');
check(html.includes('演示无法打开会话'), 'the sample exposes a way to demo the unavailable case');
check(html.includes('交互设计样稿'), 'the artifact declares itself a prototype (fictional data)');

if (failures.length > 0) { console.error(`FAILED:${failures.length}`); process.exitCode = 1; }
else console.log('workbench-flow prototype verification passed.');
