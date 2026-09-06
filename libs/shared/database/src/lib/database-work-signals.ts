import { Client } from 'pg';
import { WorkDrain } from './work-drain';

/** Notifications are hints; durable records and existing claims decide work. */
export class DatabaseWorkSignals {
  private client?: Client;
  private connecting = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private readonly subscriptions = new Map<WorkDrain, readonly string[]>();

  constructor(
    private readonly createClient: () => Client,
    private readonly recoveryMs: number,
    private readonly onFailure: () => void,
  ) {}

  watch(topics: readonly string[], batch: () => Promise<boolean>): () => void {
    const drain = new WorkDrain(batch, this.onFailure);
    this.subscriptions.set(drain, topics);
    drain.wake();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.connect();
        for (const task of this.subscriptions.keys()) task.wake();
      }, this.recoveryMs);
    }
    void this.connect();
    return () => {
      drain.stop();
      this.subscriptions.delete(drain);
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const task of this.subscriptions.keys()) task.stop();
    this.subscriptions.clear();
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.client || this.connecting) return;
    this.connecting = true;
    const client = this.createClient();
    this.client = client;
    const disconnected = () => {
      if (this.client !== client) return;
      this.client = undefined;
      if (!this.stopped) this.onFailure();
      void client.end().catch(() => undefined);
    };
    client.on('error', disconnected);
    client.on('end', disconnected);
    client.on('notification', (message) => {
      if (this.client !== client || message.channel !== 'edu_worker_work')
        return;
      for (const [task, topics] of this.subscriptions) {
        if (message.payload && topics.includes(message.payload)) task.wake();
      }
    });
    try {
      await client.connect();
      await client.query('LISTEN edu_worker_work');
      // Query after LISTEN to close the startup/reconnect notification race.
      for (const task of this.subscriptions.keys()) task.wake();
    } catch {
      disconnected();
    } finally {
      this.connecting = false;
    }
  }
}
