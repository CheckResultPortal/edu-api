import { randomUUID } from 'node:crypto';

import { PrismaPaymentOrderQuery } from '@edu-api/orders';
import { createPrismaClient, type DatabaseClient } from '@edu-api/database';

import {
  PaymentIdempotencyConflictError,
  PaymentProviderUnknownOutcomeError,
} from '../application/payment-errors';
import {
  DefaultPaymentInitializationService,
  type PaymentRateLimiter,
} from '../application/payment-initialization-service';
import {
  PaymentProviderRequestError,
  type PaymentProvider,
} from '../application/payment-provider';
import { PrismaPaymentInitializationRepository } from './prisma-payment-initialization.repository';

const databaseUrl = process.env.PAYMENTS_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('payment initialization (PostgreSQL)', () => {
  let database: DatabaseClient;
  let groupId: bigint;
  let orderId: bigint;
  let orderPublicReference: string;
  let productId: bigint;
  let suffix: string;

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
  });

  beforeEach(async () => {
    suffix = randomUUID().replace(/-/g, '').toUpperCase();
    const group = await database.catalogGroup.create({
      data: { code: `PAY_INIT_${suffix}`, name: 'Payment initialization' },
      select: { id: true },
    });
    groupId = group.id;
    const product = await database.product.create({
      data: {
        catalogGroupId: group.id,
        code: `PAY_INIT_PRODUCT_${suffix}`,
        currency: 'GHS',
        lowStockThreshold: 1,
        name: 'Payment initialization voucher',
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
        totalPriceMinor: BigInt(5_000),
        items: {
          create: {
            currency: 'GHS',
            productId,
            quantity: 2,
            totalPriceMinor: BigInt(5_000),
            unitPriceMinor: BigInt(2_500),
          },
        },
      },
      select: { id: true, publicReference: true },
    });
    orderId = order.id;
    orderPublicReference = order.publicReference;
  });

  afterEach(async () => {
    await database.idempotencyRecord.deleteMany({
      where: { scope: 'web-payment-initialize', key: { contains: suffix } },
    });
    await database.paymentProviderEvent.deleteMany({
      where: { paymentAttempt: { orderId } },
    });
    await database.fulfilmentUnit.deleteMany({
      where: { paymentApplication: { orderId } },
    });
    await database.paymentApplication.deleteMany({ where: { orderId } });
    await database.paymentAttempt.deleteMany({ where: { orderId } });
    await database.orderItem.deleteMany({ where: { orderId } });
    await database.order.delete({ where: { id: orderId } });
    await database.product.delete({ where: { id: productId } });
    await database.catalogGroup.delete({ where: { id: groupId } });
  });

  afterAll(async () => database.$disconnect());

  it('replays the original checkout and never calls Paystack twice', async () => {
    const provider = providerMock();
    const service = createService(provider);
    const command = {
      clientIp: '203.0.113.10',
      idempotencyKey: `payment:${suffix}:replay`,
      orderPublicReference,
    };

    const first = await service.initialize(command);
    const replay = await service.initialize(command);

    expect(replay).toEqual(first);
    expect(provider.initialize).toHaveBeenCalledTimes(1);
    await expect(
      database.paymentAttempt.count({ where: { orderId } }),
    ).resolves.toBe(1);
  });

  it('rejects reuse of the same key for another order reference', async () => {
    const service = createService(providerMock());
    const idempotencyKey = `payment:${suffix}:conflict`;
    await service.initialize({
      clientIp: '203.0.113.10',
      idempotencyKey,
      orderPublicReference,
    });

    await expect(
      service.initialize({
        clientIp: '203.0.113.10',
        idempotencyKey,
        orderPublicReference: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PaymentIdempotencyConflictError);
  });

  it('persists a provider timeout as UNKNOWN without paid effects', async () => {
    const provider = providerMock();
    provider.initialize = jest
      .fn()
      .mockRejectedValue(new PaymentProviderRequestError('UNKNOWN_OUTCOME'));

    await expect(
      createService(provider).initialize({
        clientIp: '203.0.113.10',
        idempotencyKey: `payment:${suffix}:timeout`,
        orderPublicReference,
      }),
    ).rejects.toBeInstanceOf(PaymentProviderUnknownOutcomeError);
    await expect(
      database.paymentAttempt.findFirstOrThrow({
        where: { orderId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'UNKNOWN' });
    await expect(
      database.paymentApplication.count({ where: { orderId } }),
    ).resolves.toBe(0);
  });

  it('never downgrades a verified success when initialization later times out', async () => {
    const provider = providerMock();
    provider.initialize = jest.fn(async (input) => {
      await database.paymentAttempt.update({
        where: {
          provider_providerReference: {
            provider: 'PAYSTACK',
            providerReference: input.providerReference,
          },
        },
        data: {
          nextVerificationAt: null,
          paidAt: new Date('2026-08-18T12:00:00.000Z'),
          providerStatus: 'success',
          providerTransactionId: '900001',
          status: 'SUCCEEDED',
          verifiedAt: new Date('2026-08-18T12:00:01.000Z'),
        },
      });
      throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
    });

    await expect(
      createService(provider).initialize({
        clientIp: '203.0.113.10',
        idempotencyKey: `payment:${suffix}:success-race`,
        orderPublicReference,
      }),
    ).rejects.toBeInstanceOf(PaymentProviderUnknownOutcomeError);
    await expect(
      database.paymentAttempt.findFirstOrThrow({
        where: { orderId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'SUCCEEDED' });
  });

  function createService(provider: PaymentProvider) {
    const repository = new PrismaPaymentInitializationRepository(
      database,
      new PrismaPaymentOrderQuery(),
    );
    const rateLimiter: PaymentRateLimiter = { consume: jest.fn() };
    return new DefaultPaymentInitializationService(
      repository,
      provider,
      rateLimiter,
      {
        callbackUrl: 'https://app.example.com/payment/callback',
        idempotencyTtlMs: 86_400_000,
        initialVerificationDelayMs: 120_000,
        privacyHmacKey: Buffer.alloc(32, 9),
      },
    );
  }
});

function providerMock(): PaymentProvider {
  return {
    authenticateWebhook: jest.fn(),
    code: 'PAYSTACK',
    initialize: jest.fn(async (input) => ({
      accessCode: 'access-value',
      authorizationUrl: 'https://checkout.paystack.com/access-value',
      providerReference: input.providerReference,
    })),
    verify: jest.fn(),
  };
}
