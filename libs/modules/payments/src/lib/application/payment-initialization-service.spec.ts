import { PaymentProviderUnknownOutcomeError } from './payment-errors';
import {
  DefaultPaymentInitializationService,
  type PaymentInitializationClaim,
  type PaymentInitializationRepository,
  type PaymentRateLimiter,
} from './payment-initialization-service';
import {
  PaymentProviderRequestError,
  type PaymentProvider,
} from './payment-provider';

describe('DefaultPaymentInitializationService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the provider only after the durable initialization claim', async () => {
    const calls: string[] = [];
    const repository = repositoryMock({
      claim: jest.fn(async () => {
        calls.push('claim');
        return claim({ isNew: true });
      }),
      recordInitialized: jest.fn(async () => {
        calls.push('record');
      }),
    });
    const provider = providerMock({
      initialize: jest.fn(async () => {
        calls.push('provider');
        return {
          accessCode: 'access-value',
          authorizationUrl: 'https://checkout.paystack.com/access-value',
          providerReference: 'EDU-attempt',
        };
      }),
    });

    await expect(
      service(repository, provider).initialize(command()),
    ).resolves.toMatchObject({
      amountMinor: '5000',
      provider: 'PAYSTACK',
      status: 'PENDING',
    });
    expect(calls).toEqual(['claim', 'provider', 'record']);
  });

  it('replays an initialized checkout without another provider call', async () => {
    const repository = repositoryMock({
      claim: jest.fn().mockResolvedValue(
        claim({
          accessCode: 'existing-access',
          authorizationUrl: 'https://checkout.paystack.com/existing-access',
          isNew: false,
          status: 'PENDING',
        }),
      ),
    });
    const provider = providerMock();

    await expect(
      service(repository, provider).initialize(command()),
    ).resolves.toMatchObject({
      accessCode: 'existing-access',
      status: 'PENDING',
    });
    expect(provider.initialize).not.toHaveBeenCalled();
  });

  it('records an uncertain provider timeout as unknown', async () => {
    const repository = repositoryMock({
      claim: jest.fn().mockResolvedValue(claim({ isNew: true })),
    });
    const provider = providerMock({
      initialize: jest
        .fn()
        .mockRejectedValue(new PaymentProviderRequestError('UNKNOWN_OUTCOME')),
    });

    await expect(
      service(repository, provider).initialize(command()),
    ).rejects.toBeInstanceOf(PaymentProviderUnknownOutcomeError);
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        isUnknown: true,
        paymentAttemptId: BigInt(11),
      }),
    );
  });
});

function service(
  repository: PaymentInitializationRepository,
  provider: PaymentProvider,
): DefaultPaymentInitializationService {
  return new DefaultPaymentInitializationService(
    repository,
    provider,
    rateLimiter,
    {
      callbackUrl: 'https://app.example.com/payment/callback',
      idempotencyTtlMs: 86_400_000,
      initialVerificationDelayMs: 120_000,
      privacyHmacKey: Buffer.alloc(32, 7),
    },
  );
}

const rateLimiter: PaymentRateLimiter = { consume: jest.fn() };

function command() {
  return {
    clientIp: '203.0.113.10',
    idempotencyKey: 'payment:0123456789abcdef',
    orderPublicReference: '2b3e39a9-06db-41a9-a856-5f985846951a',
  };
}

function claim(
  overrides: Partial<PaymentInitializationClaim>,
): PaymentInitializationClaim {
  return {
    accessCode: null,
    authorizationUrl: null,
    currency: 'GHS',
    email: 'buyer@example.com',
    expectedAmountMinor: BigInt(5_000),
    isNew: false,
    orderPublicReference: '2b3e39a9-06db-41a9-a856-5f985846951a',
    paymentAttemptId: BigInt(11),
    paymentPublicReference: '5c299e8d-d325-47ea-8268-60877bb7694b',
    providerReference: 'EDU-attempt',
    status: 'INITIALIZING',
    ...overrides,
  };
}

function repositoryMock(
  overrides: Partial<PaymentInitializationRepository> = {},
): PaymentInitializationRepository {
  return {
    claim: jest.fn(),
    recordFailure: jest.fn(),
    recordInitialized: jest.fn(),
    ...overrides,
  };
}

function providerMock(
  overrides: Partial<PaymentProvider> = {},
): PaymentProvider {
  return {
    authenticateWebhook: jest.fn(),
    code: 'PAYSTACK',
    initialize: jest.fn(),
    verify: jest.fn(),
    ...overrides,
  };
}
