import {
  PaymentProviderRequestError,
  type AuthenticatedProviderWebhook,
  type InitializeProviderPaymentInput,
  type InitializedProviderPayment,
  type PaymentProvider,
  type ProviderPaymentVerification,
} from '../application/payment-provider';

/**
 * Safe placeholder while the USSD/Moolre collection channel is disabled.
 * It never makes a provider call or creates a payment success effect.
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
    throw new PaymentProviderRequestError('AUTHENTICATION');
  }
}
