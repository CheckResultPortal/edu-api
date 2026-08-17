import { OrderInputValidationError } from '../application/order-creation-errors';
import {
  assertOrderIdempotencyKey,
  parseGuestOrderRequest,
  validateGuestOrderInput,
} from './order-validation';

describe('guest order validation', () => {
  const productPublicId = '2b3e39a9-06db-41a9-a856-5f985846951a';

  it('normalizes Ghana contact details and accepts the approved bounds', () => {
    expect(
      validateGuestOrderInput({
        email: ' Buyer@Example.COM ',
        phoneNumber: '024 123 4567',
        productPublicId: productPublicId.toUpperCase(),
        quantity: 20,
      }),
    ).toEqual({
      email: 'buyer@example.com',
      phoneNumber: '+233241234567',
      productPublicId,
      quantity: 20,
    });
  });

  it.each([0, 21, 1.5])('rejects quantity %s', (quantity) => {
    expect(() =>
      validateGuestOrderInput({
        phoneNumber: '+233241234567',
        productPublicId,
        quantity,
      }),
    ).toThrow(OrderInputValidationError);
  });

  it('rejects client-controlled price properties', () => {
    expect(() =>
      parseGuestOrderRequest({
        phoneNumber: '+233241234567',
        productPublicId,
        quantity: 1,
        price: 1,
      }),
    ).toThrow('unsupported property');
  });

  it('rejects non-Ghana phone numbers and malformed email', () => {
    expect(() =>
      validateGuestOrderInput({
        email: 'not-an-email',
        phoneNumber: '+2348012345678',
        productPublicId,
        quantity: 1,
      }),
    ).toThrow(OrderInputValidationError);
  });

  it('requires a bounded safe idempotency key', () => {
    expect(assertOrderIdempotencyKey('checkout:0123456789abcdef')).toBe(
      'checkout:0123456789abcdef',
    );
    expect(() => assertOrderIdempotencyKey('short')).toThrow(
      OrderInputValidationError,
    );
  });
});
