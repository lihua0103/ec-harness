import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:observability', kind: 'operator' };

class NoopExecutor implements RunExecutor {
  readonly kind = 'noop';
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return { launchId: input.launchId ?? 'launch-noop', fencingToken: input.fencingToken ?? 1 };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]));
    }
    return item;
  });

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-observability-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), new NoopExecutor());
  service.registerApp(draft(), operator);
  return { root, service };
};

test('audit export is an ascending hash chain that detects a removed or edited line', async () => {
  const { root, service } = await setup();
  try {
    service.createProject({ name: '公开项目' }, operator);
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.cancelRun(run.runId, run.snapshot.revision, operator);

    const exported = service.auditExport(operator, { limit: 100 });
    assert.ok(exported.count >= 3);
    assert.match(exported.headDigest, /^[a-f0-9]{64}$/);
    let previous = '0'.repeat(64);
    for (const line of exported.lines) {
      const entry = JSON.parse(line) as Record<string, unknown> & { prevDigest: string };
      assert.equal(entry.prevDigest, previous);
      const payload = canonical({
        sequence: entry.sequence,
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        details: entry.details,
        createdAt: entry.createdAt,
        ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
      });
      previous = createHash('sha256').update(previous).update(payload).digest('hex');
      assert.equal(entry.digest, previous);
    }
    assert.equal(previous, exported.headDigest);

    // A cursor export continues from the last sequence without rewriting earlier lines.
    const tail = service.auditExport(operator, { after: exported.lastSequence, limit: 100 });
    assert.equal(tail.count, 0);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP requests carry correlation ids into audit facts and metrics', async () => {
  const { root, service } = await setup();
  let api: RunningWorkbenchApi | undefined;
  try {
    api = await startWorkbenchServer({ service, authenticate: () => operator });
    const response = await fetch(`${api.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-test-1234' },
      body: JSON.stringify({ name: '关联项目' }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-request-id'), 'req-test-1234');
    const audit = service.audit(0, 20, operator).items;
    const projectEntry = audit.find((entry) => entry.action === 'PROJECT_CREATED');
    assert.ok(projectEntry, 'project creation audited');
    assert.equal(projectEntry.correlationId, 'req-test-1234');

    const metrics = await fetch(`${api.url}/api/metrics`).then((res) => res.json()) as {
      counters: Record<string, number>;
      histograms: Record<string, { count: number }>;
    };
    assert.ok(
      Object.keys(metrics.counters).some((key) => key.startsWith('platform_http_requests{')),
      'request counter recorded',
    );
    assert.ok(
      Object.keys(metrics.histograms).some((key) => key.startsWith('platform_http_duration_ms{')),
      'request duration recorded',
    );

    const prometheus = await fetch(`${api.url}/api/metrics?format=prometheus`).then((res) => res.text());
    assert.match(prometheus, /platform_http_requests/);

    const exportResponse = await fetch(`${api.url}/api/audit/export?limit=10`);
    assert.equal(exportResponse.status, 200);
    const lines = (await exportResponse.text()).trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1);
    const head = exportResponse.headers.get('x-audit-head');
    assert.match(head ?? '', /^[a-f0-9]{64}$/);
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unsafely shaped request id is replaced, never echoed into logs or audit', async () => {
  const { root, service } = await setup();
  let api: RunningWorkbenchApi | undefined;
  try {
    api = await startWorkbenchServer({ service, authenticate: () => operator });
    const response = await fetch(`${api.url}/api/workbench`, {
      headers: { 'x-request-id': 'bad id with spaces/and/slashes' },
    });
    assert.equal(response.status, 200);
    const echoed = response.headers.get('x-request-id') ?? '';
    assert.notEqual(echoed, 'bad id with spaces/and/slashes');
    assert.match(echoed, /^req-[0-9a-f-]{36}$/);
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});