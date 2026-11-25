/** WP3 navigation-intent gating for the workbench page's async navigations.
 *
 *  Every navigation (open work, history session, pending entry, restore, browser back/forward)
 *  begins a new intent; ONLY the newest intent may commit page state — the session reference,
 *  submission subscriptions and focus. The locked host's `ctx.layout.beginNavigation()` signal
 *  is composed with a local epoch counter, so both page-internal navigations and host-level
 *  panel switches invalidate stale async work (upstream contract: a later call, a panel
 *  selection, or layout disposal aborts the earlier signal).
 *
 *  An expired intent only drops its commits and releases the references it retained — it never
 *  touches resources owned by the intent that superseded it.
 *  [上游布局合同](../../../upstream/deepseek-harness-git/packages/client/ui-layout/README.md)
 */

export interface NavigationIntent {
  /** Monotonic epoch of this intent (diagnostics/tests; a larger epoch always wins). */
  readonly epoch: number
  /** True while this intent is still the newest navigation and the host has not aborted it. */
  current(): boolean
}

/** Optional host face: the page receives it as an injected prop from ctx.layout. */
export interface NavigationHost {
  beginNavigation(): AbortSignal
}

const expiredIntent = (epoch: number): NavigationIntent => ({ epoch, current: () => false })

export class NavigationGate {
  private epoch = 0
  private disposed = false
  constructor(private readonly host?: NavigationHost) {}

  /** Start a new intent, superseding any earlier one — page-internal or host-initiated. */
  begin(): NavigationIntent {
    if (this.disposed) return expiredIntent(this.epoch)
    this.epoch += 1
    const epoch = this.epoch
    let hostSignal: AbortSignal | undefined
    try {
      hostSignal = this.host?.beginNavigation()
    } catch {
      // A host without a published layout still gets epoch gating.
    }
    return {
      epoch,
      current: () => !this.disposed && this.epoch === epoch && hostSignal?.aborted !== true,
    }
  }

  /** After the page unmounts, no intent may commit anything. */
  dispose(): void {
    this.disposed = true
  }
}
