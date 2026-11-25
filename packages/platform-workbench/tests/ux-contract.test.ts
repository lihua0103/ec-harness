import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKBENCH_CSS } from '../src/client/styles.js';

// T09 contract: the page follows the host theme, keeps keyboard focus visible, degrades to one
// column on narrow screens, honours reduced motion and never restyles the native shell globally.

test('page styles are scoped and never modify the native shell globally', () => {
  assert.match(WORKBENCH_CSS, /\.ec-wb\s*\{/);
  // Every top-level rule must start with the page scope, not with a bare element or :root.
  // Drop comment blocks first, then drop @keyframes blocks (single nesting level): frame
  // selectors like from/to/percentages are not page rules, and every animation stays referenced
  // only by .ec-wb-scoped declarations.
  const stripped = WORKBENCH_CSS
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@keyframes[^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  const selectors = stripped
    .split('}')
    .map((chunk) => chunk.split('{')[0]?.trim() ?? '')
    .filter((selector) => selector.length > 0 && !selector.startsWith('@'));
  for (const selector of selectors) {
    assert.match(selector, /^\.ec-wb\b/, `unscoped selector: ${selector}`);
  }
  const atRules = [...stripped.matchAll(/@media[^{]+\{/g)].map((match) => match[0]);
  assert.ok(atRules.length >= 3);
  // Fixed positioning may exist only on the command-palette backdrop (E4-6): a deliberate,
  // explicitly closable aria-modal overlay opened by the user (Ctrl/⌘+K or the search button),
  // never on anything that would cover the native conversation on its own.
  for (const match of stripped.matchAll(/([^{}]+)\{[^}]*position\s*:\s*fixed/g)) {
    assert.match(match[1] ?? '', /\.ec-wb-palette-backdrop/, `fixed position outside the palette backdrop: ${(match[1] ?? '').trim()}`);
  }
});

test('page styles use host design tokens with readable fallbacks', () => {
  for (const token of [
    '--dsw-alias-label-primary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l2',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-radius-md',
    '--dsw-focus-ring-color',
  ]) {
    assert.ok(WORKBENCH_CSS.includes(`var(${token},`), `missing host token fallback: ${token}`);
  }
});

test('keyboard focus, narrow layout, dark theme, compact density and reduced motion are explicit', () => {
  assert.match(WORKBENCH_CSS, /:focus-visible/);
  assert.match(WORKBENCH_CSS, /@media\s*\(max-width:\s*720px\)/);
  assert.match(WORKBENCH_CSS, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(WORKBENCH_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(WORKBENCH_CSS, /\[data-density="compact"\]/);
});

// 2026-11-13 concept-draft alignment, revised by the 2026-11-21 single-sidebar design: the
// enterprise `sidebar` slot occupant carries the brand and the one global navigation; the home
// page has the AI launch entry, a readiness rail and a Works table; the work console keeps a run
// rail beside the native thread without owning the thread itself.
test('the concept draft surfaces are present in the page stylesheet', () => {
  for (const selector of [
    '.ec-wb-topbar',
    '.ec-wb-side-wordmark',
    '.ec-wb-side-brand',
    '.ec-wb-side-new',
    '.ec-wb-side-items',
    '.ec-wb-side-rail',
    '.ec-wb-launch',
    '.ec-wb-quick-target',
    '.ec-wb-checks',
    '.ec-wb-table-head',
    '.ec-wb-work-row',
    '.ec-wb-canvas-foot',
    '.ec-wb-console-head',
    '.ec-wb-console-body',
    '.ec-wb-console-thread',
    '.ec-wb-console-rail',
    '.ec-wb-interaction',
  ]) {
    assert.ok(WORKBENCH_CSS.includes(selector), `missing concept-draft surface: ${selector}`);
  }
});

// E4-4 (doable part): text tokens must meet WCAG AA (4.5:1) in BOTH themes. The stylesheet
// declares each colour token twice — light first, then the dark override block — so token
// occurrences are read positionally and every text/background pair is computed.
const luminance = (hex: string): number => {
  const channels = [0, 2, 4].map((index) => parseInt(hex.slice(1 + index, 3 + index), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (foreground: string, background: string): number => {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};
const tokenValues = (name: string): string[] =>
  [...WORKBENCH_CSS.matchAll(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((match) => match[1]);

test('text token pairs meet WCAG AA contrast (4.5:1) in light and dark themes (E4-4)', () => {
  const tokens = ['ec-ink', 'ec-muted', 'ec-secondary', 'ec-primary', 'ec-green', 'ec-amber', 'ec-danger', 'ec-paper', 'ec-white', 'ec-soft', 'ec-green-weak', 'ec-amber-weak', 'ec-danger-weak'];
  const themes: Array<Record<string, string>> = [{}, {}];
  for (const token of tokens) {
    const values = tokenValues(token);
    assert.ok(values.length >= 2, `token --${token} must have light and dark values`);
    themes[0][token] = values[0];
    themes[1][token] = values[1];
  }
  const pairs: Array<[string, string, string]> = [
    ['body text', 'ec-ink', 'ec-paper'],
    ['card text', 'ec-ink', 'ec-white'],
    ['secondary text', 'ec-muted', 'ec-paper'],
    ['secondary on card', 'ec-muted', 'ec-white'],
    ['tertiary on soft', 'ec-secondary', 'ec-soft'],
    ['links', 'ec-primary', 'ec-paper'],
    ['links on card', 'ec-primary', 'ec-white'],
    ['ok badge', 'ec-green', 'ec-green-weak'],
    ['warn badge', 'ec-amber', 'ec-amber-weak'],
    ['error badge', 'ec-danger', 'ec-danger-weak'],
    ['text on soft', 'ec-ink', 'ec-soft'],
  ];
  for (const [index, theme] of themes.entries()) {
    for (const [label, fg, bg] of pairs) {
      const ratio = contrast(theme[fg], theme[bg]);
      assert.ok(
        ratio >= 4.5,
        `${index === 0 ? 'light' : 'dark'} ${label} (${theme[fg]} on ${theme[bg]}) is ${ratio.toFixed(2)}:1, below AA 4.5:1`,
      );
    }
  }
});

test('keyboard path: skip link and palette focus affordances exist in the page source (E4-4)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /ec-wb-skip/, 'missing skip link');
  assert.match(source, /aria-activedescendant/, 'palette input must follow the combobox pattern');
  assert.match(source, /previous\?\.focus/, 'the palette must restore focus to its trigger on close');
  // The focus call is deferred one tick, so Escape must be handled at the document level too —
  // otherwise a quick Escape lands on the body and the modal cannot be dismissed from the keyboard.
  assert.match(source, /document\.addEventListener\('keydown'/, 'the palette must close on Escape from anywhere');
  assert.match(source, /id="ec-wb-content"/, 'the skip link needs a main landmark target');
});

// 2026-11-23 定调：中心永远只有一个原生会话流，且流绑定哪个会话跟随右栏「运行历史」的选择——
// 点击运行行，中心换绑该运行自己的原生会话（result.sessionId）；点「会话对话」换回 Work 会话。
// 抄本、事件与知识依据仍只在右栏卡片；任何时刻中心只挂载一个 SessionProvider。
test('the center is one native Chat stream whose session follows the rail run selection', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  const centerStart = source.indexOf('<div className="ec-wb-console-center">');
  const centerEnd = source.indexOf('<aside className="ec-wb-console-rail"', centerStart);
  const center = source.slice(centerStart, centerEnd);
  assert.match(center, /<div className="ec-wb-console-thread" data-run-view=/, 'the stream lives in one thread container for both bindings');
  // Exactly one SessionProvider in the center, keyed by the run — the swap, not a second stream.
  const providers = [...center.matchAll(/<SessionProvider /g)];
  assert.ok(providers.length === 1, `the center mounts exactly one SessionProvider, found ${providers.length}`);
  assert.match(center, /<SessionProvider key=\{`run:\$\{runView\.runId\}`\} session=\{runView\.reference\}>/, 'the run binding swaps the stream to that run session');
  assert.match(center, /: children\}/, 'the Work-bound Chat is the fallback binding under 会话对话');
  assert.doesNotMatch(center, /RunTranscript|console-history|ec-wb-mode-banner/, 'no run transcript or banner may stack beside the Chat stream');
  // The swap rides the single-slot contract: retain-then-commit without awaits, epoch withdrawal.
  assert.match(source, /const reference = await retainSessionById\(sessionId\)[\s\S]{0,200}if \(swapSeqRef\.current !== seq\) \{ releaseRunReference\(reference\); return \}/, 'a superseded swap releases what it retained and commits nothing');
  assert.match(source, /const reference = retainWorkSession\(workSessionId\)[\s\S]{0,120}adoptWorkReference\(reference\)[\s\S]{0,80}setRunView\(null\)/, 'the way back is one synchronous batch: re-retain, adopt, clear');
  assert.match(source, /const runViewLive = runView !== null && runView\.epoch === workEpoch/, 'a run view only renders under the epoch it was opened in');
  // Rail rows drive the swap; run creation walks back to the live chat.
  const railStart = source.indexOf('<aside className="ec-wb-console-rail"');
  const railEnd = source.indexOf('</aside>', railStart);
  const rail = source.slice(railStart, railEnd);
  assert.match(rail, /ec-wb-rail-transcript[\s\S]*?<RunTranscript /, 'the selected run transcript renders as a rail card');
  assert.match(rail, /onClick=\{\(\) => \{ void openRunView\(run\) \}\}/, 'clicking a run row swaps the center to that run');
  assert.match(rail, /onClick=\{\(\) => \{ closeRunView\(\) \}\}/, '会话对话 walks the synchronous way back');
  assert.match(source, /onCreated=\{\(runId\) => \{ closeRunView\(\); setSelectedRunId\(runId\)/, 'a newly created run returns the center to the live chat');
  // The page wires the single-slot machinery into the console.
  assert.match(source, /retainSessionById=\{retainKnownSession\}/, 'run retains go through the catalog-race-tolerant path');
  assert.match(source, /retainWorkSession=\{retainSession\}/, 'the way back retains the Work session synchronously');
  assert.match(source, /adoptWorkReference=\{adoptWorkReference\}/, 'fresh references are adopted back into the page state');
  assert.match(source, /releaseRunReference=\{releaseSession\}/, 'run references release WP3-precisely');
  const css = await import('../src/client/styles.js');
  assert.ok(css.WORKBENCH_CSS.includes('.ec-wb .ec-wb-console-thread { width: 100%; max-width: 100%; min-height: 0; height: auto; flex: 1 1 auto;'), 'the Chat stream fills the whole center column');
  assert.ok(css.WORKBENCH_CSS.includes('.ec-wb .ec-wb-console-thread > .ec-wb-session-conversation { height: 100%; min-height: 0; max-height: 100%;'), 'native Chat keeps a bounded independent viewport');
  assert.doesNotMatch(css.WORKBENCH_CSS, /min\(38%/, 'the Chat stream must not be clamped to a bottom strip');
  assert.ok(css.WORKBENCH_CSS.includes('.ec-wb .ec-wb-rail-transcript .ec-wb-transcript-body { max-height: 320px;'), 'rail transcript scrolls inside its card');
});

// 2026-11-23：会话外壳左索引的「＋新建工作」必须真的能新建——走既有全局创建意图（与侧栏
// create 命令同路径：回到「我的工作」首页并打开创建表单），不允许静默无效。
test('the desk index add button dispatches the global create intent from the session desk too', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /onCreate=\{\(\) => \{ setDeskPanel\(null\); selectPage\('works'\); startCreate\(\) \}\}/, 'the desk add button leaves to the works-home create view instead of no-oping');
  assert.match(source, /case 'create': selectPage\('works'\); startCreate\(command\.appKey\); break/, 'the sidebar create command stays the canonical intent');
});

test('the desk index header renders real DOM text, not injected pseudo-element labels', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/work-index.tsx', import.meta.url), 'utf8');
  assert.match(source, /ec-wb-desk-index-add-label">\{t\('home\.newLabel', locale\)\}/, 'the 新建工作 label is visible DOM text');
  const css = await import('../src/client/styles.js');
  assert.doesNotMatch(css.WORKBENCH_CSS, /desk-index-add::after/, 'the add button must not inject its label via ::after');
  assert.doesNotMatch(css.WORKBENCH_CSS, /desk-index-title::(?:before|after)\s*\{[^}]*content:\s*"(?:Active|Recent)"/, 'no fake Active/Recent labels on the index title');
});

// 2026-11-23 回归：新建工作表单属于「我的工作」首页坐标，不是独立视图。此前 creating 只在表单
// 自己的取消/提交里清除——打开表单后点索引另一行只改高亮（所选工作的摘要被表单挡住），切到其他
// 键控页再回来表单仍在。现在每一条离开该坐标的路径都在同一批更新里关闭表单。
test('the create wizard closes on every navigation away from the works-home coordinate', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  const between = (from: string, to: string): string => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start, `missing source region: ${from}`);
    return source.slice(start, end);
  };
  const close = between('const closeCreate = ', '// ── Work desk (方案 B)');
  assert.match(close, /setCreating\(false\)/, 'closing the wizard clears the creating flag');
  assert.match(close, /setStartAppKey\(''\)/, 'closing the wizard forgets the quick-target application');
  const leaves = [
    ['selectPage', 'const selectPage = ', '/** Open the create form'],
    ['inspectWork', 'const inspectWork = ', '/** 单列首页「返回工作索引」'],
    ['openDetail', 'const openDetail = ', '/** Resolve a Work by id'],
    ['commitWorkSession', 'const commitWorkSession = ', '/** `silent` marks a refresh-restore'],
    ['openHistorySession', 'const openHistorySession = ', 'const closeHistorySession = '],
  ] as const;
  for (const [label, from, to] of leaves) {
    assert.match(between(from, to), /closeCreate\(\)/, `${label} leaves the works-home coordinate and must close the wizard`);
  }
  // Only the create intent opens the wizard; its own exits reuse the shared close path.
  assert.equal([...source.matchAll(/setCreating\(true\)/g)].length, 1, 'only startCreate opens the wizard');
  assert.match(source, /onCancelCreate=\{closeCreate\}/, 'cancel closes through the shared path');
  assert.match(source, /onCreated=\{openDetail\}/, 'a created Work opens its detail, which closes the wizard itself');
});

test('the 2026-11-17 experience pass surfaces are present and scoped', () => {
  for (const selector of [
    '.ec-wb .ec-wb-console-center',
    '.ec-wb .ec-wb-bind-steps',
    '.ec-wb .ec-wb-wizard',
    '.ec-wb .ec-wb-stepbar',
    '.ec-wb .ec-wb-freshness',
    '.ec-wb .ec-wb-session-tools',
  ]) {
    assert.ok(WORKBENCH_CSS.includes(selector), `missing experience surface: ${selector}`);
  }
});

test('the console gives the native thread a bounded height instead of growing the page', () => {
  const body = WORKBENCH_CSS.split('.ec-wb .ec-wb-console-body {')[1]?.split('}')[0] ?? '';
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow:\s*hidden/);
  const thread = WORKBENCH_CSS.split('.ec-wb .ec-wb-console-thread {')[1]?.split('}')[0] ?? '';
  assert.match(thread, /min-height:\s*0/);
  const conversation = WORKBENCH_CSS.split('.ec-wb .ec-wb-session-conversation {')[1]?.split('}')[0] ?? '';
  assert.match(conversation, /flex:\s*1/);
});

// Regression: in the dark block the generic outline-button colour and the filled-primary colour
// have equal specificity, so source order decides. A filled button re-inked before the generic
// rule ends up with a light label on the jade fill (measured 1.26:1 before this guard existed).
test('dark theme re-inks filled buttons after the generic outline rule', () => {
  const dark = WORKBENCH_CSS.slice(WORKBENCH_CSS.indexOf('@media (prefers-color-scheme: dark)'));
  const outline = dark.indexOf('.ec-wb button.ec-wb-button { color:');
  const primary = dark.indexOf('.ec-wb button.ec-wb-primary { color:');
  assert.ok(outline >= 0, 'dark outline button colour is declared');
  assert.ok(primary > outline, 'dark filled primary colour must come after the generic outline colour');
});

// 方案 B (2026-11-22 Emerald research work desk): the works home is a master–detail pair —
// a work index (「我的工作」主从列表, NOT a second global navigation) beside the selected Work's
// read-only brief; the session shell carries the same index beside the native conversation and
// the work-materials rail. These assertions check the NEW responsibilities without weakening any
// earlier one above.
test('the desk shell surfaces are present and scoped', () => {
  for (const selector of [
    '.ec-wb.ec-wb-desk',
    '.ec-wb .ec-wb-desk-index',
    '.ec-wb.ec-wb-desk .ec-wb-topbar',
    '.ec-wb.ec-wb-desk .ec-wb-main',
    '.ec-wb button.ec-wb-desk-row',
    '.ec-wb .ec-wb-desk-panel',
    '.ec-wb .ec-wb-brief-wrap',
    '.ec-wb .ec-wb-artifact-card',
    '.ec-wb .ec-wb-activity-row',
    '.ec-wb .ec-wb-rail-group',
    '.ec-wb button.ec-wb-desk-index-toggle',
  ]) {
    assert.ok(WORKBENCH_CSS.includes(selector), `missing desk surface: ${selector}`);
  }
});

test('the temporary desk panel is an overlay inside the desk root, never fixed', () => {
  const backdrop = WORKBENCH_CSS.split('.ec-wb .ec-wb-desk-panel-backdrop {')[1]?.split('}')[0] ?? '';
  assert.doesNotMatch(backdrop, /position\s*:\s*fixed/, 'the desk panel backdrop must not use fixed positioning (reserved for the palette)');
  assert.match(backdrop, /position\s*:\s*absolute/, 'the desk panel backdrop overlays the desk root');
});

test('the desk index previews a Work without opening, binding or running it', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  // Page-level preview state and the §2 selection rule (visible → priority → first; empty → none).
  assert.match(source, /const \[previewWorkId, setPreviewWorkId\] = useState<string \| null>\(null\)/, 'the page owns the preview as a bare workId');
  assert.match(source, /pickPreviewWorkId\(index\.rows, previewWorkId, priorityWork\?\.work\.workId/, 'auto-selection follows the plan §2 rule against the visible rows');
  assert.match(source, /if \(index\.busy \|\| index\.error\) return/, 'waiting and failed loads are not treated as an empty result');
  // The index row handler previews only: inspecting never opens, binds or runs a Work.
  const inspect = source.slice(source.indexOf('const inspectWork ='), source.indexOf('/** 单列首页「返回工作索引」'));
  assert.ok(inspect.length > 0, 'the inspect handler exists');
  assert.doesNotMatch(inspect, /openWork|openPendingById|bindWorkSession|createSession/, 'inspecting an index row must not create, bind or open anything');
  assert.match(inspect, /selectPage\('works'\)/, 'in a session, inspecting another row leaves through the existing navigation cleanup');
  // The brief is the only surface whose enter action opens the Work (through the existing openWork).
  assert.match(source, /onEnter=\{onOpenWork\}/, 'the brief enters the work conversation through the existing openWork path');
  assert.match(source, /onDownload=\{\(runId, name\) => saveArtifact\(runId, name\)\}/, 'brief downloads reuse the verified artifact save');
});

test('the desk width contract lives in container queries, not JS width state', () => {
  // 列显隐由 CSS container query 驱动：JS 不持有宽度状态（量 stage 自身会造成显隐反馈循环）。
  const source = WORKBENCH_CSS;
  assert.match(source, /container:\s*ec-desk\s*\/\s*inline-size/, 'the desk root is the inline-size container');
  assert.match(source, /@container ec-desk \(max-width:\s*1119\.9px\)/, 'the index column collapses to a header toggle below 1120px of main area');
  assert.match(source, /@container ec-desk \(max-width:\s*1179\.9px\)/, 'the materials rail becomes a toggleable panel below 1180px of main area (three columns would squeeze the chat under ~600px)');
  assert.match(source, /@container ec-desk \(max-width:\s*799\.9px\)/, 'the works home stacks the index above the brief below 800px');
});

test('the session desk carries the index and the materials rail as shell geometry only', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /\{ session: true, desk: true \}/, 'the session view renders in the desk shell');
  assert.match(source, /data-desk-rail=\{railPanelOpen \? 'open' : 'closed'\}/, 'the rail panel state is expressed as shell geometry');
  assert.doesNotMatch(source, /new ResizeObserver/, 'the desk measures nothing in JS — width is CSS-driven');
  assert.doesNotMatch(source, /deskWidth|indexColumn|railColumn|homeSingle/, 'no JS width state remains');
  // The work index never decides the native Session reference.
  assert.match(source, /selectedId=\{sessionWork \? sessionWork\.workId : previewWorkId\}/, 'the index highlights the current Work in a session and the preview on the home');
});

// ── 2026-11-24 P0 regressions ────────────────────────────────────────────────
// Six defects reproduced on the live build are locked out here: the desk grid squeezed into a 284px
// strip between 800 and 1120px of main area, the materials rail unreachable below 1180px, 8–11.5px
// type, clipped text in the collapsed rail, a permanent "loading" line and locale-blind index chips.

const stripCss = (css: string): string => css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/@keyframes[^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g, '');

interface CssRule { selector: string; at: string; declarations: string }

/** Every declaration block with its selector and the at-rule it sits in (nesting followed recursively). */
function cssRules(css: string, at = ''): CssRule[] {
  const rules: CssRule[] = []
  let index = 0
  for (;;) {
    const open = css.indexOf('{', index)
    if (open < 0) break
    const head = css.slice(index, open).trim()
    let depth = 1
    let cursor = open + 1
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1
      else if (css[cursor] === '}') depth -= 1
      cursor += 1
    }
    const body = css.slice(open + 1, cursor - 1)
    if (head.startsWith('@')) rules.push(...cssRules(body, head))
    else rules.push({ selector: head, at, declarations: body })
    index = cursor
  }
  return rules
}

test('the desk grid declares its columns once — no later rule may override the narrow fallback', () => {
  const gridRules = cssRules(stripCss(WORKBENCH_CSS))
    .filter((rule) => rule.selector.startsWith('.ec-wb.ec-wb-desk') && /grid-template-(columns|areas)/.test(rule.declarations))
  const unconditional = gridRules.filter((rule) => rule.at === '')
  assert.equal(unconditional.length, 1, 'exactly one unconditional desk grid rule (the base); a second one at equal specificity silently cancels every narrow fallback')
  assert.match(unconditional[0]?.declarations ?? '', /grid-template-columns:\s*284px minmax\(0, 1fr\)/)
  assert.match(unconditional[0]?.declarations ?? '', /grid-template-areas:\s*"index top" "index main"/)
  const inside = (at: string): boolean => gridRules.some((rule) => rule.at === at)
  assert.ok(inside('@container ec-desk (max-width: 1119.9px)'), 'the single-column fallback lives in the 1120px container query')
  assert.ok(inside('@container ec-desk (max-width: 799.9px)'), 'the stacked home lives in the 800px container query')
  for (const rule of gridRules.filter((candidate) => candidate.at !== '')) {
    assert.match(rule.at, /max-width/, 'desk grid overrides are narrow fallbacks only')
  }
});

test('the work-materials rail stays reachable at every width', () => {
  const railRules = cssRules(stripCss(WORKBENCH_CSS))
    .filter((rule) => /\.ec-wb-console-rail$/.test(rule.selector))
  for (const rule of railRules.filter((candidate) => /display\s*:\s*none/.test(candidate.declarations))) {
    assert.match(rule.selector, /\[data-desk-rail="closed"\]/, `only the closed panel state may hide the rail: ${rule.selector} (${rule.at || 'unconditional'})`)
  }
  const panelAt = '@container ec-desk (max-width: 1179.9px)'
  const panelRules = cssRules(stripCss(WORKBENCH_CSS)).filter((rule) => rule.at === panelAt)
  const open = panelRules.find((rule) => /\[data-desk-rail="open"\] \.ec-wb-console-rail$/.test(rule.selector))
  assert.ok(open, 'the rail has an open-panel rule below 1180px of main area')
  // display must be written explicitly: the closed state's display:none has the same specificity.
  assert.match(open?.declarations ?? '', /display\s*:\s*flex/)
  assert.match(open?.declarations ?? '', /position\s*:\s*absolute/)
  assert.ok(panelRules.some((rule) => /button\.ec-wb-rail-toggle$/.test(rule.selector) && /display\s*:\s*inline-flex/.test(rule.declarations)), 'the 工作资料 toggle is shown wherever the rail is a panel')
});

test('no text is set below the 12px floor (CJK needs it; the floor was 8–11.5px)', () => {
  const sizes = [...stripCss(WORKBENCH_CSS).matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]))
  assert.ok(sizes.length > 50, 'the stylesheet declares px font sizes')
  for (const size of sizes) assert.ok(size >= 12, `font-size ${size}px is below the 12px floor`)
});

test('the collapsed rail carries icons, tooltips and a pending badge — never text labels', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/sidebar-nav.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('if (collapsed) {');
  const end = source.indexOf('\n  return (\n    <div\n      ref={rootRef}', start);
  assert.ok(start >= 0 && end > start, 'the collapsed branch exists');
  const collapsed = source.slice(start, end);
  // The host's collapsed column is 56px wide: no translatable label fits (English is 1.6–2.2x wider than Chinese).
  assert.doesNotMatch(collapsed, /ec-wb-side-rail-text|ec-wb-side-rail-conn-text/, 'no text label or connection text in the rail');
  assert.match(collapsed, /className="ec-wb-side-rail-badge" aria-hidden="true">\{pending\}<\/span>/, '待我处理 shows its count as a badge');
  assert.match(collapsed, /aria-label=\{railLabel\(item\.id\)\}/, 'the pending count is part of the accessible name');
  assert.match(collapsed, /role="status"\s+aria-label=\{connection\}/, 'the connection dot keeps an accessible name');
  const css = stripCss(WORKBENCH_CSS);
  assert.doesNotMatch(css, /ec-wb-side-rail-text|ec-wb-side-rail-conn-text/, 'the text-label rules are gone, not merely unused');
  assert.match(css, /\.ec-wb \.ec-wb-side-rail-badge \{[^}]*position:\s*absolute/, 'the badge is positioned on its icon button');
});

test('the work index mounts once — the desk grid places it, only the overlay adds a copy', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /indexSlot|ec-wb-home-inline/, 'the home no longer renders a second (hidden) copy of the index');
  assert.equal([...source.matchAll(/\{deskIndexNode\}/g)].length, 2, 'the index renders in the desk grid area and, only while open, in the temporary panel');
  assert.match(source, /data-home-mode=\{homeMode\}/, 'the home posture coordinate lives on the desk grid root');
  assert.match(source, /const homeMode = creating \|\| \(previewRow && !previewCleared\) \? 'brief' : 'index'/, 'a brief or the create wizard yields the index row to the main area; 返回工作索引 (previewCleared) hands it back');
  assert.doesNotMatch(WORKBENCH_CSS, /ec-wb-home-inline|ec-wb-desk-index-inline|ec-wb-desk-stage/, 'no rule keeps styling the removed wrappers');
  const placement = cssRules(stripCss(WORKBENCH_CSS)).find((rule) => rule.at === '' && /\.ec-wb-desk-index$/.test(rule.selector));
  assert.match(placement?.declarations ?? '', /grid-area:\s*index/, 'the index is placed by the desk grid area');
});

test('a Work without a run shows an honest activity empty state, never a permanent loading line', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/work-brief.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('id="ec-wb-brief-activity"');
  const activity = source.slice(start, source.indexOf('</section>', start));
  assert.ok(start >= 0 && activity.length > 0, 'the activity section exists');
  assert.doesNotMatch(activity, /\{!run \|\| events\.status === 'loading'\}/, 'the loading line is not keyed on "no run"');
  assert.match(activity, /runState\.status === 'loading'\s*\?\s*<p className="ec-wb-muted" role="status">\{t\('home\.loading', locale\)\}<\/p>/, 'locating the run is the only loading state');
  assert.match(activity, /runState\.status === 'none'\s*\?\s*<p className="ec-wb-muted">\{t\('brief\.noActivity', locale\)\}<\/p>/, 'no run is an empty state, not a spinner');
});

test('index row chips follow the interface language', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /workRowState\(row, latestRuns\.get\(row\.workId\), locale\)/, 'workRowState defaults to zh-CN unless the locale is passed');
  assert.match(source, /\[index\.rows, latestRuns, reviewWorkIds, preferences\.locale\]/, 'the memo recomputes when the language changes');
});
