import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'lib', 'client.js');

// The verify order builds before testing, so the bundle exists. A missing bundle is a real
// failure of the browser half, not a skip.
test('the client bundle registers a ModuleLoader factory with apply/inject', () => {
  assert.equal(existsSync(bundlePath), true, 'lib/client.js must be built');
  let captured: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined;
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec: typeof captured) => { captured = spec; } } },
  };
  vm.runInNewContext(readFileSync(bundlePath, 'utf8'), sandbox);
  assert.ok(captured, 'bundle must call window.__ModuleLoader__.load');
  assert.equal(captured!.id, '@ec-clinical/platform-workbench');
  // Every external (react, @deepseek-ai/*) is resolved by the shell's module table via `require`.
  const requireStub = () => new Proxy({}, { get: () => () => ({}) });
  const exports = captured!.factory(requireStub);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(JSON.stringify(exports.inject), JSON.stringify(['slots', 'layout', 'sessions', 'workspaces']));
});

test('the client bundle never embeds a second React or a top-level ESM import', () => {
  const text = readFileSync(bundlePath, 'utf8');
  const head = text.split('\n').slice(0, 8).join('\n');
  assert.equal(/\bimport\s+.*\bfrom\b/.test(head), false, 'client bundle must not start with ESM imports');
  // React must be requested through the loader, never inlined.
  assert.match(text, /require\("react\/jsx-runtime"\)/);
  assert.equal(text.includes("react-dom"), false, "client bundle must not embed react-dom");
  // The embedded-session wiring ships in the bundle: the page's session child slot declaration
  // and the upstream conversation factory the session host calls.
  assert.match(text, /workbench\.session/);
  assert.match(text, /conversation\.content/);
});
