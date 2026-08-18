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
  readonly email: string;
  readonly expectedAmountMinor: bigint;
  readonly isNew: boolean;
  readonly orderPublicReference: string;
  readonly paymentAttemptId: bigint;
  readonly paymentPublicReference: string;
  readonly providerReference: string;
  readonly status: PaymentAttemptState;
}

export interface ClaimPaymentInitializationInput {
  readonly idempotencyExpiresAt: Date;
  readonly idempotencyKey: string;
  readonly initialVerificationAt: Date;
  readonly orderPublicReference: string;
  readonly paymentPublicReference: string;
  readonly provider: string;
  readonly providerReference: string;
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
    readonly accessCode: string;
    readonly authorizationUrl: string;
    readonly idempotencyKey: string;
    readonly nextVerificationAt: Date;
    readonly paymentAttemptId: bigint;
  }): Promise<void>;
}

export interface PaymentInitializationService {
  initialize(command: {
    readonly clientIp: string;
    readonly idempotencyKey: string;
    readonly orderPublicReference: string;
  }): Promise<PaymentInitialization>;
}

export interface PaymentRateLimiter {
  consume(input: {
    readonly clientIp: string;
    readonly orderPublicReference: string;
  }): Promise<void>;
}

export interface PaymentInitializationConfiguration {
  readonly callbackUrl: string;
  readonly idempotencyTtlMs: number;
  readonly initialVerificationDelayMs: number;
  readonly privacyHmacKey: Uint8Array;
}

export class DefaultPaymentInitializationService
  implements PaymentInitializationService
{
  constructor(
    private readonly repository: PaymentInitializationRepository,
    private readonly provider: PaymentProvider,
    private readonly rateLimiter: PaymentRateLimiter,
    private readonly configuration: PaymentInitializationConfiguration,
  ) {}

  async initialize(command: {
    readonly clientIp: string;
    readonly idempotencyKey: string;
    readonly orderPublicReference: string;
  }): Promise<PaymentInitialization> {
    const orderPublicReference = assertPaymentOrderReference(
      command.orderPublicReference,
    );
    const idempotencyKey = assertPaymentIdempotencyKey(command.idempotencyKey);
    await this.rateLimiter.consume({
      clientIp: command.clientIp,
      orderPublicReference,
    });
    const now = new Date();
    const claim = await this.repository.claim({
      idempotencyExpiresAt: new Date(
        now.getTime() + this.configuration.idempotencyTtlMs,
      ),
      idempotencyKey,
      initialVerificationAt: new Date(
        now.getTime() + this.configuration.initialVerificationDelayMs,
      ),
      orderPublicReference,
      paymentPublicReference: randomUUID(),
      provider: this.provider.code,
      providerReference: `EDU-${randomUUID()}`,
      requestFingerprint: createRequestFingerprint(
        { orderPublicReference },
        this.configuration.privacyHmacKey,
      ),
    });

    if (!claim.isNew) return this.replay(claim);

    try {
      const initialized = await this.provider.initialize({
        amountMinor: claim.expectedAmountMinor,
        callbackUrl: this.configuration.callbackUrl,
        currency: claim.currency,
        email: claim.email,
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
        provider: this.provider.code,
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
    if (claim.status === 'SUCCEEDED') {
      return {
        accessCode: claim.accessCode,
        amountMinor: claim.expectedAmountMinor.toString(),
        authorizationUrl: claim.authorizationUrl,
        currency: claim.currency,
        paymentPublicReference: claim.paymentPublicReference,
        provider: this.provider.code,
        providerReference: claim.providerReference,
        status: 'SUCCEEDED',
      };
    }
    if (
      claim.status === 'PENDING' &&
      claim.accessCode !== null &&
      claim.authorizationUrl !== null
    ) {
      return {
        accessCode: claim.accessCode,
        amountMinor: claim.expectedAmountMinor.toString(),
        authorizationUrl: claim.authorizationUrl,
        currency: claim.currency,
        paymentPublicReference: claim.paymentPublicReference,
        provider: this.provider.code,
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
