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
        deliveryPreference: 'SMS_AND_EMAIL',
        email: ' Buyer@Example.COM ',
        firstName: '  Ama  ',
        phoneNumber: '024 123 4567',
        productPublicId: productPublicId.toUpperCase(),
        quantity: 20,
      }),
    ).toEqual({
      deliveryPreference: 'SMS_AND_EMAIL',
      email: 'buyer@example.com',
      firstName: 'Ama',
      phoneNumber: '+233241234567',
      productPublicId,
      quantity: 20,
    });
  });

  it.each([0, 21, 1.5])('rejects quantity %s', (quantity) => {
    expect(() =>
      validateGuestOrderInput({
        deliveryPreference: 'SMS_ONLY',
        firstName: 'Ama',
        phoneNumber: '+233241234567',
        productPublicId,
        quantity,
      }),
    ).toThrow(OrderInputValidationError);
  });

  it('rejects client-controlled price properties', () => {
    expect(() =>
      parseGuestOrderRequest({
        deliveryPreference: 'SMS_ONLY',
        firstName: 'Ama',
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
        deliveryPreference: 'SMS_AND_EMAIL',
        email: 'not-an-email',
        firstName: 'Ama',
        phoneNumber: '+2348012345678',
        productPublicId,
        quantity: 1,
      }),
    ).toThrow(OrderInputValidationError);
  });

  it('accepts SMS-only delivery without collecting email', () => {
    expect(
      validateGuestOrderInput({
        deliveryPreference: 'SMS_ONLY',
        firstName: 'Akosua',
        phoneNumber: '+233241234567',
        productPublicId,
        quantity: 1,
      }),
    ).toMatchObject({
      deliveryPreference: 'SMS_ONLY',
      email: null,
      firstName: 'Akosua',
    });
  });

  it.each([
    { deliveryPreference: 'SMS_ONLY', email: 'buyer@example.com' },
    { deliveryPreference: 'SMS_AND_EMAIL', email: undefined },
    { deliveryPreference: 'EMAIL_ONLY', email: 'buyer@example.com' },
  ])(
    'rejects an inconsistent delivery selection: $deliveryPreference',
    ({ deliveryPreference, email }) => {
      expect(() =>
        validateGuestOrderInput({
          deliveryPreference,
          ...(email === undefined ? {} : { email }),
          firstName: 'Ama',
          phoneNumber: '+233241234567',
          productPublicId,
          quantity: 1,
        }),
      ).toThrow(OrderInputValidationError);
    },
  );

  it('requires a non-empty bounded first name', () => {
    expect(() =>
      validateGuestOrderInput({
        deliveryPreference: 'SMS_ONLY',
        firstName: '   ',
        phoneNumber: '+233241234567',
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
