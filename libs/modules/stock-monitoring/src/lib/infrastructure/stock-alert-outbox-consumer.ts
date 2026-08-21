import type { DatabaseClient } from '@edu-api/database';
import { StructuredLogger } from '@edu-api/observability';

const stockAlertEventTypes = ['StockLow', 'StockEmpty', 'StockRecovered'];

export interface StockAlertOutboxConsumerOptions {
  readonly leaseMs: number;
  readonly workerId: string;
}

export class StockAlertOutboxConsumer {
  constructor(
    private readonly database: DatabaseClient,
    private readonly logger: StructuredLogger,
    private readonly options: StockAlertOutboxConsumerOptions,
  ) {}

  /** Publishes durable transition facts to structured operational logs. */
  async processAvailable(limit: number): Promise<number> {
    const events = await this.claimAvailable(limit);
    for (const event of events) {
      await this.process(event.id, event.eventType, event.payload);
    }
    return events.length;
  }

  private async claimAvailable(limit: number): Promise<
    readonly {
      readonly eventType: string;
      readonly id: bigint;
      readonly payload: unknown;
    }[]
  > {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.options.leaseMs);
    return this.database.$transaction(async (transaction) => {
      const events = await transaction.$queryRaw<
        Array<{ eventType: string; id: bigint; payload: unknown }>
      >`
        SELECT "id", "eventType", "payload"
        FROM "OutboxEvent"
        WHERE "eventType" IN ('StockLow', 'StockEmpty', 'StockRecovered')
          AND "publishedAt" IS NULL
          AND "needsAttentionAt" IS NULL
          AND "availableAt" <= ${now}
          AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
        ORDER BY "id" ASC
        LIMIT ${bounded(limit)}
        FOR UPDATE SKIP LOCKED
      `;
      if (events.length === 0) return events;
      await transaction.outboxEvent.updateMany({
        where: { id: { in: events.map((event) => event.id) } },
        data: {
          attempts: { increment: 1 },
          lockedAt: now,
          lockOwner: this.options.workerId,
        },
      });
      return events;
    });
  }

  private async process(
    eventId: bigint,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    const alert = parseStockAlertPayload(payload);
    if (
      alert === null ||
      !stockAlertEventTypes.includes(eventType) ||
      !eventMatchesStockLevel(eventType, alert.stockLevel)
    ) {
      await this.needsAttention(eventId, 'INVALID_STOCK_ALERT_PAYLOAD');
      return;
    }
    try {
      const message =
        `Stock alert published: event=${eventType} product=${alert.productPublicId} ` +
        `available=${alert.availableStock} waiting=${alert.paidWaitingQuantity} ` +
        `soldToday=${alert.soldToday} cycle=${alert.depletionCycle}.`;
      if (eventType === 'StockEmpty') {
        this.logger.error(message, undefined, 'StockMonitoring');
      } else if (eventType === 'StockRecovered') {
        this.logger.log(message, 'StockMonitoring');
      } else {
        this.logger.warn(message, 'StockMonitoring');
      }
      await this.database.outboxEvent.updateMany({
        where: { id: eventId, lockOwner: this.options.workerId },
        data: { lockOwner: null, lockedAt: null, publishedAt: new Date() },
      });
    } catch {
      await this.database.outboxEvent.updateMany({
        where: { id: eventId, lockOwner: this.options.workerId },
        data: { lockOwner: null, lockedAt: null },
      });
    }
  }

  private async needsAttention(eventId: bigint, code: string): Promise<void> {
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: {
        lastFailureCode: code,
        lockOwner: null,
        lockedAt: null,
        needsAttentionAt: new Date(),
      },
    });
  }
}

function parseStockAlertPayload(value: unknown): {
  readonly availableStock: number;
  readonly depletionCycle: number;
  readonly paidWaitingQuantity: number;
  readonly productPublicId: string;
  readonly soldToday: number;
  readonly stockLevel: 'NORMAL' | 'LOW' | 'EMPTY';
} | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  const expectedKeys = [
    'availableStock',
    'depletionCycle',
    'lowStockThreshold',
    'oldestWaitingPaidAt',
    'paidWaitingQuantity',
    'productPublicId',
    'soldToday',
    'stockLevel',
    'version',
  ];
  if (
    Object.keys(payload).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in payload))
  ) {
    return null;
  }
  if (
    payload.version !== 1 ||
    !isUuid(payload.productPublicId) ||
    !isNonNegativeInteger(payload.availableStock) ||
    !isPositiveInteger(payload.depletionCycle) ||
    !isNonNegativeInteger(payload.lowStockThreshold) ||
    !isNonNegativeInteger(payload.paidWaitingQuantity) ||
    !isNonNegativeInteger(payload.soldToday) ||
    !isStockLevel(payload.stockLevel) ||
    (payload.oldestWaitingPaidAt !== null &&
      (typeof payload.oldestWaitingPaidAt !== 'string' ||
        Number.isNaN(Date.parse(payload.oldestWaitingPaidAt))))
  ) {
    return null;
  }
  return {
    availableStock: payload.availableStock,
    depletionCycle: payload.depletionCycle,
    paidWaitingQuantity: payload.paidWaitingQuantity,
    productPublicId: payload.productPublicId,
    soldToday: payload.soldToday,
    stockLevel: payload.stockLevel,
  };
}

function bounded(value: number): number {
  return Math.max(1, Math.min(value, 100));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isStockLevel(value: unknown): value is 'NORMAL' | 'LOW' | 'EMPTY' {
  return value === 'NORMAL' || value === 'LOW' || value === 'EMPTY';
}

function eventMatchesStockLevel(
  eventType: string,
  stockLevel: string,
): boolean {
  return (
    (eventType === 'StockLow' && stockLevel === 'LOW') ||
    (eventType === 'StockEmpty' && stockLevel === 'EMPTY') ||
    (eventType === 'StockRecovered' && stockLevel === 'NORMAL')
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
