import { randomInt } from 'node:crypto';

import {
  decryptSecret,
  type EncryptedSecret,
  type SecretKeyring,
} from '@edu-api/encryption';
import type { DatabaseClient } from '@edu-api/database';

import type {
  EmailProvider,
  EmailAttachment,
  SendEmailResult,
  EmailProviderFailureCategory,
} from './email-provider';
import { generateVoucherDeliveryArtifacts } from './voucher-delivery-artifacts';

export interface VoucherRetrievalEmailDeliveryOptions {
  readonly emailFrom: string;
  readonly maximumAutomaticAttempts: number;
  readonly maximumRetryDelayMs: number;
  readonly processingLeaseMs: number;
  readonly retryBaseDelayMs: number;
  readonly supportPhone: string;
}

interface ClaimedRetrievalEmail {
  readonly attemptId: bigint;
  readonly attemptNumber: number;
  readonly deliveryId: bigint;
  readonly deliveryPublicId: string;
  readonly destinationEmail: string;
  readonly leaseUntil: Date;
  readonly orderPublicReference: string;
  readonly vouchers: readonly {
    readonly encryptedPin: unknown;
    readonly productName: string;
    readonly resultCheckerUrl: string | null;
    readonly serialNumber: string;
  }[];
}

export class VoucherRetrievalEmailDeliveryService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly emailProvider: EmailProvider,
    private readonly keyring: SecretKeyring,
    private readonly options: VoucherRetrievalEmailDeliveryOptions,
  ) {}

  async processAvailable(limit: number): Promise<number> {
    const due = await this.database.voucherRetrievalEmailDelivery.findMany({
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
    const stale = await this.database.voucherRetrievalEmailDelivery.findMany({
      where: { state: 'PROCESSING', processingLeaseUntil: { lt: now } },
      select: {
        id: true,
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
      await this.finishUnknown(
        delivery.id,
        attempt.id,
        delivery.processingLeaseUntil,
        attempt.attemptNumber,
      );
      recovered += 1;
    }
    return recovered;
  }

  private async claim(
    deliveryId: bigint,
  ): Promise<ClaimedRetrievalEmail | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.options.processingLeaseMs);
    return this.database.$transaction(async (transaction) => {
      const changed =
        await transaction.voucherRetrievalEmailDelivery.updateMany({
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
        await transaction.voucherRetrievalEmailDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
          select: {
            attemptCount: true,
            destinationEmail: true,
            publicId: true,
            order: {
              select: {
                publicReference: true,
                items: {
                  select: {
                    product: { select: { name: true, resultCheckerUrl: true } },
                    fulfilmentUnits: {
                      orderBy: { ordinal: 'asc' },
                      select: {
                        allocation: {
                          select: {
                            voucher: {
                              select: {
                                encryptedPin: true,
                                serialNumber: true,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });
      const item = delivery.order.items[0];
      const units = item?.fulfilmentUnits ?? [];
      if (
        item === undefined ||
        units.length === 0 ||
        units.some((unit) => unit.allocation === null)
      ) {
        throw new Error(
          'Voucher retrieval requested before fulfilment completed.',
        );
      }
      const attempt = await transaction.voucherRetrievalEmailAttempt.create({
        data: {
          attemptNumber: delivery.attemptCount,
          deliveryId,
          provider: 'resend',
        },
        select: { id: true },
      });
      return {
        attemptId: attempt.id,
        attemptNumber: delivery.attemptCount,
        deliveryId,
        deliveryPublicId: delivery.publicId,
        destinationEmail: delivery.destinationEmail,
        leaseUntil,
        orderPublicReference: delivery.order.publicReference,
        vouchers: units.map((unit) => ({
          encryptedPin: unit.allocation!.voucher.encryptedPin,
          productName: item.product.name,
          resultCheckerUrl: item.product.resultCheckerUrl,
          serialNumber: unit.allocation!.voucher.serialNumber,
        })),
      };
    });
  }

  private async send(claimed: ClaimedRetrievalEmail): Promise<void> {
    let attachments: EmailAttachment[];
    try {
      attachments = (
        await Promise.all(
          claimed.vouchers.map(async (voucher, index) => {
            if (!isEncryptedSecret(voucher.encryptedPin)) {
              throw new Error('Invalid encrypted voucher PIN.');
            }
            return generateVoucherDeliveryArtifacts({
              deliveryPublicId: `${claimed.deliveryPublicId}-${index + 1}`,
              orderPublicReference: claimed.orderPublicReference,
              pin: decryptSecret(voucher.encryptedPin, this.keyring),
              productName: voucher.productName,
              ...(voucher.resultCheckerUrl === null
                ? {}
                : { resultCheckerUrl: voucher.resultCheckerUrl }),
              serialNumber: voucher.serialNumber,
              supportPhone: this.options.supportPhone,
            });
          }),
        )
      ).flat();
    } catch {
      await this.finishFailure(
        claimed.deliveryId,
        claimed.attemptId,
        claimed.leaseUntil,
        claimed.attemptNumber,
        'PERMANENT',
      );
      return;
    }
    let result: SendEmailResult;
    try {
      result = await this.emailProvider.send({
        attachments,
        from: this.options.emailFrom,
        to: claimed.destinationEmail,
        subject: 'Your requested EduVoucher voucher copies',
        text: 'Your requested voucher copies are attached. Keep the attached documents private.',
        html: '<p>Your requested EduVoucher voucher copies are attached.</p><p>Keep the attached documents private. EduVoucher support will never ask you to post a PIN publicly.</p>',
        idempotencyKey: `voucher-retrieval-${claimed.deliveryPublicId}`,
      });
    } catch {
      await this.finishUnknown(
        claimed.deliveryId,
        claimed.attemptId,
        claimed.leaseUntil,
        claimed.attemptNumber,
      );
      return;
    }
    // Persistence errors propagate. Retain the processing lease so recovery can
    // classify the possibly completed send as UNKNOWN, never a safe failure.
    if (result.status === 'SENT') {
      await this.finishSent(
        claimed.deliveryId,
        claimed.attemptId,
        claimed.leaseUntil,
        claimed.attemptNumber,
        result.providerMessageId,
      );
    } else if (result.category === 'UNKNOWN_OUTCOME') {
      await this.finishUnknown(
        claimed.deliveryId,
        claimed.attemptId,
        claimed.leaseUntil,
        claimed.attemptNumber,
      );
    } else {
      await this.finishFailure(
        claimed.deliveryId,
        claimed.attemptId,
        claimed.leaseUntil,
        claimed.attemptNumber,
        result.category,
        result.providerCode,
      );
    }
  }

  private async finishSent(
    deliveryId: bigint,
    attemptId: bigint,
    leaseUntil: Date,
    attemptNumber: number,
    providerMessageId: string,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const changed =
        await transaction.voucherRetrievalEmailDelivery.updateMany({
          where: {
            id: deliveryId,
            state: 'PROCESSING',
            processingLeaseUntil: leaseUntil,
          },
          data: {
            lastFailureCategory: null,
            processingLeaseUntil: null,
            providerMessageId,
            sentAt: new Date(),
            state: 'SENT',
          },
        });
      if (changed.count !== 1) return;
      await transaction.voucherRetrievalEmailAttempt.update({
        where: { id: attemptId },
        data: { completedAt: new Date(), outcome: 'SENT', providerMessageId },
      });
    });
  }

  private async finishUnknown(
    deliveryId: bigint,
    attemptId: bigint,
    leaseUntil: Date,
    _attemptNumber: number,
  ): Promise<void> {
    await this.finishTerminal(
      deliveryId,
      attemptId,
      leaseUntil,
      'UNKNOWN',
      'UNKNOWN_OUTCOME',
    );
  }

  private async finishFailure(
    deliveryId: bigint,
    attemptId: bigint,
    leaseUntil: Date,
    attemptNumber: number,
    category: EmailProviderFailureCategory,
    providerCode?: string,
  ): Promise<void> {
    const retryAt =
      (category === 'TEMPORARY' || category === 'RATE_LIMITED') &&
      attemptNumber < this.options.maximumAutomaticAttempts
        ? retryAtFor(this.options, attemptNumber)
        : null;
    if (retryAt === null) {
      await this.finishTerminal(
        deliveryId,
        attemptId,
        leaseUntil,
        'NEEDS_ATTENTION',
        category,
        providerCode,
      );
      return;
    }
    await this.database.$transaction(async (transaction) => {
      const changed =
        await transaction.voucherRetrievalEmailDelivery.updateMany({
          where: {
            id: deliveryId,
            state: 'PROCESSING',
            processingLeaseUntil: leaseUntil,
          },
          data: {
            lastFailureCategory: category,
            nextAttemptAt: retryAt,
            processingLeaseUntil: null,
            state: 'RETRYING',
          },
        });
      if (changed.count !== 1) return;
      await transaction.voucherRetrievalEmailAttempt.update({
        where: { id: attemptId },
        data: { completedAt: new Date(), outcome: category, providerCode },
      });
    });
  }

  private async finishTerminal(
    deliveryId: bigint,
    attemptId: bigint,
    leaseUntil: Date,
    state: 'NEEDS_ATTENTION' | 'UNKNOWN',
    category: EmailProviderFailureCategory,
    providerCode?: string,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const changed =
        await transaction.voucherRetrievalEmailDelivery.updateMany({
          where: {
            id: deliveryId,
            state: 'PROCESSING',
            processingLeaseUntil: leaseUntil,
          },
          data: {
            lastFailureCategory: category,
            needsAttentionAt: new Date(),
            processingLeaseUntil: null,
            state,
          },
        });
      if (changed.count !== 1) return;
      await transaction.voucherRetrievalEmailAttempt.update({
        where: { id: attemptId },
        data: { completedAt: new Date(), outcome: category, providerCode },
      });
    });
  }
}

function bounded(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(
      'Voucher retrieval delivery batch size must be between 1 and 100.',
    );
  }
  return value;
}

function retryAtFor(
  options: VoucherRetrievalEmailDeliveryOptions,
  attempt: number,
): Date {
  const exponent = Math.max(0, attempt - 1);
  const boundedDelay = Math.min(
    options.maximumRetryDelayMs,
    options.retryBaseDelayMs * 2 ** exponent,
  );
  const jitter = randomInt(0, Math.max(1, Math.floor(boundedDelay / 4)) + 1);
  return new Date(Date.now() + boundedDelay + jitter);
}

function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  return (
    typeof value === 'object' &&
    value !== null &&
    'algorithm' in value &&
    value.algorithm === 'aes-256-gcm' &&
    'ciphertext' in value &&
    typeof value.ciphertext === 'string' &&
    'iv' in value &&
    typeof value.iv === 'string' &&
    'keyId' in value &&
    typeof value.keyId === 'string' &&
    'authTag' in value &&
    typeof value.authTag === 'string'
  );
}
