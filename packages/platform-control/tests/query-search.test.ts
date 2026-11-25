import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunOutcome } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:query', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:query', kind: 'service' };

class OutcomeExecutor implements RunExecutor {
  readonly kind = 'outcome';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return {
      launchId: input.launchId ?? 'launch-query',
      fencingToken: input.fencingToken ?? 1,
      outcome: Promise.resolve(this.outcome),
    };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const waitFor = async (service: PlatformControlService, runId: string): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = service.getRun(runId, operator).snapshot.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not reach a terminal state');
};

const succeededWithArtifacts = async (dir: string): Promise<RunOutcome> => {
  const name = 'listing.xlsx';
  const content = 'A,G,nh,po';
  const sourcePath = join(dir, name);
  await writeFile(sourcePath, content);
  return {
    status: 'succeeded',
    exitProven: true,
    cleanedUp: true,
    finishReason: 'completed',
    descendantsDone: true,
    consumedThrough: 1,
    artifacts: [{
      name,
      digest: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
      sourcePath,
    }],
  };
};

type QueryWorkApi = {
  items: Array<{ workId: string; title: string; projectId: string; appId: string; state: string }>;
  nextCursor: string | null;
};
type QueryRunApi = {
  items: Array<{ runId: string; workId: string | null; appId: string }>;
  nextCursor: string | null;
};
type SearchApi = {
  items: Array<{ kind: string; id: string; title: string; workId?: string; runId?: string }>;
};

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-query-'));
  const filesDir = join(root, 'worker-out');
  await mkdir(filesDir, { recursive: true });
  const service = new PlatformControlService(
    join(root, 'control.sqlite'),
    new OutcomeExecutor(await succeededWithArtifacts(filesDir)),
    undefined,
    { requireArtifacts: true },
  );
  service.registerApp(draft(), operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  const project = service.createProject({ name: '肾病三期项目' }, operator);
  const escTitle = '达标率100%清单';
  const works = [
    service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: '1.0.0', title: '基线指标清单' }, operator),
    service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: '1.0.0', title: '终点指标清单' }, operator),
    service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: '1.0.0', title: escTitle }, operator),
    service.createWork({ projectId: 'OTHER-PRJ', appId: 'listing', appVersion: '1.0.0', title: '别的项目清单' }, operator),
  ];
  const runs = [
    await (async () => {
      const run = service.createWorkRun(works[0].workId, { goal: '产出基线Listing交付物' }, operator);
      await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
      assert.equal(await waitFor(service, run.runId), 'SUCCEEDED');
      return run;
    })(),
    service.createWorkRun(works[1].workId, { goal: '核对终点指标定义' }, operator),
  ];
  return { root, service, project, works, escTitle, runs };
};

test('GET /api/works/query filters server-side and pages by keyset cursor (E4-3)', async () => {
  const { root, service, project, works, escTitle, runs } = await setup();
  let api: RunningWorkbenchApi | undefined;
  try {
    service.archiveWork(works[3].workId, operator);
    api = await startWorkbenchServer({ service, authenticate: () => operator });

    // Cursor pagination: limit=2 walks all four works in updated_at DESC order without
    // duplicates, and ends with nextCursor=null.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = new URL(`${api.url}/api/works/query`);
      url.searchParams.set('limit', '2');
      if (cursor) url.searchParams.set('cursor', cursor);
      const page = await fetch(url).then((res) => res.json()) as QueryWorkApi;
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((item) => item.workId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 2);
    assert.deepEqual([...seen].sort(), [...works.map((work) => work.workId)].sort());
    assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');

    // Filters compose: project + app + active state.
    const filtered = await fetch(`${api.url}/api/works/query?projectId=${project.projectId}&appId=listing&state=ACTIVE`)
      .then((res) => res.json()) as QueryWorkApi;
    assert.deepEqual(
      [...filtered.items.map((item) => item.workId)].sort(),
      [works[0].workId, works[1].workId, works[2].workId].sort(),
      'only the active listing works of this project',
    );
    const archived = await fetch(`${api.url}/api/works/query?state=ARCHIVED`)
      .then((res) => res.json()) as QueryWorkApi;
    assert.deepEqual(archived.items.map((item) => item.workId), [works[3].workId]);

    // Title search is substring-scoped (titles only) and escapes SQL LIKE metacharacters:
    // the literal % in one title matches exactly that work, not everything.
    const byText = await fetch(`${api.url}/api/works/query?q=${encodeURIComponent('终点指标')}`)
      .then((res) => res.json()) as QueryWorkApi;
    assert.deepEqual(byText.items.map((item) => item.workId), [works[1].workId]);
    const byPercent = await fetch(`${api.url}/api/works/query?q=${encodeURIComponent('%')}`)
      .then((res) => res.json()) as QueryWorkApi;
    assert.deepEqual(byPercent.items.map((item) => item.title), [escTitle], 'a bare % must not widen the pattern');

    // A tampered cursor is rejected, not silently treated as a first page.
    const bad = await fetch(`${api.url}/api/works/query?cursor=not-a-cursor`);
    assert.equal(bad.status, 400);
    const body = await bad.json() as { ok?: boolean; code?: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'WORK_PAGE_INVALID');
    assert.ok(runs.length >= 1);
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/runs/query filters by work, app and goal text, and pages by cursor (E4-3)', async () => {
  const { root, service, runs } = await setup();
  let api: RunningWorkbenchApi | undefined;
  try {
    api = await startWorkbenchServer({ service, authenticate: () => operator });

    const byGoal = await fetch(`${api.url}/api/runs/query?q=${encodeURIComponent('终点指标')}`)
      .then((res) => res.json()) as QueryRunApi;
    assert.deepEqual(byGoal.items.map((item) => item.runId), [runs[1].runId], 'goal text finds exactly the matching run');

    const byApp = await fetch(`${api.url}/api/runs/query?appId=listing&limit=1`)
      .then((res) => res.json()) as QueryRunApi;
    assert.equal(byApp.items.length, 1);
    assert.equal(byApp.nextCursor === null, false, 'two listing runs exist, so the first page of one must carry a cursor');
    const next = await fetch(`${api.url}/api/runs/query?appId=listing&limit=1&cursor=${encodeURIComponent(byApp.nextCursor!)}`)
      .then((res) => res.json()) as QueryRunApi;
    assert.equal(next.nextCursor, null, 'the second page ends the keyset walk');
    const both = [byApp.items[0].runId, next.items[0].runId].sort();
    assert.deepEqual(both, [runs[0].runId, runs[1].runId].sort());

    const byWork = await fetch(`${api.url}/api/runs/query?workId=${runs[0].workId ?? 'x'}`)
      .then((res) => res.json()) as QueryRunApi;
    assert.ok(byWork.items.every((item) => item.workId === (runs[0].workId ?? 'x')));

    const bad = await fetch(`${api.url}/api/runs/query?cursor=zzz`);
    assert.equal(bad.status, 400);
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/search returns authorized hits across four catalogues and rejects empty q (E4-6)', async () => {
  const { root, service, project, works, runs, escTitle } = await setup();
  let api: RunningWorkbenchApi | undefined;
  try {
    api = await startWorkbenchServer({ service, authenticate: () => operator });

    const byProjectName = await fetch(`${api.url}/api/search?q=${encodeURIComponent('肾病')}`)
      .then((res) => res.json()) as SearchApi;
    const kinds = byProjectName.items.map((item) => item.kind).sort();
    assert.ok(kinds.includes('project'), 'the project name is searchable');
    assert.ok(kinds.includes('app') === false, 'no app is labelled with this text');
    const projectHit = byProjectName.items.find((item) => item.kind === 'project')!;
    assert.equal(projectHit.id, project.projectId);

    const byTitle = await fetch(`${api.url}/api/search?q=${encodeURIComponent('100%')}`)
      .then((res) => res.json()) as SearchApi;
    const workHits = byTitle.items.filter((item) => item.kind === 'work');
    assert.deepEqual(workHits.map((hit) => hit.id), [works.find((work) => work.title === escTitle)!.workId]);
    assert.equal(workHits[0]?.workId, workHits[0]?.id, 'work hits carry workId for navigation');

    const byGoal = await fetch(`${api.url}/api/search?q=${encodeURIComponent('基线Listing')}`)
      .then((res) => res.json()) as SearchApi;
    const runHit = byGoal.items.find((item) => item.kind === 'run');
    assert.ok(runHit, 'a goal-text hit surfaces the run');
    assert.equal(runHit?.runId, runs[0].runId);
    assert.equal(runHit?.workId, works[0].workId, 'run hits carry workId+runId for navigation');

    const appHit = await fetch(`${api.url}/api/search?q=${encodeURIComponent('Listing')}`)
      .then((res) => res.json()) as SearchApi;
    assert.ok(appHit.items.some((item) => item.kind === 'app'), 'the registered app is searchable by label');

    const empty = await fetch(`${api.url}/api/search?q=`);
    assert.equal(empty.status, 400);
    const long = await fetch(`${api.url}/api/search?q=${encodeURIComponent('字'.repeat(201))}`);
    assert.equal(long.status, 400);
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
