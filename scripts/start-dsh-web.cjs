// Start the checked-out DSH Web profile with a project-local home.
//
// 2026-11-11 真实 web 运行约束：
// - cwd = 项目根（不是 upstream）：web profile 的沙箱 workspaceRoot 取
//   process.cwd()，默认 workspace-write。工作区设为项目根后，agent 可直接
//   读写 .runtime 下的方案 PDF 与产出工作簿，不触发逐次审批，同时不写入
//   upstream 锁定源码。
// - tsx 以官方入口 `tsx/esm` 注册（cwd=upstream 保证 @deepseek-ai/* 解析到
//   upstream/node_modules 的 ESM 构建）；随后 launcher 把工作区切到项目根。
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const upstream = path.join(root, 'upstream', 'deepseek-harness-git');
const launcher = path.join(__dirname, 'dsh-web-launcher.cjs');

const env = { ...process.env };
const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path';
env[pathKey] = path.dirname(process.execPath) + path.delimiter + env[pathKey];
env.DSH_HOME = path.join(root, '.runtime', 'dsh-home');

const child = spawn(process.execPath, ['--import', 'tsx/esm', launcher, 'web', '--host', '127.0.0.1', '--port', '3080'], {
  cwd: upstream,
  env,
  stdio: 'inherit',
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));