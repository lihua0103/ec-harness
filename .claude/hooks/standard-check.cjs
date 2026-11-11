// PostToolUse hook: run the executable development-standard boundary check
// automatically after every Write/Edit of a source file in this repository.
// Non-source files exit immediately; source files trigger
// scripts/check-development-standard.mjs (cross-plugin imports, exports-bypassing
// package imports). A violation surfaces its output to the editing session so the
// boundary is fixed at write time, not at delivery time.
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input);
    const file = payload.tool_input?.file_path ?? payload.tool_response?.filePath;
    if (!file || !/\.(ts|tsx|js|mjs|cjs)$/.test(file)) process.exit(0);
  } catch {
    process.exit(0);
  }
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..', '..');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-development-standard.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`standard-check hook could not run: ${result.error.message}`);
    process.exit(0); // Reporting failure must not block the already-completed edit.
  }
  process.exit(result.status ?? 0);
});
