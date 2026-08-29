export type LeaseHeartbeatScheduler = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
};

export type LeaseHeartbeatControllerOptions<State> = {
  controller: AbortController;
  leaseDurationMs: number;
  intervalMs: number;
  renewLease: () => Promise<State>;
  resolveAbortReason: (state: State) => unknown | null | undefined;
  resolveExpiredLeaseReason?: (error: unknown) => unknown | null | undefined;
  onRenewalError?: (error: unknown) => void;
  scheduler?: LeaseHeartbeatScheduler;
};

const defaultScheduler: LeaseHeartbeatScheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Owns the common worker-lease heartbeat lifecycle: serialized renewals,
 * cancellation/ownership fencing, lease-expiry fallback, and timer cleanup.
 * Queue-specific services remain responsible for interpreting their RPC state.
 */
export class LeaseHeartbeatController<State> {
  private readonly options: LeaseHeartbeatControllerOptions<State>;

  private readonly scheduler: LeaseHeartbeatScheduler;

  private leaseDeadline = 0;

  private timer: unknown = null;

  private running = false;

  constructor(options: LeaseHeartbeatControllerOptions<State>) {
    this.options = options;
    this.scheduler = options.scheduler || defaultScheduler;
  }

  start(): () => void {
    if (!this.running && !this.options.controller.signal.aborted) {
      this.running = true;
      this.leaseDeadline = this.scheduler.now() + Math.max(1, this.options.leaseDurationMs);
      this.scheduleNext();
    }
    return () => this.stop();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running || this.options.controller.signal.aborted) return;
    this.timer = this.scheduler.schedule(
      () => {
        this.timer = null;
        void this.heartbeat();
      },
      Math.max(1, this.options.intervalMs),
    );
  }

  private async heartbeat(): Promise<void> {
    if (!this.running || this.options.controller.signal.aborted) return;

    try {
      const state = await this.options.renewLease();
      const abortReason = this.options.resolveAbortReason(state);
      if (abortReason !== null && abortReason !== undefined) {
        this.options.controller.abort(abortReason);
        return;
      }
      this.leaseDeadline = this.scheduler.now() + Math.max(1, this.options.leaseDurationMs);
    } catch (error) {
      this.options.onRenewalError?.(error);
      if (this.scheduler.now() >= this.leaseDeadline) {
        const abortReason = this.options.resolveExpiredLeaseReason?.(error);
        if (abortReason !== null && abortReason !== undefined) {
          this.options.controller.abort(abortReason);
          return;
        }
      }
    }

    this.scheduleNext();
  }
}
