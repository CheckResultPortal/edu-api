import { Prisma } from '../../../../../../generated/prisma/client';

import { type TransactionalOrderProductQuery } from '@edu-api/catalog';
import type { DatabaseClient } from '@edu-api/database';

import {
  OrderCreationUnavailableError,
  OrderCurrencyUnsupportedError,
  OrderIdempotencyConflictError,
  OrderProductUnavailableError,
} from '../application/order-creation-errors';
import type {
  GuestOrder,
  OrderCreationRepository,
  PersistGuestOrderInput,
} from '../application/order-creation-service';

const idempotencyScope = 'guest-order-create';

export class PrismaOrderCreationRepository implements OrderCreationRepository {
  constructor(
    private readonly database: DatabaseClient,
    private readonly catalog: TransactionalOrderProductQuery,
  ) {}

  async create(input: PersistGuestOrderInput): Promise<GuestOrder> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.createTransaction(input);
      } catch (error) {
        if (isPrismaError(error, 'P2002')) {
          return this.replayOrConflict(input);
        }
        if (isPrismaError(error, 'P2034') && attempt < 3) continue;
        if (isPrismaError(error, 'P2034')) {
          throw new OrderCreationUnavailableError();
        }
        throw error;
      }
    }
    throw new OrderCreationUnavailableError();
  }

  private createTransaction(input: PersistGuestOrderInput) {
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
            scope: idempotencyScope,
            key: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            expiresAt: input.idempotencyExpiresAt,
          },
        });

        const product = await this.catalog.getActiveOrderProduct(
          transaction,
          input.productPublicId,
        );
        if (product === null) throw new OrderProductUnavailableError();
        if (product.currency !== 'GHS') {
          throw new OrderCurrencyUnsupportedError();
        }

        const totalPriceMinor =
          product.sellingPriceMinor * BigInt(input.quantity);
        const order = await transaction.order.create({
          data: {
            phoneNumber: input.phoneNumber,
            email: input.email,
            currency: 'GHS',
            totalPriceMinor,
            items: {
              create: {
                productId: product.id,
                quantity: input.quantity,
                unitPriceMinor: product.sellingPriceMinor,
                totalPriceMinor,
                currency: 'GHS',
              },
            },
          },
          select: {
            id: true,
            publicReference: true,
            currency: true,
            totalPriceMinor: true,
            items: {
              select: {
                quantity: true,
                unitPriceMinor: true,
                product: { select: { publicId: true } },
              },
            },
          },
        });

        await transaction.outboxEvent.create({
          data: {
            aggregateType: 'Order',
            aggregateId: order.id,
            eventType: 'OrderCreated',
            dedupeKey: `order-created:${order.publicReference}`,
            payload: {
              version: 1,
              orderPublicReference: order.publicReference,
              productPublicId: product.publicId,
              quantity: input.quantity,
              unitPriceMinor: product.sellingPriceMinor.toString(),
              totalPriceMinor: totalPriceMinor.toString(),
              currency: 'GHS',
            },
          },
        });
        await transaction.idempotencyRecord.update({
          where: {
            scope_key: {
              scope: idempotencyScope,
              key: input.idempotencyKey,
            },
          },
          data: {
            status: 'COMPLETED',
            responseStatus: 201,
            responseReference: order.publicReference,
            completedAt: now,
          },
        });

        return toGuestOrder(order);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      },
    );
  }

  private async replayOrConflict(
    input: PersistGuestOrderInput,
  ): Promise<GuestOrder> {
    const record = await this.database.idempotencyRecord.findUnique({
      where: {
        scope_key: { scope: idempotencyScope, key: input.idempotencyKey },
      },
      select: {
        requestFingerprint: true,
        responseReference: true,
        status: true,
      },
    });
    if (record === null) throw new OrderCreationUnavailableError();
    if (record.requestFingerprint !== input.requestFingerprint) {
      throw new OrderIdempotencyConflictError();
    }
    if (record.status !== 'COMPLETED' || record.responseReference === null) {
      throw new OrderCreationUnavailableError();
    }

    const order = await this.database.order.findUnique({
      where: { publicReference: record.responseReference },
      select: {
        id: true,
        publicReference: true,
        currency: true,
        totalPriceMinor: true,
        items: {
          select: {
            quantity: true,
            unitPriceMinor: true,
            product: { select: { publicId: true } },
          },
        },
      },
    });
    if (order === null) throw new OrderCreationUnavailableError();
    return toGuestOrder(order);
  }
}

function toGuestOrder(order: {
  readonly currency: string;
  readonly items: readonly {
    readonly product: { readonly publicId: string };
    readonly quantity: number;
    readonly unitPriceMinor: bigint;
  }[];
  readonly publicReference: string;
  readonly totalPriceMinor: bigint;
}): GuestOrder {
  const item = order.items[0];
  if (item === undefined || order.currency !== 'GHS') {
    throw new OrderCreationUnavailableError();
  }
  return {
    currency: 'GHS',
    productPublicId: item.product.publicId,
    publicReference: order.publicReference,
    quantity: item.quantity,
    totalPriceMinor: order.totalPriceMinor.toString(),
    unitPriceMinor: item.unitPriceMinor.toString(),
  };
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
