import {
  DefaultUssdFlowService,
  type UssdCategoryListItem,
  type UssdVoucherRetrieval,
  type UssdOrderCreator,
  type UssdPaymentInitializer,
  type UssdProductListItem,
  type UssdProductQuery,
} from './ussd-flow-service';
import type { CanonicalUssdRequest } from './ussd-provider';
import type { UssdSessionData, UssdSessionStore } from './ussd-session-store';

describe('DefaultUssdFlowService', () => {
  const configuration = {
    maximumProducts: 4,
    paymentPendingTtlMilliseconds: 900_000,
    quantityMaximum: 20,
    sessionTtlMilliseconds: 300_000,
    supportPhone: '+233240000000',
  };
  const categories: readonly UssdCategoryListItem[] = [
    {
      name: 'WAEC Result Checkers',
      publicId: '1b3e39a9-06db-41a9-a856-5f985846951a',
    },
    {
      name: 'BECE Result Checkers',
      publicId: '3c3e39a9-06db-41a9-a856-5f985846951a',
    },
  ];
  const products: readonly (UssdProductListItem & {
    readonly catalogGroupPublicId: string;
  })[] = [
    {
      catalogGroupPublicId: categories[0].publicId,
      name: 'WAEC Result Checker',
      publicId: '2b3e39a9-06db-41a9-a856-5f985846951a',
      sellingPriceMinor: '1500',
    },
    {
      catalogGroupPublicId: categories[1].publicId,
      name: 'BECE Result Checker',
      publicId: '4d3e39a9-06db-41a9-a856-5f985846951a',
      sellingPriceMinor: '1200',
    },
  ];

  function flow(overrides?: {
    categories?: readonly UssdCategoryListItem[];
    products?: readonly (UssdProductListItem & {
      readonly catalogGroupPublicId: string;
    })[];
    orderCreator?: UssdOrderCreator;
    paymentInitializer?: UssdPaymentInitializer;
    retrieval?: UssdVoucherRetrieval;
    supportPhone?: string;
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
      listActiveCategories: async () => overrides?.categories ?? categories,
      listActiveProducts: async (catalogGroupPublicId) =>
        (overrides?.products ?? products).filter(
          (product) => product.catalogGroupPublicId === catalogGroupPublicId,
        ),
    };
    const orderCreator = overrides?.orderCreator ?? makeOrderCreator();
    const paymentInitializer =
      overrides?.paymentInitializer ?? makePaymentInitializer();

    const service = new DefaultUssdFlowService(
      store,
      productQuery,
      orderCreator,
      paymentInitializer,
      {
        ...configuration,
        ...(overrides?.supportPhone === undefined
          ? {}
          : { supportPhone: overrides.supportPhone }),
      },
      overrides?.retrieval ?? {
        lookup: jest.fn().mockResolvedValue(null),
        request: jest.fn(),
      },
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

  it('renders the welcome message, category menu, and support option on a fresh dial', async () => {
    const { service } = flow();
    const result = await service.handle(initialDial, context);
    expect(result).toEqual({
      continueSession: true,
      message: expect.stringContaining('Welcome to EduVoucherStore'),
    });
    expect(result.message).toContain('1. Buy voucher');
    expect(result.message).toContain('2. Retrieve voucher');
    expect(result.message).toContain('0. Support');
  });

  it('provides customer support information and ends session when option 0 is selected', async () => {
    const { service, sessions } = flow();
    await service.handle(initialDial, context);

    const result = await service.handle(
      continuation('233244123456', '0'),
      context,
    );

    expect(result.continueSession).toBe(false);
    expect(result.message).toContain('EduVoucher Support:');
    expect(result.message).toContain('+233240000000');
    expect(result.message).not.toContain('WhatsApp');
    expect(sessions.has('233244123456')).toBe(false);
  });

  it('provides customer support information and ends session when SUPPORT text is entered', async () => {
    const { service, sessions } = flow();
    await service.handle(initialDial, context);

    const result = await service.handle(
      continuation('233244123456', 'support'),
      context,
    );

    expect(result.continueSession).toBe(false);
    expect(result.message).toContain('EduVoucher Support:');
    expect(result.message).toContain('+233240000000');
    expect(sessions.has('233244123456')).toBe(false);
  });

  it('displays welcome message and support contact when no vouchers are available', async () => {
    const { service } = flow({ categories: [] });
    const result = await service.handle(initialDial, context);

    expect(result.continueSession).toBe(true);
    expect(result.message).toContain('2. Retrieve voucher');
    const empty = await service.handle(
      continuation('233244123456', '1'),
      context,
    );
    expect(empty.message).toContain('No vouchers are available right now');
    expect(empty.message).toContain('2. Retrieve voucher');
  });

  it('shows only the voucher types inside the selected category', async () => {
    const { service } = flow();
    await service.handle(initialDial, context);
    await service.handle(continuation('233244123456', '1'), context);

    await expect(
      service.handle(continuation('233244123456', '2'), context),
    ).resolves.toEqual({
      continueSession: true,
      message: expect.stringContaining('BECE Result Checker GHS 12.00'),
    });
  });

  it('goes straight to confirmation after an SMS-only choice', async () => {
    const { service, sessions } = flow();
    await service.handle(initialDial, context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '3'), context);
    const outcome = await service.handle(
      continuation('233244123456', '1'),
      context,
    );
    expect(outcome.message).toContain('Confirm order:');
    expect(sessions.get('233244123456')).toMatchObject({
      deliveryPreference: 'SMS_ONLY',
      state: 'CONFIRM',
    });
  });

  it('collects an email when the preference includes one', async () => {
    const { service, sessions } = flow();
    await service.handle(initialDial, context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '3'), context);
    await service.handle(continuation('233244123456', '2'), context);
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

  it('keeps a Nalo session through the delivery preference step', async () => {
    const { service, sessions } = flow();
    const sessionId = 'nalo-session-123';
    const sessionDial = { ...initialDial, sessionId };

    await service.handle(sessionDial, context);
    await service.handle(continuation('233244123456', '1', sessionId), context);
    await service.handle(continuation('233244123456', '1', sessionId), context);
    await service.handle(continuation('233244123456', '1', sessionId), context);
    const deliveryMenu = await service.handle(
      continuation('233244123456', '3', sessionId),
      context,
    );
    expect(deliveryMenu.message).toContain('Choose delivery method:');

    const outcome = await service.handle(
      continuation('233244123456', '1', sessionId),
      context,
    );
    expect(outcome.message).toContain('Confirm order:');
    expect(sessions.get(sessionId)).toMatchObject({
      deliveryPreference: 'SMS_ONLY',
      quantity: 3,
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
    const orderCommand = (orderCreator.create as jest.Mock).mock.calls[0]?.[0];
    expect(orderCommand).not.toHaveProperty('firstName');
    expect(paymentInitializer.initialize).toHaveBeenCalledTimes(1);
    expect(paymentInitializer.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'USSD',
        orderPublicReference: '6b0f6e55-0f5e-4c3a-9d3e-2a7c1a111111',
        payerPhoneNumber: '+233244123456',
      }),
    );
  });

  it('never creates a second order when a pending payment session is retried', async () => {
    const orderCreator = makeOrderCreator();
    const { service } = flow({ orderCreator });

    await walkToSummary(service);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(
      { ...initialDial, input: '714*5#', isNewSession: true },
      context,
    );

    expect(orderCreator.create).toHaveBeenCalledTimes(1);
  });

  it('retains only payment-safe state after an uncertain provider outcome', async () => {
    const paymentInitializer = makePaymentInitializer();
    (paymentInitializer.initialize as jest.Mock).mockResolvedValue({
      status: 'UNKNOWN',
    });
    const { service, sessions } = flow({ paymentInitializer });

    await walkToSummary(service);
    const outcome = await service.handle(
      continuation('233244123456', '1'),
      context,
    );

    expect(outcome.message).toContain('Do not start another payment');
    expect(sessions.get('233244123456')).toEqual({
      confirmId: expect.any(String),
      paymentOrderPublicReference: '6b0f6e55-0f5e-4c3a-9d3e-2a7c1a111111',
      state: 'PAYMENT_PENDING',
    });
  });

  it('ends safely without internal detail when services fail', async () => {
    const failing = makeOrderCreator();
    (failing.create as jest.Mock).mockRejectedValue(new Error('database down'));
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

  it('does not publish placeholder support numbers', async () => {
    const { service } = flow({ supportPhone: '+233000000000' });
    const home = await service.handle(initialDial, context);
    expect(home.message).not.toContain('0. Support');
    const support = await service.handle(
      continuation(initialDial.msisdn, '0'),
      context,
    );
    expect(support.message).not.toContain('+233000000000');
  });

  it('paginates long category names without hiding navigation', async () => {
    const { service } = flow({
      categories: Array.from({ length: 8 }, (_, i) => ({
        name: String(i).repeat(40),
        publicId: String(i),
      })),
    });
    await service.handle(initialDial, context);
    const menu = await service.handle(
      continuation(initialDial.msisdn, '1'),
      context,
    );
    expect(menu.message.length).toBeLessThanOrEqual(182);
    expect(menu.message).toContain('9. More');
    expect(menu.message).toContain('0. Home');
    const next = await service.handle(
      continuation(initialDial.msisdn, '9'),
      context,
    );
    expect(next.message).toContain('2'.repeat(40));
    const invalid = await service.handle(
      continuation(initialDial.msisdn, '8'),
      context,
    );
    expect(invalid.message.length).toBeLessThanOrEqual(182);
    expect(invalid.message).toContain('0. Home');
  });

  it('authorizes retrieval with the session phone and reuses one key after an uncertain request', async () => {
    const retrieval = {
      lookup: jest.fn().mockResolvedValue({
        status: 'DELIVERED',
        canRequestVoucherEmail: true,
      }),
      request: jest
        .fn()
        .mockRejectedValueOnce(new Error('database'))
        .mockResolvedValue({}),
    };
    const { service, sessions } = flow({ categories: [], retrieval });
    await service.handle({ ...initialDial, sessionId: 'session-1' }, context);
    await service.handle(
      continuation(initialDial.msisdn, '2', 'session-1'),
      context,
    );
    await service.handle(
      continuation(initialDial.msisdn, reference, 'session-1'),
      context,
    );
    expect(retrieval.lookup).toHaveBeenCalledWith({
      phoneNumber: '+233244123456',
      orderReference: reference,
    });
    expect(retrieval.request).not.toHaveBeenCalled();
    const failed = await service.handle(
      continuation(initialDial.msisdn, '1', 'session-1'),
      context,
    );
    expect(failed.message).toContain('Retry same request');
    const queued = await service.handle(
      continuation(initialDial.msisdn, '1', 'session-1'),
      context,
    );
    expect(queued.message).toContain('queued');
    expect(retrieval.request.mock.calls[0]).toEqual(
      retrieval.request.mock.calls[1],
    );
    expect(retrieval.request.mock.calls[0][0]).toEqual({
      contact: { phoneNumber: '+233244123456' },
      orderReference: reference,
      idempotencyKey: expect.stringMatching(/^ussd-retrieval-/),
    });
    await service.handle(
      continuation(initialDial.msisdn, '1', 'session-1'),
      context,
    );
    expect(retrieval.request).toHaveBeenCalledTimes(2);
    expect(sessions.get('session-1')).toEqual({ state: 'RETRIEVAL_COMPLETE' });
  });

  it.each([
    'WAITING_FOR_STOCK',
    'PAYMENT_PENDING',
    'PAYMENT_FAILED',
    'DELIVERED',
  ])('does not queue unavailable email copies (%s)', async (status) => {
    const retrieval = {
      lookup: jest
        .fn()
        .mockResolvedValue({ status, canRequestVoucherEmail: false }),
      request: jest.fn(),
    };
    const { service } = flow({ retrieval });
    await service.handle(initialDial, context);
    await service.handle(continuation(initialDial.msisdn, '2'), context);
    const result = await service.handle(
      continuation(initialDial.msisdn, reference),
      context,
    );
    expect(result.continueSession).toBe(false);
    expect(retrieval.request).not.toHaveBeenCalled();
    expect(result.message).not.toContain('queued');
  });

  it('handles invalid/mismatched references, cancellation and expiry without a send', async () => {
    const retrieval = {
      lookup: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({
        status: 'DELIVERED',
        canRequestVoucherEmail: true,
      }),
      request: jest.fn(),
    };
    const { service, sessions } = flow({ retrieval });
    await service.handle(initialDial, context);
    await service.handle(continuation(initialDial.msisdn, '2'), context);
    await service.handle(continuation(initialDial.msisdn, 'bad-ref'), context);
    expect(retrieval.lookup).not.toHaveBeenCalled();
    const missing = await service.handle(
      continuation(initialDial.msisdn, reference),
      context,
    );
    expect(missing.message).toContain('No matching order');
    await service.handle(continuation(initialDial.msisdn, reference), context);
    const cancelled = await service.handle(
      continuation(initialDial.msisdn, '0'),
      context,
    );
    expect(cancelled.message).toContain('cancelled');
    sessions.clear();
    const expired = await service.handle(
      continuation(initialDial.msisdn, '1'),
      context,
    );
    expect(expired.message).toContain('Welcome');
    expect(retrieval.request).not.toHaveBeenCalled();
  });

  const reference = '6b0f6e55-0f5e-4c3a-9d3e-2a7c1a111111';

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
    sessionId?: string,
  ): CanonicalUssdRequest {
    return { input, isNewSession: false, msisdn, sessionId };
  }

  async function walkToSummary(service: DefaultUssdFlowService): Promise<void> {
    await service.handle(initialDial, context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '1'), context);
    await service.handle(continuation('233244123456', '3'), context);
    await service.handle(continuation('233244123456', '1'), context);
  }
});
