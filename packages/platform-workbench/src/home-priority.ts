import type { RunSummary, WorkbenchBootstrap, WorkbenchItem } from './api.js';

type Todo = NonNullable<WorkbenchBootstrap['todos']>[number];

/** Order by recorded creation time, independently of bootstrap list order. */
function newestFirst(a: { createdAt: string }, b: { createdAt: string }): number {
  return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
}

export function latestHomeRuns(runs: readonly RunSummary[]): Map<string, RunSummary> {
  const result = new Map<string, RunSummary>();
  for (const run of [...runs].sort((a, b) => newestFirst(a, b) || a.runId.localeCompare(b.runId))) {
    if (run.workId && !result.has(run.workId)) result.set(run.workId, run);
  }
  return result;
}

export function homePriority(works: readonly WorkbenchItem[], runs: ReadonlyMap<string, RunSummary>, todos: readonly Todo[]) {
  const byWork = new Map(works.filter((work) => work.state === 'ACTIVE').map((work) => [work.workId, work]));
  for (const item of [...todos].sort((a, b) => newestFirst(a, b) || a.id.localeCompare(b.id))) {
    const work = item.workId ? byWork.get(item.workId) : undefined;
    if (work && item.runId) return { kind: 'todo' as const, work, runId: item.runId, item };
  }
  const failed = [...runs.values()].filter((run) => run.snapshot?.state === 'FAILED');
  for (const run of failed.sort((a, b) => newestFirst(a, b) || a.runId.localeCompare(b.runId))) {
    const work = run.workId ? byWork.get(run.workId) : undefined;
    if (work) return { kind: 'failed' as const, work, runId: run.runId };
  }
  return null;
}
