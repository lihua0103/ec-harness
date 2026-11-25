import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';

const operator: Principal = { actorId: 'session:ops', kind: 'operator' };

test('the operations panel reports measurements, doctor facts and the honest SLO gap (E3-1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-ops-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, { requireArtifacts: false });
  const api = await startWorkbenchServer({
    service,
    authenticate: () => operator,
    doctor: () => Promise.resolve({
      ok: true,
      generatedAt: '2026-11-18T00:00:00.000Z',
      checks: [{ name: 'node.version', status: 'ok', detail: 'Node ok' }],
    }),
  });
  try {
    const response = await fetch(`${api.url}/api/ops/panel`);
    assert.equal(response.status, 200);
    const panel = await response.json() as {
      metrics: { histograms: Record<string, unknown> };
      status?: Record<string, unknown>;
      doctor: { ok: boolean; checks: unknown[] } | null;
      doctorNote: string;
      slo: { targets: unknown; note: string };
      storage?: Record<string, unknown>;
      quotas?: Record<string, unknown>;
    };
    assert.equal(panel.doctor?.ok, true);
    assert.equal(panel.doctor?.checks.length, 1);
    assert.match(panel.doctorNote, /全部检查通过/);
    // The honest core: no SLO targets exist, and the panel says so instead of implying success.
    assert.equal(panel.slo.targets, null);
    assert.match(panel.slo.note, /尚未定义/);
    assert.ok(panel.storage);
    assert.ok(panel.quotas);

    // A throwing doctor probe degrades to an honest note, never a fabricated pass.
    const failing = await startWorkbenchServer({
      service,
      authenticate: () => operator,
      doctor: () => { throw new Error('probe down'); },
    });
    try {
      const degraded = await fetch(`${failing.url}/api/ops/panel`);
      const body = await degraded.json() as { doctor: unknown; doctorNote: string };
      assert.equal(body.doctor, null);
      assert.match(body.doctorNote, /探针执行失败/);
    } finally {
      await failing.close();
    }
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
