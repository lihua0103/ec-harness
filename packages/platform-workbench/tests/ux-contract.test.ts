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
  // No fixed positioning that could cover the native conversation.
  assert.equal(/position\s*:\s*fixed/.test(stripped), false);
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
