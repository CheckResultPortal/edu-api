export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
export const PAYSTACK_PAYMENT_PROVIDER = Symbol('PAYSTACK_PAYMENT_PROVIDER');
export const MOOLRE_PAYMENT_PROVIDER = Symbol('MOOLRE_PAYMENT_PROVIDER');

export type PaymentCurrency = 'GHS';

export interface InitializeProviderPaymentInput {
  readonly amountMinor: bigint;
  readonly callbackUrl: string;
  readonly currency: PaymentCurrency;
  readonly email: string;
  readonly orderPublicReference: string;
  readonly moolreChannel?: string;
  readonly paymentPublicReference: string;
  readonly providerReference: string;
  /**
   * Customer mobile-money number in local 0-prefixed format. Providers that
   * push a payment prompt directly to a phone require it; hosted-checkout
   * providers ignore it.
   */
  readonly payerPhoneNumber?: string;
}

export interface InitializedProviderPayment {
  /**
   * Hosted-checkout providers return both values; prompt-push providers
   * return null for both because no hosted page exists.
   */
  readonly accessCode: string | null;
  readonly authorizationUrl: string | null;
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
    }
  | {
      /**
       * The provider delivers unsigned callbacks that only signal a status
       * change. Consumers must re-verify the referenced transaction through
       * the provider's status endpoint before committing any success effect.
       */
      readonly eventType: string;
      readonly kind: 'NOTIFICATION';
      readonly payloadFingerprint: string;
      readonly providerReference: string;
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
