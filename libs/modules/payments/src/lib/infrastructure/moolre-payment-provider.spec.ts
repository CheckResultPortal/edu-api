import { PaymentWebhookPayloadError } from '../application/payment-errors';
import {
  MoolrePaymentProvider,
  formatMajorAmount,
  moolreChannelForPhoneNumber,
} from './moolre-payment-provider';

const configuration = {
  accountNumber: '100000157291',
  apiUser: 'edu-integration',
  baseUrl: 'https://api.moolre.com/',
  publicKey: 'pk_test_0123456789abcdef',
  requestTimeoutMs: 10_000,
};

describe('MoolrePaymentProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('authenticateWebhook', () => {
    it('returns an unsigned NOTIFICATION that requires server-side verification', () => {
      const rawBody = collectionWebhook();

      expect(createProvider().authenticateWebhook(rawBody, undefined)).toEqual({
        eventType: 'P01',
        kind: 'NOTIFICATION',
        payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        providerReference: 'EDU-payment-one',
      });
    });

    it('acknowledges other status codes without a payment effect', () => {
      const rawBody = Buffer.from(
        JSON.stringify({ code: 'PX99', message: 'Unknown', status: 0, data: {} }),
      );

      expect(
        createProvider().authenticateWebhook(rawBody, undefined),
      ).toEqual({ kind: 'IGNORED' });
    });

    it.each([
      ['missing code', { message: 'x', status: 1 }],
      [
        'missing external reference',
        { code: 'P01', message: 'ok', status: 1, data: {} },
      ],
      [
        'non-object transaction data',
        { code: 'P01', message: 'ok', status: 1, data: 'nope' },
      ],
    ])('rejects %s', (_name, payload) => {
      const rawBody = Buffer.from(JSON.stringify(payload));

      expect(() =>
        createProvider().authenticateWebhook(rawBody, undefined),
      ).toThrow(PaymentWebhookPayloadError);
    });
  });

  describe('initialize', () => {
    const input = {
      amountMinor: BigInt(5_000),
      callbackUrl: 'https://app.example.com/moolre/webhook',
      currency: 'GHS' as const,
      email: 'ignored@moolre-prompt.local',
      orderPublicReference: '2b3e39a9-06db-41a9-a856-5f985846951a',
      payerPhoneNumber: '0244123456',
      paymentPublicReference: '5c299e8d-d325-47ea-8268-60877bb7694b',
      providerReference: 'EDU-payment-one',
    };

    it('sends a direct debit prompt and resolves without hosted checkout values', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(response({ code: 'TR099', status: 1 }));
      const provider = createProvider();

      await expect(provider.initialize(input)).resolves.toEqual({
        accessCode: null,
        authorizationUrl: null,
        providerReference: 'EDU-payment-one',
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://api.moolre.com/open/transact/payment');
      expect(options).toMatchObject({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-pubkey': configuration.publicKey,
          'x-api-user': configuration.apiUser,
        },
      });
      expect(JSON.parse(String(options?.body))).toEqual({
        accountnumber: configuration.accountNumber,
        amount: '50.00',
        channel: '13',
        currency: 'GHS',
        externalref: 'EDU-payment-one',
        payer: '0244123456',
        type: 1,
      });
    });

    it('rejects initialization without a routable payer number', async () => {
      await expect(
        createProvider().initialize({ ...input, payerPhoneNumber: undefined }),
      ).rejects.toMatchObject({ category: 'INVALID_REQUEST' });
      await expect(
        createProvider().initialize({ ...input, payerPhoneNumber: '0999999999' }),
      ).rejects.toMatchObject({ category: 'INVALID_REQUEST' });
    });

    it('maps an OTP-required response to a temporary outcome for recovery polling', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          response({ code: 'TP14', message: 'verification', status: 1 }),
        );

      await expect(createProvider().initialize(input)).rejects.toMatchObject({
        category: 'TEMPORARY',
      });
    });

    it('maps duplicate references to invalid request', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        response({
          code: 'TP13',
          data: 'externalref',
          message: 'duplicate',
          status: '0',
        }),
      );

      await expect(createProvider().initialize(input)).rejects.toMatchObject({
        category: 'INVALID_REQUEST',
      });
    });

    it('classifies an uncertain timeout as unknown outcome', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('timeout'));

      await expect(createProvider().initialize(input)).rejects.toMatchObject({
        category: 'UNKNOWN_OUTCOME',
      });
    });
  });

  describe('verify', () => {
    const successData = {
      amount: '50.00',
      externalref: 'EDU-payment-one',
      payee: 'EduVoucher',
      payer: '0244123456',
      thirdpartyref: '55730796319',
      transactionid: '34008096',
      ts: '2026-08-21 10:15:20',
      txstatus: 1,
    };

    it('normalizes a successful status check onto the canonical success shape', async () => {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
        response({ code: 'SS01', data: successData, status: 1 }),
      );

      await expect(createProvider().verify('EDU-payment-one')).resolves.toEqual({
        kind: 'PAYMENT_SUCCEEDED',
        success: {
          amountMinor: BigInt(5_000),
          currency: 'GHS',
          paidAt: new Date('2026-08-21T10:15:20.000Z'),
          providerReference: 'EDU-payment-one',
          providerStatus: 'success',
          providerTransactionId: '34008096',
        },
      });

      const [, options] = fetchMock.mock.calls[0];
      expect(JSON.parse(String(options?.body))).toEqual({
        accountnumber: configuration.accountNumber,
        id: 'EDU-payment-one',
        idtype: 1,
        type: 1,
      });
    });

    it('treats a failed terminal status as terminal and pending as retryable', async () => {
      const provider = createProvider();
      jest.spyOn(global, 'fetch').mockResolvedValue(
        response({ code: 'SS01', data: { ...successData, txstatus: 2 }, status: 1 }),
      );
      await expect(provider.verify('EDU-payment-one')).resolves.toEqual({
        isTerminal: true,
        kind: 'NOT_SUCCEEDED',
        providerStatus: 'txstatus_2',
      });

      jest.spyOn(global, 'fetch').mockResolvedValue(
        response({ code: 'SS01', data: { ...successData, txstatus: 0 }, status: 1 }),
      );
      await expect(provider.verify('EDU-payment-one')).resolves.toEqual({
        isTerminal: false,
        kind: 'NOT_SUCCEEDED',
        providerStatus: 'txstatus_0',
      });
    });

    it('keeps a not-yet-recorded or mismatched transaction retryable instead of final', async () => {
      const provider = createProvider();
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          response({ code: 'ST09', message: 'not found', status: 1 }),
        );
      await expect(provider.verify('EDU-payment-one')).rejects.toMatchObject({
        category: 'TEMPORARY',
      });

      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          response({
            code: 'SS01',
            data: { ...successData, externalref: 'someone-else' },
            status: 1,
          }),
        );
      await expect(provider.verify('EDU-payment-one')).rejects.toMatchObject({
        category: 'UNKNOWN_OUTCOME',
      });
    });
  });

  describe('moolreChannelForPhoneNumber', () => {
    it.each([
      ['0244123456', '13'],
      ['+233201234567', '6'],
      ['0271234567', '7'],
    ])('routes %s to channel %s', (phone, channel) => {
      expect(moolreChannelForPhoneNumber(phone)).toBe(channel);
    });

    it('returns null for unroutable numbers', () => {
      expect(moolreChannelForPhoneNumber('0999999999')).toBeNull();
      expect(moolreChannelForPhoneNumber('12345')).toBeNull();
    });
  });

  describe('formatMajorAmount', () => {
    it.each([
      [BigInt(5_000), '50.00'],
      [BigInt(105), '1.05'],
      [BigInt(100), '1.00'],
      [BigInt(99), '0.99'],
    ])('formats %d minor as %s major', (minor, expected) => {
      expect(formatMajorAmount(minor)).toBe(expected);
    });
  });
});

function createProvider(): MoolrePaymentProvider {
  return new MoolrePaymentProvider(configuration);
}

function collectionWebhook(): Buffer {
  return Buffer.from(
    JSON.stringify({
      code: 'P01',
      data: {
        externalref: 'EDU-payment-one',
        transactionid: '34008096',
      },
      message: 'Transaction Successful',
      status: 1,
    }),
  );
}

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}
