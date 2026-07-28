export type AdaptiveQueueWorkerOptions<Job> = {
  workerName: string;
  workerId: string;
  concurrency: number;
  minimumIdleDelayMs: number;
  maximumIdleDelayMs: number;
  claim: (slotWorkerId: string) => Promise<Job | null>;
  execute: (job: Job, slotWorkerId: string) => Promise<void>;
  beforeClaim?: () => Promise<void>;
  onError: (scope: string, error: unknown) => void;
  isShuttingDown: () => boolean;
  random?: () => number;
};

type WakeWaiter = () => void;

const boundedDelay = (value: number): number => (
  Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1
);

export const calculateAdaptiveIdleDelay = (options: {
  minimumIdleDelayMs: number;
  maximumIdleDelayMs: number;
  consecutiveMisses: number;
  randomValue?: number;
}): number => {
  const minimum = boundedDelay(options.minimumIdleDelayMs);
  const maximum = Math.max(minimum, boundedDelay(options.maximumIdleDelayMs));
  const exponent = Math.max(0, Math.min(20, Math.floor(options.consecutiveMisses) - 1));
  const baseDelay = Math.min(maximum, minimum * (2 ** exponent));
  if (baseDelay >= maximum) return maximum;
  const randomValue = Number.isFinite(options.randomValue)
    ? Math.max(0, Math.min(1, Number(options.randomValue)))
    : 0.5;
  const jitterMultiplier = 0.9 + (randomValue * 0.2);
  return Math.max(minimum, Math.min(maximum, Math.round(baseDelay * jitterMultiplier)));
};

export const estimateMaximumIdleClaimsPerHour = (
  processCount: number,
  maximumIdleDelayMs: number,
): number => (
  Math.ceil(3_600_000 / boundedDelay(maximumIdleDelayMs)) * Math.max(1, Math.floor(processCount))
);

export class AdaptiveQueueWorker<Job> {
  private readonly options: AdaptiveQueueWorkerOptions<Job>;

  private readonly availableSlots: number[];

  private readonly activeExecutions = new Map<number, Promise<void>>();

  private readonly wakeWaiters = new Set<WakeWaiter>();

  private consecutiveMisses = 0;

  private stopping = false;

  constructor(options: AdaptiveQueueWorkerOptions<Job>) {
    this.options = {
      ...options,
      concurrency: Math.max(1, Math.floor(options.concurrency)),
      minimumIdleDelayMs: boundedDelay(options.minimumIdleDelayMs),
      maximumIdleDelayMs: Math.max(
        boundedDelay(options.minimumIdleDelayMs),
        boundedDelay(options.maximumIdleDelayMs),
      ),
    };
    this.availableSlots = Array.from(
      { length: this.options.concurrency },
      (_, index) => index + 1,
    );
  }

  wake = (): void => {
    this.consecutiveMisses = 0;
    const waiters = [...this.wakeWaiters];
    this.wakeWaiters.clear();
    waiters.forEach(resolve => resolve());
  };

  stop = (): void => {
    this.stopping = true;
    this.wake();
  };

  private shouldStop = (): boolean => this.stopping || this.options.isShuttingDown();

  private slotWorkerId = (slot: number): string => `${this.options.workerId}:slot-${slot}`;

  private waitForWake = async (milliseconds: number): Promise<void> => {
    if (this.shouldStop()) return;

    await new Promise<void>(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wakeWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      this.wakeWaiters.add(finish);
    });
  };

  private waitForCapacity = async (): Promise<void> => {
    if (this.availableSlots.length > 0 || this.shouldStop()) return;
    await this.waitForWake(this.options.maximumIdleDelayMs);
  };

  private launch = (slot: number, job: Job): void => {
    const slotWorkerId = this.slotWorkerId(slot);
    const execution = Promise.resolve()
      .then(() => this.options.execute(job, slotWorkerId))
      .catch(error => this.options.onError(`Worker slot ${slot} execution failed`, error))
      .finally(() => {
        this.activeExecutions.delete(slot);
        this.availableSlots.push(slot);
        this.wake();
      });
    this.activeExecutions.set(slot, execution);
  };

  run = async (): Promise<void> => {
    while (!this.shouldStop()) {
      if (this.availableSlots.length === 0) {
        await this.waitForCapacity();
        continue;
      }

      const slot = this.availableSlots.shift();
      if (!slot) continue;
      const slotWorkerId = this.slotWorkerId(slot);

      try {
        await this.options.beforeClaim?.();
        if (this.shouldStop()) {
          this.availableSlots.unshift(slot);
          break;
        }

        const job = await this.options.claim(slotWorkerId);
        if (job) {
          this.consecutiveMisses = 0;
          this.launch(slot, job);
          // Claim again immediately to fill the remaining execution slots.
          continue;
        }

        this.availableSlots.unshift(slot);
        this.consecutiveMisses += 1;
        const delay = calculateAdaptiveIdleDelay({
          minimumIdleDelayMs: this.options.minimumIdleDelayMs,
          maximumIdleDelayMs: this.options.maximumIdleDelayMs,
          consecutiveMisses: this.consecutiveMisses,
          randomValue: (this.options.random || Math.random)(),
        });
        await this.waitForWake(delay);
      } catch (error) {
        this.availableSlots.unshift(slot);
        this.consecutiveMisses += 1;
        this.options.onError('Queue claim failed', error);
        const delay = calculateAdaptiveIdleDelay({
          minimumIdleDelayMs: this.options.minimumIdleDelayMs,
          maximumIdleDelayMs: this.options.maximumIdleDelayMs,
          consecutiveMisses: this.consecutiveMisses,
          randomValue: (this.options.random || Math.random)(),
        });
        await this.waitForWake(delay);
      }
    }

    await Promise.allSettled(this.activeExecutions.values());
  };
}
