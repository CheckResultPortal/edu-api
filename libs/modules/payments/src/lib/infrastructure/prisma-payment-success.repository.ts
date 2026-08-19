import type { Prisma } from '../../../../../../generated/prisma/client';

import type { DatabaseClient } from '@edu-api/database';
import { type TransactionalFulfilmentUnitWriter } from '@edu-api/fulfilment';
import type { PaymentOrderQuery } from '@edu-api/orders';
import { assertValidOutboxEvent } from '@edu-api/outbox';

import { PaymentProcessingUnavailableError } from '../application/payment-errors';
import type {
  PaymentSuccessOutcome,
  PaymentSuccessRepository,
  RecordVerifiedPaymentSuccessInput,
} from '../application/payment-success-service';

type EventOutcome = 'APPLIED' | 'ADDITIONAL_SUCCESS' | 'REJECTED';

export class PrismaPaymentSuccessRepository
  implements PaymentSuccessRepository
{
  constructor(
    private readonly database: DatabaseClient,
    private readonly orders: PaymentOrderQuery,
    private readonly fulfilment: TransactionalFulfilmentUnitWriter,
  ) {}

  async recordVerifiedSuccess(
    input: RecordVerifiedPaymentSuccessInput,
  ): Promise<PaymentSuccessOutcome> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.database.$transaction(
          (transaction) => this.recordTransaction(transaction, input),
          { maxWait: 5_000, timeout: 10_000 },
        );
      } catch (error) {
        if (
          isPrismaError(error, 'P2028') &&
          input.receipt !== undefined &&
          (await this.hasReceipt(input))
        ) {
          return 'DUPLICATE';
        }
        if (
          (isPrismaError(error, 'P2002') ||
            isPrismaError(error, 'P2028') ||
            isPrismaError(error, 'P2034')) &&
          attempt < 3
        ) {
          continue;
        }
        if (
          isPrismaError(error, 'P2002') ||
          isPrismaError(error, 'P2028') ||
          isPrismaError(error, 'P2034')
        ) {
          throw new PaymentProcessingUnavailableError();
        }
        throw error;
      }
    }
    throw new PaymentProcessingUnavailableError();
  }

  private async hasReceipt(
    input: RecordVerifiedPaymentSuccessInput,
  ): Promise<boolean> {
    if (input.receipt === undefined) return false;
    const event = await this.database.paymentProviderEvent.findUnique({
      where: {
        provider_eventType_providerReference: {
          eventType: input.receipt.eventType,
          provider: input.provider,
          providerReference: input.success.providerReference,
        },
      },
      select: { id: true },
    });
    return event !== null;
  }

  private async recordTransaction(
    transaction: Prisma.TransactionClient,
    input: RecordVerifiedPaymentSuccessInput,
  ): Promise<PaymentSuccessOutcome> {
    if (input.receipt !== undefined) {
      const receipt = await transaction.paymentProviderEvent.createMany({
        data: {
          eventType: input.receipt.eventType,
          outcome: 'REJECTED',
          payloadFingerprint: input.receipt.payloadFingerprint,
          provider: input.provider,
          providerReference: input.success.providerReference,
          providerTransactionId: input.success.providerTransactionId,
          rejectionReason: 'PROCESSING',
        },
        skipDuplicates: true,
      });
      if (receipt.count === 0) return 'DUPLICATE';
    }

    const payment = await transaction.paymentAttempt.findUnique({
      where: {
        provider_providerReference: {
          provider: input.provider,
          providerReference: input.success.providerReference,
        },
      },
      select: {
        currency: true,
        expectedAmountMinor: true,
        id: true,
        orderId: true,
        publicReference: true,
      },
    });
    if (payment === null) {
      await this.finishReceipt(
        transaction,
        input,
        'REJECTED',
        'UNKNOWN_REFERENCE',
      );
      return 'REJECTED';
    }

    const mismatch =
      payment.expectedAmountMinor !== input.success.amountMinor
        ? 'AMOUNT_MISMATCH'
        : payment.currency !== input.success.currency
          ? 'CURRENCY_MISMATCH'
          : null;
    if (mismatch !== null) {
      await transaction.paymentAttempt.update({
        where: { id: payment.id },
        data: {
          attentionReason: mismatch,
          needsAttentionAt: new Date(),
        },
      });
      await this.finishReceipt(transaction, input, 'REJECTED', mismatch);
      return 'REJECTED';
    }

    const reusedTransaction = await transaction.paymentAttempt.findFirst({
      where: {
        provider: input.provider,
        providerTransactionId: input.success.providerTransactionId,
        id: { not: payment.id },
      },
      select: { id: true },
    });
    if (reusedTransaction !== null) {
      await transaction.paymentAttempt.update({
        where: { id: payment.id },
        data: {
          attentionReason: 'PROVIDER_TRANSACTION_REUSED',
          needsAttentionAt: new Date(),
        },
      });
      await this.finishReceipt(
        transaction,
        input,
        'REJECTED',
        'PROVIDER_TRANSACTION_REUSED',
      );
      return 'REJECTED';
    }

    const paidOrder = await this.orders.getPaidOrder(
      transaction,
      payment.orderId,
    );
    if (paidOrder === null) throw new PaymentProcessingUnavailableError();

    const verifiedAt = new Date();
    await transaction.paymentAttempt.update({
      where: { id: payment.id },
      data: {
        nextVerificationAt: null,
        paidAt: input.success.paidAt,
        providerStatus: input.success.providerStatus,
        providerTransactionId: input.success.providerTransactionId,
        status: 'SUCCEEDED',
        verificationLeaseUntil: null,
        verifiedAt,
      },
    });

    const applicationClaim = await transaction.paymentApplication.createMany({
      data: {
        appliedAt: verifiedAt,
        orderId: payment.orderId,
        paymentAttemptId: payment.id,
      },
      skipDuplicates: true,
    });
    if (applicationClaim.count === 0) {
      const existing = await transaction.paymentApplication.findUniqueOrThrow({
        where: { orderId: payment.orderId },
        select: { paymentAttemptId: true },
      });
      if (existing.paymentAttemptId === payment.id) {
        await this.finishReceipt(transaction, input, 'APPLIED');
        return 'DUPLICATE';
      }

      await transaction.paymentAttempt.update({
        where: { id: payment.id },
        data: {
          attentionReason: 'ADDITIONAL_SUCCESS',
          needsAttentionAt: verifiedAt,
        },
      });
      await this.insertAdditionalSuccessEvent(transaction, {
        amountMinor: input.success.amountMinor,
        currency: input.success.currency,
        orderPublicReference: paidOrder.publicReference,
        paymentAttemptId: payment.id,
        paymentPublicReference: payment.publicReference,
        providerReference: input.success.providerReference,
      });
      await this.finishReceipt(transaction, input, 'ADDITIONAL_SUCCESS');
      return 'ADDITIONAL_SUCCESS';
    }

    const application = await transaction.paymentApplication.findUniqueOrThrow({
      where: { paymentAttemptId: payment.id },
      select: { id: true },
    });
    await this.fulfilment.createPaidUnits(transaction, {
      orderItemId: paidOrder.item.id,
      orderPublicReference: paidOrder.publicReference,
      paidAt: input.success.paidAt,
      paymentApplicationId: application.id,
      productId: paidOrder.item.productId,
      productPublicId: paidOrder.item.productPublicId,
      quantity: paidOrder.item.quantity,
    });
    await this.insertPaymentSucceededEvent(transaction, {
      amountMinor: input.success.amountMinor,
      currency: input.success.currency,
      orderPublicReference: paidOrder.publicReference,
      paidAt: input.success.paidAt,
      paymentAttemptId: payment.id,
      paymentPublicReference: payment.publicReference,
      providerReference: input.success.providerReference,
      quantity: paidOrder.item.quantity,
    });
    await this.finishReceipt(transaction, input, 'APPLIED');
    return 'APPLIED';
  }

  private async finishReceipt(
    transaction: Prisma.TransactionClient,
    input: RecordVerifiedPaymentSuccessInput,
    outcome: EventOutcome,
    rejectionReason?: string,
  ): Promise<void> {
    if (input.receipt === undefined) return;
    await transaction.paymentProviderEvent.update({
      where: {
        provider_eventType_providerReference: {
          eventType: input.receipt.eventType,
          provider: input.provider,
          providerReference: input.success.providerReference,
        },
      },
      data: {
        outcome,
        paymentAttemptId:
          outcome === 'REJECTED' && rejectionReason === 'UNKNOWN_REFERENCE'
            ? null
            : undefined,
        processedAt: new Date(),
        rejectionReason: rejectionReason ?? null,
      },
    });
    if (outcome !== 'REJECTED' || rejectionReason !== 'UNKNOWN_REFERENCE') {
      const payment = await transaction.paymentAttempt.findUnique({
        where: {
          provider_providerReference: {
            provider: input.provider,
            providerReference: input.success.providerReference,
          },
        },
        select: { id: true },
      });
      if (payment !== null) {
        await transaction.paymentProviderEvent.update({
          where: {
            provider_eventType_providerReference: {
              eventType: input.receipt.eventType,
              provider: input.provider,
              providerReference: input.success.providerReference,
            },
          },
          data: { paymentAttemptId: payment.id },
        });
      }
    }
  }

  private async insertPaymentSucceededEvent(
    transaction: Prisma.TransactionClient,
    input: {
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly orderPublicReference: string;
      readonly paidAt: Date;
      readonly paymentAttemptId: bigint;
      readonly paymentPublicReference: string;
      readonly providerReference: string;
      readonly quantity: number;
    },
  ): Promise<void> {
    const payload = {
      version: 1,
      amountMinor: input.amountMinor.toString(),
      currency: input.currency,
      orderPublicReference: input.orderPublicReference,
      paidAt: input.paidAt.toISOString(),
      paymentPublicReference: input.paymentPublicReference,
      providerReference: input.providerReference,
      quantity: input.quantity,
    } as const;
    assertValidOutboxEvent({
      aggregateId: input.paymentAttemptId.toString(),
      aggregateType: 'PaymentAttempt',
      dedupeKey: `payment-succeeded:${input.paymentPublicReference}`,
      eventType: 'PaymentSucceeded',
      payload,
    });
    await transaction.outboxEvent.create({
      data: {
        aggregateId: input.paymentAttemptId,
        aggregateType: 'PaymentAttempt',
        dedupeKey: `payment-succeeded:${input.paymentPublicReference}`,
        eventType: 'PaymentSucceeded',
        payload,
      },
    });
  }

  private async insertAdditionalSuccessEvent(
    transaction: Prisma.TransactionClient,
    input: {
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly orderPublicReference: string;
      readonly paymentAttemptId: bigint;
      readonly paymentPublicReference: string;
      readonly providerReference: string;
    },
  ): Promise<void> {
    const payload = {
      version: 1,
      amountMinor: input.amountMinor.toString(),
      currency: input.currency,
      orderPublicReference: input.orderPublicReference,
      paymentPublicReference: input.paymentPublicReference,
      providerReference: input.providerReference,
    } as const;
    assertValidOutboxEvent({
      aggregateId: input.paymentAttemptId.toString(),
      aggregateType: 'PaymentAttempt',
      dedupeKey: `payment-additional-success:${input.paymentPublicReference}`,
      eventType: 'PaymentAdditionalSuccessDetected',
      payload,
    });
    await transaction.outboxEvent.create({
      data: {
        aggregateId: input.paymentAttemptId,
        aggregateType: 'PaymentAttempt',
        dedupeKey: `payment-additional-success:${input.paymentPublicReference}`,
        eventType: 'PaymentAdditionalSuccessDetected',
        payload,
      },
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
