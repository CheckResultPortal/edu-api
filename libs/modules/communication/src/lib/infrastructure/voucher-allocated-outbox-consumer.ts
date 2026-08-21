import { randomInt } from 'node:crypto';

import type {
  DatabaseClient,
  DatabaseTransactionClient,
} from '@edu-api/database';

import { PrismaVoucherDeliverySourceReader } from './prisma-voucher-delivery-source-reader';

const eventType = 'VoucherAllocated';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VoucherAllocatedOutboxConsumerOptions {
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly maximumRetryDelayMs: number;
  readonly retryBaseDelayMs: number;
  readonly workerId: string;
}

export class VoucherAllocatedOutboxConsumer {
  constructor(
    private readonly database: DatabaseClient,
    private readonly sourceReader: PrismaVoucherDeliverySourceReader,
    private readonly options: VoucherAllocatedOutboxConsumerOptions,
  ) {}

  async processAvailable(limit: number): Promise<number> {
    const events = await this.claimAvailable(limit);
    for (const event of events) await this.process(event.id, event.payload);
    return events.length;
  }

  private async claimAvailable(
    limit: number,
  ): Promise<readonly { readonly id: bigint; readonly payload: unknown }[]> {
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

  private async process(eventId: bigint, payload: unknown): Promise<void> {
    const parsed = parsePayload(payload);
    if (parsed === null) {
      await this.needsAttention(eventId, 'INVALID_VOUCHER_ALLOCATED_PAYLOAD');
      return;
    }
    try {
      const outcome = await this.database.$transaction(async (transaction) => {
        const source = await this.sourceReader.findByAllocationPublicReference(
          transaction,
          parsed.allocationPublicReference,
        );
        if (
          source === null ||
          source.orderPublicReference !== parsed.orderPublicReference
        ) {
          return 'MISSING_SOURCE' as const;
        }
        const channels = channelsFor(
          source.preference,
          source.destinationPhone,
          source.destinationEmail,
        );
        if (channels === null) return 'MISSING_DESTINATION' as const;
        const communication = await transaction.communication.upsert({
          where: { allocationId: source.allocationId },
          create: {
            allocationId: source.allocationId,
            purpose: 'VOUCHER_DELIVERY',
          },
          update: {},
          select: { id: true },
        });
        await transaction.communicationDelivery.createMany({
          data: channels.map((channel) => ({
            channel: channel.channel,
            communicationId: communication.id,
            destination: channel.destination,
          })),
          skipDuplicates: true,
        });
        await transaction.outboxEvent.updateMany({
          where: { id: eventId, lockOwner: this.options.workerId },
          data: { lockOwner: null, lockedAt: null, publishedAt: new Date() },
        });
        return 'PUBLISHED' as const;
      });
      if (outcome === 'MISSING_SOURCE')
        await this.needsAttention(eventId, 'VOUCHER_DELIVERY_SOURCE_MISSING');
      if (outcome === 'MISSING_DESTINATION')
        await this.needsAttention(
          eventId,
          'VOUCHER_DELIVERY_DESTINATION_MISSING',
        );
    } catch {
      await this.retry(eventId);
    }
  }

  private async retry(eventId: bigint): Promise<void> {
    const event = await this.database.outboxEvent.findUnique({
      where: { id: eventId },
      select: { attempts: true },
    });
    if (event === null || event.attempts >= this.options.maxAttempts) {
      await this.needsAttention(eventId, 'VOUCHER_DELIVERY_OBLIGATION_FAILED');
      return;
    }
    const exponent = Math.max(0, event.attempts - 1);
    const delay = Math.min(
      this.options.maximumRetryDelayMs,
      this.options.retryBaseDelayMs * 2 ** exponent,
    );
    const retryAt = new Date(
      new Date().getTime() +
        delay +
        randomInt(0, Math.max(1, Math.floor(delay / 4))),
    );
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: { availableAt: retryAt, lockOwner: null, lockedAt: null },
    });
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

function parsePayload(
  value: unknown,
): {
  readonly allocationPublicReference: string;
  readonly orderPublicReference: string;
} | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const payload = value as Record<string, unknown>;
  const expected = [
    'allocationPublicReference',
    'allocatedAt',
    'fulfilmentUnitPublicReference',
    'orderPublicReference',
    'productPublicId',
    'version',
  ];
  if (
    Object.keys(payload).length !== expected.length ||
    expected.some((key) => !(key in payload))
  )
    return null;
  if (
    payload.version !== 1 ||
    typeof payload.allocatedAt !== 'string' ||
    Number.isNaN(Date.parse(payload.allocatedAt))
  )
    return null;
  for (const key of [
    'allocationPublicReference',
    'fulfilmentUnitPublicReference',
    'orderPublicReference',
    'productPublicId',
  ] as const) {
    if (typeof payload[key] !== 'string' || !uuid.test(payload[key]))
      return null;
  }
  return {
    allocationPublicReference: payload.allocationPublicReference as string,
    orderPublicReference: payload.orderPublicReference as string,
  };
}

function channelsFor(
  preference: 'SMS_ONLY' | 'EMAIL_ONLY' | 'SMS_AND_EMAIL',
  phone: string | null,
  email: string | null,
):
  | readonly {
      readonly channel: 'SMS' | 'EMAIL';
      readonly destination: string;
    }[]
  | null {
  if (preference === 'SMS_ONLY')
    return phone === null ? null : [{ channel: 'SMS', destination: phone }];
  if (preference === 'EMAIL_ONLY')
    return email === null ? null : [{ channel: 'EMAIL', destination: email }];
  return phone === null || email === null
    ? null
    : [
        { channel: 'SMS', destination: phone },
        { channel: 'EMAIL', destination: email },
      ];
}

function bounded(value: number): number {
  return Math.max(1, Math.min(value, 100));
}
