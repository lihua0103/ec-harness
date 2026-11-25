// 员工 Web profile 装配（单侧栏架构 2026-11-21 · ADR-0003 2026-11-25 修订）：把
// `packages/platform-workbench/employee-web.patch.yml` 的行幂等合并进目标 profile 的 cordis.patch.yml
// 用户层，或在 --rollback 时移除。
// 用法：
//   node scripts/apply-employee-web-profile.cjs --profile <DSH_HOME>/profiles/employee
//   node scripts/apply-employee-web-profile.cjs --profile <DSH_HOME>/profiles/employee --rollback
// profile 的 cordis.patch.yml 缺失时创建（用户层 outrank bundle 层的 patch 行）。
// 运行时由脚本再生成的 patch 文件（如 .runtime 下的同步产物）不要手改——优先用 --patch 叠加。
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

const args = process.argv.slice(2);
const arg = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const profile = arg('profile');
if (!profile) {
  console.error('Usage: node scripts/apply-employee-web-profile.cjs --profile <DSH_HOME>/profiles/employee [--rollback]');
  process.exit(1);
}
const rollback = args.includes('--rollback');

// 工作台插入行 + 各 disabled 行；每行以 id 在用户层定位，重复应用幂等。
const WORKBENCH_INSERT = [
  '- insert:',
  '    - id: ec-platform-workbench',
  '      name: "@ec-clinical/platform-workbench"',
];
// ADR-0003 2026-11-25：员工 Web 禁管理/定时/目标/HMR（agent 侧基线），不只隐藏侧栏树。
const GOVERNANCE_DISABLED = [
  'ui-sidebar',
  'tool-plugin-manager',
  'schedule',
  'tool-schedule',
  'goal',
  'command-goal',
  'tool-goal',
  'hmr',
];

const patchPath = resolve(profile, 'cordis.patch.yml');
if (!existsSync(profile)) mkdirSync(profile, { recursive: true });
const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
const lines = existing.length > 0 ? existing.replace(/\r\n/g, '\n').split('\n') : [];
const hasWorkbench = () => lines.some((line) => line.trim() === '- id: ec-platform-workbench');
const hasDisabled = (id) => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `- id: ${id}`) {
      const next = lines[i + 1] ?? '';
      if (/^\s*disabled:\s*true\s*$/.test(next)) return true;
    }
  }
  return false;
};

if (rollback) {
  let changed = false;
  // 移除本脚本写入的 disabled 行（仅当其 disabled: true 紧跟 id 行）。
  for (const id of GOVERNANCE_DISABLED) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === `- id: ${id}` && /^\s*disabled:\s*true\s*$/.test(lines[i + 1] ?? '')) {
        lines.splice(i, 2);
        changed = true;
        break;
      }
    }
  }
  // 移除本脚本写入的 workbench 插入条目；企业导航以 priority -1 遮蔽默认侧栏，只恢复 disabled
  // 行还不够——insert 行不移除，默认侧栏不会真正回到员工界面。
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '- id: ec-platform-workbench') {
      const entryLines = /^\s*- id: /.test(lines[i]) ? 2 : 2; // id 行 + 紧随的 name 行
      lines.splice(i, entryLines);
      changed = true;
      // insert 行下没有剩余条目时一并移除（- insert: 的下一行不再以 "- " 开头）。
      const insertIndex = lines.findIndex((line) => line.trim() === '- insert:');
      if (insertIndex >= 0 && !/^\s*-\s/.test(lines[insertIndex + 1] ?? '')) {
        lines.splice(insertIndex, 1);
      }
      break;
    }
  }
  writeFileSync(patchPath, `${lines.join('\n').replace(/\n+$/, '')}\n`);
  console.log(`rollback: governance disabled ${changed ? 'removed' : 'not present'}, workbench insert removed if present → ${patchPath}`);
  process.exit(0);
}

let changed = false;
if (!hasWorkbench()) {
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
  lines.push(...WORKBENCH_INSERT);
  changed = true;
}
for (const id of GOVERNANCE_DISABLED) {
  if (!hasDisabled(id)) {
    lines.push(`- id: ${id}`, '  disabled: true');
    changed = true;
  }
}
if (!changed) {
  console.log(`already applied: ${patchPath}`);
  process.exit(0);
}
writeFileSync(patchPath, `${lines.join('\n').replace(/\n+$/, '')}\n`);
console.log(`applied: workbench insert ${hasWorkbench() ? '✓' : '✗'}, governance disabled ${GOVERNANCE_DISABLED.filter(hasDisabled).length}/${GOVERNANCE_DISABLED.length} → ${patchPath}`);
