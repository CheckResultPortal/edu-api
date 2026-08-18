import { randomUUID } from 'node:crypto';

import { PrismaTransactionalFulfilmentUnitWriter } from '@edu-api/fulfilment';
import { PrismaPaymentOrderQuery } from '@edu-api/orders';
import { createPrismaClient, type DatabaseClient } from '@edu-api/database';

import { PrismaPaymentSuccessRepository } from './prisma-payment-success.repository';

const databaseUrl = process.env.PAYMENTS_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('verified payment effects (PostgreSQL)', () => {
  let database: DatabaseClient;
  let groupId: bigint;
  let orderId: bigint;
  let orderItemId: bigint;
  let productId: bigint;
  let repository: PrismaPaymentSuccessRepository;

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
    repository = new PrismaPaymentSuccessRepository(
      database,
      new PrismaPaymentOrderQuery(),
      new PrismaTransactionalFulfilmentUnitWriter(),
    );
  });

  beforeEach(async () => {
    const suffix = randomUUID().replace(/-/g, '').toUpperCase();
    const group = await database.catalogGroup.create({
      data: { code: `PAYMENT_${suffix}`, name: 'Payment integration' },
      select: { id: true },
    });
    groupId = group.id;
    const product = await database.product.create({
      data: {
        catalogGroupId: group.id,
        code: `PAYMENT_PRODUCT_${suffix}`,
        currency: 'GHS',
        lowStockThreshold: 1,
        name: 'Payment voucher',
        sellingPriceMinor: BigInt(2_500),
      },
      select: { id: true },
    });
    productId = product.id;
    const order = await database.order.create({
      data: {
        currency: 'GHS',
        deliveryPreference: 'SMS_AND_EMAIL',
        email: 'buyer@example.com',
        firstName: 'Ama',
        phoneNumber: '+233241234567',
        purchaseChannel: 'WEB',
        totalPriceMinor: BigInt(7_500),
        items: {
          create: {
            currency: 'GHS',
            productId,
            quantity: 3,
            totalPriceMinor: BigInt(7_500),
            unitPriceMinor: BigInt(2_500),
          },
        },
      },
      select: {
        id: true,
        items: { select: { id: true } },
      },
    });
    orderId = order.id;
    orderItemId = order.items[0].id;
  });

  afterEach(async () => {
    const payments = await database.paymentAttempt.findMany({
      where: { orderId },
      select: { id: true },
    });
    const paymentIds = payments.map((payment) => payment.id);
    await database.outboxEvent.deleteMany({
      where: {
        aggregateType: 'PaymentAttempt',
        aggregateId: { in: paymentIds },
      },
    });
    await database.paymentProviderEvent.deleteMany({
      where: { paymentAttemptId: { in: paymentIds } },
    });
    await database.fulfilmentUnit.deleteMany({ where: { orderItemId } });
    await database.paymentApplication.deleteMany({ where: { orderId } });
    await database.paymentAttempt.deleteMany({ where: { orderId } });
    await database.orderItem.deleteMany({ where: { orderId } });
    await database.order.delete({ where: { id: orderId } });
    await database.product.delete({ where: { id: productId } });
    await database.catalogGroup.delete({ where: { id: groupId } });
  });

  afterAll(async () => database.$disconnect());

  it('creates one payment application, N units, and one event across 1,000 duplicate callbacks', async () => {
    const payment = await createAttempt('storm');
    const input = successfulInput(payment.providerReference, '100001', 'a');

    const outcomes = await Promise.all(
      Array.from({ length: 1_000 }, () =>
        repository.recordVerifiedSuccess(input),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'APPLIED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'DUPLICATE')).toHaveLength(
      999,
    );
    await expect(
      database.paymentApplication.count({ where: { orderId } }),
    ).resolves.toBe(1);
    await expect(
      database.fulfilmentUnit.count({ where: { orderItemId } }),
    ).resolves.toBe(3);
    await expect(
      database.paymentProviderEvent.count({
        where: { paymentAttemptId: payment.id },
      }),
    ).resolves.toBe(1);
    await expect(
      database.outboxEvent.count({
        where: {
          aggregateId: payment.id,
          aggregateType: 'PaymentAttempt',
          eventType: 'PaymentSucceeded',
        },
      }),
    ).resolves.toBe(1);

    const units = await database.fulfilmentUnit.findMany({
      where: { orderItemId },
      orderBy: { ordinal: 'asc' },
      select: { allocatedAt: true, ordinal: true },
    });
    expect(units).toEqual([
      { allocatedAt: null, ordinal: 1 },
      { allocatedAt: null, ordinal: 2 },
      { allocatedAt: null, ordinal: 3 },
    ]);
  }, 120_000);

  it('rejects an authenticated amount mismatch without success effects', async () => {
    const payment = await createAttempt('mismatch');
    const input = successfulInput(payment.providerReference, '100002', 'b');

    await expect(
      repository.recordVerifiedSuccess({
        ...input,
        success: { ...input.success, amountMinor: BigInt(1) },
      }),
    ).resolves.toBe('REJECTED');
    await expect(
      database.paymentApplication.count({ where: { orderId } }),
    ).resolves.toBe(0);
    await expect(
      database.fulfilmentUnit.count({ where: { orderItemId } }),
    ).resolves.toBe(0);
    await expect(
      database.paymentProviderEvent.findFirstOrThrow({
        where: { paymentAttemptId: payment.id },
        select: { outcome: true, rejectionReason: true },
      }),
    ).resolves.toEqual({
      outcome: 'REJECTED',
      rejectionReason: 'AMOUNT_MISMATCH',
    });
  });

  it('keeps a second genuine success for reconciliation without duplicating units', async () => {
    const first = await createAttempt('first');
    const second = await createAttempt('second');

    const outcomes = await Promise.all([
      repository.recordVerifiedSuccess(
        successfulInput(first.providerReference, '100003', 'c'),
      ),
      repository.recordVerifiedSuccess(
        successfulInput(second.providerReference, '100004', 'd'),
      ),
    ]);

    expect(new Set(outcomes)).toEqual(
      new Set(['APPLIED', 'ADDITIONAL_SUCCESS']),
    );
    await expect(
      database.paymentApplication.count({ where: { orderId } }),
    ).resolves.toBe(1);
    await expect(
      database.fulfilmentUnit.count({ where: { orderItemId } }),
    ).resolves.toBe(3);
    await expect(
      database.paymentAttempt.count({
        where: {
          orderId,
          status: 'SUCCEEDED',
          attentionReason: 'ADDITIONAL_SUCCESS',
        },
      }),
    ).resolves.toBe(1);
    await expect(
      database.outboxEvent.count({
        where: {
          aggregateType: 'PaymentAttempt',
          aggregateId: { in: [first.id, second.id] },
        },
      }),
    ).resolves.toBe(2);
  });

  async function createAttempt(label: string) {
    return database.paymentAttempt.create({
      data: {
        currency: 'GHS',
        expectedAmountMinor: BigInt(7_500),
        nextVerificationAt: new Date(Date.now() + 60_000),
        orderId,
        provider: 'PAYSTACK',
        providerReference: `EDU-${label}-${randomUUID()}`,
        status: 'PENDING',
      },
      select: { id: true, providerReference: true },
    });
  }

  function successfulInput(
    providerReference: string,
    providerTransactionId: string,
    fingerprintCharacter: string,
  ) {
    return {
      provider: 'PAYSTACK',
      receipt: {
        eventType: 'charge.success',
        payloadFingerprint: fingerprintCharacter.repeat(64),
      },
      success: {
        amountMinor: BigInt(7_500),
        currency: 'GHS',
        paidAt: new Date('2026-08-18T12:00:00.000Z'),
        providerReference,
        providerStatus: 'success',
        providerTransactionId,
      },
    } as const;
  }
});
