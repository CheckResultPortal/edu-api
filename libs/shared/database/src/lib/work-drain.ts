/** Coalesce wakeups without losing work arriving during an in-flight batch. */
export class WorkDrain {
  private pending = false;
  private running = false;
  private stopped = false;
  private scheduled?: NodeJS.Immediate;

  constructor(
    private readonly batch: () => Promise<boolean>,
    private readonly onFailure: () => void,
  ) {}

  wake = (): void => {
    if (this.stopped) return;
    this.pending = true;
    if (!this.running && !this.scheduled) {
      this.scheduled = setImmediate(() => {
        this.scheduled = undefined;
        void this.run();
      });
    }
  };

  stop(): void {
    this.stopped = true;
    if (this.scheduled) clearImmediate(this.scheduled);
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    this.pending = false;
    this.running = true;
    try {
      if (await this.batch()) this.pending = true;
    } catch {
      // Do not busy-loop on failure: the recovery sweep retries later.
      this.pending = false;
      this.onFailure();
    } finally {
      this.running = false;
      if (this.pending) this.wake();
    }
  }
}
