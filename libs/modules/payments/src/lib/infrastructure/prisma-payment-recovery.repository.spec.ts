import type { DatabaseClient } from '@edu-api/database';

import { PrismaPaymentRecoveryRepository } from './prisma-payment-recovery.repository';

describe('PrismaPaymentRecoveryRepository', () => {
  it('conditions every recovery result write on the exact claimed lease', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const repository = new PrismaPaymentRecoveryRepository({
      paymentAttempt: { updateMany },
    } as unknown as DatabaseClient);
    const candidate = {
      id: BigInt(42),
      providerReference: 'PAY-safe-reference',
      verificationAttempts: 3,
      verificationLeaseUntil: new Date('2026-08-21T10:00:00.000Z'),
    };

    await repository.recordNotSucceeded({
      candidate,
      isTerminal: false,
      maxAttempts: 12,
      nextVerificationAt: new Date('2026-08-21T10:01:00.000Z'),
      providerStatus: 'pending',
    });
    await repository.recordProviderFailure({
      candidate,
      failureCategory: 'TEMPORARY',
      maxAttempts: 12,
      nextVerificationAt: new Date('2026-08-21T10:01:00.000Z'),
    });
    await repository.recordRejectedSuccess(candidate);

    expect(updateMany).toHaveBeenCalledTimes(3);
    for (const [input] of updateMany.mock.calls) {
      expect(input.where).toEqual({
        id: candidate.id,
        verificationLeaseUntil: candidate.verificationLeaseUntil,
      });
    }
  });
});
