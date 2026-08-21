import { randomBytes } from 'node:crypto';

import { createPrismaClient, type DatabaseClient } from '@edu-api/database';
import { StructuredLogger } from '@edu-api/observability';

import { PrismaStockMonitoringService } from './prisma-stock-monitoring.service';
import { StockAlertOutboxConsumer } from './stock-alert-outbox-consumer';

const databaseUrl = process.env.STOCK_MONITORING_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('stock monitoring (PostgreSQL)', () => {
  let database: DatabaseClient;
  let productId: bigint;
  let productPublicId: string;
  let groupId: bigint;

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
  });

  beforeEach(async () => {
    const suffix = randomBytes(8).toString('hex');
    const group = await database.catalogGroup.create({
      data: { code: `STOCK_GROUP_${suffix}`, name: 'Stock monitoring group' },
      select: { id: true },
    });
    groupId = group.id;
    const product = await database.product.create({
      data: {
        catalogGroupId: groupId,
        code: `STOCK_PRODUCT_${suffix}`,
        currency: 'GHS',
        lowStockThreshold: 2,
        name: 'Stock monitoring product',
        sellingPriceMinor: BigInt(2_500),
      },
      select: { id: true, publicId: true },
    });
    productId = product.id;
    productPublicId = product.publicId;
    await createActiveBatch(database, productId, suffix, 3);
    await database.stockMonitoringSweepState.deleteMany({ where: { id: 1 } });
  });

  afterEach(async () => {
    await database.outboxEvent.deleteMany({
      where: {
        dedupeKey: { startsWith: `stock-alert:${productId.toString()}:` },
      },
    });
    await database.stockAlert.deleteMany({ where: { productId } });
    await database.stockMonitoringState.deleteMany({ where: { productId } });
    await database.stockMonitoringSweepState.deleteMany({ where: { id: 1 } });
    const orderItems = await database.orderItem.findMany({
      where: { productId },
      select: { orderId: true },
    });
    const orderIds = orderItems.map((item) => item.orderId);
    await database.fulfilmentUnit.deleteMany({ where: { productId } });
    if (orderIds.length !== 0) {
      await database.paymentApplication.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await database.paymentAttempt.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await database.orderItem.deleteMany({ where: { productId } });
      await database.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    const batches = await database.voucherBatch.findMany({
      where: { productId },
      select: { id: true },
    });
    await database.voucher.deleteMany({ where: { productId } });
    await database.voucherBatch.deleteMany({
      where: { id: { in: batches.map((batch) => batch.id) } },
    });
    await database.product.delete({ where: { id: productId } });
    await database.catalogGroup.delete({ where: { id: groupId } });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('raises LOW and EMPTY once per depletion cycle, recovers, and publishes safe metrics', async () => {
    const service = new PrismaStockMonitoringService(database);

    await service.processAvailable(10);
    await sellAvailableVouchers(database, productId, 2);
    await service.processAvailable(10);
    await service.processAvailable(10);
    await sellAvailableVouchers(database, productId, 1);
    const oldestWaitingPaidAt = new Date(Date.now() - 5 * 60 * 1_000);
    await createWaitingPaidUnit(
      database,
      productId,
      productPublicId,
      oldestWaitingPaidAt,
    );
    await service.processAvailable(10);

    // A partial restock is still LOW within the existing depletion cycle; going
    // empty again must not emit a second urgent alert.
    await createActiveBatch(database, productId, 'partial', 1);
    await service.processAvailable(10);
    await sellAvailableVouchers(database, productId, 1);
    await service.processAvailable(10);

    await createActiveBatch(database, productId, 'healthy', 3);
    await service.processAvailable(10);
    await sellAvailableVouchers(database, productId, 1);
    await service.processAvailable(10);

    const alerts = await database.stockAlert.findMany({
      where: { productId },
      orderBy: { id: 'asc' },
      select: {
        availableStock: true,
        depletionCycle: true,
        oldestWaitingPaidAt: true,
        paidWaitingQuantity: true,
        soldToday: true,
        state: true,
      },
    });
    expect(alerts.map((alert) => [alert.depletionCycle, alert.state])).toEqual([
      [1, 'LOW'],
      [1, 'EMPTY'],
      [1, 'NORMAL'],
      [2, 'LOW'],
    ]);
    expect(alerts[1]).toMatchObject({
      availableStock: BigInt(0),
      oldestWaitingPaidAt,
      paidWaitingQuantity: BigInt(1),
    });

    const events = await database.outboxEvent.findMany({
      where: {
        dedupeKey: { startsWith: `stock-alert:${productId.toString()}:` },
      },
      orderBy: { id: 'asc' },
      select: { eventType: true, payload: true, publishedAt: true },
    });
    expect(events.map((event) => event.eventType)).toEqual([
      'StockLow',
      'StockEmpty',
      'StockRecovered',
      'StockLow',
    ]);
    expect(JSON.stringify(events)).toContain(productPublicId);
    expect(JSON.stringify(events)).not.toContain('test-encrypted-pin');

    const logger = {
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    } as unknown as StructuredLogger;
    const consumer = new StockAlertOutboxConsumer(database, logger, {
      leaseMs: 60_000,
      workerId: 'stock-monitoring-test',
    });
    await expect(consumer.processAvailable(10)).resolves.toBe(4);
    expect(
      await database.outboxEvent.count({
        where: {
          dedupeKey: { startsWith: `stock-alert:${productId.toString()}:` },
          publishedAt: { not: null },
        },
      }),
    ).toBe(4);
  });
});

async function createActiveBatch(
  database: DatabaseClient,
  productId: bigint,
  suffix: string,
  quantity: number,
): Promise<void> {
  const batch = await database.voucherBatch.create({
    data: {
      activatedAt: new Date(),
      importState: 'IMPORTED',
      productId,
      reference: `stock-batch-${suffix}-${randomBytes(4).toString('hex')}`,
      totalQuantity: quantity,
    },
    select: { id: true },
  });
  await database.voucher.createMany({
    data: Array.from({ length: quantity }, (_, index) => ({
      batchId: batch.id,
      encryptedPin: { value: 'test-encrypted-pin' },
      pinFingerprint: `stock-fingerprint-${suffix}-${index}-${randomBytes(4).toString('hex')}`,
      productId,
      serialNumber: `stock-serial-${suffix}-${index}-${randomBytes(4).toString('hex')}`,
    })),
  });
}

async function sellAvailableVouchers(
  database: DatabaseClient,
  productId: bigint,
  quantity: number,
): Promise<void> {
  const vouchers = await database.voucher.findMany({
    where: { productId, status: 'AVAILABLE' },
    orderBy: { id: 'asc' },
    take: quantity,
    select: { id: true },
  });
  expect(vouchers).toHaveLength(quantity);
  await database.voucher.updateMany({
    where: { id: { in: vouchers.map((voucher) => voucher.id) } },
    data: { soldAt: new Date(), status: 'SOLD' },
  });
}

async function createWaitingPaidUnit(
  database: DatabaseClient,
  productId: bigint,
  productPublicId: string,
  paidAt: Date,
): Promise<void> {
  const suffix = randomBytes(8).toString('hex');
  const order = await database.order.create({
    data: {
      currency: 'GHS',
      deliveryPreference: 'SMS_AND_EMAIL',
      email: `stock-${suffix}@example.com`,
      firstName: 'Stock',
      phoneNumber: '+233241234567',
      purchaseChannel: 'WEB',
      totalPriceMinor: BigInt(2_500),
      items: {
        create: {
          currency: 'GHS',
          productId,
          quantity: 1,
          totalPriceMinor: BigInt(2_500),
          unitPriceMinor: BigInt(2_500),
        },
      },
    },
    include: { items: true },
  });
  const attempt = await database.paymentAttempt.create({
    data: {
      currency: 'GHS',
      expectedAmountMinor: BigInt(2_500),
      orderId: order.id,
      paidAt,
      provider: 'PAYSTACK',
      providerReference: `STOCK_PAY_${suffix}`,
      providerStatus: 'success',
      providerTransactionId: `STOCK_TX_${suffix}`,
      status: 'SUCCEEDED',
      verifiedAt: paidAt,
    },
  });
  const application = await database.paymentApplication.create({
    data: {
      appliedAt: paidAt,
      orderId: order.id,
      paymentAttemptId: attempt.id,
    },
  });
  await database.fulfilmentUnit.create({
    data: {
      orderItemId: order.items[0].id,
      orderPublicReference: order.publicReference,
      ordinal: 1,
      paidAt,
      paymentApplicationId: application.id,
      productId,
      productPublicId,
    },
  });
}
