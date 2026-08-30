import type { DatabaseClient } from '@edu-api/database';

import {
  PaymentProviderRequestError,
  type PaymentProvider,
} from '../application/payment-provider';
import type { PaymentSuccessRepository } from '../application/payment-success-service';

const eventType = 'UssdPaymentPromptRequested';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface UssdPaymentPromptConsumerOptions {
  readonly initialVerificationDelayMs: number;
  readonly leaseMs: number;
  readonly workerId: string;
}

interface ClaimedPromptEvent {
  readonly attempts: number;
  readonly id: bigint;
  readonly payload: unknown;
}

export class UssdPaymentPromptOutboxConsumer {
  constructor(
    private readonly database: DatabaseClient,
    private readonly provider: PaymentProvider,
    private readonly successes: PaymentSuccessRepository,
    private readonly options: UssdPaymentPromptConsumerOptions,
  ) {}

  async processAvailable(limit: number): Promise<number> {
    const events = await this.claimAvailable(limit);
    for (const event of events) await this.process(event);
    return events.length;
  }

  private async claimAvailable(
    limit: number,
  ): Promise<readonly ClaimedPromptEvent[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.options.leaseMs);
    return this.database.$transaction(async (transaction) => {
      const events = await transaction.$queryRaw<
        Array<{ id: bigint; payload: unknown }>
      >`
        SELECT id, payload
        FROM "OutboxEvent"
        WHERE "eventType" = ${eventType}
          AND "publishedAt" IS NULL
          AND "needsAttentionAt" IS NULL
          AND "availableAt" <= ${now}
          AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
        ORDER BY id ASC
        LIMIT ${bounded(limit)}
        FOR UPDATE SKIP LOCKED
      `;
      const claimed: ClaimedPromptEvent[] = [];
      for (const event of events) {
        const updated = await transaction.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts: { increment: 1 },
            lockedAt: now,
            lockOwner: this.options.workerId,
          },
          select: { attempts: true },
        });
        claimed.push({ ...event, attempts: updated.attempts });
      }
      return claimed;
    });
  }

  private async process(event: ClaimedPromptEvent): Promise<void> {
    const payload = parsePayload(event.payload);
    if (payload === null) {
      await this.needsAttention(event.id, 'INVALID_USSD_PROMPT_PAYLOAD');
      return;
    }
    const payment = await this.database.paymentAttempt.findUnique({
      where: { publicReference: payload.paymentPublicReference },
      select: {
        currency: true,
        expectedAmountMinor: true,
        id: true,
        provider: true,
        providerReference: true,
        publicReference: true,
        status: true,
        order: {
          select: { phoneNumber: true, publicReference: true },
        },
      },
    });
    if (
      payment === null ||
      payment.provider !== this.provider.code ||
      payment.providerReference !== payload.providerReference ||
      payment.order.publicReference !== payload.orderPublicReference ||
      payment.currency !== 'GHS' ||
      payment.order.phoneNumber === null
    ) {
      await this.needsAttention(event.id, 'USSD_PROMPT_SOURCE_MISSING');
      return;
    }
    if (payment.status !== 'INITIALIZING') {
      await this.publish(event.id);
      return;
    }

    // A reclaimed event may have crashed after the provider request. Verify
    // first and never blindly send a second prompt after an unknown outcome.
    if (event.attempts > 1) {
      await this.reconcileStalePrompt(event.id, payment.providerReference);
      return;
    }

    try {
      const initialized = await this.provider.initialize({
        amountMinor: payment.expectedAmountMinor,
        callbackUrl: 'https://invalid.example/',
        currency: 'GHS',
        email: '',
        orderPublicReference: payment.order.publicReference,
        payerPhoneNumber: payment.order.phoneNumber,
        paymentPublicReference: payment.publicReference,
        providerReference: payment.providerReference,
      });
      await this.database.$transaction(async (transaction) => {
        await transaction.paymentAttempt.updateMany({
          where: { id: payment.id, status: 'INITIALIZING' },
          data: {
            accessCode: initialized.accessCode,
            authorizationUrl: initialized.authorizationUrl,
            nextVerificationAt: new Date(
              Date.now() + this.options.initialVerificationDelayMs,
            ),
            status: 'PENDING',
          },
        });
        await markPublished(transaction, event.id, this.options.workerId);
      });
    } catch (error) {
      const category =
        error instanceof PaymentProviderRequestError
          ? error.category
          : 'UNKNOWN_OUTCOME';
      const now = new Date();
      await this.database.$transaction(async (transaction) => {
        await transaction.paymentAttempt.updateMany({
          where: { id: payment.id, status: 'INITIALIZING' },
          data:
            category === 'INVALID_REQUEST'
              ? { nextVerificationAt: null, status: 'FAILED' }
              : category === 'AUTHENTICATION'
                ? {
                    attentionReason: 'USSD_PROMPT_AUTHENTICATION',
                    needsAttentionAt: now,
                    nextVerificationAt: null,
                    status: 'UNKNOWN',
                  }
                : { nextVerificationAt: now, status: 'UNKNOWN' },
        });
        await markPublished(transaction, event.id, this.options.workerId);
      });
    }
  }

  private async reconcileStalePrompt(
    eventId: bigint,
    providerReference: string,
  ): Promise<void> {
    try {
      const verification = await this.provider.verify(providerReference);
      if (verification.kind === 'PAYMENT_SUCCEEDED') {
        await this.successes.recordVerifiedSuccess({
          provider: this.provider.code,
          success: verification.success,
        });
      } else {
        await this.database.paymentAttempt.updateMany({
          where: { provider: this.provider.code, providerReference },
          data: {
            nextVerificationAt: verification.isTerminal ? null : new Date(),
            providerStatus: verification.providerStatus,
            status: verification.isTerminal ? 'FAILED' : 'UNKNOWN',
          },
        });
      }
    } catch {
      await this.database.paymentAttempt.updateMany({
        where: { provider: this.provider.code, providerReference },
        data: { nextVerificationAt: new Date(), status: 'UNKNOWN' },
      });
    }
    await this.publish(eventId);
  }

  private async publish(eventId: bigint): Promise<void> {
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: {
        lastFailureCode: null,
        lockedAt: null,
        lockOwner: null,
        publishedAt: new Date(),
      },
    });
  }

  private async needsAttention(eventId: bigint, code: string): Promise<void> {
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: {
        lastFailureCode: code,
        lockedAt: null,
        lockOwner: null,
        needsAttentionAt: new Date(),
      },
    });
  }
}

async function markPublished(
  transaction: Pick<DatabaseClient, 'outboxEvent'>,
  eventId: bigint,
  workerId: string,
): Promise<void> {
  await transaction.outboxEvent.updateMany({
    where: { id: eventId, lockOwner: workerId },
    data: {
      lastFailureCode: null,
      lockedAt: null,
      lockOwner: null,
      publishedAt: new Date(),
    },
  });
}

function parsePayload(value: unknown): {
  readonly orderPublicReference: string;
  readonly paymentPublicReference: string;
  readonly providerReference: string;
} | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const expected = [
    'orderPublicReference',
    'paymentPublicReference',
    'providerReference',
    'version',
  ];
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key) ||
    payload.version !== 1 ||
    typeof payload.orderPublicReference !== 'string' ||
    !uuid.test(payload.orderPublicReference) ||
    typeof payload.paymentPublicReference !== 'string' ||
    !uuid.test(payload.paymentPublicReference) ||
    typeof payload.providerReference !== 'string' ||
    payload.providerReference.length < 1 ||
    payload.providerReference.length > 200
  ) {
    return null;
  }
  return {
    orderPublicReference: payload.orderPublicReference,
    paymentPublicReference: payload.paymentPublicReference,
    providerReference: payload.providerReference,
  };
}

function bounded(value: number): number {
  return Math.max(1, Math.min(value, 100));
}
