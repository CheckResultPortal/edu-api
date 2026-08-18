import { Prisma } from '../../../../../../generated/prisma/client';

import type { DatabaseClient } from '@edu-api/database';
import type { PaymentOrderQuery } from '@edu-api/orders';

import {
  PaymentIdempotencyConflictError,
  PaymentOrderUnavailableError,
  PaymentProcessingUnavailableError,
} from '../application/payment-errors';
import {
  assertNewPaymentAllowed,
  type ClaimPaymentInitializationInput,
  type PaymentInitializationClaim,
  type PaymentInitializationRepository,
} from '../application/payment-initialization-service';

const idempotencyScope = 'web-payment-initialize';

export class PrismaPaymentInitializationRepository
  implements PaymentInitializationRepository
{
  constructor(
    private readonly database: DatabaseClient,
    private readonly orders: PaymentOrderQuery,
  ) {}

  async claim(
    input: ClaimPaymentInitializationInput,
  ): Promise<PaymentInitializationClaim> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.claimTransaction(input);
      } catch (error) {
        if (isIdempotencyClaimConflict(error)) {
          return this.replayOrConflict(input);
        }
        if (isPrismaError(error, 'P2034') && attempt < 3) continue;
        if (isPrismaError(error, 'P2034')) {
          throw new PaymentProcessingUnavailableError();
        }
        throw error;
      }
    }
    throw new PaymentProcessingUnavailableError();
  }

  async recordInitialized(input: {
    readonly accessCode: string;
    readonly authorizationUrl: string;
    readonly idempotencyKey: string;
    readonly nextVerificationAt: Date;
    readonly paymentAttemptId: bigint;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.paymentAttempt.update({
        where: { id: input.paymentAttemptId },
        data: {
          accessCode: input.accessCode,
          authorizationUrl: input.authorizationUrl,
        },
      });
      await transaction.paymentAttempt.updateMany({
        where: { id: input.paymentAttemptId, status: 'INITIALIZING' },
        data: {
          nextVerificationAt: input.nextVerificationAt,
          status: 'PENDING',
        },
      });
      await transaction.idempotencyRecord.update({
        where: {
          scope_key: { scope: idempotencyScope, key: input.idempotencyKey },
        },
        data: {
          completedAt: new Date(),
          responseStatus: 201,
          status: 'COMPLETED',
        },
      });
    });
  }

  async recordFailure(input: {
    readonly idempotencyKey: string;
    readonly isUnknown: boolean;
    readonly nextVerificationAt: Date | null;
    readonly paymentAttemptId: bigint;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.paymentAttempt.updateMany({
        where: { id: input.paymentAttemptId, status: 'INITIALIZING' },
        data: {
          nextVerificationAt: input.nextVerificationAt,
          status: input.isUnknown ? 'UNKNOWN' : 'FAILED',
        },
      });
      await transaction.idempotencyRecord.update({
        where: {
          scope_key: { scope: idempotencyScope, key: input.idempotencyKey },
        },
        data: {
          completedAt: new Date(),
          responseStatus: input.isUnknown ? 503 : 502,
          status: 'COMPLETED',
        },
      });
    });
  }

  private claimTransaction(input: ClaimPaymentInitializationInput) {
    return this.database.$transaction(
      async (transaction) => {
        const now = new Date();
        await transaction.idempotencyRecord.deleteMany({
          where: {
            scope: idempotencyScope,
            key: input.idempotencyKey,
            expiresAt: { lte: now },
          },
        });
        await transaction.idempotencyRecord.create({
          data: {
            expiresAt: input.idempotencyExpiresAt,
            key: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            scope: idempotencyScope,
          },
        });

        const order = await this.orders.getWebPaymentOrder(
          transaction,
          input.orderPublicReference,
        );
        if (order === null || order.currency !== 'GHS') {
          throw new PaymentOrderUnavailableError();
        }
        const application = await transaction.paymentApplication.findUnique({
          where: { orderId: order.id },
          select: { id: true },
        });
        assertNewPaymentAllowed(application !== null);

        const payment = await transaction.paymentAttempt.create({
          data: {
            currency: 'GHS',
            expectedAmountMinor: order.totalPriceMinor,
            nextVerificationAt: input.initialVerificationAt,
            orderId: order.id,
            provider: input.provider,
            providerReference: input.providerReference,
            publicReference: input.paymentPublicReference,
          },
          select: {
            id: true,
            publicReference: true,
          },
        });
        await transaction.idempotencyRecord.update({
          where: {
            scope_key: { scope: idempotencyScope, key: input.idempotencyKey },
          },
          data: { responseReference: payment.publicReference },
        });

        return {
          accessCode: null,
          authorizationUrl: null,
          currency: 'GHS' as const,
          email: order.email,
          expectedAmountMinor: order.totalPriceMinor,
          isNew: true,
          orderPublicReference: order.publicReference,
          paymentAttemptId: payment.id,
          paymentPublicReference: payment.publicReference,
          providerReference: input.providerReference,
          status: 'INITIALIZING' as const,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      },
    );
  }

  private async replayOrConflict(
    input: ClaimPaymentInitializationInput,
  ): Promise<PaymentInitializationClaim> {
    const record = await this.database.idempotencyRecord.findUnique({
      where: {
        scope_key: { scope: idempotencyScope, key: input.idempotencyKey },
      },
      select: { requestFingerprint: true, responseReference: true },
    });
    if (record === null || record.responseReference === null) {
      throw new PaymentProcessingUnavailableError();
    }
    if (record.requestFingerprint !== input.requestFingerprint) {
      throw new PaymentIdempotencyConflictError();
    }
    const responseReference = record.responseReference;

    return this.database.$transaction(async (transaction) => {
      const payment = await transaction.paymentAttempt.findUnique({
        where: { publicReference: responseReference },
        select: {
          accessCode: true,
          authorizationUrl: true,
          currency: true,
          expectedAmountMinor: true,
          id: true,
          orderId: true,
          providerReference: true,
          publicReference: true,
          status: true,
        },
      });
      if (payment === null || payment.currency !== 'GHS') {
        throw new PaymentProcessingUnavailableError();
      }
      const order = await this.orders.getWebPaymentOrderById(
        transaction,
        payment.orderId,
      );
      if (order === null) throw new PaymentProcessingUnavailableError();

      return {
        accessCode: payment.accessCode,
        authorizationUrl: payment.authorizationUrl,
        currency: 'GHS',
        email: order.email,
        expectedAmountMinor: payment.expectedAmountMinor,
        isNew: false,
        orderPublicReference: order.publicReference,
        paymentAttemptId: payment.id,
        paymentPublicReference: payment.publicReference,
        providerReference: payment.providerReference,
        status: payment.status,
      };
    });
  }
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function isIdempotencyClaimConflict(error: unknown): boolean {
  if (!isPrismaError(error, 'P2002')) return false;
  if (typeof error !== 'object' || error === null || !('meta' in error)) {
    return false;
  }
  const meta = error.meta;
  if (typeof meta !== 'object' || meta === null) return false;
  if ('modelName' in meta && meta.modelName === 'IdempotencyRecord') {
    return true;
  }
  if (!('target' in meta)) return false;
  const target = meta.target;
  if (typeof target === 'string') {
    return target.includes('IdempotencyRecord_scope_key_key');
  }
  return (
    Array.isArray(target) && target.includes('scope') && target.includes('key')
  );
}
