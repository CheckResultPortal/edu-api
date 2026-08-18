import type {
  GuestOrder,
  OrderCreationRepository,
  OrderRateLimiter,
  PersistGuestOrderInput,
} from './order-creation-service';
import { DefaultOrderCreationService } from './order-creation-service';

describe('DefaultOrderCreationService', () => {
  it('rate-limits canonical contact and persists a fingerprinted request', async () => {
    const result: GuestOrder = {
      currency: 'GHS',
      deliveryPreference: 'SMS_AND_EMAIL',
      productPublicId: '2b3e39a9-06db-41a9-a856-5f985846951a',
      publicReference: '429a38f1-5f76-4ed2-a271-e60064598abc',
      purchaseChannel: 'WEB',
      quantity: 2,
      totalPriceMinor: '5000',
      unitPriceMinor: '2500',
    };
    let persisted: PersistGuestOrderInput | undefined;
    const repository: OrderCreationRepository = {
      create: jest.fn(async (input) => {
        persisted = input;
        return result;
      }),
    };
    const rateLimiter: OrderRateLimiter = { consume: jest.fn() };
    const service = new DefaultOrderCreationService(
      repository,
      rateLimiter,
      86_400_000,
      privacyHmacKey,
    );

    await expect(
      service.create(
        {
          email: 'BUYER@example.com',
          firstName: ' Ama ',
          idempotencyKey: 'checkout:0123456789abcdef',
          phoneNumber: '0241234567',
          productPublicId: result.productPublicId,
          quantity: 2,
        },
        { clientIp: '203.0.113.10' },
      ),
    ).resolves.toEqual(result);

    expect(rateLimiter.consume).toHaveBeenCalledWith({
      clientIp: '203.0.113.10',
      phoneNumber: '+233241234567',
    });
    expect(persisted).toMatchObject({
      deliveryPreference: 'SMS_AND_EMAIL',
      email: 'buyer@example.com',
      firstName: 'Ama',
      idempotencyKey: 'checkout:0123456789abcdef',
      phoneNumber: '+233241234567',
      purchaseChannel: 'WEB',
      requestFingerprint: expect.any(String),
    });
    expect(
      persisted?.idempotencyExpiresAt.getTime() ?? Number.NaN,
    ).toBeGreaterThan(Date.now() + 86_300_000);
  });
});

const privacyHmacKey = Buffer.alloc(32, 7);
