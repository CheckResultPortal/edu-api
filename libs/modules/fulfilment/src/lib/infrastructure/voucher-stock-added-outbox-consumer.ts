import { randomInt } from 'node:crypto';

import type { DatabaseClient } from '@edu-api/database';
import type { StructuredLogger } from '@edu-api/observability';

import {
  VoucherStockAddedAllocationHandler,
  type VoucherStockAddedPayload,
} from './voucher-stock-added-allocation.handler';

const voucherStockAddedEventType = 'VoucherStockAdded';

export interface VoucherStockAddedConsumerOptions {
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly maximumRetryDelayMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly workerId: string;
}

export class VoucherStockAddedOutboxConsumer {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly maximumRetryDelayMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly workerId: string;

  constructor(
    private readonly database: DatabaseClient,
    private readonly handler: VoucherStockAddedAllocationHandler,
    private readonly chunkSize: number,
    options: VoucherStockAddedConsumerOptions,
    private readonly logger?: StructuredLogger,
  ) {
    this.chunkSize = requireBoundedPositiveInteger(chunkSize, 'chunkSize', 500);
    this.leaseMs = requirePositiveInteger(
      options.leaseMs ?? 120_000,
      'leaseMs',
    );
    this.maxAttempts = requirePositiveInteger(
      options.maxAttempts ?? 5,
      'maxAttempts',
    );
    this.maximumRetryDelayMs = requirePositiveInteger(
      options.maximumRetryDelayMs ?? 300_000,
      'maximumRetryDelayMs',
    );
    this.retryBaseDelayMs = requirePositiveInteger(
      options.retryBaseDelayMs ?? 5_000,
      'retryBaseDelayMs',
    );
    if (this.maximumRetryDelayMs < this.retryBaseDelayMs) {
      throw new Error(
        'maximumRetryDelayMs must be greater than or equal to retryBaseDelayMs.',
      );
    }
    this.workerId = options.workerId.trim();
    if (this.workerId.length === 0) {
      throw new Error('workerId must not be empty.');
    }
  }

  async processAvailable(maximumEvents = 25): Promise<number> {
    const boundedMaximumEvents = Math.min(
      requireBoundedPositiveInteger(maximumEvents, 'maximumEvents', 100),
      100,
    );
    let processedEventCount = 0;

    for (
      let eventIndex = 0;
      eventIndex < boundedMaximumEvents;
      eventIndex += 1
    ) {
      const claimedEvent = await this.claimNextOutboxEvent();
      if (claimedEvent === null) break;
      await this.processClaimedEvent(claimedEvent.id);
      processedEventCount += 1;
    }

    return processedEventCount;
  }

  private async claimNextOutboxEvent(): Promise<{ id: bigint } | null> {
    const claimedAt = new Date();
    const staleBefore = new Date(claimedAt.getTime() - this.leaseMs);

    return this.database.$transaction(async (transaction) => {
      const claimableEvents = await transaction.$queryRaw<
        Array<{ id: bigint }>
      >`
        SELECT outbox_event.id
        FROM "OutboxEvent" AS outbox_event
        WHERE outbox_event."eventType" = ${voucherStockAddedEventType}
          AND outbox_event."publishedAt" IS NULL
          AND outbox_event."needsAttentionAt" IS NULL
          AND outbox_event."availableAt" <= ${claimedAt}
          AND (
            outbox_event."lockedAt" IS NULL
            OR outbox_event."lockedAt" < ${staleBefore}
          )
        ORDER BY outbox_event.id ASC
        FOR UPDATE OF outbox_event SKIP LOCKED
        LIMIT 1
      `;
      const claimableEvent = claimableEvents[0];
      if (claimableEvent === undefined) return null;

      const claimedEventCount = await transaction.outboxEvent.updateMany({
        where: { id: claimableEvent.id },
        data: {
          attempts: { increment: 1 },
          lockedAt: claimedAt,
          lockOwner: this.workerId,
        },
      });
      return claimedEventCount.count === 1 ? { id: claimableEvent.id } : null;
    });
  }

  private async processClaimedEvent(eventId: bigint): Promise<void> {
    try {
      await this.database.$transaction(
        async (transaction) => {
          const claimedEvents = await transaction.$queryRaw<
            Array<{ id: bigint; payload: unknown }>
          >`
            SELECT outbox_event.id, outbox_event.payload
            FROM "OutboxEvent" AS outbox_event
            WHERE outbox_event.id = ${eventId}
              AND outbox_event."lockOwner" = ${this.workerId}
              AND outbox_event."publishedAt" IS NULL
              AND outbox_event."needsAttentionAt" IS NULL
            FOR UPDATE OF outbox_event
          `;
          const claimedEvent = claimedEvents[0];
          if (claimedEvent === undefined) return;

          const payload = parseVoucherStockAddedPayload(claimedEvent.payload);
          if (payload === null) {
            await transaction.outboxEvent.update({
              where: { id: eventId },
              data: {
                lastFailureCode: 'INVALID_PAYLOAD',
                lockedAt: null,
                lockOwner: null,
                needsAttentionAt: new Date(),
              },
            });
            return;
          }

          await this.handler.handle(transaction, payload, this.chunkSize);
          await transaction.outboxEvent.update({
            where: { id: eventId },
            data: {
              lastFailureCode: null,
              lockedAt: null,
              lockOwner: null,
              publishedAt: new Date(),
            },
          });
        },
        { maxWait: 5_000, timeout: 30_000 },
      );
    } catch (error) {
      this.logger?.error(
        `VoucherStockAdded processing failed for outbox event ${eventId.toString()} (failure=${safeFailureKind(error)}).`,
        undefined,
        'RestockDrain',
      );
      await this.handleProcessingFailure(eventId);
    }
  }

  private async handleProcessingFailure(eventId: bigint): Promise<void> {
    const failedAt = new Date();
    const claimedEvent = await this.database.outboxEvent.findFirst({
      where: { id: eventId, lockOwner: this.workerId },
      select: { attempts: true },
    });
    if (claimedEvent === null) return;

    if (claimedEvent.attempts >= this.maxAttempts) {
      await this.database.outboxEvent.updateMany({
        where: { id: eventId, lockOwner: this.workerId },
        data: {
          lastFailureCode: 'MAX_ATTEMPTS_EXCEEDED',
          lockedAt: null,
          lockOwner: null,
          needsAttentionAt: failedAt,
        },
      });
      return;
    }

    const exponentialDelayMs = Math.min(
      this.maximumRetryDelayMs,
      this.retryBaseDelayMs * 2 ** Math.max(0, claimedEvent.attempts - 1),
    );
    const jitterMaximumMs = Math.max(1, Math.floor(exponentialDelayMs / 4));
    const retryDelayMs = Math.min(
      this.maximumRetryDelayMs,
      exponentialDelayMs + randomInt(0, jitterMaximumMs + 1),
    );
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.workerId },
      data: {
        lastFailureCode: 'PROCESSING_FAILED',
        lockedAt: null,
        lockOwner: null,
        availableAt: new Date(failedAt.getTime() + retryDelayMs),
      },
    });
  }
}

const voucherStockAddedKeys = [
  'batchPublicId',
  'productPublicId',
  'quantity',
  'version',
] as const;

function parseVoucherStockAddedPayload(
  value: unknown,
): VoucherStockAddedPayload | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== voucherStockAddedKeys.length ||
    voucherStockAddedKeys.some((key, index) => key !== keys[index])
  ) {
    return null;
  }

  const batchPublicId = value['batchPublicId'];
  const productPublicId = value['productPublicId'];
  const quantity = value['quantity'];
  const version = value['version'];
  if (
    !isUuid(batchPublicId) ||
    !isUuid(productPublicId) ||
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 2_147_483_647 ||
    version !== 1
  ) {
    return null;
  }

  return { batchPublicId, productPublicId, quantity, version };
}

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function requirePositiveInteger(value: number, name: string): number {
  return requireBoundedPositiveInteger(value, name, Number.MAX_SAFE_INTEGER);
}

function requireBoundedPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function safeFailureKind(error: unknown): string {
  if (
    error instanceof Error &&
    error.name === 'PrismaClientKnownRequestError'
  ) {
    return 'DATABASE';
  }
  if (error instanceof Error && error.name === 'PrismaClientRustPanicError') {
    return 'DATABASE_RUNTIME';
  }
  return 'UNCLASSIFIED';
}
