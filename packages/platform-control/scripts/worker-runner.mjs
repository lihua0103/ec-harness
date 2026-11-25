#!/usr/bin/env node
/** Child worker runner.
 *
 *  Runs one platform job in a dedicated Node process and speaks the NDJSON protocol documented in
 *  `src/child-worker.ts`. It is intentionally small: the control plane owns lifecycle, artifacts
 *  and supervision; this process only hosts the locked DSH SDK harness.
 */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const jobPath = process.argv[2];
if (!jobPath) {
  process.stderr.write('WORKER_JOB_MISSING\n');
  process.exit(2);
}

const out = (message) => {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // The parent closed the pipe; the process is being torn down.
  }
};

const job = JSON.parse(await readFile(jobPath, 'utf8'));
const abort = new AbortController();
const pendingAnswers = new Map();

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === 'cancel') {
    abort.abort();
    for (const resolve of pendingAnswers.values()) resolve({ cancelled: true });
    pendingAnswers.clear();
    return;
  }
  if (message.type === 'answer' && typeof message.requestId === 'string') {
    const resolve = pendingAnswers.get(message.requestId);
    if (resolve) {
      pendingAnswers.delete(message.requestId);
      resolve(message.result ?? { cancelled: true });
    }
  }
});

let sdk;
try {
  sdk = await import('@deepseek-ai/dsh-sdk-client');
} catch {
  out({ type: 'error', error: 'WORKER_SDK_UNAVAILABLE' });
  process.exit(3);
}

const askParent = (request, context) =>
  new Promise((resolve) => {
    if (context?.signal?.aborted) {
      resolve({ cancelled: true });
      return;
    }
    pendingAnswers.set(request.requestId, resolve);
    out({ type: 'question', request });
    context?.signal?.addEventListener('abort', () => {
      if (!pendingAnswers.has(request.requestId)) return;
      pendingAnswers.delete(request.requestId);
      resolve({ cancelled: true });
    }, { once: true });
  });

let failed = false;
let harness;
try {
  harness = new sdk.DeepSeekHarness({
    ...job.harness,
    cwd: job.cwd,
    onUserQuestion: askParent,
  });
  const result = await harness.run(job.prompt, {
    signal: abort.signal,
    onNotification: (notification) => out({ type: 'notification', notification }),
  });
  out({
    type: 'result',
    result: {
      sessionId: result.sessionId,
      finalResponse: result.finalResponse,
      ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
      ...(result.events !== undefined ? { events: result.events } : {}),
    },
  });
} catch (error) {
  if (!abort.signal.aborted) {
    failed = true;
    out({ type: 'error', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
} finally {
  try { await harness?.close() } catch { /* exit code still reflects the run */ }
}
process.exit(failed ? 1 : 0);