/** Local installation doctor CLI.
 *
 *  Usage:
 *    node --import tsx src/doctor-cli.ts [--store <control.sqlite>] [--deployment <dir>] [--no-sdk]
 *
 *  Exit code 0: no failing check (warnings allowed). 1: at least one failing check.
 */
import { resolve } from 'node:path';
import { readDeployment } from './deployment.js';
import { defaultControlStorePath, resolveControlHome, resolveStorePath } from './config.js';
import { runDoctor } from './doctor.js';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const deploymentPath = arg('deployment') ?? process.env.PLATFORM_WORKBENCH_DEPLOYMENT;
const deployment = deploymentPath ? await readDeployment(resolve(deploymentPath)) : null;
// E0d: the doctor checks the same canonical store every other entrypoint reads and writes.
const storePath = resolve(
  arg('store') ?? (deployment ? resolveStorePath(deployment.config) : defaultControlStorePath(resolveControlHome())),
);
const report = await runDoctor({
  storePath,
  ...(deployment?.config.worker ? { worker: deployment.config.worker } : {}),
  ...(args.includes('--no-sdk') ? { checkSdk: false } : {}),
});
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);