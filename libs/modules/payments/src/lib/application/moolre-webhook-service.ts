import {
  type PaymentSuccessRepository,
  type PaymentSuccessOutcome,
} from './payment-success-service';
import type { PaymentProvider } from './payment-provider';

export const MOOLRE_WEBHOOK_SERVICE = Symbol('MOOLRE_WEBHOOK_SERVICE');

/**
 * Moolre collection callbacks authenticate with their shared secret. A P01 payload is
 * never treated as proof of payment: the referenced transaction is re-verified
 * through the provider status endpoint and only a verified success is recorded.
 */
export interface MoolreWebhookService {
  handle(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<PaymentSuccessOutcome>;
}

export class DefaultMoolreVerificationWebhookService
  implements MoolreWebhookService
{
  constructor(
    private readonly provider: PaymentProvider,
    private readonly repository: PaymentSuccessRepository,
  ) {
    if (provider.code !== 'MOOLRE') {
      throw new Error(
        'The Moolre webhook service requires the Moolre provider.',
      );
    }
  }

  async handle(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<PaymentSuccessOutcome> {
    const event = this.provider.authenticateWebhook(rawBody, signature);
    if (event.kind !== 'NOTIFICATION') return 'IGNORED';

    const verification = await this.provider.verify(event.providerReference);
    if (verification.kind !== 'PAYMENT_SUCCEEDED') {
      // Pending or failed transactions have no success effect here; the
      // payment recovery worker owns their lifecycle.
      return 'IGNORED';
    }

    return this.repository.recordVerifiedSuccess({
      provider: this.provider.code,
      receipt: {
        eventType: event.eventType,
        payloadFingerprint: event.payloadFingerprint,
      },
      success: verification.success,
    });
  }
}
