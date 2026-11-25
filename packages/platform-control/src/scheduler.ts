/** Platform-side scheduler: durable outbox dispatch plus launch-lease supervision.
 *
 *  It is not Harness's native schedule plugin; it only services platform-owned work:
 *  1. renew launch leases for in-process workers (an expired lease triggers reconciliation);
 *  2. reconcile launches whose lease already expired (UNKNOWN, never a silent retry);
 *  3. claim due outbox messages and dispatch their runs, with backoff and dead-lettering.
 *
 *  Overlapping ticks are skipped rather than queued, so a slow dispatch never doubles a run.
 */
import type { Principal } from './policy.js';
import type { PlatformControlService } from './service.js';
import { logger, metrics } from './observability.js';

export interface SchedulerOptions {
  /** Lease time granted on each renewal; must exceed the tick interval. */
  leaseTtlMs?: number;
  /** Runs dispatched per tick. */
  batchSize?: number;
}

export class RunScheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  constructor(
    private readonly service: PlatformControlService,
    private readonly intervalMs: number,
    private readonly principal: Principal,
    private readonly options: SchedulerOptions = {},
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000) {
      throw new Error('SCHEDULER_INTERVAL_INVALID');
    }
    if (options.leaseTtlMs !== undefined && (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs < intervalMs)) {
      throw new Error('SCHEDULER_LEASE_INVALID');
    }
    if (options.batchSize !== undefined && (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100)) {
      throw new Error('SCHEDULER_BATCH_INVALID');
    }
  }
  start(): () => void {
    if (this.timer) return () => this.stop();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  /** One bounded turn; overlapping ticks are skipped, never queued. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const leaseTtlMs = this.options.leaseTtlMs ?? Math.max(this.intervalMs * 12, 60_000);
      this.service.renewOpenLaunchLeases(leaseTtlMs);
      const reconciled = this.service.reconcileExpiredLaunches(this.principal);
      if (reconciled.reconciled > 0) {
        logger.warn('scheduler.reconciled_expired_launches', { count: reconciled.reconciled });
      }
      const result = await this.service.dispatchOutbox(this.principal, {
        limit: this.options.batchSize ?? 1,
      });
      if (result.claimed > 0) {
        metrics.counter('platform_scheduler_tick_claimed', undefined, result.claimed);
        logger.debug('scheduler.dispatch', result);
      }
      // L3/T04：知识捕获 outbox 泵与派发同拍；未配置 sink 时泵如实返回零投递，不丢弃事件。
      const drained = await this.service.drainKnowledgeCaptureOutbox({ limit: 10 });
      if (drained.claimed > 0) {
        logger.debug('scheduler.knowledge_drain', drained);
      }
    } catch (error) {
      metrics.counter('platform_scheduler_tick_failed');
      logger.error('scheduler.tick_failed', {
        error: error instanceof Error ? error.message.slice(0, 2000) : 'UNKNOWN',
      });
    } finally {
      this.ticking = false;
    }
  }
}