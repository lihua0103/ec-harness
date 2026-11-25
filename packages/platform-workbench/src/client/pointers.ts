/**
 *  The three Work pointers (需求 §10 / SC-03): the baseline being edited, the most recent run,
 *  and the current recognised delivery — shown separately, never collapsed into "最新".
 *  Pure facts only: the caller formats times and renders. The delivery pointer is deliberately
 *  conservative — a review approval is a recognition fact, not a formal delivery (the delivery
 *  package mechanism does not exist yet), and missing or unreadable review state is never shown
 *  as approved.
 */
import type { RunSummary, ReviewItem } from '../api.js'

export interface PointerBaseline {
  revision: number;
  sourceRef: string;
  /** null until a second batch exists; otherwise whether the newest digest differs from the previous one. */
  digestChanged: boolean | null;
  createdAt: string;
}

export interface PointerRun {
  runId: string;
  state?: string;
  createdAt: string;
}

export interface DeliveryPointer {
  /** The run the pointer talks about, when one exists; null means "nothing to point at". */
  runId: string | null;
  /** The APPROVED decision when the newest succeeded run was recognised; null otherwise. */
  approved: ReviewItem | null;
  label: string;
  detail: string;
}

export interface PointerFacts {
  baseline: PointerBaseline | null;
  run: PointerRun | null;
  delivery: DeliveryPointer;
}

/** Both list parameters are newest-first, matching the control plane's page order.
 *  `reviews` is the newest succeeded run's review list, or null while it has not been read. */
export function workPointers(
  baselines: ReadonlyArray<{ revision: number; sourceRef: string; digest: string; createdAt: string }>,
  runs: ReadonlyArray<RunSummary>,
  reviews: ReadonlyArray<ReviewItem> | null,
): PointerFacts {
  const latestBaseline = baselines[0] ?? null
  const previousBaseline = baselines[1] ?? null
  const latestRun = runs[0] ?? null
  return {
    baseline: latestBaseline
      ? {
          revision: latestBaseline.revision,
          sourceRef: latestBaseline.sourceRef,
          digestChanged: previousBaseline ? latestBaseline.digest !== previousBaseline.digest : null,
          createdAt: latestBaseline.createdAt,
        }
      : null,
    run: latestRun
      ? { runId: latestRun.runId, state: latestRun.snapshot?.state, createdAt: latestRun.createdAt }
      : null,
    delivery: deliveryPointer(runs, reviews),
  }
}

export function deliveryPointer(
  runs: ReadonlyArray<RunSummary>,
  reviews: ReadonlyArray<ReviewItem> | null,
): DeliveryPointer {
  const candidate = runs.find((run) => run.snapshot?.state === 'SUCCEEDED') ?? null
  if (!candidate) {
    return {
      runId: null,
      approved: null,
      label: '无认可交付',
      detail: '还没有成功完成的运行；复核认可需要先有可复核的成果。',
    }
  }
  if (reviews === null) {
    return {
      runId: candidate.runId,
      approved: null,
      label: '认可待查',
      detail: '正在读取该运行的复核结论；在读取到结论之前不显示认可。',
    }
  }
  const decisions = reviews.filter((item) => item.runId === candidate.runId)
  const open = decisions.find((item) => item.state === 'REQUESTED')
  if (open) {
    return {
      runId: candidate.runId,
      approved: null,
      label: '复核进行中',
      detail: '已发起复核，等待复核结论；结论给出前不显示认可。',
    }
  }
  const decision = decisions.find((item) => item.state === 'APPROVED' || item.state === 'REJECTED')
  if (decision?.state === 'APPROVED') {
    return {
      runId: candidate.runId,
      approved: decision,
      label: '已复核认可',
      detail: '最新成功运行的复核已通过；复核认可 ≠ 正式交付，正式交付包机制尚未建成（E1-3）。',
    }
  }
  if (decision?.state === 'REJECTED') {
    return {
      runId: candidate.runId,
      approved: null,
      label: '复核未通过',
      detail: '最新成功运行的复核被驳回；不将其作为认可交付。',
    }
  }
  return {
    runId: candidate.runId,
    approved: null,
    label: '尚未复核',
    detail: '最新成功运行未发起复核；复核认可 ≠ 正式交付，正式交付包机制尚未建成（E1-3）。',
  }
}
