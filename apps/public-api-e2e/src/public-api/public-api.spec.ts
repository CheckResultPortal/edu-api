import { randomInt, randomUUID } from 'node:crypto';

import axios from 'axios';

import { createPrismaClient, type DatabaseClient } from '@edu-api/database';

let database: DatabaseClient;
let productId: bigint;
let productPublicId: string;
const e2eIdempotencyKeys: string[] = [];

beforeAll(async () => {
  database = await createPrismaClient({
    DATABASE_URL: process.env.DATABASE_URL,
  });
  const suffix = randomUUID().replace(/-/g, '').toUpperCase();
  const group = await database.catalogGroup.create({
    data: { code: `PUBLIC_E2E_${suffix}`, name: 'Public E2E', sortOrder: 0 },
    select: { id: true },
  });
  const product = await database.product.create({
    data: {
      catalogGroupId: group.id,
      code: `PUBLIC_E2E_PRODUCT_${suffix}`,
      currency: 'GHS',
      lowStockThreshold: 0,
      name: 'Public E2E voucher',
      sellingPriceMinor: BigInt(2_500),
    },
    select: { id: true, publicId: true },
  });
  productId = product.id;
  productPublicId = product.publicId;
}, 30_000);

afterAll(async () => {
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
    where: { scope: 'guest-order-create', key: { in: e2eIdempotencyKeys } },
  });
  const product = await database.product.delete({
    where: { id: productId },
    select: { catalogGroupId: true },
  });
  await database.catalogGroup.delete({
    where: { id: product.catalogGroupId },
  });
  await database.$disconnect();
}, 30_000);

describe('public API', () => {
  it('returns the public API health response', async () => {
    const res = await axios.get('/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: {
        type: 'health-checks',
        id: 'public-api',
        attributes: { status: 'ok' },
      },
      meta: { correlationId: expect.any(String) },
    });
  });

  it('returns ready when PostgreSQL and Redis are available', async () => {
    const res = await axios.get('/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: {
        type: 'health-checks',
        id: 'public-api',
        attributes: { status: 'ok' },
      },
      meta: { correlationId: expect.any(String) },
    });
  });

  it('publishes the generated OpenAPI health contract', async () => {
    const res = await axios.get('/v1/openapi.json');

    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      openapi: '3.0.0',
      info: {
        title: 'public-api API',
        version: '1.0.0',
      },
    });
    expect(res.data.paths).toEqual(
      expect.objectContaining({
        '/v1/health/live': expect.objectContaining({ get: expect.any(Object) }),
        '/v1/health/ready': expect.objectContaining({
          get: expect.any(Object),
        }),
        '/v1/orders': expect.objectContaining({ post: expect.any(Object) }),
      }),
    );
    expect(
      res.data.paths['/v1/orders'].post.requestBody.content['application/json']
        .schema.required,
    ).toEqual([
      'email',
      'firstName',
      'phoneNumber',
      'productPublicId',
      'quantity',
    ]);
  });

  it('rejects a client-controlled price before order processing', async () => {
    await expect(
      axios.post(
        '/v1/orders',
        {
          email: 'buyer@example.com',
          firstName: 'Ama',
          phoneNumber: '+233241234567',
          price: 1,
          productPublicId: '2b3e39a9-06db-41a9-a856-5f985846951a',
          quantity: 1,
        },
        { headers: { 'Idempotency-Key': 'checkout:0123456789abcdef' } },
      ),
    ).rejects.toMatchObject({
      response: {
        status: 400,
        data: {
          errors: [expect.objectContaining({ code: 'INVALID_ORDER_REQUEST' })],
        },
      },
    });
  });

  it('creates and replays one authoritative guest order over HTTP', async () => {
    const idempotencyKey = randomUUID();
    e2eIdempotencyKeys.push(idempotencyKey);
    const phoneNumber = `+23324${String(randomInt(10_000_000)).padStart(7, '0')}`;
    const request = {
      email: 'Buyer@Example.com',
      firstName: 'Ama',
      phoneNumber,
      productPublicId,
      quantity: 2,
    };
    const first = await axios.post('/v1/orders', request, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    const replay = await axios.post('/v1/orders', request, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.data.data.id).toBe(first.data.data.id);
    expect(first.data).toMatchObject({
      data: {
        type: 'orders',
        id: expect.any(String),
        attributes: {
          currency: 'GHS',
          deliveryPreference: 'SMS_AND_EMAIL',
          productPublicId,
          purchaseChannel: 'WEB',
          quantity: 2,
          totalPriceMinor: '5000',
          unitPriceMinor: '2500',
        },
      },
      meta: { correlationId: expect.any(String) },
    });
  });

  it('rejects unsupported deliveryPreference property on web request', async () => {
    await expect(
      axios.post(
        '/v1/orders',
        {
          deliveryPreference: 'SMS_ONLY',
          email: 'buyer@example.com',
          firstName: 'Ama',
          phoneNumber: '+233241234567',
          productPublicId,
          quantity: 1,
        },
        { headers: { 'Idempotency-Key': randomUUID() } },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});
