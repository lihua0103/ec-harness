/** Explicitly approved local synthetic execution. This runner is NOT a clinical-data sandbox. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, lstat, writeFile, realpath, open } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { runtimeEnvironment } from './runtime-env.js';
import { verifyArtifacts, type ArtifactCheck } from './artifacts.js';
import { CHECKER_VERSION, checkSynthetic, type Check } from './checker.js';
import { ListingError } from './workbook.js';
import type { Scenario, PkType } from './knowledge.js';

export interface RuntimeSpec { executable: string; kind: 'Rterm' | 'Rscript'; home: string; }
export interface ExecutionDiagnostics { logFile: string; logBytes: number; tail: string; }
export interface ExecutionReceipt {
  runId: string; programDigest: string; inputDigest: string; runtimeDigest: string; runtimeVersion: string;
  status: 'PASSED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'OUTPUT_LIMIT';
  exitCode: number | null; check: Check | null; outputDigest: string | null; artifacts?: ArtifactCheck;
  diagnostics?: ExecutionDiagnostics;
  startedAt: string; finishedAt: string; enforcement: 'UNCONFINED_SYNTHETIC';
}
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** File metadata checks detect ordinary replacement, not an adversarial same-user kernel/filesystem. */
export async function readRegularFile(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw new ListingError('ARTIFACT_NOT_REGULAR');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > limit) throw new ListingError('ARTIFACT_CHANGED');
    const data = await handle.readFile();
    if (data.length > limit) throw new ListingError('ARTIFACT_TOO_LARGE');
    return data;
  } finally { await handle.close(); }
}

/** Best-effort OS liveness query for a recorded PID; recovery evidence, never a termination mechanism. */
export async function processAlive(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const text = await new Promise<string>(done => {
      const probe = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let captured = '';
      probe.stdout.on('data', (chunk: Buffer) => { if (captured.length < 65536) captured += chunk.toString('utf8'); });
      probe.once('error', () => done(''));
      probe.once('close', () => done(captured));
    });
    // tasklist prints an INFO line (not CSV) when nothing matches; a matching row keeps the pid between commas.
    return new RegExp(`"?${pid}"?,`).test(text);
  }
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Version probe runs only an operator-configured R executable, never a model-supplied command. */
export async function probeRuntime(runtime: RuntimeSpec): Promise<{ version: string; digest: string }> {
  if (!['Rterm', 'Rscript'].includes(runtime.kind)) throw new ListingError('RUNTIME_INVALID');
  const executable = await realpath(resolve(runtime.executable));
  if (!/^R(?:term|script)(?:\.exe)?$/i.test(basename(executable))) throw new ListingError('RUNTIME_INVALID');
  const binary = await readFile(executable);
  const args = runtime.kind === 'Rterm'
    ? ['--vanilla', '--slave', '-e', 'cat(R.version.string)'] : ['--vanilla', '-e', 'cat(R.version.string)'];
  return new Promise((resolveProbe, reject) => {
    let output = '', settled = false;
    const child = spawn(executable, args, { cwd: runtime.home, env: runtimeEnvironment(runtime, runtime.home), windowsHide: true, shell: false });
    const timer = setTimeout(() => { settled = true; child.kill(); reject(new ListingError('RUNTIME_PROBE_TIMEOUT')); }, 10000);
    child.stdout.on('data', data => { if (output.length < 4096) output += data.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); settled = true; reject(new ListingError('RUNTIME_UNAVAILABLE')); });
    child.once('close', code => {
      clearTimeout(timer); if (settled) return;
      if (code !== 0 || !/^R version \d+\.\d+\.\d+[^\r\n]{0,100}$/.test(output.trim())) reject(new ListingError('RUNTIME_UNAVAILABLE'));
      else resolveProbe({ version: output.trim(), digest: sha256(binary) });
    });
  });
}
interface RunInput {
  runId: string; directory: string; code: string; input: string; scenario: Scenario; pkType?: PkType;
  runtime: RuntimeSpec; timeoutMs?: number; signal?: AbortSignal;
}
/** Call only after a trusted human approval bound to this code digest, with NO real-data input. */
export async function runLocalSynthetic(request: RunInput): Promise<ExecutionReceipt> {
  if (request.signal?.aborted) throw new ListingError('CANCELLED');
  const directory = await realpath(request.directory);
  const configuredRuntime: RuntimeSpec = { ...request.runtime,
    executable: await realpath(resolve(request.runtime.executable)), home: await realpath(resolve(request.runtime.home)) };
  const runtime = await probeRuntime(configuredRuntime);
  if (request.signal?.aborted) throw new ListingError('CANCELLED');
  await writeFile(join(directory, 'main.R'), request.code, { flag: 'wx' });
  await writeFile(join(directory, 'input.csv'), request.input, { flag: 'wx' });
  const receipt: ExecutionReceipt = { runId: request.runId, programDigest: sha256(request.code), inputDigest: sha256(request.input),
    runtimeDigest: runtime.digest, runtimeVersion: runtime.version, status: 'FAILED', exitCode: null, check: null, outputDigest: null,
    startedAt: new Date().toISOString(), finishedAt: '', enforcement: 'UNCONFINED_SYNTHETIC' };
  const args = configuredRuntime.kind === 'Rterm'
    ? ['--vanilla', '--slave', '--file=main.R', '--args', 'input.csv', 'output.csv']
    : ['--vanilla', 'main.R', 'input.csv', 'output.csv'];
  let logTail = '', logBytes = 0;
  const reason = await new Promise<ExecutionReceipt['status'] | null>((resolveRun, reject) => {
    let bytes = 0, output = Buffer.alloc(0), stopped: ExecutionReceipt['status'] | null = null, terminating = false;
    const child = spawn(configuredRuntime.executable, args, { cwd: directory, env: runtimeEnvironment(configuredRuntime, directory),
      shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    if (child.pid) void writeFile(join(directory, 'process.json'), JSON.stringify({ pid: child.pid }), { flag: 'wx' }).catch(() => {});
    const stop = (status: ExecutionReceipt['status']) => {
      if (terminating) return; terminating = true; stopped = status;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => child.kill('SIGKILL')); killer.on('close', code => { if (code !== 0) child.kill('SIGKILL'); });
      } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const abort = () => stop('CANCELLED');
    const timer = setTimeout(() => stop('TIMED_OUT'), Math.min(Math.max(request.timeoutMs ?? 30000, 100), 120000));
    const capture = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) stop('OUTPUT_LIMIT');
      else output = Buffer.concat([output, chunk]);
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    child.once('error', () => { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); reject(new ListingError('RUNTIME_SPAWN_FAILED')); });
    child.once('close', async code => {
      clearTimeout(timer); request.signal?.removeEventListener('abort', abort); receipt.exitCode = code;
      logBytes = output.length; logTail = output.subarray(Math.max(0, output.length - 4000)).toString('utf8');
      try { await writeFile(join(directory, 'execution.local.log'), output, { flag: 'wx' }); resolveRun(stopped); }
      catch { reject(new ListingError('EXECUTION_LOG_WRITE_FAILED')); }
    });
  });
  if (reason) receipt.status = reason;
  else if (receipt.exitCode === 0) {
    try {
      const output = await readRegularFile(join(directory, 'output.csv'), 1024 * 1024);
      receipt.outputDigest = sha256(output);
      receipt.check = checkSynthetic(request.scenario, request.pkType, request.input, output.toString('utf8'));
      if(receipt.check.passed) {
        const xlsx=await readRegularFile(join(directory,'output.xlsx'),4*1024*1024);
        const rds=await readRegularFile(join(directory,'output.rds'),1024*1024);
        receipt.artifacts=await verifyArtifacts(request.scenario,request.pkType,output.toString('utf8'),xlsx,rds,configuredRuntime,request.signal);
        receipt.status='PASSED';
      }
    } catch(error) {
      receipt.status=request.signal?.aborted?'CANCELLED':'FAILED';
      receipt.check = { passed: false, code: error instanceof ListingError ? error.code : 'OUTPUT_UNAVAILABLE', checkerVersion: CHECKER_VERSION };
    }
  }
  receipt.diagnostics = { logFile: 'execution.local.log', logBytes, tail: logTail };
  receipt.finishedAt = new Date().toISOString();
  return receipt;
}
