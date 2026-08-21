import { randomBytes, randomUUID } from 'node:crypto';

import { createPrismaClient, type DatabaseClient } from '@edu-api/database';
import { PrismaTransactionalVoucherClaimer } from '@edu-api/voucher-inventory';

import { DefaultVoucherAllocationService } from '../application/voucher-allocation-service';
import { PaymentSucceededAllocationHandler } from './payment-succeeded-allocation.handler';
import { PaymentSucceededOutboxConsumer } from './payment-succeeded-outbox-consumer';
import { PrismaVoucherAllocationRepository } from './prisma-voucher-allocation.repository';
import { VoucherStockAddedAllocationHandler } from './voucher-stock-added-allocation.handler';
import { VoucherStockAddedOutboxConsumer } from './voucher-stock-added-outbox-consumer';

const databaseUrl = process.env.FULFILMENT_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('voucher allocation effects (PostgreSQL)', () => {
  let database: DatabaseClient;
  let repository: PrismaVoucherAllocationRepository;
  let allocationService: DefaultVoucherAllocationService;
  let groupId: bigint;
  let productId: bigint;
  let productPublicId: string;
  let orderPublicReference: string;
  let orderItemId: bigint;
  let paymentApplicationId: bigint;
  let paymentAttemptId: bigint;
  let batchId: bigint;
  let batchPublicId: string;
  let manualOutboxIds: bigint[];

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
    repository = new PrismaVoucherAllocationRepository(
      new PrismaTransactionalVoucherClaimer(),
    );
    allocationService = new DefaultVoucherAllocationService(repository);
  });

  beforeEach(async () => {
    manualOutboxIds = [];
    const suffix = compactUuid();
    const group = await database.catalogGroup.create({
      data: { code: `ALLOC_GRP_${suffix}`, name: 'Allocation test group' },
      select: { id: true },
    });
    groupId = group.id;

    const product = await database.product.create({
      data: {
        catalogGroupId: group.id,
        code: `ALLOC_PROD_${suffix}`,
        currency: 'GHS',
        lowStockThreshold: 1,
        name: 'Allocation test product',
        sellingPriceMinor: BigInt(2_500),
      },
      select: { id: true, publicId: true },
    });
    productId = product.id;
    productPublicId = product.publicId;

    const obligation = await createPaidObligation({
      database,
      paidAt: new Date('2026-08-19T00:00:00.000Z'),
      productId,
      productPublicId,
      createUnit: false,
      suffix: `BASE_${suffix}`,
    });
    orderPublicReference = obligation.orderPublicReference;
    orderItemId = obligation.orderItemId;
    paymentApplicationId = obligation.paymentApplicationId;
    paymentAttemptId = obligation.paymentAttemptId;

    const batch = await database.voucherBatch.create({
      data: {
        activatedAt: new Date(),
        importState: 'IMPORTED',
        productId,
        reference: `batch_${suffix}`,
        totalQuantity: 20,
      },
      select: { id: true, publicId: true },
    });
    batchId = batch.id;
    batchPublicId = batch.publicId;
  });

  afterEach(async () => {
    await cleanupFixture(database, groupId, manualOutboxIds);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('atomically allocates an eligible voucher with product constraints and a private outbox payload', async () => {
    const voucher = await createVoucher(database, {
      batchId,
      productId,
      serialPrefix: 'ATOMIC',
    });
    const unit = await createWaitingUnit(database, {
      orderItemId,
      orderPublicReference,
      paidAt: new Date('2026-08-19T00:00:01.000Z'),
      paymentApplicationId,
      productId,
      productPublicId,
    });

    const result = await allocateNextWaitingUnit(
      database,
      repository,
      productId,
    );

    expect(result.outcome).toBe('ALLOCATED');
    const [updatedVoucher, updatedUnit, allocation] = await Promise.all([
      database.voucher.findUniqueOrThrow({ where: { id: voucher.id } }),
      database.fulfilmentUnit.findUniqueOrThrow({ where: { id: unit.id } }),
      database.voucherAllocation.findUniqueOrThrow({
        where: { fulfilmentUnitId: unit.id },
      }),
    ]);
    expect(updatedVoucher.status).toBe('SOLD');
    expect(updatedVoucher.soldAt).toBeInstanceOf(Date);
    expect(updatedUnit.allocatedAt).toBeInstanceOf(Date);
    expect(allocation).toMatchObject({ productId, voucherId: voucher.id });

    const outbox = await database.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: unit.id,
        aggregateType: 'FulfilmentUnit',
        eventType: 'VoucherAllocated',
      },
    });
    const serializedPayload = JSON.stringify(outbox.payload);
    expect(serializedPayload).not.toContain('test-encrypted-pin');
    expect(serializedPayload).not.toContain('buyer@example.com');
    expect(serializedPayload).not.toContain('+233241234567');
  });

  it('allows 100 concurrent workers to produce exactly one winner for one voucher', async () => {
    await createVoucher(database, {
      batchId,
      productId,
      serialPrefix: 'CONCURRENT',
    });

    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        createPaidObligation({
          database,
          paidAt: new Date(Date.UTC(2026, 7, 19, 1, 0, 0, index)),
          productId,
          productPublicId,
          suffix: `CONCURRENT_${index}_${compactUuid()}`,
        }),
      ),
    );

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        allocateNextWaitingUnit(database, repository, productId),
      ),
    );
    expect(
      results.filter((result) => result.outcome === 'ALLOCATED'),
    ).toHaveLength(1);
    await expect(
      database.voucherAllocation.count({ where: { productId } }),
    ).resolves.toBe(1);
    await expect(
      database.fulfilmentUnit.count({
        where: { allocatedAt: { not: null }, productId },
      }),
    ).resolves.toBe(1);
  });

  it('allocates the oldest waiting obligations first for a partial stock set', async () => {
    await Promise.all([
      createVoucher(database, {
        batchId,
        productId,
        serialPrefix: 'FIFO_1',
      }),
      createVoucher(database, {
        batchId,
        productId,
        serialPrefix: 'FIFO_2',
      }),
    ]);

    const units = await Promise.all(
      [3, 1, 2].map((second, index) =>
        createWaitingUnit(database, {
          orderItemId,
          orderPublicReference,
          ordinal: index + 1,
          paidAt: new Date(`2026-08-19T00:00:0${second}.000Z`),
          paymentApplicationId,
          productId,
          productPublicId,
        }),
      ),
    );

    await expect(
      database.$transaction((transaction) =>
        allocationService.allocateWaitingUnitsForProduct(
          transaction,
          productId,
          3,
        ),
      ),
    ).resolves.toEqual({
      allocatedCount: 2,
      examinedCount: 3,
      stoppedForZeroStock: true,
    });

    const ordered = await database.fulfilmentUnit.findMany({
      where: { id: { in: units.map((unit) => unit.id) } },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      select: { allocatedAt: true },
    });
    expect(ordered.map((unit) => unit.allocatedAt !== null)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('stops after one allocation transaction when stock is empty', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createWaitingUnit(database, {
          orderItemId,
          orderPublicReference,
          ordinal: index + 1,
          paidAt: new Date(Date.UTC(2026, 7, 19, 2, 0, 0, index)),
          paymentApplicationId,
          productId,
          productPublicId,
        }),
      ),
    );

    await expect(
      database.$transaction((transaction) =>
        allocationService.allocateWaitingUnitsForProduct(
          transaction,
          productId,
          500,
        ),
      ),
    ).resolves.toEqual({
      allocatedCount: 0,
      examinedCount: 1,
      stoppedForZeroStock: true,
    });
    await expect(
      database.fulfilmentUnit.count({
        where: { allocatedAt: null, productId },
      }),
    ).resolves.toBe(20);
  });

  it('skips expired and unactivated voucher batches', async () => {
    const [expiredBatch, unactivatedBatch] = await Promise.all([
      database.voucherBatch.create({
        data: {
          activatedAt: new Date(),
          importState: 'IMPORTED',
          productId,
          reference: `expired_${compactUuid()}`,
          totalQuantity: 1,
          validUntil: new Date(Date.now() - 60_000),
        },
      }),
      database.voucherBatch.create({
        data: {
          importState: 'IMPORTED',
          productId,
          reference: `unactivated_${compactUuid()}`,
          totalQuantity: 1,
        },
      }),
    ]);
    await Promise.all([
      createVoucher(database, {
        batchId: expiredBatch.id,
        productId,
        serialPrefix: 'EXPIRED',
      }),
      createVoucher(database, {
        batchId: unactivatedBatch.id,
        productId,
        serialPrefix: 'UNACTIVATED',
      }),
      createWaitingUnit(database, {
        orderItemId,
        orderPublicReference,
        paidAt: new Date(),
        paymentApplicationId,
        productId,
        productPublicId,
      }),
    ]);

    await expect(
      allocateNextWaitingUnit(database, repository, productId),
    ).resolves.toMatchObject({ outcome: 'ZERO_STOCK' });
  });

  it('rejects a cross-product voucher allocation at the database boundary', async () => {
    const secondProduct = await database.product.create({
      data: {
        catalogGroupId: groupId,
        code: `OTHER_${compactUuid()}`,
        currency: 'GHS',
        name: 'Other product',
        sellingPriceMinor: BigInt(3_000),
      },
    });
    const secondBatch = await database.voucherBatch.create({
      data: {
        activatedAt: new Date(),
        importState: 'IMPORTED',
        productId: secondProduct.id,
        reference: `other_batch_${compactUuid()}`,
        totalQuantity: 1,
      },
    });
    const secondVoucher = await createVoucher(database, {
      batchId: secondBatch.id,
      productId: secondProduct.id,
      serialPrefix: 'OTHER',
    });
    const unit = await createWaitingUnit(database, {
      orderItemId,
      orderPublicReference,
      paidAt: new Date(),
      paymentApplicationId,
      productId,
      productPublicId,
    });

    await expect(
      database.voucherAllocation.create({
        data: {
          fulfilmentUnitId: unit.id,
          productId,
          voucherId: secondVoucher.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('consumes one PaymentSucceeded event exactly once and publishes it', async () => {
    await createVoucher(database, {
      batchId,
      productId,
      serialPrefix: 'OUTBOX',
    });
    const unit = await createWaitingUnit(database, {
      orderItemId,
      orderPublicReference,
      paidAt: new Date(),
      paymentApplicationId,
      productId,
      productPublicId,
    });
    const event = await createPaymentSucceededEvent(database, {
      aggregateId: paymentAttemptId,
      orderPublicReference,
      quantity: 1,
    });
    manualOutboxIds.push(event.id);
    const consumer = new PaymentSucceededOutboxConsumer(
      database,
      new PaymentSucceededAllocationHandler(allocationService),
      { workerId: 'allocation-test:success' },
    );

    await expect(consumer.processAvailable(10)).resolves.toBe(1);
    await expect(consumer.processAvailable(10)).resolves.toBe(0);
    const [updatedEvent, updatedUnit] = await Promise.all([
      database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
      database.fulfilmentUnit.findUniqueOrThrow({ where: { id: unit.id } }),
    ]);
    expect(updatedEvent.publishedAt).toBeInstanceOf(Date);
    expect(updatedEvent.lockedAt).toBeNull();
    expect(updatedUnit.allocatedAt).toBeInstanceOf(Date);
  });

  it('drains a bounded FIFO backlog from VoucherStockAdded and publishes the event', async () => {
    await Promise.all([
      createVoucher(database, {
        batchId,
        productId,
        serialPrefix: 'RESTOCK_1',
      }),
      createVoucher(database, {
        batchId,
        productId,
        serialPrefix: 'RESTOCK_2',
      }),
    ]);
    const units = await Promise.all(
      [3, 1, 2].map((second, index) =>
        createWaitingUnit(database, {
          orderItemId,
          orderPublicReference,
          ordinal: index + 1,
          paidAt: new Date(`2026-08-19T00:00:0${second}.000Z`),
          paymentApplicationId,
          productId,
          productPublicId,
        }),
      ),
    );
    const event = await createVoucherStockAddedEvent(database, {
      aggregateId: batchId,
      batchPublicId,
      productPublicId,
      quantity: 2,
    });
    manualOutboxIds.push(event.id);
    const consumer = new VoucherStockAddedOutboxConsumer(
      database,
      new VoucherStockAddedAllocationHandler(allocationService),
      250,
      { workerId: 'restock-test:stock-event' },
    );

    await expect(consumer.processAvailable(1)).resolves.toBe(1);
    const [updatedEvent, orderedUnits] = await Promise.all([
      database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
      database.fulfilmentUnit.findMany({
        where: { id: { in: units.map((unit) => unit.id) } },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        select: { allocatedAt: true },
      }),
    ]);
    expect(updatedEvent).toMatchObject({
      lockedAt: null,
      publishedAt: expect.any(Date),
    });
    expect(orderedUnits.map((unit) => unit.allocatedAt !== null)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('recovers waiting work without a VoucherStockAdded event', async () => {
    await createVoucher(database, {
      batchId,
      productId,
      serialPrefix: 'RECOVERY',
    });
    const unit = await createWaitingUnit(database, {
      orderItemId,
      orderPublicReference,
      paidAt: new Date(),
      paymentApplicationId,
      productId,
      productPublicId,
    });

    await expect(
      database.$transaction((transaction) =>
        allocationService.drainNextWaitingProduct(transaction, 250),
      ),
    ).resolves.toMatchObject({
      allocation: { allocatedCount: 1 },
      outcome: 'DRAINED',
      productPublicId,
    });
    await expect(
      database.fulfilmentUnit.findUniqueOrThrow({ where: { id: unit.id } }),
    ).resolves.toMatchObject({ allocatedAt: expect.any(Date) });
  });

  it('rolls back allocations when processing crashes before event completion', async () => {
    await Promise.all([
      createVoucher(database, {
        batchId,
        productId,
        serialPrefix: 'ROLLBACK_1',
      }),
      createVoucher(database, {
        batchId,
        productId,
        serialPrefix: 'ROLLBACK_2',
      }),
      createWaitingUnit(database, {
        orderItemId,
        orderPublicReference,
        paidAt: new Date('2026-08-19T00:00:00.000Z'),
        paymentApplicationId,
        productId,
        productPublicId,
      }),
      createPaidObligation({
        database,
        paidAt: new Date('2026-08-19T00:00:01.000Z'),
        productId,
        productPublicId,
        suffix: `ROLLBACK_WAITING_${compactUuid()}`,
      }),
    ]);
    const event = await createPaymentSucceededEvent(database, {
      aggregateId: paymentAttemptId,
      orderPublicReference,
      quantity: 1,
    });
    manualOutboxIds.push(event.id);

    const allocationHandler = new PaymentSucceededAllocationHandler(
      allocationService,
    );
    const crashAfterAllocationHandler = {
      handle: jest.fn(
        async (...parameters: Parameters<typeof allocationHandler.handle>) => {
          await allocationHandler.handle(...parameters);
          throw new Error('simulated crash before event completion');
        },
      ),
    } as unknown as PaymentSucceededAllocationHandler;
    const crashingConsumer = new PaymentSucceededOutboxConsumer(
      database,
      crashAfterAllocationHandler,
      {
        maximumRetryDelayMs: 1_000,
        retryBaseDelayMs: 1_000,
        workerId: 'allocation-test:crash',
      },
    );

    await expect(crashingConsumer.processAvailable(1)).resolves.toBe(1);
    await expect(
      database.voucherAllocation.count({ where: { productId } }),
    ).resolves.toBe(0);
    await expect(
      database.voucher.count({ where: { productId, status: 'SOLD' } }),
    ).resolves.toBe(0);

    await database.outboxEvent.update({
      where: { id: event.id },
      data: { availableAt: new Date(0) },
    });
    const recoveryConsumer = new PaymentSucceededOutboxConsumer(
      database,
      allocationHandler,
      { workerId: 'allocation-test:recovery' },
    );
    await expect(recoveryConsumer.processAvailable(1)).resolves.toBe(1);
    await expect(recoveryConsumer.processAvailable(1)).resolves.toBe(0);
    await expect(
      database.voucherAllocation.count({ where: { productId } }),
    ).resolves.toBe(1);
    await expect(
      database.voucher.count({ where: { productId, status: 'SOLD' } }),
    ).resolves.toBe(1);
  });

  it('moves a malformed PaymentSucceeded event directly to needs-attention', async () => {
    const event = await database.outboxEvent.create({
      data: {
        aggregateId: paymentAttemptId,
        aggregateType: 'PaymentAttempt',
        eventType: 'PaymentSucceeded',
        payload: { orderPublicReference },
      },
    });
    manualOutboxIds.push(event.id);
    const consumer = new PaymentSucceededOutboxConsumer(
      database,
      new PaymentSucceededAllocationHandler(allocationService),
      { workerId: 'allocation-test:invalid' },
    );

    await expect(consumer.processAvailable(1)).resolves.toBe(1);
    await expect(
      database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).resolves.toMatchObject({
      lastFailureCode: 'INVALID_PAYLOAD',
      lockedAt: null,
      needsAttentionAt: expect.any(Date),
      publishedAt: null,
    });
  });

  it('recovers a stale event lease before processing the event', async () => {
    const event = await database.outboxEvent.create({
      data: {
        aggregateId: paymentAttemptId,
        aggregateType: 'PaymentAttempt',
        attempts: 2,
        eventType: 'PaymentSucceeded',
        lockedAt: new Date(Date.now() - 60_000),
        lockOwner: 'stopped-worker',
        payload: { orderPublicReference },
      },
    });
    manualOutboxIds.push(event.id);
    const consumer = new PaymentSucceededOutboxConsumer(
      database,
      new PaymentSucceededAllocationHandler(allocationService),
      { leaseMs: 30_000, workerId: 'allocation-test:lease-recovery' },
    );

    await expect(consumer.processAvailable(1)).resolves.toBe(1);
    await expect(
      database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).resolves.toMatchObject({
      attempts: 3,
      lastFailureCode: 'INVALID_PAYLOAD',
      lockedAt: null,
      lockOwner: null,
      needsAttentionAt: expect.any(Date),
    });
  });

  it('releases a failed event with exponential retry timing and jitter', async () => {
    const event = await createPaymentSucceededEvent(database, {
      aggregateId: paymentAttemptId,
      orderPublicReference,
      quantity: 1,
    });
    manualOutboxIds.push(event.id);
    const failingHandler = {
      handle: jest.fn().mockRejectedValue(new Error('temporary failure')),
    } as unknown as PaymentSucceededAllocationHandler;
    const consumer = new PaymentSucceededOutboxConsumer(
      database,
      failingHandler,
      {
        maximumRetryDelayMs: 1_000,
        retryBaseDelayMs: 1_000,
        workerId: 'allocation-test:retry',
      },
    );
    const startedAt = Date.now();

    await expect(consumer.processAvailable(1)).resolves.toBe(1);
    const updated = await database.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(updated).toMatchObject({
      attempts: 1,
      lastFailureCode: 'PROCESSING_FAILED',
      lockedAt: null,
      needsAttentionAt: null,
      publishedAt: null,
    });
    expect(updated.availableAt.getTime()).toBeGreaterThanOrEqual(
      startedAt + 1_000,
    );
  });

  it('moves a repeatedly failing event to needs-attention at its limit', async () => {
    const event = await createPaymentSucceededEvent(database, {
      aggregateId: paymentAttemptId,
      orderPublicReference,
      quantity: 1,
    });
    manualOutboxIds.push(event.id);
    const failingHandler = {
      handle: jest.fn().mockRejectedValue(new Error('persistent failure')),
    } as unknown as PaymentSucceededAllocationHandler;
    const consumer = new PaymentSucceededOutboxConsumer(
      database,
      failingHandler,
      { maxAttempts: 1, workerId: 'allocation-test:max-attempts' },
    );

    await expect(consumer.processAvailable(1)).resolves.toBe(1);
    await expect(
      database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).resolves.toMatchObject({
      attempts: 1,
      lastFailureCode: 'MAX_ATTEMPTS_EXCEEDED',
      lockedAt: null,
      needsAttentionAt: expect.any(Date),
      publishedAt: null,
    });
  });
});

function allocateNextWaitingUnit(
  database: DatabaseClient,
  repository: PrismaVoucherAllocationRepository,
  productId: bigint,
) {
  return database.$transaction(
    (transaction) =>
      repository.allocateNextWaitingUnitForProduct(transaction, productId),
    { maxWait: 5_000, timeout: 10_000 },
  );
}

async function createPaidObligation(input: {
  createUnit?: boolean;
  database: DatabaseClient;
  paidAt: Date;
  productId: bigint;
  productPublicId: string;
  suffix: string;
}) {
  const order = await input.database.order.create({
    data: {
      currency: 'GHS',
      deliveryPreference: 'SMS_AND_EMAIL',
      email: 'buyer@example.com',
      firstName: 'Ama',
      phoneNumber: '+233241234567',
      purchaseChannel: 'WEB',
      totalPriceMinor: BigInt(2_500),
      items: {
        create: {
          currency: 'GHS',
          productId: input.productId,
          quantity: 1,
          totalPriceMinor: BigInt(2_500),
          unitPriceMinor: BigInt(2_500),
        },
      },
    },
    include: { items: true },
  });
  const attempt = await input.database.paymentAttempt.create({
    data: {
      currency: 'GHS',
      expectedAmountMinor: BigInt(2_500),
      orderId: order.id,
      paidAt: input.paidAt,
      provider: 'PAYSTACK',
      providerReference: `PAY_${input.suffix}`,
      providerStatus: 'success',
      providerTransactionId: `TX_${input.suffix}`,
      status: 'SUCCEEDED',
      verifiedAt: input.paidAt,
    },
  });
  const application = await input.database.paymentApplication.create({
    data: {
      appliedAt: input.paidAt,
      orderId: order.id,
      paymentAttemptId: attempt.id,
    },
  });
  const unit =
    input.createUnit === false
      ? null
      : await createWaitingUnit(input.database, {
          orderItemId: order.items[0].id,
          orderPublicReference: order.publicReference,
          paidAt: input.paidAt,
          paymentApplicationId: application.id,
          productId: input.productId,
          productPublicId: input.productPublicId,
        });
  return {
    orderItemId: order.items[0].id,
    orderPublicReference: order.publicReference,
    paymentApplicationId: application.id,
    paymentAttemptId: attempt.id,
    unit,
  };
}

function createWaitingUnit(
  database: DatabaseClient,
  input: {
    orderItemId: bigint;
    orderPublicReference: string;
    ordinal?: number;
    paidAt: Date;
    paymentApplicationId: bigint;
    productId: bigint;
    productPublicId: string;
  },
) {
  return database.fulfilmentUnit.create({
    data: {
      orderItemId: input.orderItemId,
      orderPublicReference: input.orderPublicReference,
      ordinal: input.ordinal ?? 1,
      paidAt: input.paidAt,
      paymentApplicationId: input.paymentApplicationId,
      productId: input.productId,
      productPublicId: input.productPublicId,
    },
  });
}

function createVoucher(
  database: DatabaseClient,
  input: { batchId: bigint; productId: bigint; serialPrefix: string },
) {
  return database.voucher.create({
    data: {
      batchId: input.batchId,
      encryptedPin: { ciphertext: 'test-encrypted-pin' },
      pinFingerprint: randomBytes(32).toString('base64url'),
      productId: input.productId,
      serialNumber: `${input.serialPrefix}_${randomUUID()}`,
      status: 'AVAILABLE',
    },
  });
}

async function createPaymentSucceededEvent(
  database: DatabaseClient,
  input: {
    aggregateId: bigint;
    orderPublicReference: string;
    quantity: number;
  },
) {
  return database.outboxEvent.create({
    data: {
      aggregateId: input.aggregateId,
      aggregateType: 'PaymentAttempt',
      eventType: 'PaymentSucceeded',
      payload: {
        amountMinor: '2500',
        currency: 'GHS',
        orderPublicReference: input.orderPublicReference,
        paidAt: '2026-08-19T00:00:00.000Z',
        paymentPublicReference: randomUUID(),
        providerReference: `PAY_${compactUuid()}`,
        quantity: input.quantity,
        version: 1,
      },
    },
  });
}

async function createVoucherStockAddedEvent(
  database: DatabaseClient,
  input: {
    aggregateId: bigint;
    batchPublicId: string;
    productPublicId: string;
    quantity: number;
  },
) {
  return database.outboxEvent.create({
    data: {
      aggregateId: input.aggregateId,
      aggregateType: 'VoucherBatch',
      eventType: 'VoucherStockAdded',
      payload: {
        batchPublicId: input.batchPublicId,
        productPublicId: input.productPublicId,
        quantity: input.quantity,
        version: 1,
      },
    },
  });
}

async function cleanupFixture(
  database: DatabaseClient,
  groupId: bigint,
  manualOutboxIds: readonly bigint[],
): Promise<void> {
  await database.fulfilmentBacklogSweepState.deleteMany();
  const products = await database.product.findMany({
    where: { catalogGroupId: groupId },
    select: { id: true },
  });
  const productIds = products.map((product) => product.id);
  const orderItems = await database.orderItem.findMany({
    where: { productId: { in: productIds } },
    select: { id: true, orderId: true },
  });
  const orderIds = [...new Set(orderItems.map((item) => item.orderId))];
  const attempts = await database.paymentAttempt.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true },
  });
  const units = await database.fulfilmentUnit.findMany({
    where: { productId: { in: productIds } },
    select: { id: true },
  });
  if (manualOutboxIds.length > 0) {
    await database.outboxEvent.deleteMany({
      where: { id: { in: [...manualOutboxIds] } },
    });
  }
  if (units.length > 0) {
    await database.outboxEvent.deleteMany({
      where: {
        aggregateId: { in: units.map((unit) => unit.id) },
        aggregateType: 'FulfilmentUnit',
      },
    });
  }
  if (attempts.length > 0) {
    await database.outboxEvent.deleteMany({
      where: {
        aggregateId: { in: attempts.map((attempt) => attempt.id) },
        aggregateType: 'PaymentAttempt',
      },
    });
  }
  await database.voucherAllocation.deleteMany({
    where: { productId: { in: productIds } },
  });
  await database.voucher.deleteMany({
    where: { productId: { in: productIds } },
  });
  await database.voucherBatch.deleteMany({
    where: { productId: { in: productIds } },
  });
  await database.fulfilmentUnit.deleteMany({
    where: { productId: { in: productIds } },
  });
  await database.paymentApplication.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await database.paymentAttempt.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await database.orderItem.deleteMany({
    where: { id: { in: orderItems.map((item) => item.id) } },
  });
  await database.order.deleteMany({ where: { id: { in: orderIds } } });
  await database.product.deleteMany({ where: { id: { in: productIds } } });
  await database.catalogGroup.delete({ where: { id: groupId } });
}

function compactUuid(): string {
  return randomUUID().replace(/-/g, '').toUpperCase();
}
