import { Prisma } from '../../../../../../generated/prisma/client';

import type { DatabaseClient } from '@edu-api/database';

import type {
  PaymentRecoveryCandidate,
  PaymentRecoveryRepository,
} from '../application/payment-recovery-service';

interface RecoveryRow {
  readonly id: bigint;
  readonly providerReference: string;
  readonly verificationAttempts: number;
}

export class PrismaPaymentRecoveryRepository
  implements PaymentRecoveryRepository
{
  constructor(private readonly database: DatabaseClient) {}

  async deleteExpiredIdempotency(
    batchSize: number,
    now: Date,
  ): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
      throw new Error(
        'Payment idempotency cleanup batch size must be between 1 and 5000.',
      );
    }
    const records = await this.database.idempotencyRecord.findMany({
      where: {
        scope: 'web-payment-initialize',
        expiresAt: { lte: now },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
      select: { id: true },
    });
    if (records.length === 0) return 0;
    const result = await this.database.idempotencyRecord.deleteMany({
      where: {
        scope: 'web-payment-initialize',
        expiresAt: { lte: now },
        id: { in: records.map((record) => record.id) },
      },
    });
    return result.count;
  }

  async claimDue(input: {
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly now: Date;
    readonly provider: string;
  }): Promise<readonly PaymentRecoveryCandidate[]> {
    if (
      !Number.isInteger(input.batchSize) ||
      input.batchSize < 1 ||
      input.batchSize > 100
    ) {
      throw new Error('Payment recovery batch size must be between 1 and 100.');
    }
    const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
    return this.database.$queryRaw<RecoveryRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "PaymentAttempt"
        WHERE "provider" = ${input.provider}
          AND "status" IN (
            'INITIALIZING'::"PaymentAttemptStatus",
            'PENDING'::"PaymentAttemptStatus",
            'UNKNOWN'::"PaymentAttemptStatus"
          )
          AND "nextVerificationAt" <= ${input.now}
          AND (
            "verificationLeaseUntil" IS NULL
            OR "verificationLeaseUntil" <= ${input.now}
          )
          AND "needsAttentionAt" IS NULL
        ORDER BY "nextVerificationAt" ASC, "id" ASC
        LIMIT ${input.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "PaymentAttempt" AS payment
      SET "verificationLeaseUntil" = ${leaseUntil},
          "updatedAt" = ${input.now}
      FROM candidates
      WHERE payment."id" = candidates."id"
      RETURNING payment."id", payment."providerReference",
                payment."verificationAttempts"
    `);
  }

  async recordNotSucceeded(input: {
    readonly candidate: PaymentRecoveryCandidate;
    readonly isTerminal: boolean;
    readonly maxAttempts: number;
    readonly nextVerificationAt: Date;
    readonly providerStatus: string;
  }): Promise<void> {
    const attempts = input.candidate.verificationAttempts + 1;
    const exhausted = attempts >= input.maxAttempts;
    await this.database.paymentAttempt.update({
      where: { id: input.candidate.id },
      data: input.isTerminal
        ? {
            nextVerificationAt: null,
            providerStatus: input.providerStatus,
            status: 'FAILED',
            verificationAttempts: attempts,
            verificationLeaseUntil: null,
          }
        : exhausted
          ? {
              attentionReason: 'VERIFICATION_EXHAUSTED',
              needsAttentionAt: new Date(),
              nextVerificationAt: null,
              providerStatus: input.providerStatus,
              status: 'UNKNOWN',
              verificationAttempts: attempts,
              verificationLeaseUntil: null,
            }
          : {
              nextVerificationAt: input.nextVerificationAt,
              providerStatus: input.providerStatus,
              verificationAttempts: attempts,
              verificationLeaseUntil: null,
            },
    });
  }

  async recordProviderFailure(input: {
    readonly candidate: PaymentRecoveryCandidate;
    readonly failureCategory: string;
    readonly maxAttempts: number;
    readonly nextVerificationAt: Date;
  }): Promise<void> {
    const attempts = input.candidate.verificationAttempts + 1;
    const needsAttention =
      attempts >= input.maxAttempts ||
      input.failureCategory === 'AUTHENTICATION' ||
      input.failureCategory === 'INVALID_REQUEST';
    await this.database.paymentAttempt.update({
      where: { id: input.candidate.id },
      data: needsAttention
        ? {
            attentionReason: `VERIFICATION_${input.failureCategory}`.slice(
              0,
              100,
            ),
            needsAttentionAt: new Date(),
            nextVerificationAt: null,
            status: 'UNKNOWN',
            verificationAttempts: attempts,
            verificationLeaseUntil: null,
          }
        : {
            nextVerificationAt: input.nextVerificationAt,
            status: 'UNKNOWN',
            verificationAttempts: attempts,
            verificationLeaseUntil: null,
          },
    });
  }

  async recordRejectedSuccess(
    candidate: PaymentRecoveryCandidate,
  ): Promise<void> {
    await this.database.paymentAttempt.update({
      where: { id: candidate.id },
      data: {
        nextVerificationAt: null,
        status: 'UNKNOWN',
        verificationAttempts: candidate.verificationAttempts + 1,
        verificationLeaseUntil: null,
      },
    });
  }
}
