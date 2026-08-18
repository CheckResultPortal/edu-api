import { createHmac } from 'node:crypto';

import {
  PaymentWebhookAuthenticationError,
  PaymentWebhookPayloadError,
} from '../application/payment-errors';
import { PaystackPaymentProvider } from './paystack-payment-provider';

const secretKey = 'sk_test_012345678901234567890123456789';

describe('PaystackPaymentProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('authenticates the exact raw body and normalizes charge.success', () => {
    const provider = createProvider();
    const rawBody = successfulWebhook();

    expect(provider.authenticateWebhook(rawBody, signature(rawBody))).toEqual({
      eventType: 'charge.success',
      kind: 'PAYMENT_SUCCEEDED',
      payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      success: {
        amountMinor: BigInt(5_000),
        currency: 'GHS',
        paidAt: new Date('2026-08-18T12:00:00.000Z'),
        providerReference: 'EDU-payment-one',
        providerStatus: 'success',
        providerTransactionId: '123456789',
      },
    });
  });

  it('rejects a missing or changed signature before accepting the payload', () => {
    const provider = createProvider();
    const rawBody = successfulWebhook();

    expect(() => provider.authenticateWebhook(rawBody, undefined)).toThrow(
      PaymentWebhookAuthenticationError,
    );
    expect(() =>
      provider.authenticateWebhook(rawBody, '0'.repeat(128)),
    ).toThrow(PaymentWebhookAuthenticationError);
  });

  it('acknowledges authenticated unrelated events without a payment effect', () => {
    const provider = createProvider();
    const rawBody = Buffer.from(JSON.stringify({ event: 'transfer.success' }));

    expect(provider.authenticateWebhook(rawBody, signature(rawBody))).toEqual({
      kind: 'IGNORED',
    });
  });

  it('rejects malformed signed success data', () => {
    const provider = createProvider();
    const rawBody = Buffer.from(
      JSON.stringify({ event: 'charge.success', data: { amount: 5000 } }),
    );

    expect(() =>
      provider.authenticateWebhook(rawBody, signature(rawBody)),
    ).toThrow(PaymentWebhookPayloadError);
  });

  it.each([
    ['missing', undefined],
    ['non-success', 'failed'],
  ])(
    'rejects a signed charge.success event with %s data.status',
    (_, status) => {
      const provider = createProvider();
      const payload = {
        event: 'charge.success',
        data: {
          amount: 5000,
          currency: 'GHS',
          id: 123456789,
          paid_at: '2026-08-18T12:00:00.000Z',
          reference: 'EDU-payment-one',
          ...(status === undefined ? {} : { status }),
        },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));

      expect(() =>
        provider.authenticateWebhook(rawBody, signature(rawBody)),
      ).toThrow(PaymentWebhookPayloadError);
    },
  );

  it('initializes with authoritative server values and the secret only in authorization', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      response({
        status: true,
        data: {
          access_code: 'access-value',
          authorization_url: 'https://checkout.paystack.com/access-value',
          reference: 'EDU-payment-one',
        },
      }),
    );
    const provider = createProvider();

    await expect(
      provider.initialize({
        amountMinor: BigInt(5_000),
        callbackUrl: 'https://app.example.com/payment/callback',
        currency: 'GHS',
        email: 'buyer@example.com',
        orderPublicReference: '2b3e39a9-06db-41a9-a856-5f985846951a',
        paymentPublicReference: '5c299e8d-d325-47ea-8268-60877bb7694b',
        providerReference: 'EDU-payment-one',
      }),
    ).resolves.toEqual({
      accessCode: 'access-value',
      authorizationUrl: 'https://checkout.paystack.com/access-value',
      providerReference: 'EDU-payment-one',
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.paystack.co/transaction/initialize');
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      amount: 5000,
      callback_url: 'https://app.example.com/payment/callback',
      currency: 'GHS',
      email: 'buyer@example.com',
      metadata: {
        order_reference: '2b3e39a9-06db-41a9-a856-5f985846951a',
        payment_reference: '5c299e8d-d325-47ea-8268-60877bb7694b',
      },
      reference: 'EDU-payment-one',
    });
  });

  it('classifies an uncertain initialization timeout without retrying it', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('timeout'));

    await expect(
      createProvider().initialize({
        amountMinor: BigInt(5_000),
        callbackUrl: 'https://app.example.com/payment/callback',
        currency: 'GHS',
        email: 'buyer@example.com',
        orderPublicReference: '2b3e39a9-06db-41a9-a856-5f985846951a',
        paymentPublicReference: '5c299e8d-d325-47ea-8268-60877bb7694b',
        providerReference: 'EDU-payment-one',
      }),
    ).rejects.toMatchObject({
      category: 'UNKNOWN_OUTCOME',
    });
  });

  it('normalizes verification success for the same canonical success path', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      response({
        status: true,
        data: {
          amount: 5000,
          currency: 'GHS',
          id: 123456789,
          paid_at: '2026-08-18T12:00:00.000Z',
          reference: 'EDU-payment-one',
          status: 'success',
        },
      }),
    );

    await expect(createProvider().verify('EDU-payment-one')).resolves.toEqual({
      kind: 'PAYMENT_SUCCEEDED',
      success: expect.objectContaining({
        amountMinor: BigInt(5_000),
        providerReference: 'EDU-payment-one',
      }),
    });
  });
});

function createProvider(): PaystackPaymentProvider {
  return new PaystackPaymentProvider({
    baseUrl: 'https://api.paystack.co/',
    requestTimeoutMs: 10_000,
    secretKey,
  });
}

function successfulWebhook(): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: 'charge.success',
      data: {
        amount: 5000,
        currency: 'GHS',
        id: 123456789,
        paid_at: '2026-08-18T12:00:00.000Z',
        reference: 'EDU-payment-one',
        status: 'success',
      },
    }),
  );
}

function signature(rawBody: Buffer): string {
  return createHmac('sha512', secretKey).update(rawBody).digest('hex');
}

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
