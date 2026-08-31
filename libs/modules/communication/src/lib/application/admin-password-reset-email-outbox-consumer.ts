import { randomInt } from 'node:crypto';

import type { DatabaseClient } from '@edu-api/database';

import {
  AdminInvitationDeliveryReader,
  type AdminInvitationDeliveryConfiguration,
} from './admin-invitation-delivery-reader';
import type { EmailProvider } from './email-provider';

const eventType = 'ADMIN_PASSWORD_RESET_DELIVERY_REQUESTED';

export interface AdminPasswordResetEmailConsumerOptions {
  readonly from: string;
  readonly leaseMs: number;
  readonly maximumAutomaticAttempts: number;
  readonly workerId: string;
}

interface ClaimedEvent {
  readonly attempts: number;
  readonly id: bigint;
  readonly lastFailureCode: string | null;
  readonly payload: unknown;
}

/**
 * Sends administrator reset links from the transactional outbox. The bearer is
 * decrypted only by the narrow reader immediately before the provider call.
 */
export class AdminPasswordResetEmailOutboxConsumer {
  private readonly deliveryReader: AdminInvitationDeliveryReader;

  constructor(
    private readonly database: DatabaseClient,
    configuration: AdminInvitationDeliveryConfiguration,
    private readonly provider: EmailProvider,
    private readonly options: AdminPasswordResetEmailConsumerOptions,
  ) {
    this.deliveryReader = new AdminInvitationDeliveryReader(
      database,
      configuration,
    );
  }

  async processAvailable(limit: number): Promise<number> {
    const events = await this.claimAvailable(limit);
    for (const event of events) await this.process(event);
    return events.length;
  }

  private async claimAvailable(
    limit: number,
  ): Promise<readonly ClaimedEvent[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.options.leaseMs);
    return this.database.$transaction(async (transaction) => {
      const events = await transaction.$queryRaw<
        Array<{
          attempts: number;
          id: bigint;
          lastFailureCode: string | null;
          payload: unknown;
        }>
      >`
        SELECT "attempts", "id", "lastFailureCode", "payload"
        FROM "OutboxEvent"
        WHERE "eventType" = ${eventType}
          AND "publishedAt" IS NULL
          AND "needsAttentionAt" IS NULL
          AND "availableAt" <= ${now}
          AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
        ORDER BY "id" ASC
        LIMIT ${bounded(limit)}
        FOR UPDATE SKIP LOCKED
      `;
      const claimed: ClaimedEvent[] = [];
      for (const event of events) {
        const updated = await transaction.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts: { increment: 1 },
            lockedAt: now,
            lockOwner: this.options.workerId,
          },
          select: { attempts: true },
        });
        claimed.push({ ...event, attempts: updated.attempts });
      }
      return claimed;
    });
  }

  private async process(event: ClaimedEvent): Promise<void> {
    const passwordResetPublicId = passwordResetReference(event.payload);
    if (passwordResetPublicId === null) {
      await this.needsAttention(event.id, 'INVALID_PASSWORD_RESET_PAYLOAD');
      return;
    }
    const reset = await this.deliveryReader.getPendingPasswordReset(
      passwordResetPublicId,
    );
    if (reset === null) {
      await this.publish(event.id);
      return;
    }
    // A worker crash after an external email call is ambiguous. Only explicit
    // temporary/rate-limit outcomes are retried; an unknown send is surfaced.
    if (event.attempts > 1 && event.lastFailureCode === null) {
      await this.needsAttention(event.id, 'UNKNOWN_EMAIL_OUTCOME');
      return;
    }

    let result: Awaited<ReturnType<EmailProvider['send']>>;
    try {
      result = await this.provider.send({
        from: this.options.from,
        to: reset.email,
        subject: 'Reset your EduVoucher administrator password',
        text: `Reset your administrator password: ${reset.passwordResetUrl}`,
        html: `<p>Use this one-time link to reset your EduVoucher administrator password.</p><p><a href="${escapeHtml(reset.passwordResetUrl)}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
        idempotencyKey: `admin-password-reset-email:${reset.passwordResetPublicId}`,
      });
    } catch {
      await this.needsAttention(event.id, 'UNKNOWN_EMAIL_OUTCOME');
      return;
    }
    if (result.status === 'SENT') {
      await this.publish(event.id);
      return;
    }
    const retryAt = retryAtFor(
      result.category,
      event.attempts,
      this.options.maximumAutomaticAttempts,
      new Date(),
    );
    if (retryAt === null) {
      await this.needsAttention(event.id, result.category);
      return;
    }
    await this.database.outboxEvent.updateMany({
      where: { id: event.id, lockOwner: this.options.workerId },
      data: {
        availableAt: retryAt,
        lastFailureCode: result.category,
        lockedAt: null,
        lockOwner: null,
      },
    });
  }

  private async publish(eventId: bigint): Promise<void> {
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: {
        lastFailureCode: null,
        lockedAt: null,
        lockOwner: null,
        publishedAt: new Date(),
      },
    });
  }

  private async needsAttention(eventId: bigint, code: string): Promise<void> {
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: {
        lastFailureCode: code,
        lockedAt: null,
        lockOwner: null,
        needsAttentionAt: new Date(),
      },
    });
  }
}

function passwordResetReference(payload: unknown): string | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const value = (payload as Record<string, unknown>).passwordResetPublicId;
  return typeof value === 'string' && isUuid(value) ? value : null;
}

function retryAtFor(
  category: string,
  attemptNumber: number,
  maximumAttempts: number,
  now: Date,
): Date | null {
  if (
    (category !== 'TEMPORARY' && category !== 'RATE_LIMITED') ||
    attemptNumber >= maximumAttempts
  ) {
    return null;
  }
  const delay = Math.min(15 * 60 * 1000, 30_000 * 2 ** (attemptNumber - 1));
  return new Date(now.getTime() + delay + randomInt(0, 10_001));
}

function bounded(value: number): number {
  return Math.max(1, Math.min(value, 100));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character] as string;
  });
}
