import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// DSH 0.2.2-rc.2 narrowed the macOS Desktop window-drag exclusion
// (upstream docs/upgrade-guide/v0.2.2-rc.1/window-drag-regions): an interactive control is
// subtracted from the window's drag geometry only inside a `data-window-drag` row or an
// `data-window-drag-controls` scope. The workbench draws its overlays outside those scopes, so
// each one excludes its own visible box with `data-window-drag-exclude`; without the mark, a
// control that lands on a draggable header row would drag the window instead of acting.
// The attribute is inert on Web and on Windows (the rule is scoped to html[data-platform='darwin']).

const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string): string => readFileSync(join(here, '..', 'src', 'client', name), 'utf8');
const EXCLUDE = /\bdata-window-drag-exclude\b/;

/**
 * The complete JSX opening tag of the first `<div>` carrying `className`, read to the `>` that
 * closes the tag rather than to a `>` inside an attribute's arrow function.
 */
function openingTag(file: string, className: string): string {
  const text = source(file);
  const at = text.indexOf(`className="${className}"`);
  assert.ok(at >= 0, `${file}: an element with className="${className}" must exist`);
  const open = text.lastIndexOf('<div', at);
  let depth = 0;
  for (let index = open + '<div'.length; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === '>' && depth === 0) return text.slice(open, index + 1);
  }
  return assert.fail(`${file}: the opening tag with className="${className}" must close`);
}

test('the global search palette excludes both its backdrop and its dialog box', () => {
  // The backdrop covers the whole window, so it must not swallow a press as a window drag either.
  assert.match(openingTag('WorkbenchPage.tsx', 'ec-wb-palette-backdrop'), EXCLUDE);
  const palette = openingTag('WorkbenchPage.tsx', 'ec-wb-palette');
  assert.match(palette, /role="dialog"/);
  assert.match(palette, EXCLUDE);
});

test('the desk panel dialog and the desk tools menu exclude their visible boxes', () => {
  const panel = openingTag('work-desk-frame.tsx', 'ec-wb-desk-panel');
  assert.match(panel, /role="dialog"/);
  assert.match(panel, EXCLUDE);
  const menu = openingTag('work-desk-frame.tsx', 'ec-wb-desk-tools-menu');
  assert.match(menu, /role="menu"/);
  assert.match(menu, EXCLUDE);
});

test('the desk filter panel excludes its visible box', () => {
  assert.match(openingTag('work-index.tsx', 'ec-wb-desk-filter-panel'), EXCLUDE);
});

test('the sidebar is drag-excluded only while it is the modal drawer', () => {
  const root = openingTag('sidebar-nav.tsx', 'ec-wb ec-wb-side');
  // The persistent rail keeps its own controls; only the open drawer covers content as an overlay.
  assert.match(root, /role=\{dialogOpen \? 'dialog' : undefined\}/);
  assert.match(root, /data-window-drag-exclude=\{dialogOpen \|\| undefined\}/);
});

test('the built client bundle carries the exclusion attribute', () => {
  // The verify order builds before testing, so the bundle exists and must keep the marks.
  const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
  assert.ok(bundle.includes('data-window-drag-exclude'), 'lib/client.js must keep the attribute');
});
