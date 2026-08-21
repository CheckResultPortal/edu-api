import { randomInt } from 'node:crypto';

import {
  decryptSecret,
  type EncryptedSecret,
  type SecretKeyring,
} from '@edu-api/encryption';
import type { DatabaseClient } from '@edu-api/database';

import type { EmailProvider } from './email-provider';
import type { SmsProvider } from './sms-provider';

export interface VoucherDeliveryWorkerOptions {
  readonly emailFrom: string;
  readonly maximumAutomaticAttempts: number;
  readonly maximumRetryDelayMs: number;
  readonly processingLeaseMs: number;
  readonly retryBaseDelayMs: number;
}

interface ClaimedDelivery {
  readonly attemptId: bigint;
  readonly attemptNumber: number;
  readonly channel: 'SMS' | 'EMAIL';
  readonly deliveryId: bigint;
  readonly deliveryPublicId: string;
  readonly destination: string;
  readonly encryptedPin: unknown;
  readonly leaseUntil: Date;
  readonly serialNumber: string;
}

export class VoucherDeliveryService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly emailProvider: EmailProvider,
    private readonly smsProvider: SmsProvider,
    private readonly keyring: SecretKeyring,
    private readonly options: VoucherDeliveryWorkerOptions,
  ) {}

  async processAvailable(limit: number): Promise<number> {
    const due = await this.database.communicationDelivery.findMany({
      where: {
        state: { in: ['PENDING', 'RETRYING'] },
        nextAttemptAt: { lte: new Date() },
      },
      select: { id: true },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: bounded(limit),
    });
    let processed = 0;
    for (const candidate of due) {
      const claimed = await this.claim(candidate.id);
      if (claimed === null) continue;
      processed += 1;
      await this.send(claimed);
    }
    return processed;
  }

  async recoverStalledDeliveries(limit: number): Promise<number> {
    const now = new Date();
    const stale = await this.database.communicationDelivery.findMany({
      where: { state: 'PROCESSING', processingLeaseUntil: { lt: now } },
      select: {
        id: true,
        publicId: true,
        channel: true,
        processingLeaseUntil: true,
        attempts: {
          where: { outcome: 'PROCESSING' },
          orderBy: { attemptNumber: 'desc' },
          take: 1,
          select: { id: true, attemptNumber: true },
        },
      },
      orderBy: { processingLeaseUntil: 'asc' },
      take: bounded(limit),
    });
    let recovered = 0;
    for (const delivery of stale) {
      const attempt = delivery.attempts[0];
      if (attempt === undefined || delivery.processingLeaseUntil === null)
        continue;
      const recoveryLeaseUntil = new Date(
        now.getTime() + this.options.processingLeaseMs,
      );
      const claimed = await this.database.communicationDelivery.updateMany({
        where: {
          id: delivery.id,
          state: 'PROCESSING',
          processingLeaseUntil: delivery.processingLeaseUntil,
        },
        data: { processingLeaseUntil: recoveryLeaseUntil },
      });
      if (claimed.count !== 1) continue;
      recovered += 1;
      const reference = referenceFor(delivery.publicId);
      const lookup =
        delivery.channel === 'SMS'
          ? await this.smsProvider.lookup(reference)
          : 'UNKNOWN';
      if (lookup === 'ACCEPTED') {
        await this.finish(
          delivery.id,
          attempt.id,
          recoveryLeaseUntil,
          { status: 'SENT', providerMessageId: reference },
          attempt.attemptNumber,
        );
      } else if (lookup === 'NOT_FOUND') {
        await this.finish(
          delivery.id,
          attempt.id,
          recoveryLeaseUntil,
          { status: 'FAILED', category: 'TEMPORARY' },
          attempt.attemptNumber,
        );
      } else {
        await this.finish(
          delivery.id,
          attempt.id,
          recoveryLeaseUntil,
          { status: 'FAILED', category: 'UNKNOWN_OUTCOME' },
          attempt.attemptNumber,
        );
      }
    }
    return recovered;
  }

  /** Atomically makes a safe, non-ambiguous needs-attention delivery eligible again. */
  async requestManualRetry(deliveryPublicId: string): Promise<boolean> {
    const updated = await this.database.communicationDelivery.updateMany({
      where: {
        publicId: deliveryPublicId,
        state: 'NEEDS_ATTENTION',
        lastFailureCategory: { not: 'UNKNOWN_OUTCOME' },
      },
      data: {
        lastFailureCategory: null,
        needsAttentionAt: null,
        nextAttemptAt: new Date(),
        state: 'PENDING',
      },
    });
    return updated.count === 1;
  }

  private async claim(deliveryId: bigint): Promise<ClaimedDelivery | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.options.processingLeaseMs);
    return this.database.$transaction(async (transaction) => {
      const changed = await transaction.communicationDelivery.updateMany({
        where: {
          id: deliveryId,
          state: { in: ['PENDING', 'RETRYING'] },
          nextAttemptAt: { lte: now },
        },
        data: {
          attemptCount: { increment: 1 },
          processingLeaseUntil: leaseUntil,
          state: 'PROCESSING',
        },
      });
      if (changed.count !== 1) return null;
      const delivery =
        await transaction.communicationDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
          select: {
            id: true,
            publicId: true,
            channel: true,
            destination: true,
            attemptCount: true,
            communication: {
              select: {
                allocation: {
                  select: {
                    voucher: {
                      select: { encryptedPin: true, serialNumber: true },
                    },
                  },
                },
              },
            },
          },
        });
      const attempt = await transaction.communicationAttempt.create({
        data: {
          attemptNumber: delivery.attemptCount,
          deliveryId,
          provider:
            delivery.channel === 'SMS' ? this.smsProvider.name : 'resend',
        },
        select: { id: true },
      });
      return {
        attemptId: attempt.id,
        attemptNumber: delivery.attemptCount,
        channel: delivery.channel,
        deliveryId,
        deliveryPublicId: delivery.publicId,
        destination: delivery.destination,
        encryptedPin: delivery.communication.allocation.voucher.encryptedPin,
        leaseUntil,
        serialNumber: delivery.communication.allocation.voucher.serialNumber,
      };
    });
  }

  private async send(claimed: ClaimedDelivery): Promise<void> {
    let result:
      | { readonly providerMessageId: string; readonly status: 'SENT' }
      | {
          readonly category:
            | 'AUTHENTICATION'
            | 'INVALID_REQUEST'
            | 'PERMANENT'
            | 'RATE_LIMITED'
            | 'TEMPORARY'
            | 'UNKNOWN_OUTCOME';
          readonly providerCode?: string;
          readonly status: 'FAILED';
        };
    try {
      if (!isEncryptedSecret(claimed.encryptedPin))
        throw new Error('Invalid encrypted voucher PIN.');
      const pin = decryptSecret(claimed.encryptedPin, this.keyring);
      const text = `EduVoucher result checker voucher. Serial: ${claimed.serialNumber}. PIN: ${pin}`;
      const reference = referenceFor(claimed.deliveryPublicId);
      result =
        claimed.channel === 'SMS'
          ? await this.smsProvider.send({
              message: text,
              reference,
              to: claimed.destination,
            })
          : await this.emailProvider.send({
              from: this.options.emailFrom,
              to: claimed.destination,
              subject: 'Your EduVoucher result checker voucher',
              text,
              html: `<p>Your EduVoucher result checker voucher.</p><p>Serial: <strong>${escapeHtml(claimed.serialNumber)}</strong><br>PIN: <strong>${escapeHtml(pin)}</strong></p>`,
              idempotencyKey: reference,
            });
    } catch {
      result = { category: 'PERMANENT', status: 'FAILED' };
    }
    await this.finish(
      claimed.deliveryId,
      claimed.attemptId,
      claimed.leaseUntil,
      result,
      claimed.attemptNumber,
    );
  }

  private async finish(
    deliveryId: bigint,
    attemptId: bigint,
    leaseUntil: Date,
    result:
      | { readonly providerMessageId: string; readonly status: 'SENT' }
      | {
          readonly category:
            | 'AUTHENTICATION'
            | 'INVALID_REQUEST'
            | 'PERMANENT'
            | 'RATE_LIMITED'
            | 'TEMPORARY'
            | 'UNKNOWN_OUTCOME';
          readonly providerCode?: string;
          readonly status: 'FAILED';
        },
    attemptNumber?: number,
  ): Promise<void> {
    const now = new Date();
    await this.database.$transaction(async (transaction) => {
      const active = await transaction.communicationDelivery.updateMany({
        where: {
          id: deliveryId,
          processingLeaseUntil: leaseUntil,
          state: 'PROCESSING',
        },
        data:
          result.status === 'SENT'
            ? {
                processingLeaseUntil: null,
                providerMessageId: result.providerMessageId,
                sentAt: now,
                state: 'SENT',
              }
            : failureUpdate(
                result.category,
                attemptNumber ?? 1,
                this.options,
                now,
              ),
      });
      if (active.count !== 1) return;
      await transaction.communicationAttempt.updateMany({
        where: { id: attemptId, outcome: 'PROCESSING' },
        data:
          result.status === 'SENT'
            ? {
                completedAt: now,
                outcome: 'SENT',
                providerMessageId: result.providerMessageId,
              }
            : {
                completedAt: now,
                outcome: result.category,
                ...(result.providerCode === undefined
                  ? {}
                  : { providerCode: result.providerCode }),
              },
      });
    });
  }
}

function failureUpdate(
  category:
    | 'AUTHENTICATION'
    | 'INVALID_REQUEST'
    | 'PERMANENT'
    | 'RATE_LIMITED'
    | 'TEMPORARY'
    | 'UNKNOWN_OUTCOME',
  attempt: number,
  options: VoucherDeliveryWorkerOptions,
  now: Date,
) {
  if (category === 'UNKNOWN_OUTCOME')
    return {
      lastFailureCategory: category,
      needsAttentionAt: now,
      processingLeaseUntil: null,
      state: 'UNKNOWN' as const,
    };
  if (
    !['TEMPORARY', 'RATE_LIMITED'].includes(category) ||
    attempt >= options.maximumAutomaticAttempts
  )
    return {
      lastFailureCategory: category,
      needsAttentionAt: now,
      processingLeaseUntil: null,
      state: 'NEEDS_ATTENTION' as const,
    };
  const delay = Math.min(
    options.maximumRetryDelayMs,
    options.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return {
    lastFailureCategory: category,
    nextAttemptAt: new Date(
      now.getTime() + delay + randomInt(0, Math.max(1, Math.floor(delay / 4))),
    ),
    processingLeaseUntil: null,
    state: 'RETRYING' as const,
  };
}
function referenceFor(deliveryPublicId: string): string {
  return `eduvoucher-${deliveryPublicId}`;
}
function bounded(value: number): number {
  return Math.max(1, Math.min(value, 100));
}
function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).algorithm === 'aes-256-gcm' &&
    typeof (value as Record<string, unknown>).ciphertext === 'string' &&
    typeof (value as Record<string, unknown>).iv === 'string' &&
    typeof (value as Record<string, unknown>).authTag === 'string' &&
    typeof (value as Record<string, unknown>).keyId === 'string'
  );
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] as string,
  );
}
