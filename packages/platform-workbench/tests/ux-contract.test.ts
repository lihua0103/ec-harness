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

// 2026-11-13 concept-draft alignment: the shell carries the brand topbar and a navigation column
// with recent Works; the home page has the AI launch entry, a readiness rail and a Works table;
// the work console keeps a run rail beside the native thread without owning the thread itself.
test('the concept draft surfaces are present in the page stylesheet', () => {
  for (const selector of [
    '.ec-wb-topbar',
    '.ec-wb-wordmark',
    '.ec-wb-nav-caption',
    '.ec-wb-recent',
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

// The center is always the Work's native conversation; inspecting a run updates the rail only.
// A run record must never unmount the native thread or its composer.
test('the work console keeps the native conversation and puts run records in the rail', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /const activeRun = runs\.find/, 'console must derive the active run');
  assert.match(source, /活动运行/, 'rail must show the active run while none is selected');
  assert.match(source, /实时对话只显示本工作的 AI 对话，运行活动在运行记录中/, 'the console must explain where run activity lives');
  assert.doesNotMatch(source, /aria-label="中心内容"/, 'there must be no live-chat / run-record mode switch');
  const center = source.slice(
    source.indexOf('<div className="ec-wb-console-center">'),
    source.indexOf('<aside className="ec-wb-console-rail"'),
  );
  assert.match(center, /ec-wb-console-thread/, 'the center must always render the native thread');
  assert.doesNotMatch(center, /RunTranscript/, 'the run record must not replace the native thread');
  const rail = source.slice(source.indexOf('<aside className="ec-wb-console-rail"'));
  assert.match(rail, /<RunTranscript /, 'the run transcript lives in the rail');
});

test('the 2026-11-17 experience pass surfaces are present and scoped', () => {
  for (const selector of [
    '.ec-wb .ec-wb-rail-record',
    '.ec-wb .ec-wb-mode-banner',
    '.ec-wb .ec-wb-console-center',
    '.ec-wb .ec-wb-bind-steps',
    '.ec-wb .ec-wb-wizard',
    '.ec-wb .ec-wb-stepbar',
    '.ec-wb .ec-wb-freshness',
    '.ec-wb .ec-wb-session-tools',
  ]) {
    assert.ok(WORKBENCH_CSS.includes(selector), `missing experience surface: ${selector}`);
  }
  // The rail's record card bounds its transcript window instead of growing the rail unbounded.
  assert.ok(
    WORKBENCH_CSS.includes('.ec-wb .ec-wb-rail-record .ec-wb-transcript'),
    'the rail record keeps a bounded transcript window',
  );
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
