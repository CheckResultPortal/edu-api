import type {
  AuthenticatedProviderWebhook,
  PaymentProvider,
  VerifiedProviderPaymentSuccess,
} from './payment-provider';

export const PAYMENT_SUCCESS_REPOSITORY = Symbol('PAYMENT_SUCCESS_REPOSITORY');
export const PAYMENT_WEBHOOK_SERVICE = Symbol('PAYMENT_WEBHOOK_SERVICE');

export type PaymentSuccessOutcome =
  | 'APPLIED'
  | 'ADDITIONAL_SUCCESS'
  | 'DUPLICATE'
  | 'IGNORED'
  | 'REJECTED';

export interface PaymentProviderEventReceipt {
  readonly eventType: string;
  readonly payloadFingerprint: string;
}

export interface RecordVerifiedPaymentSuccessInput {
  readonly provider: string;
  readonly receipt?: PaymentProviderEventReceipt;
  readonly success: VerifiedProviderPaymentSuccess;
}

export interface PaymentSuccessRepository {
  recordVerifiedSuccess(
    input: RecordVerifiedPaymentSuccessInput,
  ): Promise<PaymentSuccessOutcome>;
}

export interface PaymentWebhookService {
  handle(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<PaymentSuccessOutcome>;
}

export class DefaultPaymentWebhookService implements PaymentWebhookService {
  constructor(
    private readonly provider: PaymentProvider,
    private readonly repository: PaymentSuccessRepository,
  ) {}

  async handle(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<PaymentSuccessOutcome> {
    const event = this.provider.authenticateWebhook(rawBody, signature);
    if (event.kind === 'IGNORED') return 'IGNORED';
    // Unsigned NOTIFICATION events are never proof of payment; they are
    // handled by a verification-first webhook service, not this one.
    if (event.kind !== 'PAYMENT_SUCCEEDED') return 'IGNORED';
    return this.record(event);
  }

  private record(
    event: Extract<
      AuthenticatedProviderWebhook,
      { readonly kind: 'PAYMENT_SUCCEEDED' }
    >,
  ): Promise<PaymentSuccessOutcome> {
    return this.repository.recordVerifiedSuccess({
      provider: this.provider.code,
      receipt: {
        eventType: event.eventType,
        payloadFingerprint: event.payloadFingerprint,
      },
      success: event.success,
    });
  }
}
