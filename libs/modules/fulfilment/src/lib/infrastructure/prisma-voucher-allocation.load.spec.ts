import { randomBytes, randomUUID } from 'node:crypto';

import { createPrismaClient, type DatabaseClient } from '@edu-api/database';
import { PrismaTransactionalVoucherClaimer } from '@edu-api/voucher-inventory';

import { DefaultVoucherAllocationService } from '../application/voucher-allocation-service';
import { PrismaVoucherAllocationRepository } from './prisma-voucher-allocation.repository';

const loadTestDatabaseUrl = process.env.FULFILMENT_LOAD_TEST_DATABASE_URL;
const loadTestsEnabled =
  process.env.RUN_FULFILMENT_LOAD_TESTS === 'true' &&
  loadTestDatabaseUrl !== undefined;
const describeLoadTest = loadTestsEnabled ? describe : describe.skip;
if (loadTestsEnabled) jest.setTimeout(10 * 60_000);

describeLoadTest('voucher allocation load certification (PostgreSQL)', () => {
  const orderCount = 500;
  const unitsPerOrder = 20;
  const totalVoucherCount = orderCount * unitsPerOrder;
  const workerCount = 20;

  let database: DatabaseClient;
  let allocationService: DefaultVoucherAllocationService;
  let catalogGroupId: bigint | undefined;
  let productId: bigint | undefined;

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: loadTestDatabaseUrl });
    allocationService = new DefaultVoucherAllocationService(
      new PrismaVoucherAllocationRepository(
        new PrismaTransactionalVoucherClaimer(),
      ),
    );

    const fixture = await seedLoadFixture(database, {
      orderCount,
      unitsPerOrder,
    });
    catalogGroupId = fixture.catalogGroupId;
    productId = fixture.productId;
  });

  afterAll(async () => {
    if (database !== undefined) {
      if (catalogGroupId !== undefined && productId !== undefined) {
        await cleanupLoadFixture(database, catalogGroupId, productId);
      }
      await database.$disconnect();
    }
  });

  it('allocates 10,000 vouchers with 20 concurrent bounded workers', async () => {
    const testedProductId = requireFixtureId(productId);
    const allocatedCounts = await Promise.all(
      Array.from({ length: workerCount }, () =>
        allocateUntilNoWorkRemains(
          database,
          allocationService,
          testedProductId,
        ),
      ),
    );

    expect(allocatedCounts.reduce((total, count) => total + count, 0)).toBe(
      totalVoucherCount,
    );
    await expect(
      database.voucherAllocation.count({
        where: { productId: testedProductId },
      }),
    ).resolves.toBe(totalVoucherCount);
    await expect(
      database.voucher.count({
        where: { productId: testedProductId, status: 'SOLD' },
      }),
    ).resolves.toBe(totalVoucherCount);
    await expect(
      database.fulfilmentUnit.count({
        where: { allocatedAt: null, productId: testedProductId },
      }),
    ).resolves.toBe(0);
  });
});

async function allocateUntilNoWorkRemains(
  database: DatabaseClient,
  allocationService: DefaultVoucherAllocationService,
  productId: bigint,
): Promise<number> {
  let allocatedCount = 0;

  while (true) {
    const cycle = await database.$transaction(
      (transaction) =>
        allocationService.allocateWaitingUnitsForProduct(
          transaction,
          productId,
          20,
        ),
      { maxWait: 30_000, timeout: 30_000 },
    );
    allocatedCount += cycle.allocatedCount;

    if (cycle.examinedCount === 0 || cycle.stoppedForZeroStock) {
      return allocatedCount;
    }
  }
}

async function seedLoadFixture(
  database: DatabaseClient,
  input: { orderCount: number; unitsPerOrder: number },
): Promise<{ catalogGroupId: bigint; productId: bigint }> {
  const fixtureSuffix = compactUuid();
  const catalogGroup = await database.catalogGroup.create({
    data: {
      code: `LOAD_GROUP_${fixtureSuffix}`,
      name: 'Voucher allocation load test',
    },
  });
  const product = await database.product.create({
    data: {
      catalogGroupId: catalogGroup.id,
      code: `LOAD_PRODUCT_${fixtureSuffix}`,
      currency: 'GHS',
      lowStockThreshold: 100,
      name: 'Voucher allocation load product',
      sellingPriceMinor: BigInt(2_500),
    },
  });
  const voucherBatch = await database.voucherBatch.create({
    data: {
      activatedAt: new Date(),
      importState: 'IMPORTED',
      productId: product.id,
      reference: `load_batch_${fixtureSuffix}`,
      totalQuantity: input.orderCount * input.unitsPerOrder,
    },
  });

  const orderReferences = Array.from({ length: input.orderCount }, () =>
    randomUUID(),
  );
  await database.order.createMany({
    data: orderReferences.map((publicReference) => ({
      currency: 'GHS',
      deliveryPreference: 'SMS_AND_EMAIL' as const,
      email: 'load-test@example.com',
      phoneNumber: '+233241234567',
      publicReference,
      purchaseChannel: 'WEB' as const,
      totalPriceMinor: BigInt(2_500 * input.unitsPerOrder),
    })),
  });
  const orders = await database.order.findMany({
    where: { publicReference: { in: orderReferences } },
    select: { id: true, publicReference: true },
  });

  await database.orderItem.createMany({
    data: orders.map((order) => ({
      currency: 'GHS',
      orderId: order.id,
      productId: product.id,
      quantity: input.unitsPerOrder,
      totalPriceMinor: BigInt(2_500 * input.unitsPerOrder),
      unitPriceMinor: BigInt(2_500),
    })),
  });
  const orderItems = await database.orderItem.findMany({
    where: { orderId: { in: orders.map((order) => order.id) } },
    select: { id: true, orderId: true },
  });

  const paidAtByOrderId = new Map<bigint, Date>();
  await database.paymentAttempt.createMany({
    data: orders.map((order, orderIndex) => {
      const paidAt = new Date(Date.UTC(2026, 7, 19, 0, 0, 0, orderIndex));
      paidAtByOrderId.set(order.id, paidAt);
      return {
        currency: 'GHS',
        expectedAmountMinor: BigInt(2_500 * input.unitsPerOrder),
        orderId: order.id,
        paidAt,
        provider: 'PAYSTACK',
        providerReference: `LOAD_PAY_${fixtureSuffix}_${orderIndex}`,
        providerStatus: 'success',
        providerTransactionId: `LOAD_TRANSACTION_${fixtureSuffix}_${orderIndex}`,
        status: 'SUCCEEDED' as const,
        verifiedAt: paidAt,
      };
    }),
  });
  const paymentAttempts = await database.paymentAttempt.findMany({
    where: { orderId: { in: orders.map((order) => order.id) } },
    select: { id: true, orderId: true },
  });

  const paymentAttemptByOrderId = new Map(
    paymentAttempts.map((paymentAttempt) => [
      paymentAttempt.orderId,
      paymentAttempt,
    ]),
  );
  await database.paymentApplication.createMany({
    data: orders.map((order) => ({
      appliedAt: requireMapValue(paidAtByOrderId, order.id),
      orderId: order.id,
      paymentAttemptId: requireMapValue(paymentAttemptByOrderId, order.id).id,
    })),
  });
  const paymentApplications = await database.paymentApplication.findMany({
    where: { orderId: { in: orders.map((order) => order.id) } },
    select: { id: true, orderId: true },
  });

  const orderById = new Map(orders.map((order) => [order.id, order]));
  const paymentApplicationByOrderId = new Map(
    paymentApplications.map((application) => [
      application.orderId,
      application,
    ]),
  );
  const fulfilmentUnits = orderItems.flatMap((orderItem) => {
    const order = requireMapValue(orderById, orderItem.orderId);
    const paymentApplication = requireMapValue(
      paymentApplicationByOrderId,
      orderItem.orderId,
    );
    const paidAt = requireMapValue(paidAtByOrderId, orderItem.orderId);
    return Array.from({ length: input.unitsPerOrder }, (_, unitIndex) => ({
      orderItemId: orderItem.id,
      orderPublicReference: order.publicReference,
      ordinal: unitIndex + 1,
      paidAt,
      paymentApplicationId: paymentApplication.id,
      productId: product.id,
      productPublicId: product.publicId,
      publicReference: randomUUID(),
    }));
  });
  for (let offset = 0; offset < fulfilmentUnits.length; offset += 1_000) {
    await database.fulfilmentUnit.createMany({
      data: fulfilmentUnits.slice(offset, offset + 1_000),
    });
  }

  const vouchers = Array.from(
    { length: input.orderCount * input.unitsPerOrder },
    (_, voucherIndex) => ({
      batchId: voucherBatch.id,
      encryptedPin: { ciphertext: 'load-test-encrypted-pin' },
      pinFingerprint: randomBytes(32).toString('base64url'),
      productId: product.id,
      publicId: randomUUID(),
      serialNumber: `LOAD_${fixtureSuffix}_${voucherIndex}`,
      status: 'AVAILABLE' as const,
    }),
  );
  for (let offset = 0; offset < vouchers.length; offset += 1_000) {
    await database.voucher.createMany({
      data: vouchers.slice(offset, offset + 1_000),
    });
  }

  return { catalogGroupId: catalogGroup.id, productId: product.id };
}

async function cleanupLoadFixture(
  database: DatabaseClient,
  catalogGroupId: bigint,
  productId: bigint,
): Promise<void> {
  const fulfilmentUnits = await database.fulfilmentUnit.findMany({
    where: { productId },
    select: { id: true },
  });
  for (let offset = 0; offset < fulfilmentUnits.length; offset += 1_000) {
    await database.outboxEvent.deleteMany({
      where: {
        aggregateId: {
          in: fulfilmentUnits
            .slice(offset, offset + 1_000)
            .map((unit) => unit.id),
        },
        aggregateType: 'FulfilmentUnit',
      },
    });
  }
  const orderItems = await database.orderItem.findMany({
    where: { productId },
    select: { id: true, orderId: true },
  });
  const orderIds = orderItems.map((orderItem) => orderItem.orderId);

  await database.voucherAllocation.deleteMany({ where: { productId } });
  await database.voucher.deleteMany({ where: { productId } });
  await database.voucherBatch.deleteMany({ where: { productId } });
  await database.fulfilmentUnit.deleteMany({ where: { productId } });
  await database.paymentApplication.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await database.paymentAttempt.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await database.orderItem.deleteMany({ where: { productId } });
  await database.order.deleteMany({ where: { id: { in: orderIds } } });
  await database.product.delete({ where: { id: productId } });
  await database.catalogGroup.delete({ where: { id: catalogGroupId } });
}

function requireMapValue<TKey, TValue>(
  values: ReadonlyMap<TKey, TValue>,
  key: TKey,
): TValue {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error('Load fixture relationship is incomplete.');
  }
  return value;
}

function compactUuid(): string {
  return randomUUID().replace(/-/g, '').toUpperCase();
}

function requireFixtureId(value: bigint | undefined): bigint {
  if (value === undefined) {
    throw new Error('Load fixture was not initialized.');
  }
  return value;
}
