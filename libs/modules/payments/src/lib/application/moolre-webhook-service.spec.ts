import { DefaultMoolreVerificationWebhookService } from './moolre-webhook-service';
import { MoolrePaymentProvider } from '../infrastructure/moolre-payment-provider';
import { PaymentWebhookAuthenticationError } from './payment-errors';

describe('Moolre callback verification', () => {
  const provider = () =>
    new MoolrePaymentProvider({
      apiUser: 'test-user',
      publicKey: 'test-public-key',
      accountNumber: '1234567890',
      baseUrl: 'https://api.moolre.com/',
      requestTimeoutMs: 10000,
      webhookSecret: 'test-secret',
    });
  it.each(['wrong-secret', 'test-secret'])(
    'gates status verification for %s',
    async (secret) => {
      const adapter = provider();
      const verify = jest
        .spyOn(adapter, 'verify')
        .mockResolvedValue({
          kind: 'NOT_SUCCEEDED',
          isTerminal: false,
          providerStatus: 'PENDING',
        });
      const recordVerifiedSuccess = jest.fn();
      const service = new DefaultMoolreVerificationWebhookService(adapter, {
        recordVerifiedSuccess,
      } as never);
      const body = Buffer.from(
        JSON.stringify({
          code: 'P01',
          status: 1,
          data: { secret, externalref: 'EDU-payment-one' },
        }),
      );
      if (secret === 'wrong-secret') {
        await expect(service.handle(body, undefined)).rejects.toThrow(
          PaymentWebhookAuthenticationError,
        );
        expect(verify).not.toHaveBeenCalled();
      } else {
        await expect(service.handle(body, undefined)).resolves.toBe('IGNORED');
        expect(verify).toHaveBeenCalledWith('EDU-payment-one');
      }
      expect(recordVerifiedSuccess).not.toHaveBeenCalled();
    },
  );
});
