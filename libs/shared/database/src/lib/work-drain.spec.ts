import { WorkDrain } from './work-drain';

describe('work drain', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('coalesces bursts and drains full batches without a polling delay', async () => {
    const batch = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const task = new WorkDrain(batch, jest.fn());
    for (let i = 0; i < 100; i++) task.wake();
    await jest.runAllTimersAsync();
    expect(batch).toHaveBeenCalledTimes(2);
    task.stop();
  });

  it('retains a wakeup during an active batch without overlapping', async () => {
    let finish!: (more: boolean) => void;
    const batch = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(false);
    const task = new WorkDrain(batch, jest.fn());
    task.wake();
    await jest.runAllTimersAsync();
    task.wake();
    task.wake();
    expect(batch).toHaveBeenCalledTimes(1);
    finish(false);
    await jest.runAllTimersAsync();
    expect(batch).toHaveBeenCalledTimes(2);
    task.stop();
  });

  it('does not spin on errors and can recover on the next wakeup', async () => {
    const failed = jest.fn();
    const batch = jest
      .fn()
      .mockRejectedValueOnce(new Error('private'))
      .mockResolvedValue(false);
    const task = new WorkDrain(batch, failed);
    task.wake();
    await jest.runAllTimersAsync();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith();
    task.wake();
    await jest.runAllTimersAsync();
    expect(batch).toHaveBeenCalledTimes(2);
    task.stop();
  });

  it('stops queued work and does not continue an active batch after shutdown', async () => {
    let finish!: (more: boolean) => void;
    const batch = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const task = new WorkDrain(batch, jest.fn());
    task.wake();
    await jest.runAllTimersAsync();
    task.stop();
    finish(true);
    task.wake();
    await jest.runAllTimersAsync();
    expect(batch).toHaveBeenCalledTimes(1);
    const queued = new WorkDrain(batch, jest.fn());
    queued.wake();
    queued.stop();
    await jest.runAllTimersAsync();
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
