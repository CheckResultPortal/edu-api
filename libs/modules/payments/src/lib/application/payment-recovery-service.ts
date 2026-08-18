import type { PaymentProvider } from './payment-provider';
import type {
  PaymentSuccessOutcome,
  PaymentSuccessRepository,
} from './payment-success-service';

export const PAYMENT_RECOVERY_REPOSITORY = Symbol(
  'PAYMENT_RECOVERY_REPOSITORY',
);
export const PAYMENT_RECOVERY_SERVICE = Symbol('PAYMENT_RECOVERY_SERVICE');

export interface PaymentRecoveryCandidate {
  readonly id: bigint;
  readonly providerReference: string;
  readonly verificationAttempts: number;
}

export interface PaymentRecoveryRepository {
  deleteExpiredIdempotency(batchSize: number, now: Date): Promise<number>;

  claimDue(input: {
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly now: Date;
    readonly provider: string;
  }): Promise<readonly PaymentRecoveryCandidate[]>;

  recordNotSucceeded(input: {
    readonly candidate: PaymentRecoveryCandidate;
    readonly isTerminal: boolean;
    readonly maxAttempts: number;
    readonly nextVerificationAt: Date;
    readonly providerStatus: string;
  }): Promise<void>;

  recordProviderFailure(input: {
    readonly candidate: PaymentRecoveryCandidate;
    readonly failureCategory: string;
    readonly maxAttempts: number;
    readonly nextVerificationAt: Date;
  }): Promise<void>;

  recordRejectedSuccess(candidate: PaymentRecoveryCandidate): Promise<void>;
}

export interface PaymentRecoveryConfiguration {
  readonly baseDelayMs: number;
  readonly batchSize: number;
  readonly idempotencyCleanupBatchSize: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
}

export interface PaymentRecoveryCycleResult {
  readonly applied: number;
  readonly claimed: number;
  readonly cleanedIdempotencyRecords: number;
  readonly needsAttention: number;
}

export interface PaymentRecoveryService {
  runCycle(): Promise<PaymentRecoveryCycleResult>;
}

export class DefaultPaymentRecoveryService implements PaymentRecoveryService {
  constructor(
    private readonly provider: PaymentProvider,
    private readonly successRepository: PaymentSuccessRepository,
    private readonly recoveryRepository: PaymentRecoveryRepository,
    private readonly configuration: PaymentRecoveryConfiguration,
  ) {}

  async runCycle(): Promise<PaymentRecoveryCycleResult> {
    const now = new Date();
    const cleanedIdempotencyRecords =
      await this.recoveryRepository.deleteExpiredIdempotency(
        this.configuration.idempotencyCleanupBatchSize,
        now,
      );
    const candidates = await this.recoveryRepository.claimDue({
      batchSize: this.configuration.batchSize,
      leaseMs: this.configuration.leaseMs,
      now,
      provider: this.provider.code,
    });
    const outcomes = await Promise.all(
      candidates.map((candidate) => this.recover(candidate)),
    );
    return {
      applied: outcomes.filter(isApplied).length,
      claimed: candidates.length,
      cleanedIdempotencyRecords,
      needsAttention: outcomes.filter(
        (outcome) => outcome === 'NEEDS_ATTENTION',
      ).length,
    };
  }

  private async recover(
    candidate: PaymentRecoveryCandidate,
  ): Promise<PaymentSuccessOutcome | 'NOT_SUCCEEDED' | 'NEEDS_ATTENTION'> {
    try {
      const verification = await this.provider.verify(
        candidate.providerReference,
      );
      if (verification.kind === 'PAYMENT_SUCCEEDED') {
        const result = await this.successRepository.recordVerifiedSuccess({
          provider: this.provider.code,
          success: verification.success,
        });
        if (result === 'REJECTED') {
          await this.recoveryRepository.recordRejectedSuccess(candidate);
          return 'NEEDS_ATTENTION';
        }
        return result;
      }

      const nextAttempt = candidate.verificationAttempts + 1;
      await this.recoveryRepository.recordNotSucceeded({
        candidate,
        isTerminal: verification.isTerminal,
        maxAttempts: this.configuration.maxAttempts,
        nextVerificationAt: nextVerificationTime(
          nextAttempt,
          this.configuration.baseDelayMs,
        ),
        providerStatus: verification.providerStatus,
      });
      return nextAttempt >= this.configuration.maxAttempts
        ? 'NEEDS_ATTENTION'
        : 'NOT_SUCCEEDED';
    } catch (error) {
      const failureCategory = providerFailureCategory(error);
      const nextAttempt = candidate.verificationAttempts + 1;
      await this.recoveryRepository.recordProviderFailure({
        candidate,
        failureCategory,
        maxAttempts: this.configuration.maxAttempts,
        nextVerificationAt: nextVerificationTime(
          nextAttempt,
          this.configuration.baseDelayMs,
        ),
      });
      return nextAttempt >= this.configuration.maxAttempts ||
        failureCategory === 'AUTHENTICATION' ||
        failureCategory === 'INVALID_REQUEST'
        ? 'NEEDS_ATTENTION'
        : 'NOT_SUCCEEDED';
    }
  }
}

function nextVerificationTime(attempt: number, baseDelayMs: number): Date {
  const exponent = Math.min(Math.max(0, attempt - 1), 8);
  const deterministicDelay = baseDelayMs * 2 ** exponent;
  const jitter = Math.floor(Math.random() * Math.max(1, baseDelayMs));
  return new Date(Date.now() + deterministicDelay + jitter);
}

function providerFailureCategory(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'category' in error &&
    typeof error.category === 'string'
    ? error.category
    : 'UNKNOWN_OUTCOME';
}

function isApplied(
  outcome: PaymentSuccessOutcome | 'NOT_SUCCEEDED' | 'NEEDS_ATTENTION',
): boolean {
  return outcome === 'APPLIED';
}
