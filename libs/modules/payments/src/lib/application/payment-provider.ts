export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export type PaymentCurrency = 'GHS';

export interface InitializeProviderPaymentInput {
  readonly amountMinor: bigint;
  readonly callbackUrl: string;
  readonly currency: PaymentCurrency;
  readonly email: string;
  readonly orderPublicReference: string;
  readonly paymentPublicReference: string;
  readonly providerReference: string;
}

export interface InitializedProviderPayment {
  readonly accessCode: string;
  readonly authorizationUrl: string;
  readonly providerReference: string;
}

export interface VerifiedProviderPaymentSuccess {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly paidAt: Date;
  readonly providerReference: string;
  readonly providerStatus: string;
  readonly providerTransactionId: string;
}

export type AuthenticatedProviderWebhook =
  | { readonly kind: 'IGNORED' }
  | {
      readonly eventType: string;
      readonly kind: 'PAYMENT_SUCCEEDED';
      readonly payloadFingerprint: string;
      readonly success: VerifiedProviderPaymentSuccess;
    };

export type ProviderPaymentVerification =
  | {
      readonly kind: 'PAYMENT_SUCCEEDED';
      readonly success: VerifiedProviderPaymentSuccess;
    }
  | {
      readonly isTerminal: boolean;
      readonly kind: 'NOT_SUCCEEDED';
      readonly providerStatus: string;
    };

export type PaymentProviderFailureCategory =
  | 'AUTHENTICATION'
  | 'INVALID_REQUEST'
  | 'TEMPORARY'
  | 'UNKNOWN_OUTCOME';

export class PaymentProviderRequestError extends Error {
  constructor(readonly category: PaymentProviderFailureCategory) {
    super('The payment provider request did not complete successfully.');
  }
}

export interface PaymentProvider {
  readonly code: string;

  authenticateWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): AuthenticatedProviderWebhook;

  initialize(
    input: InitializeProviderPaymentInput,
  ): Promise<InitializedProviderPayment>;

  verify(providerReference: string): Promise<ProviderPaymentVerification>;
}
