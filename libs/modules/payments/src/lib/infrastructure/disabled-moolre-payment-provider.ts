import {
  PaymentProviderRequestError,
  type AuthenticatedProviderWebhook,
  type InitializeProviderPaymentInput,
  type InitializedProviderPayment,
  type PaymentProvider,
  type ProviderPaymentVerification,
} from '../application/payment-provider';

/**
 * Preserves the payment-provider contract when the optional Moolre USSD
 * channel is disabled. No provider request is made in this mode.
 */
export class DisabledMoolrePaymentProvider implements PaymentProvider {
  readonly code = 'MOOLRE';

  authenticateWebhook(
    _rawBody: Buffer,
    _signature: string | undefined,
  ): AuthenticatedProviderWebhook {
    return { kind: 'IGNORED' };
  }

  async initialize(
    _input: InitializeProviderPaymentInput,
  ): Promise<InitializedProviderPayment> {
    throw new PaymentProviderRequestError('INVALID_REQUEST');
  }

  async verify(
    _providerReference: string,
  ): Promise<ProviderPaymentVerification> {
    throw new PaymentProviderRequestError('INVALID_REQUEST');
  }
}
