import { UssdPaymentPromptPoller } from './ussd-payment-prompt-poller';

describe('independent USSD prompt polling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  function setup(enabled = true, environment = 'production') {
    const processAvailable = jest.fn().mockResolvedValue(0);
    const values: Record<string, unknown> = {
      NODE_ENV: environment,
      USSD_ENABLED: enabled,
      USSD_PAYMENT_PROMPT_BATCH_SIZE: 25,
      USSD_PAYMENT_PROMPT_POLL_INTERVAL_MS: 2000,
    };
    const logger = { log: jest.fn(), error: jest.fn() };
    const poller = new UssdPaymentPromptPoller(
      { processAvailable } as never,
      { getOrThrow: (key: string) => values[key] } as never,
      logger as never,
    );
    return { processAvailable, poller, logger };
  }
  it('starts promptly, retries failure and stops on shutdown', async () => {
    const { processAvailable, poller, logger } = setup();
    processAvailable.mockRejectedValueOnce(new Error('secret provider text'));
    poller.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(2000);
    expect(processAvailable).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'secret provider text',
    );
    poller.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(6000);
    expect(processAvailable).toHaveBeenCalledTimes(2);
  });
  it('never overlaps a slow dispatch cycle', async () => {
    const { processAvailable, poller } = setup();
    let finish!: (value: number) => void;
    processAvailable.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );
    poller.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(6000);
    expect(processAvailable).toHaveBeenCalledTimes(1);
    finish(0);
    await jest.advanceTimersByTimeAsync(2000);
    expect(processAvailable).toHaveBeenCalledTimes(2);
    poller.onApplicationShutdown();
  });
  it.each([
    [false, 'production'],
    [true, 'test'],
  ])(
    'does not run when disabled or testing (%s, %s)',
    async (enabled, environment) => {
      const { processAvailable, poller } = setup(
        enabled as boolean,
        environment as string,
      );
      poller.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(6000);
      expect(processAvailable).not.toHaveBeenCalled();
    },
  );
});
