import { PrismaGuestOrderStatusQuery } from './prisma-guest-order-status-query';
import { normalizeOrderPublicReference } from '../domain/order-validation';

describe('customer order references', () => {
  it('normalizes the branded code to the stored six digits', () => {
    expect(normalizeOrderPublicReference(' EDUPAY-123456 ')).toBe('123456');
    expect(normalizeOrderPublicReference('edupay-123456')).toBe('123456');
    expect(() => normalizeOrderPublicReference('EDUPAY-1234')).toThrow();
  });
  it.each([
    '123456',
    '6b0f6e55-0f5e-4c3a-9d3e-2a7c1a111111',
    'EDU-1687db83-c205-448d-9b58-29c2dcdd5c05',
  ])(
    'accepts supported reference %s with phone-scoped lookup',
    async (reference) => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const query = new PrismaGuestOrderStatusQuery({
        order: { findFirst },
      } as never);
      await query.findByPhoneAndReference(
        '+233244123456',
        normalizeOrderPublicReference(reference),
      );
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            phoneNumber: '+233244123456',
            contactAnonymizedAt: null,
          }),
        }),
      );
      const where = findFirst.mock.calls[0][0].where;
      if (reference === '123456') expect(where.customerCode).toBe(reference);
      else if (reference.startsWith('EDU-'))
        expect(where.paymentAttempts.some).toEqual({
          provider: 'PAYSTACK',
          providerReference: reference,
        });
      else expect(where.publicReference).toBe(reference);
    },
  );
  it.each(['12345', '1234567', '000000', 'EDU-nope'])(
    'rejects malformed reference %s',
    (reference) => {
      expect(() => normalizeOrderPublicReference(reference)).toThrow();
    },
  );
});
