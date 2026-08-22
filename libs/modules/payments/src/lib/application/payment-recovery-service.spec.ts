import {
  DefaultPaymentRecoveryService,
  type PaymentRecoveryRepository,
} from './payment-recovery-service';
import type { PaymentProvider } from './payment-provider';
import type { PaymentSuccessRepository } from './payment-success-service';

describe('DefaultPaymentRecoveryService', () => {
  it('routes verified success through the canonical success repository', async () => {
    const recovery = recoveryRepository();
    recovery.claimDue = jest.fn().mockResolvedValue([candidate]);
    const provider = paymentProvider();
    provider.verify = jest.fn().mockResolvedValue({
      kind: 'PAYMENT_SUCCEEDED',
      success,
    });
    const successes: PaymentSuccessRepository = {
      recordVerifiedSuccess: jest.fn().mockResolvedValue('APPLIED'),
    };

    await expect(
      service([provider], successes, recovery).runCycle(),
    ).resolves.toEqual({
      applied: 1,
      claimed: 1,
      cleanedIdempotencyRecords: 0,
      needsAttention: 0,
    });
    expect(successes.recordVerifiedSuccess).toHaveBeenCalledWith({
      provider: 'PAYSTACK',
      success,
    });
  });

  it('records a provider terminal state without guessing payment success', async () => {
    const recovery = recoveryRepository();
    recovery.claimDue = jest.fn().mockResolvedValue([candidate]);
    const provider = paymentProvider();
    provider.verify = jest.fn().mockResolvedValue({
      isTerminal: true,
      kind: 'NOT_SUCCEEDED',
      providerStatus: 'failed',
    });

    await service(
      [provider],
      { recordVerifiedSuccess: jest.fn() },
      recovery,
    ).runCycle();

    expect(recovery.recordNotSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate,
        isTerminal: true,
        maxAttempts: 12,
        providerStatus: 'failed',
      }),
    );
  });

  it('marks rejected verified success for operator attention', async () => {
    const recovery = recoveryRepository();
    recovery.claimDue = jest.fn().mockResolvedValue([candidate]);
    const provider = paymentProvider();
    provider.verify = jest.fn().mockResolvedValue({
      kind: 'PAYMENT_SUCCEEDED',
      success,
    });

    await expect(
      service(
        [provider],
        { recordVerifiedSuccess: jest.fn().mockResolvedValue('REJECTED') },
        recovery,
      ).runCycle(),
    ).resolves.toMatchObject({ needsAttention: 1 });
    expect(recovery.recordRejectedSuccess).toHaveBeenCalledWith(candidate);
  });
});

const candidate = {
  id: BigInt(1),
  providerReference: 'EDU-attempt',
  verificationAttempts: 0,
  verificationLeaseUntil: new Date('2026-08-21T10:00:00.000Z'),
};

const success = {
  amountMinor: BigInt(5_000),
  currency: 'GHS',
  paidAt: new Date('2026-08-18T12:00:00.000Z'),
  providerReference: 'EDU-attempt',
  providerStatus: 'success',
  providerTransactionId: '100001',
};

function service(
  providers: readonly PaymentProvider[],
  successes: PaymentSuccessRepository,
  recovery: PaymentRecoveryRepository,
): DefaultPaymentRecoveryService {
  return new DefaultPaymentRecoveryService(providers, successes, recovery, {
    baseDelayMs: 60_000,
    batchSize: 25,
    idempotencyCleanupBatchSize: 1_000,
    leaseMs: 60_000,
    maxAttempts: 12,
  });
}

function recoveryRepository(): PaymentRecoveryRepository {
  return {
    claimDue: jest.fn().mockResolvedValue([]),
    deleteExpiredIdempotency: jest.fn().mockResolvedValue(0),
    recordNotSucceeded: jest.fn(),
    recordProviderFailure: jest.fn(),
    recordRejectedSuccess: jest.fn(),
  };
}

function paymentProvider(): PaymentProvider {
  return {
    authenticateWebhook: jest.fn(),
    code: 'PAYSTACK',
    initialize: jest.fn(),
    verify: jest.fn(),
  };
}
