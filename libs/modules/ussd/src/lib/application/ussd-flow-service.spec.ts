import {
  DefaultUssdFlowService,
  type UssdOrderCreator,
  type UssdPaymentInitializer,
  type UssdProductQuery,
} from './ussd-flow-service';
import type { CanonicalUssdRequest } from './ussd-provider';
import type { UssdSessionData, UssdSessionStore } from './ussd-session-store';

describe('DefaultUssdFlowService', () => {
  const configuration = {
    maximumProducts: 4,
    quantityMaximum: 20,
    sessionTtlMilliseconds: 300_000,
  };

  function flow(overrides?: {
    products?: readonly { name: string; publicId: string; sellingPriceMinor: string }[];
    orderCreator?: UssdOrderCreator;
    paymentInitializer?: UssdPaymentInitializer;
  }) {
    const sessions = new Map<string, UssdSessionData>();
    const store: UssdSessionStore = {
      get: async (msisdn) => sessions.get(msisdn) ?? null,
      set: async (msisdn, data) => {
        sessions.set(msisdn, data);
      },
      delete: async (msisdn) => {
        sessions.delete(msisdn);
      },
    };
    const productQuery: UssdProductQuery = {
      listActiveProducts: async () =>
        overrides?.products ?? [
          {
            name: 'WAEC Result Checker',
            publicId: '2b3e39a9-06db-41a9-a856-5f985846951a',
            sellingPriceMinor: '1500',
          },
        ],
    };
    const orderCreator =
      overrides?.orderCreator ??
      makeOrderCreator();
    const paymentInitializer =
      overrides?.paymentInitializer ?? makePaymentInitializer();

    const service = new DefaultUssdFlowService(
      store,
      productQuery,
      orderCreator,
      paymentInitializer,
      configuration,
    );
    return {
      orderCreator,
      paymentInitializer,
      service,
      sessions,
      store,
    };
  }

  const initialDial: CanonicalUssdRequest = {
    input: '714*5#',
    isNewSession: true,
    msisdn: '233244123456',
  };
  const context = { clientIp: '10.0.0.8' };

  it('renders the product menu on a fresh dial', async () => {
    const { service } = flow();
    await expect(service.handle(initialDial, context)).resolves.toEqual({
      continueSession: true,
      message: expect.stringContaining('WAEC Result Checker GHS 15.00'),
    });
  });

  it('walks product, quantity and SMS-only delivery to a summary', async () => {
    const { service, sessions } = flow();
    await service.handle(initialDial, context);
    await service.handle(
      continuation('233244123456', '1'),
      context,
    );
    await service.handle(
      continuation('233244123456', '3'),
      context,
    );
    await service.handle(
      continuation('233244123456', '1'),
      context,
    );
    const session = sessions.get('233244123456');
    expect(session).toMatchObject({ state: 'CONFIRM' });
  });

  it('collects an email when the preference includes one', async () => {
    const { service, sessions } = flow();
    await service.handle(initialDial, context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '3'), context);
    await service.handle(
      continuation('233244123456', '2'),
      context,
    );
    expect(sessions.get('233244123456')).toMatchObject({ state: 'EMAIL' });

    await service.handle(
      continuation('233244123456', 'buyer@example.com'),
      context,
    );
    expect(sessions.get('233244123456')).toMatchObject({
      email: 'buyer@example.com',
      state: 'CONFIRM',
    });
  });

  it('creates exactly one order plus one Moolre prompt on confirm', async () => {
    const orderCreator = makeOrderCreator();
    const paymentInitializer = makePaymentInitializer();
    const { service } = flow({ orderCreator, paymentInitializer });

    await walkToSummary(service);
    const outcome = await service.handle(
      continuation('233244123456', '1'),
      context,
    );

    expect(outcome.continueSession).toBe(false);
    expect(outcome.message).toContain('Approve the Mobile Money prompt');
    expect(orderCreator.create).toHaveBeenCalledTimes(1);
    expect(orderCreator.create).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryPreference: 'SMS_ONLY',
        phoneNumber: '+233244123456',
        quantity: 3,
      }),
      context,
    );
    expect(paymentInitializer.initialize).toHaveBeenCalledTimes(1);
    expect(paymentInitializer.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'USSD',
        orderPublicReference: '6b0f6e55-0f5e-4c3a-9d3e-2a7c1a111111',
        payerPhoneNumber: '+233244123456',
      }),
    );
  });

  it('never creates a second prompt when confirm repeats', async () => {
    const orderCreator = makeOrderCreator();
    const { service } = flow({ orderCreator });

    await walkToSummary(service);
    await service.handle(continuation('233244123456', '1'), context);
    // Session is deleted after the first attempt; a duplicate screen must
    // not reach the order or payment services again.
    await service.handle(continuation('233244123456', '1'), context);

    expect(orderCreator.create).toHaveBeenCalledTimes(1);
  });

  it('ends safely without internal detail when services fail', async () => {
    const failing = makeOrderCreator();
    (failing.create as jest.Mock).mockRejectedValue(
      new Error('database down'),
    );
    const { service } = flow({ orderCreator: failing });

    await walkToSummary(service);
    const outcome = await service.handle(
      continuation('233244123456', '1'),
      context,
    );

    expect(outcome).toEqual({
      continueSession: false,
      message: expect.not.stringContaining('database'),
    });
  });

  it('cancels cleanly on 0', async () => {
    const { service, sessions } = flow();
    await walkToSummary(service);
    const outcome = await service.handle(
      continuation('233244123456', '0'),
      context,
    );

    expect(outcome.message).toContain('cancelled');
    expect(sessions.has('233244123456')).toBe(false);
  });

  function makeOrderCreator(): UssdOrderCreator {
    return {
      create: jest.fn().mockResolvedValue({
        currency: 'GHS',
        publicReference: '6b0f6e55-0f5e-4c3a-9d3e-2a7c1a111111',
        totalPriceMinor: '4500',
      }),
    };
  }

  function makePaymentInitializer(): UssdPaymentInitializer {
    return {
      initialize: jest.fn().mockResolvedValue({ status: 'PENDING' }),
    };
  }

  function continuation(
    msisdn: string,
    input: string,
  ): CanonicalUssdRequest {
    return { input, isNewSession: false, msisdn };
  }

  async function walkToSummary(
    service: DefaultUssdFlowService,
  ): Promise<void> {
    await service.handle(initialDial, context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '3'), context);
    await service.handle(continuation('233244123456', '1'), context);
  }
});
