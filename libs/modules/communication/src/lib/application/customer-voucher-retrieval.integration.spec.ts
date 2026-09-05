import { randomUUID } from 'node:crypto';
import { createPrismaClient, type DatabaseClient } from '@edu-api/database';
import {
  PrismaCustomerVoucherRetrieval,
  CustomerVoucherRetrievalConflictError,
} from './customer-voucher-retrieval';

const databaseUrl = process.env.COMMUNICATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('Customer voucher retrieval idempotency (PostgreSQL)', () => {
  let database: DatabaseClient;
  let orderId: bigint;
  let key: string;
  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
  });
  beforeEach(async () => {
    key = `retrieval-test-${randomUUID()}`;
    const order = await database.order.create({
      data: {
        purchaseChannel: 'WEB',
        deliveryPreference: 'SMS_AND_EMAIL',
        phoneNumber: '+233244123456',
        email: 'stored@example.test',
        totalPriceMinor: BigInt(1500),
        currency: 'GHS',
      },
    });
    orderId = order.id;
  });
  afterEach(async () => {
    await database.voucherRetrievalEmailDelivery.deleteMany({
      where: { orderId },
    });
    await database.idempotencyRecord.deleteMany({
      where: { scope: 'customer-voucher-retrieval', key },
    });
    await database.order.delete({ where: { id: orderId } });
  });
  afterAll(async () => {
    await database.$disconnect();
  });

  it('converges concurrent requests on one durable obligation and rejects a changed destination', async () => {
    const writer = new PrismaCustomerVoucherRetrieval(
      database,
      Buffer.alloc(32, 42),
    );
    const input = {
      orderId,
      destinationEmail: 'stored@example.test',
      idempotencyKey: key,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => writer.request(input)),
    );
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    for (const result of results) {
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(
          CustomerVoucherRetrievalConflictError,
        );
    }
    const first = await writer.request(input);
    expect(await writer.request(input)).toEqual(first);
    expect(
      await database.voucherRetrievalEmailDelivery.count({
        where: { orderId },
      }),
    ).toBe(1);
    await expect(
      writer.request({ ...input, destinationEmail: 'changed@example.test' }),
    ).rejects.toBeInstanceOf(CustomerVoucherRetrievalConflictError);
    const record =
      await database.voucherRetrievalEmailDelivery.findUniqueOrThrow({
        where: { publicId: first.deliveryPublicId },
      });
    expect(record.destinationEmail).toBe(input.destinationEmail);
    expect(record.state).toBe('PENDING');
  });
});
