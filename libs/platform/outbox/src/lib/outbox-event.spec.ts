import { assertValidOutboxEvent } from './outbox-event';

describe('assertValidOutboxEvent', () => {
  it('accepts reference-only event data', () => {
    expect(() =>
      assertValidOutboxEvent({
        aggregateId: '42',
        aggregateType: 'payment',
        eventType: 'PaymentSucceeded',
        payload: { orderReference: 'ord_123', paymentId: '42' },
      }),
    ).not.toThrow();
  });

  it('accepts a password-reset reference without carrying password material', () => {
    expect(() =>
      assertValidOutboxEvent({
        aggregateId: '42',
        aggregateType: 'AdminPasswordReset',
        eventType: 'ADMIN_PASSWORD_RESET_DELIVERY_REQUESTED',
        payload: { resetPublicId: 'c3d09494-d000-4a2e-a2c3-8a6aef890193' },
      }),
    ).not.toThrow();
  });

  it('rejects secret-bearing payload fields', () => {
    expect(() =>
      assertValidOutboxEvent({
        aggregateId: '42',
        aggregateType: 'voucher',
        eventType: 'VoucherAllocated',
        payload: { pin: '1234567890' },
      }),
    ).toThrow('must not contain pin');
  });

  it('rejects sensitive payload fields regardless of naming style', () => {
    expect(() =>
      assertValidOutboxEvent({
        aggregateId: '42',
        aggregateType: 'voucher',
        eventType: 'VoucherImported',
        payload: { voucherPin: '123456789012' },
      }),
    ).toThrow('voucherPin');
  });
});
