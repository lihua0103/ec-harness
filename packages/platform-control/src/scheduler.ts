/** Platform-side scheduler: dispatch queued runs through the configured worker executor.
 *  It is not Harness's native schedule plugin; it only services platform-owned QUEUED runs. */
import type { Principal } from './policy.js';
import type { PlatformControlService } from './service.js';

export class RunScheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  constructor(
    private readonly service: PlatformControlService,
    private readonly intervalMs: number,
    private readonly principal: Principal,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000) {
      throw new Error('SCHEDULER_INTERVAL_INVALID');
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
      await this.service.dispatchQueued(1, this.principal);
    } finally {
      this.ticking = false;
    }
  }
}
