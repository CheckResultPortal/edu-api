import { EventEmitter } from 'node:events';
import { DatabaseWorkSignals } from './database-work-signals';

describe('database work signals', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  function setup() {
    const clients: Array<
      EventEmitter & { connect: jest.Mock; query: jest.Mock; end: jest.Mock }
    > = [];
    const factory = jest.fn(() => {
      const client = Object.assign(new EventEmitter(), {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({}),
        end: jest.fn().mockResolvedValue(undefined),
      });
      clients.push(client);
      return client as never;
    });
    const failed = jest.fn();
    return {
      clients,
      failed,
      factory,
      signals: new DatabaseWorkSignals(factory, 5000, failed),
    };
  }
  it('uses one lazy connection and routes only subscribed non-secret topics', async () => {
    const { signals, clients, factory } = setup();
    expect(factory).not.toHaveBeenCalled();
    const batch = jest.fn().mockResolvedValue(false);
    const stop = signals.watch(['PaymentSucceeded'], batch);
    signals.watch(['VoucherAllocated'], jest.fn().mockResolvedValue(false));
    await jest.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(clients[0].query).toHaveBeenCalledWith('LISTEN edu_worker_work');
    batch.mockClear();
    clients[0].emit('notification', {
      channel: 'wrong',
      payload: 'PaymentSucceeded',
    });
    clients[0].emit('notification', {
      channel: 'edu_worker_work',
      payload: 'unknown',
    });
    await jest.advanceTimersByTimeAsync(1);
    expect(batch).not.toHaveBeenCalled();
    clients[0].emit('notification', {
      channel: 'edu_worker_work',
      payload: 'PaymentSucceeded',
    });
    await jest.advanceTimersByTimeAsync(1);
    expect(batch).toHaveBeenCalledTimes(1);
    stop();
    await signals.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(10000);
    expect(batch).toHaveBeenCalledTimes(1);
  });
  it('recovers missed notifications, reconnects and drains after LISTEN', async () => {
    const { signals, clients, failed } = setup();
    const batch = jest.fn().mockResolvedValue(false);
    signals.watch(['PaymentSucceeded'], batch);
    await jest.advanceTimersByTimeAsync(1);
    batch.mockClear();
    clients[0].emit('error', new Error('secret connection string'));
    expect(failed).toHaveBeenCalledWith();
    await jest.advanceTimersByTimeAsync(5001);
    expect(clients).toHaveLength(2);
    expect(clients[1].query).toHaveBeenCalledWith('LISTEN edu_worker_work');
    expect(batch).toHaveBeenCalled();
    batch.mockClear();
    await jest.advanceTimersByTimeAsync(5000);
    expect(batch).toHaveBeenCalled();
    await signals.onApplicationShutdown();
  });
});
