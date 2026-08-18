import { randomUUID } from 'node:crypto';

import { PrismaTransactionalOrderProductQuery } from '@edu-api/catalog';
import { createPrismaClient, type DatabaseClient } from '@edu-api/database';

import {
  OrderCurrencyUnsupportedError,
  OrderIdempotencyConflictError,
  OrderProductUnavailableError,
} from '../application/order-creation-errors';
import {
  DefaultOrderCreationService,
  type OrderCreationService,
  type OrderRateLimiter,
} from '../application/order-creation-service';
import { PrismaOrderCreationRepository } from './prisma-order-creation.repository';

const databaseUrl = process.env.ORDERS_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('guest order creation (PostgreSQL)', () => {
  let database: DatabaseClient;
  let productId: bigint;
  let productPublicId: string;
  let service: OrderCreationService;
  let suffix: string;

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
  });

  beforeEach(async () => {
    suffix = randomUUID().replace(/-/g, '').toUpperCase();
    const group = await database.catalogGroup.create({
      data: {
        code: `ORDER_${suffix}`,
        name: 'Order integration',
        sortOrder: 0,
      },
      select: { id: true },
    });
    const product = await database.product.create({
      data: {
        catalogGroupId: group.id,
        code: `ORDER_PRODUCT_${suffix}`,
        currency: 'GHS',
        lowStockThreshold: 1,
        name: 'Order product',
        sellingPriceMinor: BigInt(2_500),
      },
      select: { id: true, publicId: true },
    });
    productId = product.id;
    productPublicId = product.publicId;
    const repository = new PrismaOrderCreationRepository(
      database,
      new PrismaTransactionalOrderProductQuery(),
    );
    const allowAll: OrderRateLimiter = { consume: jest.fn() };
    service = new DefaultOrderCreationService(
      repository,
      allowAll,
      24 * 60 * 60 * 1_000,
    );
  });

  afterEach(async () => {
    const orders = await database.order.findMany({
      where: { items: { some: { productId } } },
      select: { id: true },
    });
    const orderIds = orders.map((order) => order.id);
    if (orderIds.length !== 0) {
      await database.outboxEvent.deleteMany({
        where: { aggregateType: 'Order', aggregateId: { in: orderIds } },
      });
      await database.orderItem.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await database.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await database.idempotencyRecord.deleteMany({
      where: { scope: 'guest-order-create', key: { contains: suffix } },
    });
    await database.product.delete({ where: { id: productId } });
    await database.catalogGroup.deleteMany({
      where: { code: `ORDER_${suffix}` },
    });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('atomically snapshots authoritative price and emits a contact-free event', async () => {
    const order = await service.create(command('snapshot', 2), {
      clientIp: '203.0.113.10',
    });
    expect(order).toMatchObject({
      currency: 'GHS',
      productPublicId,
      quantity: 2,
      totalPriceMinor: '5000',
      unitPriceMinor: '2500',
    });
    expect(order.publicReference).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await database.product.update({
      where: { id: productId },
      data: { sellingPriceMinor: BigInt(3_000) },
    });
    const stored = await database.order.findUniqueOrThrow({
      where: { publicReference: order.publicReference },
      include: { items: true },
    });
    expect(stored.phoneNumber).toBe('+233241234567');
    expect(stored.email).toBe('buyer@example.com');
    expect(stored.firstName).toBe('Ama');
    expect(stored.deliveryPreference).toBe('SMS_AND_EMAIL');
    expect(stored.totalPriceMinor).toBe(BigInt(5_000));
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0]).toMatchObject({
      quantity: 2,
      unitPriceMinor: BigInt(2_500),
      totalPriceMinor: BigInt(5_000),
      currency: 'GHS',
    });

    const event = await database.outboxEvent.findFirstOrThrow({
      where: {
        aggregateType: 'Order',
        aggregateId: stored.id,
        eventType: 'OrderCreated',
      },
      select: { payload: true },
    });
    const eventPayload = JSON.stringify(event.payload);
    expect(eventPayload).not.toContain('+233241234567');
    expect(eventPayload).not.toContain('buyer@example.com');
    expect(eventPayload).not.toContain('Ama');
  });

  it('stores SMS-only delivery without unnecessary email data', async () => {
    const order = await service.create(
      {
        deliveryPreference: 'SMS_ONLY',
        firstName: 'Akosua',
        idempotencyKey: idempotencyKey('sms-only'),
        phoneNumber: '024 123 4567',
        productPublicId,
        quantity: 1,
      },
      { clientIp: '203.0.113.10' },
    );
    const stored = await database.order.findUniqueOrThrow({
      where: { publicReference: order.publicReference },
    });
    expect(stored).toMatchObject({
      deliveryPreference: 'SMS_ONLY',
      email: null,
      firstName: 'Akosua',
      phoneNumber: '+233241234567',
    });
  });

  it('replays the original result and rejects a changed payload', async () => {
    const original = await service.create(command('replay', 1), {
      clientIp: '203.0.113.10',
    });
    await expect(
      service.create(command('replay', 1), { clientIp: '203.0.113.10' }),
    ).resolves.toEqual(original);
    await expect(
      service.create(command('replay', 2), { clientIp: '203.0.113.10' }),
    ).rejects.toBeInstanceOf(OrderIdempotencyConflictError);
    await expect(
      database.order.count({ where: { items: { some: { productId } } } }),
    ).resolves.toBe(1);
  });

  it('returns one order for concurrent retries of the same request', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.create(command('concurrent', 3), {
          clientIp: '203.0.113.10',
        }),
      ),
    );
    expect(new Set(results.map((order) => order.publicReference)).size).toBe(1);
    await expect(
      database.order.count({ where: { items: { some: { productId } } } }),
    ).resolves.toBe(1);
    const storedOrder = await database.order.findUniqueOrThrow({
      where: { publicReference: results[0].publicReference },
      select: { id: true },
    });
    await expect(
      database.outboxEvent.count({
        where: {
          aggregateId: storedOrder.id,
          aggregateType: 'Order',
          eventType: 'OrderCreated',
        },
      }),
    ).resolves.toBe(1);
  });

  it('allows the approved key to represent a new order after expiry', async () => {
    const first = await service.create(command('expired', 1), {
      clientIp: '203.0.113.10',
    });
    await database.idempotencyRecord.update({
      where: {
        scope_key: {
          scope: 'guest-order-create',
          key: idempotencyKey('expired'),
        },
      },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const second = await service.create(command('expired', 1), {
      clientIp: '203.0.113.10',
    });
    expect(second.publicReference).not.toBe(first.publicReference);
  });

  it('rolls back the claim and business records for an unavailable product', async () => {
    await database.product.update({
      where: { id: productId },
      data: { isActive: false },
    });
    await expect(
      service.create(command('inactive', 1), { clientIp: '203.0.113.10' }),
    ).rejects.toBeInstanceOf(OrderProductUnavailableError);
    await expect(
      database.idempotencyRecord.count({
        where: { key: idempotencyKey('inactive') },
      }),
    ).resolves.toBe(0);
    await expect(
      database.order.count({ where: { items: { some: { productId } } } }),
    ).resolves.toBe(0);
  });

  it('rejects a non-GHS catalog product without persisting an order', async () => {
    await database.product.update({
      where: { id: productId },
      data: { currency: 'USD' },
    });
    await expect(
      service.create(command('currency', 1), { clientIp: '203.0.113.10' }),
    ).rejects.toBeInstanceOf(OrderCurrencyUnsupportedError);
    await expect(
      database.order.count({ where: { items: { some: { productId } } } }),
    ).resolves.toBe(0);
  });

  it('has database enforcement for the approved quantity ceiling', async () => {
    await expect(
      database.order.create({
        data: {
          deliveryPreference: 'SMS_ONLY',
          firstName: 'Ama',
          phoneNumber: '+233241234567',
          currency: 'GHS',
          totalPriceMinor: BigInt(52_500),
          items: {
            create: {
              productId,
              quantity: 21,
              unitPriceMinor: BigInt(2_500),
              totalPriceMinor: BigInt(52_500),
              currency: 'GHS',
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('has database enforcement for name and delivery contact consistency', async () => {
    await expect(
      database.order.create({
        data: {
          deliveryPreference: 'SMS_ONLY',
          email: 'buyer@example.com',
          firstName: 'Ama',
          phoneNumber: '+233241234567',
          currency: 'GHS',
          totalPriceMinor: BigInt(2_500),
          items: {
            create: {
              productId,
              quantity: 1,
              unitPriceMinor: BigInt(2_500),
              totalPriceMinor: BigInt(2_500),
              currency: 'GHS',
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(Error);

    await expect(
      database.order.create({
        data: {
          deliveryPreference: 'SMS_ONLY',
          firstName: null,
          phoneNumber: '+233241234567',
          currency: 'GHS',
          totalPriceMinor: BigInt(2_500),
          items: {
            create: {
              productId,
              quantity: 1,
              unitPriceMinor: BigInt(2_500),
              totalPriceMinor: BigInt(2_500),
              currency: 'GHS',
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  function command(label: string, quantity: number) {
    return {
      deliveryPreference: 'SMS_AND_EMAIL',
      email: 'Buyer@Example.com',
      firstName: 'Ama',
      idempotencyKey: idempotencyKey(label),
      phoneNumber: '024 123 4567',
      productPublicId,
      quantity,
    };
  }

  function idempotencyKey(label: string): string {
    return `order:${suffix}:${label}`;
  }
});
