import { UssdPaymentPromptPoller } from './ussd-payment-prompt-poller';

describe('event-triggered USSD prompts', () => {
  function setup(enabled = true, environment = 'production') {
    const processAvailable = jest.fn().mockResolvedValue(0);
    const values: Record<string, unknown> = {
      NODE_ENV: environment,
      USSD_ENABLED: enabled,
      USSD_PAYMENT_PROMPT_BATCH_SIZE: 25,
    };
    const logger = { log: jest.fn(), error: jest.fn() };
    const stop = jest.fn();
    const signals = { watch: jest.fn().mockReturnValue(stop) };
    const poller = new UssdPaymentPromptPoller(
      { processAvailable } as never,
      { getOrThrow: (key: string) => values[key] } as never,
      logger as never,
      signals as never,
    );
    poller.onApplicationBootstrap();
    return { processAvailable, signals, poller, stop, logger };
  }
  it('subscribes to committed prompt requests and immediately continues full batches', async () => {
    const { signals, processAvailable, poller, stop } = setup();
    expect(signals.watch.mock.calls[0][0]).toEqual([
      'UssdPaymentPromptRequested',
    ]);
    const run = signals.watch.mock.calls[0][1];
    processAvailable.mockResolvedValueOnce(25);
    expect(await run()).toBe(true);
    expect(await run()).toBe(false);
    poller.onApplicationShutdown();
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('leaves errors to recovery without logging provider secrets', async () => {
    const { signals, processAvailable, logger } = setup();
    processAvailable.mockRejectedValueOnce(new Error('secret provider text'));
    expect(await signals.watch.mock.calls[0][1]()).toBe(false);
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'secret provider text',
    );
  });
  it.each([
    [false, 'production'],
    [true, 'test'],
  ])('does not subscribe when disabled (%s, %s)', (enabled, environment) => {
    expect(
      setup(enabled as boolean, environment as string).signals.watch,
    ).not.toHaveBeenCalled();
  });
});
