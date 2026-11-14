/** Enterprise correlation for native composer submissions (T05).
 *
 *  The enterprise side records one Submission per client-minted native `rpcId`. That identity and
 *  the employee identity live in the browser, so this observer runs in the Client half: it retains
 *  the Work's bound native Session through the public `ctx.sessions` service, reads the public
 *  durable event window, and reconciles every `user/message` carrying an `rpcId`.
 *
 *  It is deliberately not a DOM listener and not a second chat protocol: nothing is intercepted,
 *  blocked or replayed. A message the Host did not durably record is reported as an error, and an
 *  intent the Host left UNKNOWN is surfaced as UNKNOWN rather than being automatically re-sent.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** This plugin's own retention of a Work's bound native Session (observer + embedded view). */
    platformWorkbench: unknown
  }
}

import type { SubmissionItem } from '../api.js'
import { nativeUserSubmission, type NativeUserSubmission } from '../forms.js'

export interface SubmissionIo {
  /** Existing submissions of this Work, used to resume idempotently after a reload or crash. */
  list(): Promise<SubmissionItem[]>
  record(input: { requestId: string; text: string }): Promise<SubmissionItem>
  acknowledge(submissionId: string, admission: string): Promise<SubmissionItem>
  consume(submissionId: string): Promise<SubmissionItem>
}

export type CorrelationOutcome =
  | { kind: 'consumed'; submissionId: string }
  | { kind: 'recorded'; submissionId: string }
  | { kind: 'already-consumed'; submissionId: string }
  | { kind: 'unknown'; submissionId: string }
  | { kind: 'skipped'; reason: string }

/**
 * Reconcile one durable native message into the enterprise record. Idempotent on `requestId`:
 * a reload, a repeated live event and a resumed window all converge on the same submission.
 */
export class SubmissionCorrelator {
  private readonly known = new Map<string, SubmissionItem>()
  private loaded = false

  constructor(private readonly io: SubmissionIo) {}

  /** Load the Work's existing submissions once; an unreadable list is an error, not "none". */
  async load(): Promise<void> {
    const items = await this.io.list()
    this.known.clear()
    for (const item of items) this.known.set(item.requestId, item)
    this.loaded = true
  }

  /** @returns what this observation proved; throws when the control plane refused the write. */
  async observe(submission: NativeUserSubmission): Promise<CorrelationOutcome> {
    if (!this.loaded) await this.load()
    const existing = this.known.get(submission.requestId)
    if (existing?.state === 'CONSUMED') return { kind: 'already-consumed', submissionId: existing.submissionId }
    if (existing?.state === 'UNKNOWN' || existing?.state === 'REJECTED') {
      // The contract forbids automatic replay of an unknown receipt; a person must reconcile it.
      return { kind: 'unknown', submissionId: existing.submissionId }
    }
    let record = existing
    if (!record) {
      record = await this.io.record({ requestId: submission.requestId, text: submission.text })
      this.known.set(record.requestId, record)
    }
    const admission = `session-event:${submission.seq}:user/message`
    if (record.state === 'RECORDED') {
      record = await this.io.acknowledge(record.submissionId, admission)
      this.known.set(record.requestId, record)
    }
    if (record.state === 'ACCEPTED') {
      record = await this.io.consume(record.submissionId)
      this.known.set(record.requestId, record)
      return { kind: 'consumed', submissionId: record.submissionId }
    }
    if (record.state === 'CONSUMED') return { kind: 'consumed', submissionId: record.submissionId }
    if (record.state === 'UNKNOWN' || record.state === 'REJECTED') {
      return { kind: 'unknown', submissionId: record.submissionId }
    }
    return { kind: 'recorded', submissionId: record.submissionId }
  }
}

export interface SubmissionWatch {
  stop(): void
  /** Resolves once the initial window has been reconciled (or the session could not be opened). */
  ready: Promise<{ observing: boolean; reason?: string }>
}

interface WatchOptions {
  workId: string
  domainId: string
  sessionId: string
  /** Binding creation time: messages older than the enterprise binding are not backfilled. */
  since?: string
  io: SubmissionIo
  onError?(message: string): void
}

/** Retain the bound Session and reconcile new durable user messages as they are published. */
export function watchSessionSubmissions(ctx: ClientContext, options: WatchOptions): SubmissionWatch {
  const correlator = new SubmissionCorrelator(options.io)
  const sinceMs = options.since ? Date.parse(options.since) : Number.NaN
  const seen = new Set<number>()
  let released: (() => void) | undefined
  let stopped = false
  let queue: Promise<void> = Promise.resolve()
  let report: (message: string) => void = options.onError ?? (() => {})

  const reconcile = (entries: readonly unknown[]): void => {
    for (const entry of entries) {
      const event = (entry as { type?: unknown; event?: unknown } | null)
      if (!event || event.type !== 'event') continue
      const submission = nativeUserSubmission(event.event)
      if (!submission || seen.has(submission.seq)) continue
      // Never retroactively claim a prompt that predates this Work's binding as its submission.
      if (Number.isFinite(sinceMs) && (submission.time ?? 0) < sinceMs) continue
      seen.add(submission.seq)
      queue = queue.then(async () => {
        try {
          const outcome = await correlator.observe(submission)
          console.info(`[platform-workbench] submission ${submission.requestId}: ${outcome.kind}`)
        } catch (reason) {
          // Never pretend the intent was recorded: surface the control plane's own failure.
          report(reason instanceof Error ? reason.message : 'SUBMISSION_CORRELATION_FAILED')
        }
      })
    }
  }

  const ready = (async () => {
    try {
      // The native navigation and the Client catalog settle asynchronously; a freshly created
      // Session can be open in the view before this plugin's list snapshot knows it. Refresh and
      // retry for a short bounded window instead of silently giving up on the first miss.
      let reference: ReturnType<ClientContext['sessions']['retain']> | undefined
      let lastError: unknown
      for (let attempt = 0; attempt < 20 && !stopped; attempt += 1) {
        try {
          reference = ctx.sessions.retain(options.sessionId as never, { source: 'platformWorkbench' })
          break
        } catch (reason) {
          lastError = reason
          await ctx.sessions.refresh().catch(() => {})
          await new Promise((resolveWait) => setTimeout(resolveWait, 250))
        }
      }
      if (!reference) throw lastError instanceof Error ? lastError : new Error('SESSION_OBSERVATION_UNAVAILABLE')
      released = () => reference!.release()
      const binding = await reference.ready
      if (stopped) {
        released()
        return { observing: false, reason: 'stopped' }
      }
      const source = binding.eventSource
      reconcile(source.getSnapshot().entries)
      const unsubscribe = source.subscribe(() => {
        if (stopped) return
        const change = source.getSnapshot().change
        if (change.kind === 'append') reconcile(change.entries)
        else if (change.kind === 'replace' || change.kind === 'prepend') reconcile(source.getSnapshot().entries)
      })
      const release = released
      released = () => {
        unsubscribe()
        release?.()
      }
      return { observing: true }
    } catch (reason) {
      report(reason instanceof Error ? reason.message : 'SESSION_OBSERVATION_UNAVAILABLE')
      return { observing: false, reason: 'unavailable' }
    }
  })()

  return {
    ready,
    stop() {
      stopped = true
      released?.()
      released = undefined
    },
  }
}

export interface SubmissionWatchOptions {
  workId: string
  domainId: string
  sessionId: string
  /** Binding creation time; messages older than it are not treated as this Work's submissions. */
  since?: string
}

/** Start or replace the single observer for one bound Session; the newest call owns it. */
export class SubmissionWatcher {
  private readonly active = new Map<string, { workId: string; watch: SubmissionWatch }>()

  constructor(
    private readonly ctx: ClientContext,
    private readonly makeIo: (options: SubmissionWatchOptions) => SubmissionIo,
    private readonly onError?: (message: string) => void,
  ) {}

  watch(options: SubmissionWatchOptions): SubmissionWatch {
    // One live observer per Work: a rebinding replaces the previous Session instead of stacking.
    for (const [sessionId, entry] of [...this.active]) {
      if (entry.workId !== options.workId) continue
      entry.watch.stop()
      this.active.delete(sessionId)
    }
    const watch = watchSessionSubmissions(this.ctx, {
      ...options,
      io: this.makeIo(options),
      ...(this.onError ? { onError: this.onError } : {}),
    })
    this.active.set(options.sessionId, { workId: options.workId, watch })
    void watch.ready.then((result) => {
      if (result.observing) console.info(`[platform-workbench] observing submissions for ${options.sessionId}`)
      else console.warn(`[platform-workbench] submission observation unavailable: ${result.reason ?? 'unknown'}`)
    })
    return watch
  }
  stopAll(): void {
    for (const entry of this.active.values()) entry.watch.stop()
    this.active.clear()
  }

  get size(): number {
    return this.active.size
  }
}
