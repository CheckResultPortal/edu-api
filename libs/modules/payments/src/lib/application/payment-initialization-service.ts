import { randomUUID } from 'node:crypto';

import { createRequestFingerprint } from '@edu-api/idempotency';

import {
  PaymentInitializationInProgressError,
  PaymentOrderAlreadyPaidError,
  PaymentProviderRejectedError,
  PaymentProviderUnknownOutcomeError,
} from './payment-errors';
import {
  PaymentProviderRequestError,
  type PaymentProvider,
} from './payment-provider';
import {
  assertPaymentIdempotencyKey,
  assertPaymentOrderReference,
} from '../domain/payment-validation';

export const PAYMENT_INITIALIZATION_REPOSITORY = Symbol(
  'PAYMENT_INITIALIZATION_REPOSITORY',
);
export const PAYMENT_INITIALIZATION_SERVICE = Symbol(
  'PAYMENT_INITIALIZATION_SERVICE',
);
export const PAYMENT_RATE_LIMITER = Symbol('PAYMENT_RATE_LIMITER');

export type PaymentAttemptState =
  | 'INITIALIZING'
  | 'PENDING'
  | 'UNKNOWN'
  | 'SUCCEEDED'
  | 'FAILED';

export interface PaymentInitialization {
  readonly accessCode: string | null;
  readonly amountMinor: string;
  readonly authorizationUrl: string | null;
  readonly currency: 'GHS';
  readonly paymentPublicReference: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly status: 'PENDING' | 'SUCCEEDED';
}

export interface PaymentInitializationClaim {
  readonly accessCode: string | null;
  readonly authorizationUrl: string | null;
  readonly currency: 'GHS';
  readonly email: string | null;
  readonly expectedAmountMinor: bigint;
  readonly isNew: boolean;
  readonly orderPublicReference: string;
  readonly payerPhoneNumber: string | null;
  readonly paymentAttemptId: bigint;
  readonly paymentPublicReference: string;
  readonly providerReference: string;
  readonly purchaseChannel: PaymentChannel;
  readonly status: PaymentAttemptState;
}

export type PaymentChannel = 'WEB' | 'USSD';

export interface ClaimPaymentInitializationInput {
  readonly idempotencyExpiresAt: Date;
  readonly idempotencyKey: string;
  readonly initialVerificationAt: Date;
  readonly orderPublicReference: string;
  readonly moolreChannel?: string;
  readonly paymentPublicReference: string;
  readonly providerCodes: Readonly<Record<PaymentChannel, string>>;
  readonly providerReference: string;
  readonly purchaseChannel: PaymentChannel;
  readonly requestFingerprint: string;
}

export interface PaymentInitializationRepository {
  claim(
    input: ClaimPaymentInitializationInput,
  ): Promise<PaymentInitializationClaim>;

  recordFailure(input: {
    readonly idempotencyKey: string;
    readonly isUnknown: boolean;
    readonly nextVerificationAt: Date | null;
    readonly paymentAttemptId: bigint;
  }): Promise<void>;

  recordInitialized(input: {
    readonly accessCode: string | null;
    readonly authorizationUrl: string | null;
    readonly idempotencyKey: string;
    readonly nextVerificationAt: Date;
    readonly paymentAttemptId: bigint;
  }): Promise<void>;
}

export interface PaymentInitializationService {
  initialize(command: {
    readonly channel: PaymentChannel;
    readonly clientIp: string;
    readonly idempotencyKey: string;
    readonly moolreChannel?: string;
    readonly orderPublicReference: string;
    readonly payerPhoneNumber?: string;
  }): Promise<PaymentInitialization>;
}

export interface PaymentRateLimiter {
  consume(input: {
    /** Omitted for authenticated USSD gateway traffic. */
    readonly clientIp?: string;
    readonly orderPublicReference: string;
  }): Promise<void>;
}

export interface PaymentInitializationConfiguration {
  readonly callbackUrl: string;
  readonly idempotencyTtlMs: number;
  readonly initialVerificationDelayMs: number;
  readonly privacyHmacKey: Uint8Array;
}

export interface PaymentChannelProviders {
  readonly USSD: PaymentProvider;
  readonly WEB: PaymentProvider;
}

export class DefaultPaymentInitializationService
  implements PaymentInitializationService
{
  constructor(
    private readonly repository: PaymentInitializationRepository,
    private readonly providers: PaymentChannelProviders,
    private readonly rateLimiter: PaymentRateLimiter,
    private readonly configuration: PaymentInitializationConfiguration,
  ) {}

  async initialize(command: {
    readonly channel: PaymentChannel;
    readonly clientIp: string;
    readonly idempotencyKey: string;
    readonly moolreChannel?: string;
    readonly orderPublicReference: string;
    readonly payerPhoneNumber?: string;
  }): Promise<PaymentInitialization> {
    const orderPublicReference = assertPaymentOrderReference(
      command.orderPublicReference,
    );
    const idempotencyKey = assertPaymentIdempotencyKey(command.idempotencyKey);
    await this.rateLimiter.consume({
      ...(command.channel === 'WEB' ? { clientIp: command.clientIp } : {}),
      orderPublicReference,
    });
    const now = new Date();
    const claim = await this.repository.claim({
      idempotencyExpiresAt: new Date(
        now.getTime() + this.configuration.idempotencyTtlMs,
      ),
      idempotencyKey,
      ...(command.moolreChannel === undefined
        ? {}
        : { moolreChannel: command.moolreChannel }),
      initialVerificationAt: new Date(
        now.getTime() + this.configuration.initialVerificationDelayMs,
      ),
      orderPublicReference,
      paymentPublicReference: randomUUID(),
      providerCodes: {
        USSD: this.providers.USSD.code,
        WEB: this.providers.WEB.code,
      },
      providerReference: `EDU-${randomUUID()}`,
      purchaseChannel: command.channel,
      requestFingerprint: createRequestFingerprint(
        { orderPublicReference },
        this.configuration.privacyHmacKey,
      ),
    });

    if (!claim.isNew) return this.replay(claim);

    // USSD prompt dispatch is a durable outbox responsibility. The short
    // handset session returns after PostgreSQL has committed the attempt; a
    // worker contacts Moolre and payment recovery verifies the final result.
    if (claim.purchaseChannel === 'USSD') {
      return {
        accessCode: null,
        amountMinor: claim.expectedAmountMinor.toString(),
        authorizationUrl: null,
        currency: claim.currency,
        paymentPublicReference: claim.paymentPublicReference,
        provider: this.providers.USSD.code,
        providerReference: claim.providerReference,
        status: 'PENDING',
      };
    }

    const provider = this.providers[claim.purchaseChannel];
    try {
      const initialized = await provider.initialize({
        amountMinor: claim.expectedAmountMinor,
        callbackUrl: this.configuration.callbackUrl,
        currency: claim.currency,
        email: claim.email ?? '',
        ...(claim.payerPhoneNumber === null
          ? {}
          : { payerPhoneNumber: claim.payerPhoneNumber }),
        orderPublicReference: claim.orderPublicReference,
        paymentPublicReference: claim.paymentPublicReference,
        providerReference: claim.providerReference,
      });
      await this.repository.recordInitialized({
        accessCode: initialized.accessCode,
        authorizationUrl: initialized.authorizationUrl,
        idempotencyKey,
        nextVerificationAt: new Date(
          Date.now() + this.configuration.initialVerificationDelayMs,
        ),
        paymentAttemptId: claim.paymentAttemptId,
      });

      return {
        accessCode: initialized.accessCode,
        amountMinor: claim.expectedAmountMinor.toString(),
        authorizationUrl: initialized.authorizationUrl,
        currency: claim.currency,
        paymentPublicReference: claim.paymentPublicReference,
        provider: provider.code,
        providerReference: claim.providerReference,
        status: 'PENDING',
      };
    } catch (error) {
      const isRejected =
        error instanceof PaymentProviderRequestError &&
        (error.category === 'AUTHENTICATION' ||
          error.category === 'INVALID_REQUEST');
      await this.repository.recordFailure({
        idempotencyKey,
        isUnknown: !isRejected,
        nextVerificationAt: isRejected ? null : new Date(),
        paymentAttemptId: claim.paymentAttemptId,
      });
      if (isRejected) throw new PaymentProviderRejectedError();
      throw new PaymentProviderUnknownOutcomeError();
    }
  }

  private replay(claim: PaymentInitializationClaim): PaymentInitialization {
    if (claim.purchaseChannel === 'USSD' && claim.status === 'INITIALIZING') {
      return {
        accessCode: null,
        amountMinor: claim.expectedAmountMinor.toString(),
        authorizationUrl: null,
        currency: claim.currency,
        paymentPublicReference: claim.paymentPublicReference,
        provider: this.providers.USSD.code,
        providerReference: claim.providerReference,
        status: 'PENDING',
      };
    }
    if (claim.status === 'SUCCEEDED') {
      return {
        accessCode: claim.accessCode,
        amountMinor: claim.expectedAmountMinor.toString(),
        authorizationUrl: claim.authorizationUrl,
        currency: claim.currency,
        paymentPublicReference: claim.paymentPublicReference,
        provider: this.providers[claim.purchaseChannel].code,
        providerReference: claim.providerReference,
        status: 'SUCCEEDED',
      };
    }
    if (claim.status === 'PENDING') {
      // Hosted-checkout providers store an authorization URL; prompt-push
      // providers legitimately replay with null checkout values.
      return {
        accessCode: claim.accessCode,
        amountMinor: claim.expectedAmountMinor.toString(),
        authorizationUrl: claim.authorizationUrl,
        currency: claim.currency,
        paymentPublicReference: claim.paymentPublicReference,
        provider: this.providers[claim.purchaseChannel].code,
        providerReference: claim.providerReference,
        status: claim.status,
      };
    }
    if (claim.status === 'FAILED') throw new PaymentProviderRejectedError();
    if (claim.status === 'UNKNOWN') {
      throw new PaymentProviderUnknownOutcomeError();
    }
    throw new PaymentInitializationInProgressError();
  }
}

export function assertNewPaymentAllowed(hasApplication: boolean): void {
  if (hasApplication) throw new PaymentOrderAlreadyPaidError();
}
